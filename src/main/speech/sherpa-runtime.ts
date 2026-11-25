import { createHash } from 'node:crypto'
import { type Stats } from 'node:fs'
import {
  chmod,
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
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { getConfigRoot } from '../../lib/utils'
import { SHERPA_MODULE_ROOT_ENV } from './speech-worker-protocol'
import { Logger } from '../system/logger'
import type { SpeechSherpaRuntimeStatus } from '../../lib/speech/types'

/**
 * Provisioning of the sherpa-onnx platform binary.
 *
 * `sherpa-onnx-node` is a thin JavaScript wrapper over a native addon plus two
 * dynamic libraries (onnxruntime is 28 MB of that). Every package used to carry
 * one platform's copy whether or not the user ever selected a sherpa model, and
 * on macOS the recommended runtime is Core ML, so most installs never touched
 * it. It is provisioned at runtime instead:
 *
 * 1. **Download.** The pinned npm package for this machine is fetched from the
 *    registry, verified against its published integrity, and unpacked into the
 *    app config root.
 * 2. **Pair.** The wrapper that ships with the app (`sherpa-onnx-node`, about
 *    108 KB of JavaScript) is copied next to it, so the wrapper's own
 *    `../sherpa-onnx-<platform>/sherpa-onnx.node` lookup resolves inside the
 *    provisioned tree. That is why the engine loads through
 *    `createRequire(<runtime>/package.json)` rather than the app's module root.
 *
 * The addon links its libraries through `@loader_path`, so unpacking the whole
 * platform package next to the wrapper keeps the dylib resolution working.
 */

const SHERPA_VERSION = '2.0.1'

/** Registry packages for every platform this app can run on. */
const PLATFORM_PACKAGES: Readonly<Record<string, { name: string; integrity: string }>> = {
  'darwin-arm64': {
    name: 'sherpa-onnx-darwin-arm64',
    integrity:
      'sha512-agXmbbwiVPUSMViMhWhYAt59iG21ui7x6HxQFU35XzHOfQe9x6Pg9V160Pzak/66x0ePMjixsLUtMaaUrLfCwQ=='
  },
  'darwin-x64': {
    name: 'sherpa-onnx-darwin-x64',
    integrity:
      'sha512-SBnHa3LDOSI/5/rpBHGxKQDFq+yIdxowYY0InLzfojTUx+yGgqu7cYBrRxjzvHOiOKi0O4rmlFVZboyhIqpDgA=='
  },
  'linux-x64': {
    name: 'sherpa-onnx-linux-x64',
    integrity:
      'sha512-w5mRRrIvPvcNWac7rQ8AN/t/cwElPGoRpH+ceCRBV7XfjCIQ9Rcr3Ig/kXcJLNOxgK4bGmef+Y47lIWiesDODw=='
  },
  'linux-arm64': {
    name: 'sherpa-onnx-linux-arm64',
    integrity:
      'sha512-5CJvLjFYIg23oELCsT7l07fMLT3PdquZ3tqh7KZK3Pzi+c2YiPKRe1DDUxoNdtCaw3ZiS4aQSQPBblB9JStuDA=='
  },
  'win-x64': {
    name: 'sherpa-onnx-win-x64',
    integrity:
      'sha512-7vwdAw9PGEb0JLSpK7UFxAdp1vabBHK9Nhw2jFRBWSFgtslUPHIB0T6syJfRgiUGyCeNW9fJvcFAk2F2u7hBEw=='
  },
  'win-arm64': {
    name: 'sherpa-onnx-win-arm64',
    integrity:
      'sha512-Mb9iqy2Zp7GC5a99dk5E8EQJsEBnapf+IcwHLVCgtIf5mxYHO9Q8YptnAoOHZOD0Zi+R+MblFyG9qv0Q6tin4Q=='
  },
  'win-ia32': {
    name: 'sherpa-onnx-win-ia32',
    integrity:
      'sha512-q7qFCA3FK+tYc8pexC9Kzu9WGGoZ9X//UkpxVp6iT4E4W5tPhOEirPyvawS6zgfEW6K/GOISMcYe996Yc7d6iw=='
  }
}

/** A download cannot legitimately exceed this. */
const TARBALL_CEILING_BYTES = 512 * 1024 * 1024

const WRAPPER_PACKAGE_NAME = 'sherpa-onnx-node'
const ADDON_FILE_NAME = 'sherpa-onnx.node'
const REGISTRY_BASE = 'https://registry.npmjs.org'

function platformKey(): string {
  const platform = process.platform === 'win32' ? 'win' : process.platform
  return `${platform}-${process.arch}`
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

/**
 * Resolves and installs the sherpa-onnx platform binary on demand.
 *
 * Constructed with the directory of the bundled `sherpa-onnx-node` wrapper;
 * everything it provisions lives under the app configuration root.
 */
export class SherpaRuntime {
  private statusCache: SpeechSherpaRuntimeStatus | null = null
  private preparing: Promise<string> | null = null
  private preparedModuleRoot: string | null = null
  private lastFailure: string | null = null

  constructor(
    private readonly wrapperSource: string,
    private readonly root = join(getConfigRoot(), 'speech', 'runtime', 'sherpa')
  ) {}

  /** The registry package this machine needs, or null when none exists. */
  platformPackage(): { name: string; integrity: string } | null {
    return PLATFORM_PACKAGES[platformKey()] ?? null
  }

  /** Why the engine could not be prepared on the last attempt, when it failed. */
  unavailableReason(): string | null {
    return this.lastFailure
  }

  runtimeDirectory(): string {
    const platform = this.platformPackage()
    return platform ? join(this.root, `${SHERPA_VERSION}-${platform.name}`) : this.root
  }

  /** The module root to resolve `sherpa-onnx-node` from. */
  moduleRoot(): string {
    return join(this.runtimeDirectory(), 'node_modules')
  }

  async status(force = false): Promise<SpeechSherpaRuntimeStatus> {
    if (!force && this.statusCache) return this.statusCache
    const platform = this.platformPackage()
    const base = {
      runtimeDirectory: this.runtimeDirectory(),
      version: SHERPA_VERSION,
      ...(platform ? { packageName: platform.name, downloadName: platform.name } : {})
    } as const
    if (!platform) {
      this.statusCache = {
        ...base,
        supported: false,
        available: false,
        prepared: false,
        downloadRequired: false
      }
      return this.statusCache
    }
    const prepared = await this.isPrepared()
    this.statusCache = {
      ...base,
      supported: true,
      available: prepared,
      prepared,
      downloadRequired: !prepared,
      ...(this.lastFailure ? { unavailableReason: this.lastFailure } : {})
    }
    return this.statusCache
  }

  /**
   * Make the engine usable and return the module root to resolve from.
   *
   * Never downloads: an absent engine is the caller's cue to offer the
   * download, exactly like the MLX engine.
   */
  async prepare(signal?: AbortSignal): Promise<string> {
    const platform = this.platformPackage()
    if (!platform) throw new Error('The sherpa-onnx engine has no build for this platform.')
    if (this.preparedModuleRoot) return this.preparedModuleRoot
    if (this.preparing) return this.preparing
    this.preparing = this.materialize(platform.name, signal)
      .then((moduleRoot) => {
        this.preparedModuleRoot = moduleRoot
        this.lastFailure = null
        this.statusCache = null
        return moduleRoot
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

  /** Provision the engine for a model download: fetch it when it is missing. */
  async ensure(signal?: AbortSignal): Promise<SpeechSherpaRuntimeStatus> {
    const platform = this.platformPackage()
    if (!platform) throw new Error('The sherpa-onnx engine has no build for this platform.')
    if (this.preparedModuleRoot) return this.status()
    if (!(await this.isPrepared())) await this.download(signal)
    await this.prepare(signal)
    return this.status(true)
  }

  /**
   * Download the pinned platform package and install it under the runtime root.
   *
   * The caller owns consent; this fails closed on integrity mismatch and never
   * leaves a partial installation behind.
   */
  async download(signal?: AbortSignal): Promise<SpeechSherpaRuntimeStatus> {
    const platform = this.platformPackage()
    if (!platform) throw new Error('The sherpa-onnx engine has no build for this platform.')
    const staging = join(this.root, 'staging')
    const tarball = join(staging, `${platform.name}-${SHERPA_VERSION}.tgz`)
    const extracted = join(staging, 'package')
    await mkdir(staging, { recursive: true })
    try {
      await this.fetchVerified(platform.name, platform.integrity, tarball, signal)
      await rm(extracted, { recursive: true, force: true })
      await this.extract(tarball, staging)
      const moduleDirectory = join(this.moduleRoot(), platform.name)
      await rm(moduleDirectory, { recursive: true, force: true })
      await mkdir(dirname(moduleDirectory), { recursive: true })
      await rename(extracted, moduleDirectory)
      if (!(await isFile(join(moduleDirectory, ADDON_FILE_NAME)))) {
        await rm(moduleDirectory, { recursive: true, force: true })
        throw new Error('The sherpa-onnx download contained no native addon.')
      }
      await this.installWrapper()
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    }
    this.preparedModuleRoot = null
    this.statusCache = null
    await this.prepare()
    Logger.info('Installed the sherpa-onnx engine', {
      path: join(this.moduleRoot(), platform.name)
    })
    return this.status(true)
  }

  /** Remove only the app-managed engine copy. */
  async removeManaged(): Promise<void> {
    await rm(this.runtimeDirectory(), { recursive: true, force: true }).catch(() => undefined)
    this.preparedModuleRoot = null
    this.statusCache = null
  }

  private async isPrepared(): Promise<boolean> {
    const platform = this.platformPackage()
    if (!platform) return false
    const moduleRoot = this.moduleRoot()
    const addon = join(moduleRoot, platform.name, ADDON_FILE_NAME)
    const wrapper = join(moduleRoot, WRAPPER_PACKAGE_NAME, 'package.json')
    return (await isFile(addon)) && (await isFile(wrapper))
  }

  private async materialize(platformName: string, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new Error('Speech operation cancelled.')
    const addon = join(this.moduleRoot(), platformName, ADDON_FILE_NAME)
    if (!(await isFile(addon))) {
      throw new Error(
        'The sherpa-onnx engine is not installed yet. Downloading a sherpa-onnx model installs it.'
      )
    }
    await this.installWrapper()
    return this.moduleRoot()
  }

  /**
   * Copy the bundled wrapper beside the provisioned platform package.
   *
   * A copy, not a link: the wrapper ships inside `app.asar`, which is a virtual
   * read-only archive, so it cannot be hard-linked. It is 108 KB of JavaScript,
   * which makes the copy free next to a 32 MB native package.
   */
  private async installWrapper(): Promise<void> {
    const target = join(this.moduleRoot(), WRAPPER_PACKAGE_NAME)
    await rm(target, { recursive: true, force: true })
    await copyDirectory(this.wrapperSource, target)
  }

  private async fetchVerified(
    packageName: string,
    expectedIntegrity: string,
    targetPath: string,
    signal?: AbortSignal
  ): Promise<void> {
    const url = `${REGISTRY_BASE}/${packageName}/-/${packageName}-${SHERPA_VERSION}.tgz`
    const response = await fetch(url, { ...(signal ? { signal } : {}) })
    if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}).`)
    const hash = createHash('sha512')
    let received = 0
    const reader = response.body.getReader()
    const handle = await open(targetPath, 'w')
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        if (received > TARBALL_CEILING_BYTES) {
          throw new Error('The sherpa-onnx download exceeded the expected size.')
        }
        hash.update(value)
        await handle.write(value)
      }
    } finally {
      await handle.close()
    }
    const integrity = `sha512-${hash.digest('base64')}`
    if (integrity !== expectedIntegrity) {
      await rm(targetPath, { force: true }).catch(() => undefined)
      throw new Error('The sherpa-onnx download failed its integrity verification.')
    }
  }

  /** System `tar` handles `.tgz` on macOS, Linux, and Windows 10+. */
  private extract(archivePath: string, targetDirectory: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn('tar', ['-xzf', archivePath, '-C', targetDirectory], {
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

/** Recursive copy that reads through Electron's asar-aware `fs` and writes plainly. */
async function copyDirectory(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(destination, entry.name)
    if (entry.isDirectory()) {
      await copyDirectory(from, to)
      continue
    }
    if (!entry.isFile()) continue
    await writeFile(to, await readFile(from))
    await chmod(to, 0o644).catch(() => undefined)
  }
}

/**
 * Locate the bundled `sherpa-onnx-node` wrapper from the running bundle, so the
 * runtime can copy it into the provisioned tree.
 */
export function bundledSherpaWrapper(): string {
  const require = createRequire(import.meta.url)
  return dirname(require.resolve(WRAPPER_PACKAGE_NAME))
}

/** The pinned engine identity, exported so diagnostics and tests share one source. */
export const SHERPA_RUNTIME_PINNED = {
  version: SHERPA_VERSION,
  packages: PLATFORM_PACKAGES,
  wrapperPackageName: WRAPPER_PACKAGE_NAME,
  addonFileName: ADDON_FILE_NAME
} as const

/** Re-exported so the engine and its backend share one variable name. */
export { SHERPA_MODULE_ROOT_ENV }
