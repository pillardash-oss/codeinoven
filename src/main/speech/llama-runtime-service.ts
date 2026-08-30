import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, access, chmod, mkdir, open, readdir, realpath, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { spawn } from 'node:child_process'
import { getConfigRoot } from '../../lib/utils'
import type {
  SpeechLlamaRuntimeInstallation,
  SpeechLlamaRuntimeSource,
  SpeechLlamaRuntimeStatus
} from '../../lib/speech/types'

export type LlamaRuntimeSource = SpeechLlamaRuntimeSource

export type LlamaRuntimeInstallation = SpeechLlamaRuntimeInstallation

export type LlamaRuntimeStatus = SpeechLlamaRuntimeStatus

interface RuntimeCandidate {
  path: string
  source: LlamaRuntimeSource
}

/**
 * Pinned llama.cpp release providing `llama-server`. Digests come from the
 * GitHub release asset metadata for the exact tag; downloads verify the full
 * archive SHA-256 before extraction and never run a partially extracted build.
 */
const LLAMA_RELEASE_TAG = 'b10644'
const LLAMA_RELEASE_BASE_URL = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_RELEASE_TAG}`

interface LlamaRuntimeAsset {
  archiveName: string
  byteSize: number
  sha256: string
}

const LLAMA_RUNTIME_ASSETS: Readonly<Record<string, LlamaRuntimeAsset>> = {
  'darwin-arm64': {
    archiveName: 'llama-b10644-bin-macos-arm64.tar.gz',
    byteSize: 10973723,
    sha256: '3bf52a55f3cfdb2a6a33e59667f143fb70d5d731225783a145a97faba13498dd'
  },
  'darwin-x64': {
    archiveName: 'llama-b10644-bin-macos-x64.tar.gz',
    byteSize: 11043476,
    sha256: '5f3576bce78e0f64fbea1ec932c1f23ceb2f7793a6406f0c0707fad3cf29edf0'
  },
  'linux-arm64': {
    archiveName: 'llama-b10644-bin-ubuntu-arm64.tar.gz',
    byteSize: 13063648,
    sha256: '52c0fc49778f8ac6adca07573784ffac0ea06601e7fd25b6a68fbb531e163c05'
  },
  'linux-x64': {
    archiveName: 'llama-b10644-bin-ubuntu-x64.tar.gz',
    byteSize: 16307543,
    sha256: 'a086a0d9ebf1a67a3d492a4f4afb2092c669d0f1ba75a70c5a4922fb19339823'
  },
  'win32-arm64': {
    archiveName: 'llama-b10644-bin-win-cpu-arm64.zip',
    byteSize: 11853940,
    sha256: 'a90ecd4feb28478aaf8e5d94f7defdaa8d799498d5264cf7fb7b3a56350e875b'
  },
  'win32-x64': {
    archiveName: 'llama-b10644-bin-win-cpu-x64.zip',
    byteSize: 18076263,
    sha256: 'dec540d4d691de376bc95bad2b6eefad4cb3b4baf99a0671095bead3dc1f2625'
  }
}

function platformKey(): string {
  return `${process.platform}-${process.arch}`
}

function serverBinaryName(): string {
  return process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
}

/**
 * Discovers an existing llama.cpp runtime or downloads the pinned prebuilt
 * release into the CodeInOven configuration directory. Nothing is bundled:
 * machines that already ship llama-server reuse it transparently.
 */
export class LlamaRuntimeService {
  private statusCache: LlamaRuntimeStatus | null = null

  constructor(private readonly root = join(getConfigRoot(), 'speech', 'runtime')) {}

  managedDirectory(): string {
    return join(this.root, `llama-${LLAMA_RELEASE_TAG}`)
  }

  async status(force = false): Promise<LlamaRuntimeStatus> {
    if (!force && this.statusCache) return this.statusCache
    const asset = LLAMA_RUNTIME_ASSETS[platformKey()]
    const managedBinary = await this.findManagedBinary()
    const discovered = await this.discoverInstallations(managedBinary)
    const selected = discovered[0]
    this.statusCache = {
      available: Boolean(selected),
      ...(selected?.version ? { version: selected.version } : {}),
      ...(selected ? { selectedPath: selected.realPath } : {}),
      installations: discovered,
      managedDir: this.managedDirectory(),
      releaseTag: LLAMA_RELEASE_TAG,
      downloadRequired: !selected && Boolean(asset),
      ...(asset
        ? { downloadName: asset.archiveName, downloadByteSize: asset.byteSize }
        : {})
    }
    return this.statusCache
  }

  /**
   * Download and unpack the pinned release. The caller owns user consent; this
   * method fails closed on checksum mismatch and never leaves a partial
   * installation behind.
   */
  async download(signal?: AbortSignal): Promise<LlamaRuntimeStatus> {
    const key = platformKey()
    const asset = LLAMA_RUNTIME_ASSETS[key]
    if (!asset) throw new Error(`No packaged llama.cpp runtime for ${key}.`)
    const url = `${LLAMA_RELEASE_BASE_URL}/${asset.archiveName}`
    const stagingDir = join(this.root, 'staging')
    await mkdir(stagingDir, { recursive: true })
    const stagingArchive = join(stagingDir, asset.archiveName)
    try {
      await this.fetchVerified(url, asset, stagingArchive, signal)
      const extractTarget = this.managedDirectory()
      await rm(extractTarget, { recursive: true, force: true })
      await mkdir(extractTarget, { recursive: true })
      await this.extract(stagingArchive, extractTarget)
      const binary = await this.locateBinary(extractTarget)
      if (process.platform !== 'win32') {
        await chmod(binary, 0o755).catch(() => undefined)
      }
    } finally {
      await rm(stagingArchive, { force: true }).catch(() => undefined)
    }
    // Imported dylib/dll layout can vary between releases; resolve once now.
    return this.status(true)
  }

  /** Remove only the app-managed runtime copy. Discovered installs are untouched. */
  async removeManaged(): Promise<void> {
    await rm(this.managedDirectory(), { recursive: true, force: true }).catch(() => undefined)
    this.statusCache = null
  }

  private async fetchVerified(
    url: string,
    asset: LlamaRuntimeAsset,
    targetPath: string,
    signal?: AbortSignal
  ): Promise<void> {
    const response = await fetch(url, { ...(signal ? { signal } : {}) })
    if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}).`)
    const hash = createHash('sha256')
    let received = 0
    const reader = response.body.getReader()
    const handle = await open(targetPath, 'wx')
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        if (received > asset.byteSize) throw new Error('Download exceeded the expected size.')
        hash.update(value)
        await handle.write(value)
      }
    } finally {
      await handle.close()
    }
    const digest = hash.digest('hex')
    if (digest !== asset.sha256) {
      await rm(targetPath, { force: true }).catch(() => undefined)
      throw new Error('The llama.cpp runtime download failed its checksum verification.')
    }
    const size = await stat(targetPath).then((value) => value.size)
    if (size !== asset.byteSize) {
      await rm(targetPath, { force: true }).catch(() => undefined)
      throw new Error('The llama.cpp runtime download has an unexpected size.')
    }
  }

  /** System bsdtar handles tar.gz everywhere and zip archives on Windows 10+. */
  private extract(archivePath: string, targetDir: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        'tar',
        ['-xf', archivePath, '-C', targetDir],
        { stdio: ['ignore', 'ignore', 'pipe'] }
      )
      let failure = ''
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        if (failure.length < 2000) failure += chunk
      })
      child.once('error', reject)
      child.once('exit', (code) => {
        if (code === 0) resolve()
        else reject(new Error(failure.trim() || `Extraction exited with code ${code ?? 'unknown'}.`))
      })
    })
  }

  private async findManagedBinary(): Promise<string | null> {
    try {
      return await this.locateBinary(this.managedDirectory())
    } catch {
      return null
    }
  }

  private async locateBinary(dir: string): Promise<string> {
    const name = serverBinaryName()
    const direct = join(dir, name)
    if (await this.isExecutable(direct)) return direct
    // Release archives historically nest binaries under build/bin/.
    for (const nested of [join(dir, 'build', 'bin', name), join(dir, 'bin', name)]) {
      if (await this.isExecutable(nested)) return nested
    }
    return this.searchRecursively(dir, name, 4)
  }

  private async searchRecursively(dir: string, name: string, depth: number): Promise<string> {
    if (depth <= 0) throw new Error(`The ${name} binary was not found in the downloaded runtime.`)
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      throw new Error(`The ${name} binary was not found in the downloaded runtime.`)
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const candidate = join(dir, entry.name, name)
      if (await this.isExecutable(candidate)) return candidate
      try {
        return await this.searchRecursively(join(dir, entry.name), name, depth - 1)
      } catch {
        continue
      }
    }
    throw new Error(`The ${name} binary was not found in the downloaded runtime.`)
  }

  private async discoverInstallations(
    managedBinary: string | null
  ): Promise<LlamaRuntimeInstallation[]> {
    const executable = serverBinaryName()
    const candidates: RuntimeCandidate[] = []
    const envOverride =
      process.env['CODEINOVEN_LLAMA_SERVER_PATH'] ?? process.env['LLAMA_SERVER_PATH']
    if (envOverride) candidates.push({ path: envOverride, source: 'environment' })
    candidates.push({ path: join(homedir(), '.local', 'bin', executable), source: 'canonical' })
    candidates.push({ path: join(homedir(), '.cargo', 'bin', executable), source: 'canonical' })
    if (process.platform === 'darwin') {
      candidates.push({ path: `/opt/homebrew/bin/${executable}`, source: 'homebrew' })
      candidates.push({ path: `/usr/local/bin/${executable}`, source: 'homebrew' })
    }
    for (const directory of (process.env['PATH'] ?? '').split(delimiter)) {
      if (!directory) continue
      candidates.push({ path: join(directory, executable), source: 'path' })
    }
    if (managedBinary) candidates.unshift({ path: managedBinary, source: 'managed' })

    const seen = new Set<string>()
    const accessible: Array<RuntimeCandidate & { realPath: string }> = []
    for (const candidate of candidates) {
      if (seen.has(candidate.path)) continue
      seen.add(candidate.path)
      try {
        await access(candidate.path, constants.X_OK)
        accessible.push({ ...candidate, realPath: await realpath(candidate.path) })
      } catch {
        // Missing or non-executable candidate; keep scanning.
      }
    }
    const grouped = new Map<string, Array<RuntimeCandidate & { realPath: string }>>()
    for (const candidate of accessible) {
      const group = grouped.get(candidate.realPath) ?? []
      group.push(candidate)
      grouped.set(candidate.realPath, group)
    }
    const sourceRank: Record<LlamaRuntimeSource, number> = {
      environment: 0,
      managed: 1,
      canonical: 2,
      homebrew: 3,
      path: 4
    }
    const interim = await Promise.all(
      [...grouped.entries()].map(async ([realPath, group]): Promise<{
        realPath: string
        source: LlamaRuntimeSource
        path: string
        version: string | null
      }> => ({
        realPath,
        source: group
          .map((item) => item.source)
          .sort((left, right) => sourceRank[left] - sourceRank[right])[0],
        path: group[0]?.path ?? realPath,
        version: await this.binaryVersion(realPath)
      }))
    )
    return interim
      .filter((installation): installation is LlamaRuntimeInstallation & { version: string } =>
        installation.version !== null)
      .sort((left, right) => {
        // Pinned-release builds first so behavior matches what we test against.
        const leftPinned = left.version.startsWith(LLAMA_RELEASE_TAG.slice(1)) ? 0 : 1
        const rightPinned = right.version.startsWith(LLAMA_RELEASE_TAG.slice(1)) ? 0 : 1
        if (leftPinned !== rightPinned) return leftPinned - rightPinned
        return left.path.length - right.path.length
      })
      .map(({ path, source, realPath, version }) => ({ path, source, realPath, version }))
  }

  private async binaryVersion(path: string): Promise<string | null> {
    return new Promise((resolve) => {
      // Some llama.cpp builds (e.g. Homebrew) print the version banner on
      // stderr instead of stdout, so scan both streams.
      execFile(path, ['--version'], { timeout: 5000 }, (error, stdout, stderr) => {
        if (error) {
          resolve(null)
          return
        }
        // Output looks like: version: 6243abc12 (1234) built with ...
        const match = /version:\s*(\S+)/u.exec(`${stdout}\n${stderr}`.trim())
        resolve(match?.[1] ?? null)
      })
    })
  }

  private async isExecutable(path: string): Promise<boolean> {
    try {
      await access(path, constants.X_OK)
      return (await stat(path)).isFile()
    } catch {
      return false
    }
  }
}
