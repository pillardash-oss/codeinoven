/**
 * Shared build plumbing for the bundled Apple Silicon speech workers.
 *
 * `mlx-worker`, `coreml-worker`, and `speech-capture-worker` are compiled from
 * the Swift packages under `resources/speech/` into
 * `resources/speech/runtime/<platform>-<arch>/`, which is gitignored. Without
 * reuse every checkout   the project root and every managed Git worktree  
 * compiles the same ~170 MB of artifacts again in `predev`, and the MLX worker
 * additionally needs the separately installed Xcode Metal toolchain, so a fresh
 * worktree could not start at all on a Mac missing that component.
 *
 * Every worker therefore resolves through the same three steps, cheapest first:
 *
 * 1. **Installed and current.** A small state file records which source
 *    revision produced what sits in the runtime directory, so an untouched
 *    checkout does no work beyond hashing a few hundred kilobytes of Swift.
 * 2. **Shared cache hit.** Artifacts are cached by the content hash of their
 *    package sources under the machine-local config root, so a second checkout
 *    with identical sources installs the compiled artifact instead of compiling
 *    it.
 * 3. **Compile.** A real miss compiles, then publishes the result for every
 *    other checkout. The toolchain is preflighted first, so a missing
 *    prerequisite reports itself instead of surfacing as SwiftPM's misleading
 *    "CompileMetalFile ... failed" / "could not read serialized diagnostics
 *    file" cascade.
 *
 * Keys are content-based but deliberately exclude the compiler toolchain: the
 * cache is machine-local and never distributed, so any entry is runnable on the
 * machine that wrote it, and identical sources do not recompile after an Xcode
 * update.
 *
 * The cache root is the shared config root on purpose. It is machine-local
 * build output, so an instance started with its own `CODEINOVEN_CONFIG_ROOT`
 * still reuses the same entries; `getConfigRoot()` resolves that shared root
 * here because these build scripts run under Bun, where `process.defaultApp` is
 * undefined and the development override is not an Electron launch.
 */
import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { getConfigRoot } from '../../src/lib/utils'
import { Logger } from '../../src/main/system/logger'

/** Bumped when the cache layout or key composition changes. */
const CACHE_FORMAT_VERSION = 'v1'

/** How many source revisions of one worker the cache keeps at once. */
const CACHE_ENTRIES_PER_WORKER = 2

/** Abandoned staging directories older than this are swept on the next publish. */
const STAGING_SWEEP_AGE_MS = 60 * 60 * 1000

/** One compilable speech worker package. */
export interface SpeechWorkerPackage {
  /** Human-readable name used in logs and errors, e.g. `MLX speech worker`. */
  readonly label: string
  /** Stable cache namespace and state-file name, e.g. `mlx-worker`. */
  readonly cacheName: string
  /** SwiftPM package directory, the one holding `Package.swift`. */
  readonly packageDirectory: string
  /** SwiftPM product name, which is also the installed executable name. */
  readonly product: string
  /** Gitignored SwiftPM scratch directory for this worker. */
  readonly scratchDirectory: string
  /**
   * Whether compiling this package needs the separable Xcode Metal toolchain
   * (mlx-swift compiles Metal kernels through its `Cmlx` target).
   */
  readonly requiresMetalToolchain?: boolean
}

/** How a worker or asset was resolved. */
export type SpeechWorkerOutcome = 'local' | 'cache' | 'built'

export interface ResolvedSpeechWorker {
  readonly outcome: SpeechWorkerOutcome
  /** Content key of the resolved artifact. */
  readonly key: string
  /** Installed executable inside the runtime directory. */
  readonly artifactPath: string
}

/** How a produced asset was resolved. */
export type CachedAssetOutcome = 'local' | 'cache' | 'produced'

/** One artifact to install into the runtime directory. */
interface ArtifactTransfer {
  /** File name, identical in the runtime directory and inside a cache entry. */
  readonly name: string
  /** Absolute destination inside the runtime directory. */
  readonly destination: string
  /** Install with the executable bit set. */
  readonly executable?: boolean
}

interface InstalledArtifact {
  readonly name: string
  readonly size: number
}

/** Which source revision produced the artifacts currently installed. */
interface InstalledState {
  readonly key: string
  readonly artifacts: readonly InstalledArtifact[]
}

interface ProbeResult {
  readonly ok: boolean
  readonly output: string
}

/** Whether this machine can compile and run the bundled speech workers. */
export function speechWorkersSupportedHere(): boolean {
  return process.platform === 'darwin' && process.arch === 'arm64'
}

/** Directory the compiled workers are installed into for this target. */
export function speechRuntimeDirectory(projectRoot: string): string {
  return join(projectRoot, 'resources', 'speech', 'runtime', `${process.platform}-${process.arch}`)
}

/**
 * Ensure the worker executable is installed, reusing a previous build whenever
 * the package sources are unchanged.
 */
export async function ensureSpeechWorker(
  projectRoot: string,
  worker: SpeechWorkerPackage
): Promise<ResolvedSpeechWorker> {
  const runtimeDirectory = speechRuntimeDirectory(projectRoot)
  const artifactPath = join(runtimeDirectory, worker.product)
  const statePath = installedStatePath(projectRoot, worker.cacheName)
  const key = await computeSpeechWorkerKey(worker)
  const transfers: ArtifactTransfer[] = [
    { name: worker.product, destination: artifactPath, executable: true }
  ]

  const installed = await readInstalledState(statePath)
  if (installed?.key === key && (await installedArtifactsExist(runtimeDirectory, installed))) {
    Logger.dev(`[speech-build] ${worker.label} is current (${shortKey(key)}).`)
    return { outcome: 'local', key, artifactPath }
  }

  await mkdir(runtimeDirectory, { recursive: true })

  const cacheDirectory = cacheEntryDirectory(worker.cacheName, key)
  if (await installFromCache(cacheDirectory, transfers, worker)) {
    await writeInstalledState(statePath, runtimeDirectory, key, transfers)
    Logger.info(
      `[speech-build] ${worker.label}: installed the cached build ${shortKey(key)}, no recompile.`
    )
    return { outcome: 'cache', key, artifactPath }
  }

  // One-time adoption: artifacts compiled before this cache existed carry no
  // state file. They were accepted by the same "newer than every source" rule
  // the previous scripts used, so they seed the cache instead of being thrown
  // away and compiled again.
  if (installed === null && (await legacyArtifactIsFresh(artifactPath, worker.packageDirectory))) {
    await writeInstalledState(statePath, runtimeDirectory, key, transfers)
    await publishToCache(
      worker.cacheName,
      worker.label,
      cacheDirectory,
      transfers,
      runtimeDirectory
    )
    Logger.info(`[speech-build] ${worker.label}: adopted the existing build into the cache.`)
    return { outcome: 'local', key, artifactPath }
  }

  await assertSwiftToolchain(worker)
  Logger.info(`[speech-build] ${worker.label}: compiling ${shortKey(key)}, no reusable build.`)
  await runSwiftBuild(worker)
  await installArtifact(await findCompiledProduct(worker), artifactPath, true)
  await writeInstalledState(statePath, runtimeDirectory, key, transfers)
  await publishToCache(worker.cacheName, worker.label, cacheDirectory, transfers, runtimeDirectory)
  return { outcome: 'built', key, artifactPath }
}

/**
 * Ensure a downloaded artifact is installed, reusing the cache before doing any
 * network or extraction work. The MLX Metal library is resolved through this
 * path so that losing it never forces the worker binary to be recompiled.
 */
export async function ensureCachedAsset(
  projectRoot: string,
  options: {
    /** Human-readable name used in logs, e.g. `MLX Metal library`. */
    readonly label: string
    /** Stable cache namespace, e.g. `mlx-metal`. */
    readonly cacheName: string
    /** Cache key, e.g. the pinned digest of the archive the artifact comes from. */
    readonly cacheKey: string
    /** File name in the runtime directory and inside a cache entry. */
    readonly artifactName: string
    /** Absolute destination inside the runtime directory. */
    readonly destination: string
    /**
     * Whether a file already sitting at the destination may be trusted. Set for
     * artifacts that are only ever installed from a checksum-verified download,
     * where the pinned digest is the cache key itself.
     */
    readonly adoptExistingDestination?: boolean
    /** Produce the artifact on a miss; returns the path to install from. */
    readonly produce: () => Promise<string>
  }
): Promise<CachedAssetOutcome> {
  const runtimeDirectory = speechRuntimeDirectory(projectRoot)
  const statePath = installedStatePath(projectRoot, options.cacheName)
  const transfers: ArtifactTransfer[] = [
    { name: options.artifactName, destination: options.destination }
  ]

  const installed = await readInstalledState(statePath)
  if (
    installed?.key === options.cacheKey &&
    (await installedArtifactsExist(runtimeDirectory, installed))
  ) {
    Logger.dev(`[speech-build] ${options.label} is current.`)
    return 'local'
  }

  await mkdir(runtimeDirectory, { recursive: true })

  const cacheDirectory = cacheEntryDirectory(options.cacheName, options.cacheKey)
  if (await installFromCache(cacheDirectory, transfers, { label: options.label })) {
    await writeInstalledState(statePath, runtimeDirectory, options.cacheKey, transfers)
    Logger.info(`[speech-build] ${options.label}: installed the cached copy, nothing downloaded.`)
    return 'cache'
  }

  if (
    installed === null &&
    options.adoptExistingDestination === true &&
    (await stat(options.destination).catch(() => null))?.isFile()
  ) {
    await writeInstalledState(statePath, runtimeDirectory, options.cacheKey, transfers)
    await publishToCache(
      options.cacheName,
      options.label,
      cacheDirectory,
      transfers,
      runtimeDirectory
    )
    Logger.info(`[speech-build] ${options.label}: adopted the existing file into the cache.`)
    return 'local'
  }

  await installArtifact(await options.produce(), options.destination, false)
  await writeInstalledState(statePath, runtimeDirectory, options.cacheKey, transfers)
  await publishToCache(
    options.cacheName,
    options.label,
    cacheDirectory,
    transfers,
    runtimeDirectory
  )
  return 'produced'
}

/** Machine-local cache root shared by every checkout (see the module header). */
function speechBuildCacheRoot(): string {
  return join(getConfigRoot(), 'build-cache', 'speech-workers', CACHE_FORMAT_VERSION)
}

function cacheEntryDirectory(cacheName: string, key: string): string {
  return join(speechBuildCacheRoot(), cacheName, key)
}

function installedStatePath(projectRoot: string, cacheName: string): string {
  return join(projectRoot, '.cio', 'tmp', 'speech-worker-state', `${cacheName}.json`)
}

/**
 * Content key for a worker: every file SwiftPM compiles from, plus the target it
 * compiles for.
 */
async function computeSpeechWorkerKey(worker: SpeechWorkerPackage): Promise<string> {
  const digest = createHash('sha256')
  digest.update(`speech-worker-cache-${CACHE_FORMAT_VERSION}\n`)
  digest.update(`${process.platform}-${process.arch}\n`)
  digest.update(`${worker.cacheName}\n${worker.product}\n`)
  for (const relativePath of await listPackageSources(worker.packageDirectory)) {
    digest.update(`${relativePath}\n`)
    digest.update(await readFile(join(worker.packageDirectory, relativePath)))
    digest.update('\n')
  }
  return digest.digest('hex')
}

/**
 * Files that decide a build, as sorted package-relative paths: `Package.swift`,
 * `Package.resolved` when the package pins one, and everything under `Sources/`.
 */
async function listPackageSources(packageDirectory: string): Promise<string[]> {
  const paths: string[] = []
  for (const manifest of ['Package.swift', 'Package.resolved']) {
    if ((await stat(join(packageDirectory, manifest)).catch(() => null))?.isFile()) {
      paths.push(manifest)
    }
  }
  await collectSourceFiles(packageDirectory, 'Sources', paths)
  return paths.sort()
}

async function collectSourceFiles(
  packageDirectory: string,
  relativeDirectory: string,
  paths: string[]
): Promise<void> {
  const entries = await readdir(join(packageDirectory, relativeDirectory), {
    withFileTypes: true
  }).catch(() => [])
  for (const entry of entries) {
    const relativePath = `${relativeDirectory}/${entry.name}`
    if (entry.isDirectory()) await collectSourceFiles(packageDirectory, relativePath, paths)
    else if (entry.isFile()) paths.push(relativePath)
  }
}

async function readInstalledState(statePath: string): Promise<InstalledState | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(statePath, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const candidate = parsed as { key?: unknown; artifacts?: unknown }
    if (typeof candidate.key !== 'string' || !Array.isArray(candidate.artifacts)) return null
    const artifacts: InstalledArtifact[] = []
    for (const entry of candidate.artifacts) {
      const record = entry as { name?: unknown; size?: unknown }
      if (typeof record.name !== 'string' || typeof record.size !== 'number') return null
      artifacts.push({ name: record.name, size: record.size })
    }
    return { key: candidate.key, artifacts }
  } catch {
    // A missing or unreadable state file simply means "unknown revision".
    return null
  }
}

async function installedArtifactsExist(
  runtimeDirectory: string,
  state: InstalledState
): Promise<boolean> {
  for (const artifact of state.artifacts) {
    const details = await stat(join(runtimeDirectory, artifact.name)).catch(() => null)
    if (!details?.isFile() || details.size !== artifact.size) return false
  }
  return state.artifacts.length > 0
}

/** Record which key produced the artifacts that now sit in the runtime directory. */
async function writeInstalledState(
  statePath: string,
  runtimeDirectory: string,
  key: string,
  transfers: readonly ArtifactTransfer[]
): Promise<void> {
  const artifacts: InstalledArtifact[] = []
  for (const transfer of transfers) {
    const details = await stat(join(runtimeDirectory, transfer.name)).catch(() => null)
    // Never claim a revision whose artifacts are not all on disk.
    if (!details?.isFile()) return
    artifacts.push({ name: transfer.name, size: details.size })
  }
  await mkdir(dirname(statePath), { recursive: true })
  await writeFile(statePath, `${JSON.stringify({ key, artifacts }, null, 2)}\n`, 'utf8')
}

/** The pre-cache freshness rule: installed output newer than every source file. */
async function legacyArtifactIsFresh(
  artifactPath: string,
  packageDirectory: string
): Promise<boolean> {
  const artifact = await stat(artifactPath).catch(() => null)
  if (!artifact?.isFile()) return false
  let newestSource: number | null = null
  for (const relativePath of await listPackageSources(packageDirectory)) {
    const details = await stat(join(packageDirectory, relativePath)).catch(() => null)
    if (details && (newestSource === null || details.mtimeMs > newestSource)) {
      newestSource = details.mtimeMs
    }
  }
  return newestSource !== null && artifact.mtimeMs >= newestSource
}

/**
 * Copy every requested artifact out of a cache entry. Returns `false` when any
 * of them is absent, which is a plain miss; the caller compiles or downloads.
 */
async function installFromCache(
  cacheDirectory: string,
  transfers: readonly ArtifactTransfer[],
  worker: { readonly label: string }
): Promise<boolean> {
  for (const transfer of transfers) {
    const details = await stat(join(cacheDirectory, transfer.name)).catch(() => null)
    if (!details?.isFile()) return false
  }
  try {
    for (const transfer of transfers) {
      await installArtifact(
        join(cacheDirectory, transfer.name),
        transfer.destination,
        transfer.executable === true
      )
    }
    return true
  } catch (error) {
    // A concurrent prune or a short read is a miss, never a failure.
    Logger.dev(`[speech-build] ${worker.label}: cache install failed (${describeError(error)}).`)
    return false
  }
}

/** Copy one file into place through a rename, so a running instance never sees a torn artifact. */
async function installArtifact(
  source: string,
  destination: string,
  executable: boolean
): Promise<void> {
  const stagingPath = `${destination}.${randomBytes(6).toString('hex')}.staging`
  await mkdir(dirname(destination), { recursive: true })
  try {
    await copyFile(source, stagingPath)
    if (executable) await chmod(stagingPath, 0o755)
    await rename(stagingPath, destination)
  } catch (error) {
    // Never leave a partial file inside the runtime directory: electron-builder
    // copies it verbatim into the packaged application.
    await rm(stagingPath, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * Store the installed artifacts under their key, then keep only the newest
 * entries for that worker so the cache cannot grow without bound.
 */
async function publishToCache(
  cacheName: string,
  label: string,
  cacheDirectory: string,
  transfers: readonly ArtifactTransfer[],
  runtimeDirectory: string
): Promise<boolean> {
  const stagingDirectory = `${cacheDirectory}.${randomBytes(6).toString('hex')}.staging`
  try {
    await mkdir(stagingDirectory, { recursive: true })
    for (const transfer of transfers) {
      const installedPath = join(runtimeDirectory, transfer.name)
      const details = await stat(installedPath).catch(() => null)
      if (!details?.isFile()) throw new Error(`missing ${transfer.name}`)
      await copyFile(installedPath, join(stagingDirectory, transfer.name))
    }
    await mkdir(dirname(cacheDirectory), { recursive: true })
    if ((await stat(cacheDirectory).catch(() => null))?.isDirectory()) {
      await rm(stagingDirectory, { recursive: true, force: true })
    } else {
      await rename(stagingDirectory, cacheDirectory)
      Logger.dev(`[speech-build] cached ${label} as ${shortKey(basename(cacheDirectory))}.`)
    }
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true })
    Logger.dev(`[speech-build] could not cache ${label}: ${describeError(error)}`)
    return false
  }
  await pruneCacheEntries(cacheName, cacheDirectory)
  return true
}

/** Keep the entry just written plus the most recent others, never unbounded. */
async function pruneCacheEntries(cacheName: string, keepDirectory: string): Promise<void> {
  const namespaceDirectory = join(speechBuildCacheRoot(), cacheName)
  const entries = await readdir(namespaceDirectory, { withFileTypes: true }).catch(() => [])
  const candidates: { path: string; mtimeMs: number }[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const path = join(namespaceDirectory, entry.name)
    if (path === keepDirectory) continue
    const details = await stat(path).catch(() => null)
    if (!details) continue
    // A staging directory belongs to a publish in flight, or to one that was
    // killed; only sweep the abandoned ones, so a concurrent publish survives.
    if (entry.name.endsWith('.staging')) {
      if (Date.now() - details.mtimeMs > STAGING_SWEEP_AGE_MS) {
        await rm(path, { recursive: true, force: true }).catch(() => undefined)
      }
      continue
    }
    candidates.push({ path, mtimeMs: details.mtimeMs })
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)
  for (const stale of candidates.slice(CACHE_ENTRIES_PER_WORKER - 1)) {
    await rm(stale.path, { recursive: true, force: true }).catch(() => undefined)
    Logger.dev(`[speech-build] pruned the stale cached build ${shortKey(basename(stale.path))}.`)
  }
}

/**
 * Fail with the real cause and the fix when this machine cannot compile the
 * package, instead of letting SwiftPM report a Metal toolchain gap as
 * "CompileMetalFile ... failed with a nonzero exit code".
 */
async function assertSwiftToolchain(worker: SpeechWorkerPackage): Promise<void> {
  const swift = await runProbe('/usr/bin/swift', ['--version'])
  if (!swift.ok) {
    throw new Error(
      [
        `${worker.label} needs a Swift toolchain, which this Mac does not have.`,
        'Install Xcode, or the Command Line Tools, and run the build again:',
        '  xcode-select --install',
        `Probe output: ${swift.output || '(none)'}`
      ].join('\n')
    )
  }
  if (worker.requiresMetalToolchain !== true) return

  const metal = await runProbe('/usr/bin/xcrun', ['-sdk', 'macosx', 'metal', '--version'])
  if (!metal.ok) {
    throw new Error(
      [
        `${worker.label} needs the Xcode Metal toolchain, which this Mac does not have.`,
        'Xcode ships it as a separate component. Install it once and run the build again:',
        '  xcodebuild -downloadComponent MetalToolchain',
        `Probe output: ${metal.output || '(none)'}`
      ].join('\n')
    )
  }
}

function runProbe(command: string, args: readonly string[]): Promise<ProbeResult> {
  return new Promise((resolve) => {
    execFile(command, [...args], { encoding: 'utf8', timeout: 30_000 }, (error, stdout, stderr) => {
      resolve({ ok: error === null, output: `${stdout}${stderr}`.trim() })
    })
  })
}

/** Compile the package with the same bounded parallelism the scripts always used. */
async function runSwiftBuild(worker: SpeechWorkerPackage): Promise<void> {
  await mkdir(worker.scratchDirectory, { recursive: true })
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      '/usr/bin/swift',
      [
        'build',
        '--package-path',
        worker.packageDirectory,
        '--scratch-path',
        worker.scratchDirectory,
        '--configuration',
        'release',
        '--product',
        worker.product,
        '--jobs',
        '2'
      ],
      { stdio: 'inherit' }
    )
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${worker.label} compilation exited with code ${code ?? 'unknown'}.`))
    })
  })
}

/**
 * Locate the executable SwiftPM produced, across the build-system layouts in use.
 *
 * The scratch directory can hold artifacts from more than one layout: a newer
 * SwiftPM writes `out/Products/Release/<product>` while an earlier build left
 * `<arch>-apple-macosx/release/<product>` behind. Taking the first path that
 * exists installed the stale binary and silently discarded the build that had
 * just run, which is how a shipped native fix never reached the app. The newest
 * candidate is the one this build produced.
 */
async function findCompiledProduct(worker: SpeechWorkerPackage): Promise<string> {
  const candidates = [
    join(worker.scratchDirectory, `${process.arch}-apple-macosx`, 'release', worker.product),
    join(worker.scratchDirectory, 'release', worker.product),
    join(worker.scratchDirectory, 'out', 'Products', 'Release', worker.product)
  ]
  let newest: { path: string; mtimeMs: number } | null = null
  for (const candidate of candidates) {
    const details = await stat(candidate).catch(() => null)
    if (!details?.isFile()) continue
    if (newest === null || details.mtimeMs > newest.mtimeMs) {
      newest = { path: candidate, mtimeMs: details.mtimeMs }
    }
  }
  if (newest === null) throw new Error(`SwiftPM did not produce ${worker.product}.`)
  return newest.path
}

function shortKey(key: string): string {
  return key.slice(0, 12)
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
