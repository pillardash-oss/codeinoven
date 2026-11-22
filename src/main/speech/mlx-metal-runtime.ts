import { createHash } from 'node:crypto'
import { createReadStream, type Stats } from 'node:fs'
import {
  chmod,
  copyFile,
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { atomicWrite, getConfigRoot } from '../../lib/utils'
import { Logger } from '../system/logger'
import type {
  SpeechMlxMetalRuntimeSource,
  SpeechMlxMetalRuntimeStatus
} from '../../lib/speech/types'

/**
 * Provisioning of the MLX Metal library (`mlx.metallib`).
 *
 * MLX loads its precompiled Metal kernels from a file sitting beside the
 * executable that links it, and the `mlx-worker` in this app is a statically
 * linked Mach-O that carries the MLX runtime but none of its GPU kernels. That
 * library is 102 MB of kernels covering every MLX operation and dtype, and it is
 * pinned to the exact MLX version the worker was compiled against, so this module
 * treats it as engine data rather than code:
 *
 * 1. **Reuse.** A Metal library another MLX installation already put on this
 *    machine (a Python environment's `mlx` package, an explicit environment
 *    override, or a development checkout's own build output) is linked into
 *    place, so the common case downloads nothing.
 * 2. **Download.** When no copy exists, the pinned `mlx_metal` wheel is fetched,
 *    checksum-verified, and its `mlx.metallib` extracted and verified against the
 *    digest this build was compiled with.
 * 3. **Materialize.** Whichever copy wins is hard-linked next to a hard link of
 *    the bundled worker in a writable runtime directory, because MLX only looks
 *    beside the executable and a signed app bundle is not writable.
 *
 * Only macOS on Apple silicon has an MLX engine at all, which is why the whole
 * module is inert everywhere else.
 */

/** The `mlx_metal` release pinned to the MLX the worker compiles against. */
const MLX_METAL_VERSION = '0.31.1'

const MLX_METAL_WHEEL_NAME = `mlx_metal-${MLX_METAL_VERSION}-py3-none-macosx_14_0_arm64.whl`

/**
 * The wheel MLX builds for macOS 14 on arm64. Both the wheel and the library
 * inside it are pinned: the wheel digest proves the download, and the library
 * digest proves it is the exact kernel set the bundled worker was built with.
 */
const MLX_METAL_WHEEL_URL =
  'https://files.pythonhosted.org/packages/39/66/2313497fdbc7fbadf8e026c09366e3f049f9114e65ca4edc23cdb8699186/' +
  MLX_METAL_WHEEL_NAME
const MLX_METAL_WHEEL_SHA256 = '70741174131dbf7fdd479cb730e06e08c358eac3bf7905d9e884e7960cfdd5b8'
const MLX_METALLIB_SHA256 = '58851101cd4afc56d3080255fe4db366cbd87d654ce5e0651436e4970cd209d1'
const MLX_METALLIB_BYTES = 107_392_404

/** A download cannot legitimately exceed this. */
const MLX_METAL_WHEEL_CEILING_BYTES = 512 * 1024 * 1024

/** Anything smaller than this is a truncated or unrelated file, not the engine. */
const MINIMUM_METALLIB_BYTES = 8 * 1024 * 1024

/** Metal binary libraries start with this magic (`MTLB`). */
const METALLIB_MAGIC = Buffer.from('MTLB', 'ascii')

const WORKER_FILE_NAME = 'mlx-worker'
const METALLIB_FILE_NAME = 'mlx.metallib'
const STATE_FILE_NAME = 'state.json'

/** Python versions a user-installed MLX package can live under. */
const PYTHON_VERSIONS = ['3.9', '3.10', '3.11', '3.12', '3.13', '3.14'] as const

/** How many virtual environments each managed Python root is inspected for. */
const VENV_SCAN_CEILING = 32

type LinkedEntry = {
  source: string
  size: number
  mtimeMs: number
}

interface RuntimeState {
  version: 1
  worker: LinkedEntry
  metallib: LinkedEntry & { sourceType: SpeechMlxMetalRuntimeSource }
}

interface MetalLibraryCandidate {
  path: string
  source: SpeechMlxMetalRuntimeSource
}

function supportedHere(): boolean {
  return process.platform === 'darwin' && process.arch === 'arm64'
}

async function statOrNull(path: string): Promise<Stats | null> {
  try {
    return await stat(path)
  } catch {
    return null
  }
}

async function isFile(path: string): Promise<boolean> {
  return (await statOrNull(path))?.isFile() ?? false
}

async function isDirectory(path: string): Promise<boolean> {
  return (await statOrNull(path))?.isDirectory() ?? false
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', resolve)
  })
  return hash.digest('hex')
}

/** True when the file is a Metal binary library and big enough to be real. */
async function isMetalLibrary(path: string): Promise<boolean> {
  const info = await statOrNull(path)
  if (!info?.isFile() || info.size < MINIMUM_METALLIB_BYTES) return false
  const handle = await open(path, 'r').catch(() => null)
  if (!handle) return false
  try {
    const header = Buffer.alloc(METALLIB_MAGIC.length)
    await handle.read(header, 0, header.length, 0)
    return header.equals(METALLIB_MAGIC)
  } catch {
    return false
  } finally {
    await handle.close()
  }
}

async function findMetallibUnder(directory: string, depth: number): Promise<string | null> {
  if (depth <= 0) return null
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isFile() && entry.name.endsWith('.metallib') && (await isMetalLibrary(path))) {
      return path
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const found = await findMetallibUnder(join(directory, entry.name), depth - 1)
    if (found) return found
  }
  return null
}

/**
 * Candidate `site-packages` directories for the Python installs that commonly
 * carry an MLX package. Built from known layouts rather than by scanning the
 * filesystem, so discovery costs a handful of failed `stat` calls when MLX is
 * not installed.
 */
async function pythonSitePackageDirectories(): Promise<string[]> {
  const home = homedir()
  const directories = new Set<string>()
  const versioned = [
    join(home, '.local', 'lib'),
    join(home, 'miniconda3', 'lib'),
    join(home, 'anaconda3', 'lib'),
    join(home, 'miniforge3', 'lib'),
    '/opt/homebrew/lib',
    '/usr/local/lib'
  ]
  for (const root of versioned) {
    for (const version of PYTHON_VERSIONS) {
      directories.add(join(root, `python${version}`, 'site-packages'))
    }
  }
  for (const version of PYTHON_VERSIONS) {
    directories.add(join(home, 'Library', 'Python', version, 'lib', 'python', 'site-packages'))
  }
  // Managed environment roots nest their packages one level deeper.
  const managed = [
    join(home, '.pyenv', 'versions'),
    join(home, '.local', 'pipx', 'venvs'),
    join(home, 'miniconda3', 'envs'),
    join(home, 'anaconda3', 'envs'),
    join(home, 'miniforge3', 'envs')
  ]
  for (const root of managed) {
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries.slice(0, VENV_SCAN_CEILING)) {
      if (!entry.isDirectory()) continue
      for (const version of PYTHON_VERSIONS) {
        directories.add(join(root, entry.name, 'lib', `python${version}`, 'site-packages'))
      }
    }
  }
  return [...directories]
}

/**
 * Resolves, downloads, and materializes the MLX Metal library.
 *
 * Constructed with the path of the `mlx-worker` inside the bundle; everything it
 * provisions lives under the app configuration root.
 */
export class MlxMetalRuntime {
  private statusCache: SpeechMlxMetalRuntimeStatus | null = null
  private preparing: Promise<string> | null = null
  private preparedWorkerPath: string | null = null
  private lastFailure: string | null = null

  constructor(
    private readonly workerSource: string,
    private readonly root = join(getConfigRoot(), 'speech', 'runtime', 'mlx-metal')
  ) {}

  supported(): boolean {
    return supportedHere()
  }

  runtimeDirectory(): string {
    return this.root
  }

  /** Why the engine could not be prepared on the last attempt, when it failed. */
  unavailableReason(): string | null {
    return this.lastFailure
  }

  workerPathInRuntime(): string {
    return join(this.root, WORKER_FILE_NAME)
  }

  async status(force = false): Promise<SpeechMlxMetalRuntimeStatus> {
    if (!force && this.statusCache) return this.statusCache
    const base = {
      runtimeDirectory: this.root,
      metallibVersion: MLX_METAL_VERSION,
      metallibSha256: MLX_METALLIB_SHA256,
      downloadName: MLX_METAL_WHEEL_NAME,
      downloadByteSize: MLX_METALLIB_BYTES
    } as const
    if (!supportedHere()) {
      this.statusCache = {
        ...base,
        supported: false,
        available: false,
        prepared: false,
        downloadRequired: false
      }
      return this.statusCache
    }
    const candidate = await this.resolveCandidate()
    const prepared = await this.isPrepared()
    this.statusCache = {
      ...base,
      supported: true,
      available: Boolean(candidate) || prepared,
      prepared,
      downloadRequired: !candidate && !prepared,
      ...(candidate ? { selectedPath: candidate.path, source: candidate.source } : {}),
      ...(prepared ? { workerPath: this.workerPathInRuntime() } : {}),
      ...(this.lastFailure ? { unavailableReason: this.lastFailure } : {})
    }
    return this.statusCache
  }

  /**
   * Make the engine usable and return the worker to spawn.
   *
   * Prefers a library already on the machine. Only when none exists does the
   * caller get an error it can turn into a download offer.
   */
  async prepare(signal?: AbortSignal): Promise<string> {
    if (!supportedHere()) throw new Error('The MLX engine runs on macOS on Apple silicon only.')
    if (this.preparedWorkerPath) return this.preparedWorkerPath
    if (this.preparing) return this.preparing
    this.preparing = this.materialize(signal)
      .then((workerPath) => {
        this.preparedWorkerPath = workerPath
        this.lastFailure = null
        this.statusCache = null
        return workerPath
      })
      .catch((error: unknown) => {
        this.lastFailure = error instanceof Error ? error.message : String(error)
        throw error
      })
      .finally(() => {
        this.preparing = null
      })
    return this.preparing
  }

  /**
   * Provision the engine for a model download: reuse what the machine already
   * has, and fetch the pinned library only when there is nothing to reuse.
   */
  async ensure(signal?: AbortSignal): Promise<SpeechMlxMetalRuntimeStatus> {
    if (!supportedHere()) throw new Error('The MLX engine runs on macOS on Apple silicon only.')
    if (this.preparedWorkerPath) return this.status()
    const candidate = await this.resolveCandidate()
    if (!candidate) return this.download(signal)
    await this.prepare(signal)
    return this.status(true)
  }

  /**
   * Download the pinned engine and replace whatever the machine was using.
   *
   * The caller owns consent; this fails closed on checksum mismatch and never
   * leaves a partial library behind. A discovered copy is untouched   the
   * managed copy simply outranks it from now on.
   */
  async download(signal?: AbortSignal): Promise<SpeechMlxMetalRuntimeStatus> {
    if (!supportedHere()) throw new Error('The MLX engine runs on macOS on Apple silicon only.')
    const staging = join(this.root, 'staging')
    const wheel = join(staging, MLX_METAL_WHEEL_NAME)
    const extracted = join(staging, 'wheel')
    await mkdir(staging, { recursive: true })
    try {
      await this.fetchVerified(MLX_METAL_WHEEL_URL, MLX_METAL_WHEEL_SHA256, wheel, signal)
      await rm(extracted, { recursive: true, force: true })
      await mkdir(extracted, { recursive: true })
      await this.extract(wheel, extracted)
      const library = await findMetallibUnder(extracted, 6)
      if (!library) throw new Error('The MLX engine download contained no Metal library.')
      const digest = await hashFile(library)
      if (digest !== MLX_METALLIB_SHA256) {
        throw new Error('The MLX engine download failed its Metal library checksum.')
      }
      await mkdir(this.root, { recursive: true })
      const managed = join(this.root, METALLIB_FILE_NAME)
      await rm(managed, { force: true })
      await rename(library, managed)
      await chmod(managed, 0o644).catch(() => undefined)
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    }
    // The managed library is new content, so any previous link record is stale.
    await rm(join(this.root, STATE_FILE_NAME), { force: true }).catch(() => undefined)
    this.preparedWorkerPath = null
    this.statusCache = null
    await this.prepare()
    Logger.info('Installed the MLX Metal library', { path: join(this.root, METALLIB_FILE_NAME) })
    return this.status(true)
  }

  /** Drop the app-managed library. Discovered copies are never touched. */
  async removeManaged(): Promise<void> {
    await rm(join(this.root, METALLIB_FILE_NAME), { force: true }).catch(() => undefined)
    await rm(join(this.root, STATE_FILE_NAME), { force: true }).catch(() => undefined)
    this.preparedWorkerPath = null
    this.statusCache = null
  }

  private async isPrepared(): Promise<boolean> {
    return (await isFile(this.workerPathInRuntime())) && (await isFile(this.metallibPath()))
  }

  private metallibPath(): string {
    return join(this.root, METALLIB_FILE_NAME)
  }

  /**
   * The best Metal library on this machine, in priority order: an explicit
   * override, the app's own managed copy, the build output beside the worker in
   * a development checkout, then an MLX package another tool installed.
   */
  private async resolveCandidate(): Promise<MetalLibraryCandidate | null> {
    const override =
      process.env['CODEINOVEN_MLX_METALLIB_PATH']?.trim() ||
      process.env['MLX_METALLIB_PATH']?.trim()
    if (override && (await isMetalLibrary(override))) {
      return { path: override, source: 'environment' }
    }
    const managed = this.metallibPath()
    if (await isMetalLibrary(managed)) {
      return { path: managed, source: await this.managedSource() }
    }
    // In a development checkout the pinned library is built next to the worker
    // by scripts/build-mlx-speech-worker.ts. A packaged bundle has no file here,
    // so this candidate simply misses.
    const development = join(dirname(this.workerSource), METALLIB_FILE_NAME)
    if (development !== managed && (await isMetalLibrary(development))) {
      return { path: development, source: 'development' }
    }
    for (const sitePackages of await pythonSitePackageDirectories()) {
      const mlxPackage = join(sitePackages, 'mlx')
      if (!(await isDirectory(mlxPackage))) continue
      const found = await findMetallibUnder(mlxPackage, 4)
      if (found) return { path: found, source: 'python' }
    }
    return null
  }

  /**
   * What the app-managed library actually is.
   *
   * Materializing a discovered library links it to the managed path, so the file
   * alone no longer says where it came from. The state file does, and reporting
   * provenance honestly is what lets the settings surface say "reused from an MLX
   * install on this machine" instead of claiming the app downloaded it.
   */
  private async managedSource(): Promise<SpeechMlxMetalRuntimeSource> {
    const state = await this.readState()
    const record = state?.metallib
    if (!record) return 'managed'
    return record.source === this.metallibPath() ? 'managed' : record.sourceType
  }

  /**
   * Put a worker and a Metal library side by side in the runtime directory.
   *
   * MLX resolves its library relative to the executable, and the executable
   * lives in a signed bundle that must not be written to, so both are linked
   * here: the bundled worker, and the winning library. Hard links keep this free
   * of a second 53 MB worker and a second 102 MB library; filesystems that refuse
   * them fall back to a copy recorded in the state file, so the copy is not
   * repeated on every launch.
   */
  private async materialize(signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new Error('Speech operation cancelled.')
    const candidate = await this.resolveCandidate()
    if (!candidate) {
      throw new Error('The MLX engine is not installed yet. Downloading an MLX model installs it.')
    }
    await mkdir(this.root, { recursive: true })
    const state = await this.readState()
    const workerTarget = this.workerPathInRuntime()
    const workerSourceInfo = await stat(this.workerSource)
    if (
      !(await this.isAlreadyLinked(
        workerTarget,
        this.workerSource,
        workerSourceInfo,
        state?.worker ?? null
      ))
    ) {
      await this.replaceWithLink(workerTarget, this.workerSource, 0o755)
    }
    // Recorded on every pass: a hard link satisfies the inode check, but the
    // record is what keeps a copy from being repeated on the next launch.
    const nextWorker = this.entryFor(this.workerSource, workerSourceInfo)
    const metallibTarget = this.metallibPath()
    let nextMetallib: RuntimeState['metallib']
    if (candidate.path === metallibTarget) {
      // Already at the managed path: keep whatever provenance the record holds,
      // because linking a discovered library here must not relabel it as
      // downloaded.
      nextMetallib = state?.metallib ?? {
        ...this.entryFor(metallibTarget, await stat(metallibTarget)),
        sourceType: 'managed'
      }
    } else {
      const sourceInfo = await stat(candidate.path)
      if (
        !(await this.isAlreadyLinked(
          metallibTarget,
          candidate.path,
          sourceInfo,
          state?.metallib ?? null
        )) ||
        state?.metallib?.sourceType !== candidate.source
      ) {
        await this.replaceWithLink(metallibTarget, candidate.path, 0o644)
      }
      nextMetallib = {
        ...this.entryFor(candidate.path, sourceInfo),
        sourceType: candidate.source
      }
    }
    await this.writeState({ version: 1, worker: nextWorker, metallib: nextMetallib })
    return workerTarget
  }

  private entryFor(source: string, info: Stats): LinkedEntry {
    return { source, size: info.size, mtimeMs: info.mtimeMs }
  }

  /**
   * Whether the destination is already the right file: either the same inode as
   * the source (a hard link), or a copy the state file records from this exact
   * source revision.
   */
  private async isAlreadyLinked(
    destination: string,
    source: string,
    sourceInfo: Stats,
    record: LinkedEntry | null
  ): Promise<boolean> {
    const destinationInfo = await statOrNull(destination)
    if (!destinationInfo?.isFile()) return false
    if (destinationInfo.ino === sourceInfo.ino && destinationInfo.dev === sourceInfo.dev)
      return true
    return (
      record !== null &&
      record.source === source &&
      record.size === sourceInfo.size &&
      record.mtimeMs === sourceInfo.mtimeMs &&
      destinationInfo.size === sourceInfo.size
    )
  }

  private async replaceWithLink(destination: string, source: string, mode: number): Promise<void> {
    await rm(destination, { force: true })
    try {
      await link(source, destination)
    } catch {
      await copyFile(source, destination)
    }
    await chmod(destination, mode).catch(() => undefined)
  }

  private async readState(): Promise<RuntimeState | null> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(join(this.root, STATE_FILE_NAME), 'utf8'))
    } catch {
      return null
    }
    if (typeof parsed !== 'object' || parsed === null) return null
    const candidate = parsed as Partial<RuntimeState>
    if (candidate.version !== 1) return null
    if (!candidate.worker || !candidate.metallib) return null
    return candidate as RuntimeState
  }

  private async writeState(state: RuntimeState): Promise<void> {
    await mkdir(this.root, { recursive: true })
    await atomicWrite(join(this.root, STATE_FILE_NAME), `${JSON.stringify(state, null, 2)}\n`)
  }

  /** Stream the pinned wheel and verify its content before anything is unpacked. */
  private async fetchVerified(
    url: string,
    expectedSha256: string,
    targetPath: string,
    signal?: AbortSignal
  ): Promise<void> {
    const response = await fetch(url, { ...(signal ? { signal } : {}) })
    if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}).`)
    const hash = createHash('sha256')
    let received = 0
    const reader = response.body.getReader()
    const handle = await open(targetPath, 'w')
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        if (received > MLX_METAL_WHEEL_CEILING_BYTES) {
          throw new Error('The MLX engine download exceeded the expected size.')
        }
        hash.update(value)
        await handle.write(value)
      }
    } finally {
      await handle.close()
    }
    if (hash.digest('hex') !== expectedSha256) {
      await rm(targetPath, { force: true }).catch(() => undefined)
      throw new Error('The MLX engine download failed its checksum verification.')
    }
  }

  /** `ditto` is the macOS zip extractor; the engine exists on macOS only. */
  private extract(archivePath: string, targetDirectory: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/ditto', ['-x', '-k', archivePath, targetDirectory], {
        stdio: ['ignore', 'ignore', 'pipe']
      })
      let failure = ''
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        if (failure.length < 2000) failure += chunk
      })
      child.once('error', reject)
      child.once('exit', (code) => {
        if (code === 0) resolve()
        else
          reject(new Error(failure.trim() || `Extraction exited with code ${code ?? 'unknown'}.`))
      })
    })
  }
}

/** The pinned engine identity, exported so tests and diagnostics share one source. */
export const MLX_METAL_PINNED = {
  version: MLX_METAL_VERSION,
  wheelName: MLX_METAL_WHEEL_NAME,
  wheelUrl: MLX_METAL_WHEEL_URL,
  wheelSha256: MLX_METAL_WHEEL_SHA256,
  metallibSha256: MLX_METALLIB_SHA256,
  metallibBytes: MLX_METALLIB_BYTES,
  workerFileName: WORKER_FILE_NAME,
  metallibFileName: METALLIB_FILE_NAME
} as const

/** Test seam: writes a file this module accepts as a Metal binary library. */
export async function writeMetalLibraryStub(
  path: string,
  bytes = MINIMUM_METALLIB_BYTES
): Promise<void> {
  const content = Buffer.alloc(Math.max(bytes, MINIMUM_METALLIB_BYTES))
  METALLIB_MAGIC.copy(content, 0)
  await writeFile(path, content)
}
