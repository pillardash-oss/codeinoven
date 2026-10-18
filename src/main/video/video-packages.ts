import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, statfs } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWrite, getConfigRoot } from '../../lib/utils'
import type {
  VideoPackagesPhase,
  VideoPackagesProgressEvent,
  VideoPackagesState
} from '../../lib/ipc/video-packages'
import { resolvePackageCommand, type PackageCommand } from '../drivers/cli-environment'
import { appServiceRegistry } from '../system/app-service-registry'
import { Logger } from '../system/logger'

/**
 * The heavy inference stack the `remove-background` video operation needs, kept
 * out of the shipped installer and installed on demand.
 *
 * Every other video operation runs on the bundled `ffmpeg-static` binary. Only
 * GPU matting pulls in `@remotion/video-matting`, `@huggingface/transformers`,
 * `@mediabunny/server` and `mediabunny` (with their transitive `onnxruntime-node`
 * and `sharp` natives, hundreds of megabytes). Those are pinned npm packages
 * installed at runtime into the app's own config folder, never into a user's
 * repository, and imported from there.
 *
 * Layout, beneath the app config root:
 *
 *   video/packages/                 the installed pack (node_modules + manifest)
 *   video/packages/installed.json   the installed ledger
 *   video/models/                   model weights, the matting cache
 *
 * The service follows the gateway supervisor's install shape and the search and
 * speech downloaders' progress and disk-preflight conventions.
 */

interface PinnedPackage {
  name: string
  version: string
  /** npm install specifier, e.g. `@remotion/video-matting@4.0.535`. */
  spec: string
}

/**
 * The exact versions the feature is built against. Installing the whole
 * dependency graph from a manifest rather than letting a resolver drift keeps a
 * user install identical to the one the app was tested with.
 */
const VIDEO_PACKAGES: readonly PinnedPackage[] = [
  {
    name: '@remotion/video-matting',
    version: '4.0.535',
    spec: '@remotion/video-matting@4.0.535'
  },
  { name: '@huggingface/transformers', version: '4.2.0', spec: '@huggingface/transformers@4.2.0' },
  { name: '@mediabunny/server', version: '1.61.3', spec: '@mediabunny/server@1.61.3' },
  { name: 'mediabunny', version: '1.61.3', spec: 'mediabunny@1.61.3' }
]

/** Version reported for the whole pack; anchored on the matting package. */
export const VIDEO_PACKAGES_VERSION = '4.0.535'

/**
 * Bytes the pack is expected to need, used for the pre-install disk preflight.
 * A verified install lands at about 462 MB; the estimate leaves room for the
 * package manager's download cache and extraction on the same volume.
 */
const ESTIMATED_PACK_BYTES = 768 * 1024 * 1024

/** Hard ceiling for the finished install; a larger result is an error. */
const MAX_PACK_BYTES = 2 * 1024 * 1024 * 1024

/** A package install has no per-file percentage; the phase stream is throttled. */
const PROGRESS_EMIT_INTERVAL_MS = 250

/** A cold install downloads native binaries; give it room but never hang forever. */
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000

/** Captured stderr is a failure message, not a transcript. */
const STDERR_TAIL_CHARS = 4_000

interface VideoPackagesLedger {
  version: string
  packages: Array<{ name: string; version: string }>
  sizeBytes: number
  installedAt: number
}

class VideoPackCancelled extends Error {
  constructor() {
    super('The video pack install was cancelled.')
  }
}

export class VideoPackagesService {
  /** App-owned video root; `video/packages` holds the pack, `video/models` the weights. */
  readonly root: string
  readonly packagesDir: string
  readonly modelsDir: string
  readonly ledgerPath: string

  private readonly listeners = new Set<(state: VideoPackagesProgressEvent) => void>()
  private ready: Promise<void> | null = null
  private child: ChildProcess | null = null
  private busy = false
  private cancelled = false
  private installed = false
  private version: string | null = null
  private sizeBytes = 0
  private phase: VideoPackagesPhase = 'idle'
  private percent: number | null = null
  private error: string | null = null
  private lastEmitAt = 0
  private lastPhase: VideoPackagesPhase = 'idle'

  constructor(root = join(getConfigRoot(), 'video')) {
    this.root = root
    this.packagesDir = join(root, 'packages')
    this.modelsDir = join(root, 'models')
    this.ledgerPath = join(this.packagesDir, 'installed.json')
  }

  /**
   * Create the app-owned directories and recover the installed state from disk.
   * Idempotent: the state read awaits the first scan so a settings page opened
   * while the boot pass is still running never sees a stale "not installed".
   */
  initialize(): Promise<void> {
    this.ready ??= this.bootstrap()
    return this.ready
  }

  private async bootstrap(): Promise<void> {
    try {
      await mkdir(this.packagesDir, { recursive: true })
      await mkdir(this.modelsDir, { recursive: true })
      await this.refresh()
    } catch (error) {
      Logger.error('Video pack initialization failed', {
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  /** Current pack state. `installed` is only true after `refresh` verified it. */
  state(): VideoPackagesState {
    return {
      installed: this.installed,
      version: this.version,
      sizeBytes: this.sizeBytes,
      phase: this.phase,
      percent: this.percent,
      error: this.error
    }
  }

  /**
   * Re-read the ledger and re-verify the packages on disk. The remove-background
   * gate awaits this so a stale in-memory flag can never block a working pack.
   */
  async refresh(): Promise<void> {
    if (this.busy) return
    const ledger = await this.readLedger()
    if (ledger && this.packagesPresent()) {
      this.installed = true
      this.version = ledger.version
      this.sizeBytes = ledger.sizeBytes
      this.percent = null
      this.error = null
      this.phase = 'installed'
      return
    }
    this.installed = false
    this.version = null
    this.sizeBytes = 0
    this.percent = null
    if (this.phase !== 'failed' && this.phase !== 'cancelled') this.phase = 'idle'
  }

  onProgress(listener: (state: VideoPackagesProgressEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Install the pinned pack. Refuses while another install runs or when no
   * supported package manager exists, preflights disk space, runs the manager as
   * a child process with a hard timeout, and only reports installed after the
   * ledger is written and the packages are present on disk.
   */
  async install(): Promise<void> {
    if (this.busy) throw new Error('A video pack install is already running.')
    this.busy = true
    this.cancelled = false
    this.error = null
    try {
      // Resolve the package manager before touching disk so a machine without
      // one refuses up front, with a message naming what to install.
      const install = this.installCommand()
      await this.setPhase('preparing', { percent: null, force: true })
      await mkdir(this.packagesDir, { recursive: true })
      await mkdir(this.modelsDir, { recursive: true })
      await this.assertDiskSpace()
      await atomicWrite(join(this.packagesDir, 'package.json'), this.manifestJson())
      await rm(this.ledgerPath, { force: true })
      await this.setPhase('installing', { percent: null, force: true })
      await this.runInstall(install)
      const sizeBytes = await directorySize(this.packagesDir)
      if (sizeBytes > MAX_PACK_BYTES) {
        await rm(this.packagesDir, { recursive: true, force: true })
        throw new Error(
          `The video pack is larger than the 2 GB limit (${Math.round(sizeBytes / 1024 / 1024)} MB). Nothing was kept.`
        )
      }
      if (!this.packagesPresent()) {
        throw new Error(
          'The video pack installed but its packages could not be found. Try removing the pack and installing it again.'
        )
      }
      const installedAt = Date.now()
      const ledger: VideoPackagesLedger = {
        version: VIDEO_PACKAGES_VERSION,
        packages: VIDEO_PACKAGES.map((pkg) => ({ name: pkg.name, version: pkg.version })),
        sizeBytes,
        installedAt
      }
      await atomicWrite(this.ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`)
      this.installed = true
      this.version = ledger.version
      this.sizeBytes = sizeBytes
      this.error = null
      await this.setPhase('installed', { percent: null, force: true })
    } catch (cause) {
      const cancelled = cause instanceof VideoPackCancelled || this.cancelled
      await rm(join(this.packagesDir, 'node_modules'), { recursive: true, force: true })
      await rm(join(this.packagesDir, 'bun.lock'), { force: true })
      await rm(join(this.packagesDir, 'package-lock.json'), { force: true })
      await rm(join(this.packagesDir, 'pnpm-lock.yaml'), { force: true })
      await rm(join(this.packagesDir, 'yarn.lock'), { force: true })
      this.installed = false
      this.version = null
      this.sizeBytes = 0
      if (cancelled) {
        this.percent = null
        this.error = null
        await this.setPhase('cancelled', { percent: null, force: true })
      } else {
        this.error = cause instanceof Error ? cause.message : String(cause)
        this.percent = null
        await this.setPhase('failed', { percent: null, force: true })
      }
      throw cause
    } finally {
      this.child = null
      this.busy = false
    }
  }

  /** Kill the running install, if any. Returns whether a child was signalled. */
  cancel(): boolean {
    if (!this.child) return false
    this.cancelled = true
    this.child.kill('SIGKILL')
    return true
  }

  /**
   * Delete the pack, its ledger and the model weights it downloaded. Refuses
   * while a video job is running, because a matting job is reading the pack.
   */
  async remove(): Promise<void> {
    if (this.busy) throw new Error('Wait for the video pack install to finish or cancel it.')
    if (this.videoJobRunning()) {
      throw new Error(
        'A video job is running. Wait for it to finish before removing the video pack.'
      )
    }
    await rm(this.packagesDir, { recursive: true, force: true })
    await rm(this.modelsDir, { recursive: true, force: true })
    this.installed = false
    this.version = null
    this.sizeBytes = 0
    this.percent = null
    this.error = null
    await this.setPhase('idle', { percent: null, force: true })
  }

  // ─── Internals ──────────────────────────────────────────────────────────────

  private manifestJson(): string {
    const dependencies: Record<string, string> = {}
    for (const pkg of VIDEO_PACKAGES) dependencies[pkg.name] = pkg.version
    return `${JSON.stringify(
      { name: 'codeinoven-video-packages', private: true, dependencies },
      null,
      2
    )}\n`
  }

  /**
   * The package manager command that installs exactly the pinned packages.
   *
   * `resolvePackageCommand` is the app's single process/package-manager
   * boundary, so Bun, npm, pnpm and Yarn all work without a feature-local PATH
   * guess. Passing the manifest directory as a package name would install the
   * folder as a local dependency instead, so the pins travel as arguments.
   */
  private installCommand(): PackageCommand {
    const [first, ...rest] = VIDEO_PACKAGES
    if (!first) throw new Error('The video pack has no pinned packages.')
    try {
      return resolvePackageCommand(
        'install',
        first.spec,
        rest.map((pkg) => pkg.spec)
      )
    } catch (cause) {
      throw new Error(
        'The video pack needs a JavaScript package manager. Install Bun, Node.js with npm, pnpm, or Yarn and restart CodeInOven.',
        { cause }
      )
    }
  }

  private runInstall(install: PackageCommand): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(install.command, install.args, {
        cwd: this.packagesDir,
        env: install.env,
        shell: install.shell,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      this.child = child
      let stderr = ''
      let settled = false
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, INSTALL_TIMEOUT_MS)
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.child = null
        if (error) reject(error)
        else resolve()
      }
      child.stdout?.on('data', () => this.emit())
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-STDERR_TAIL_CHARS)
        this.emit()
      })
      child.once('error', (error) => finish(error))
      child.once('exit', (code) => {
        if (this.cancelled) {
          finish(new VideoPackCancelled())
        } else if (timedOut) {
          finish(
            new Error(
              `Installing the video pack timed out after ${Math.round(INSTALL_TIMEOUT_MS / 60_000)} minutes. Check your connection and try again.`
            )
          )
        } else if (code === 0) {
          finish()
        } else {
          const tail = stderr.trim()
          finish(
            new Error(
              `The video pack install failed (${code ?? 'signal'})${tail ? `: ${tail}` : '.'}`
            )
          )
        }
      })
    })
  }

  /**
   * Preflight the install against free disk space so a nearly full disk fails
   * immediately with an actionable message instead of halfway through writing
   * native binaries, mirroring the speech and search model downloaders.
   */
  private async assertDiskSpace(): Promise<void> {
    try {
      const stats = await statfs(this.root)
      const available = Number(stats.bavail) * Number(stats.bsize)
      const margin = Math.min(
        Math.max(ESTIMATED_PACK_BYTES * 0.05, 64 * 1024 * 1024),
        1_073_741_824
      )
      if (available < ESTIMATED_PACK_BYTES + margin) {
        throw new Error(
          `Not enough disk space to install the video pack: ${Math.round(
            (ESTIMATED_PACK_BYTES + margin) / 1024 / 1024
          )} MB is needed, ${Math.round(available / 1024 / 1024)} MB is available. Free up space and try again.`
        )
      }
    } catch (cause) {
      if (cause instanceof Error && cause.message.startsWith('Not enough disk space')) throw cause
      // statfs failing must never block an install; the package manager below
      // still surfaces a real error if the disk is genuinely unwritable.
    }
  }

  private async readLedger(): Promise<VideoPackagesLedger | null> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.ledgerPath, 'utf8'))
      if (typeof raw !== 'object' || raw === null) return null
      const record = raw as Record<string, unknown>
      const version = record['version']
      const sizeBytes = record['sizeBytes']
      const installedAt = record['installedAt']
      const packages = record['packages']
      if (
        typeof version !== 'string' ||
        typeof sizeBytes !== 'number' ||
        !Number.isFinite(sizeBytes) ||
        typeof installedAt !== 'number' ||
        !Array.isArray(packages)
      ) {
        return null
      }
      const pins = packages.flatMap((entry): Array<{ name: string; version: string }> => {
        if (typeof entry !== 'object' || entry === null) return []
        const row = entry as Record<string, unknown>
        const name = row['name']
        const pinned = row['version']
        if (typeof name !== 'string' || typeof pinned !== 'string') return []
        return [{ name, version: pinned }]
      })
      return { version, sizeBytes, installedAt, packages: pins }
    } catch {
      return null
    }
  }

  /** True when every pinned package sits in the pack's own `node_modules`. */
  private packagesPresent(): boolean {
    const nodeModules = join(this.packagesDir, 'node_modules')
    return VIDEO_PACKAGES.every((pkg) =>
      existsSync(join(nodeModules, ...pkg.name.split('/'), 'package.json'))
    )
  }

  private videoJobRunning(): boolean {
    return appServiceRegistry
      .list()
      .some((service) => service.kind === 'worker' && service.name.startsWith('Video: '))
  }

  private async setPhase(
    phase: VideoPackagesPhase,
    options: { percent: number | null; force?: boolean }
  ): Promise<void> {
    this.phase = phase
    this.percent = options.percent
    this.emit(options.force === true)
  }

  /** Publish state to listeners, throttled like the search download stream. */
  private emit(force = false): void {
    const now = Date.now()
    const phaseChanged = this.phase !== this.lastPhase
    if (!force && !phaseChanged && now - this.lastEmitAt < PROGRESS_EMIT_INTERVAL_MS) return
    this.lastEmitAt = now
    this.lastPhase = this.phase
    const snapshot = this.state()
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch (error) {
        Logger.error('Video pack progress listener failed', {
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }
}

/** Recursive byte size of regular files; symlinks are skipped so nothing counts twice. */
async function directorySize(directory: string): Promise<number> {
  let total = 0
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      total += await directorySize(path)
    } else if (entry.isFile()) {
      total += await stat(path)
        .then((stats) => stats.size)
        .catch(() => 0)
    }
  }
  return total
}
