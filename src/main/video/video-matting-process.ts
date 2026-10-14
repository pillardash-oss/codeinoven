import { open, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

type MattingModel = 'modnet' | 'ben2-base'

interface MattingRequest {
  source: string
  output: string
  /** Model cache directory, under the app config root's `video/models`. */
  cache: string
  /** Installed video pack root; the four packages resolve from here. */
  packages: string
  model: MattingModel
}
interface EnginePort {
  postMessage: (message: unknown) => void
  on: (event: 'message', listener: (message: { data: unknown }) => void) => unknown
}
const parentPort = (process as NodeJS.Process & { parentPort?: EnginePort }).parentPort
const controller = new AbortController()
let lastProgressAt = 0
function report(progress: number, stage: string): void {
  const now = Date.now()
  if (now - lastProgressAt < 200) return
  lastProgressAt = now
  parentPort?.postMessage({ type: 'progress', progress, stage })
}

/**
 * The loader surfaces this process needs from the runtime-installed pack.
 *
 * Declared locally so this worker never imports the packages statically: they
 * are not shipped, and the electron-vite build must not try to bundle them.
 */
interface TransformersModule {
  env: { cacheDir: string }
}
interface MediabunnyServerModule {
  registerMediabunnyServer: () => void
}
interface VideoMattingProgress {
  progress?: number
  stage?: string
}
interface MattingLayer {
  dispose: () => Promise<void> | void
}
interface VideoMattingModule {
  canUseVideoMatting: (options: {
    model: MattingModel
  }) => Promise<{ supported: boolean; detailedReason?: string }>
  downloadVideoMattingModel: (options: {
    model: MattingModel
    signal: AbortSignal
    onProgress: () => void
  }) => Promise<void>
  separateVideoLayers: (options: {
    src: string
    model: MattingModel
    audio: 'none'
    outputs: {
      base: { outputWritable: WritableStream<{ data: Uint8Array; position: number }> }
      foreground: { outputWritable: WritableStream<{ data: Uint8Array; position: number }> }
    }
    signal: AbortSignal
    onProgress: (progress: VideoMattingProgress) => void
  }) => Promise<{ base: MattingLayer; foreground: MattingLayer }>
  disposeVideoMattingModel: (options: { model: MattingModel }) => Promise<void> | void
}

interface PackageManifest {
  main?: string
  module?: string
  exports?: unknown
}

/** Follow one `exports` condition chain, preferring the Node ESM branch. */
function pickCondition(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  return (
    pickCondition(record['node']) ??
    pickCondition(record['import']) ??
    pickCondition(record['module']) ??
    pickCondition(record['default'])
  )
}

/** The `.` export entry, or the root condition map when `exports` has no `.` key. */
function pickExportEntry(exportsField: unknown): string | null {
  if (typeof exportsField === 'string') return exportsField
  if (!exportsField || typeof exportsField !== 'object') return null
  const record = exportsField as Record<string, unknown>
  const hasRootEntry = Object.keys(record).some((key) => !key.startsWith('.'))
  const root = record['.'] ?? (hasRootEntry ? record : undefined)
  return pickCondition(root)
}

/**
 * Resolve one installed package to its ESM entry file.
 *
 * `createRequire(...).resolve()` cannot be used here: it follows the `require`
 * condition, and `@remotion/video-matting` exports an `import` condition only,
 * while `@mediabunny/server`'s CommonJS bundle hides its named exports from
 * `import()`. Reading the manifest and following the Node/import ESM entry is
 * what a bare `import('<pkg>')` resolved to before the pack became optional.
 */
async function resolvePackageEntry(packagesDir: string, name: string): Promise<string> {
  const packageDir = join(packagesDir, 'node_modules', ...name.split('/'))
  let manifest: PackageManifest
  try {
    const raw: unknown = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
    if (typeof raw !== 'object' || raw === null) throw new Error('manifest is not an object')
    manifest = raw as PackageManifest
  } catch (cause) {
    throw new Error(
      `The video pack package ${name} is missing. Install the optional video pack in Settings > Design and video.`,
      { cause }
    )
  }
  const relative = pickExportEntry(manifest.exports) ?? manifest.module ?? manifest.main
  if (!relative) throw new Error(`The video pack package ${name} has no loadable entry.`)
  return join(packageDir, relative)
}

async function loadPackage<T>(packagesDir: string, name: string): Promise<T> {
  const entry = await resolvePackageEntry(packagesDir, name)
  return (await import(pathToFileURL(entry).href)) as T
}

/** GPU inference and positional encoding writes never run on Electron main. */
async function matte(request: MattingRequest): Promise<{ files: string[] }> {
  const { env } = await loadPackage<TransformersModule>(
    request.packages,
    '@huggingface/transformers'
  )
  env.cacheDir = request.cache
  await mkdir(request.cache, { recursive: true })
  const { registerMediabunnyServer } = await loadPackage<MediabunnyServerModule>(
    request.packages,
    '@mediabunny/server'
  )
  const {
    canUseVideoMatting,
    downloadVideoMattingModel,
    separateVideoLayers,
    disposeVideoMattingModel
  } = await loadPackage<VideoMattingModule>(request.packages, '@remotion/video-matting')
  registerMediabunnyServer()
  const support = await canUseVideoMatting({ model: request.model })
  if (!support.supported)
    throw new Error(support.detailedReason ?? 'This GPU cannot run background removal')
  const basePath = join(request.output, 'base.webm'),
    foregroundPath = join(request.output, 'foreground.webm')
  const base = await open(basePath, 'wx'),
    foreground = await open(foregroundPath, 'wx')
  function target(file: typeof base): WritableStream<{ data: Uint8Array; position: number }> {
    return new WritableStream({
      async write(chunk) {
        controller.signal.throwIfAborted()
        if (chunk.position + chunk.data.byteLength > 1024 * 1024 * 1024)
          throw new Error('Matting output exceeds 1 GiB')
        let offset = 0
        while (offset < chunk.data.byteLength) {
          const result = await file.write(
            chunk.data,
            offset,
            chunk.data.byteLength - offset,
            chunk.position + offset
          )
          offset += result.bytesWritten
        }
      }
    })
  }
  try {
    await downloadVideoMattingModel({
      model: request.model,
      signal: controller.signal,
      onProgress: () => report(0, 'Downloading background removal model')
    })
    const layers = await separateVideoLayers({
      src: request.source,
      model: request.model,
      audio: 'none',
      outputs: {
        base: { outputWritable: target(base) },
        foreground: { outputWritable: target(foreground) }
      },
      signal: controller.signal,
      onProgress: (progress) =>
        report(
          progress.progress ?? 0.99,
          progress.stage === 'finalizing' ? 'Finalizing transparent video' : 'Removing background'
        )
    })
    await layers.base.dispose()
    await layers.foreground.dispose()
    return { files: [basePath, foregroundPath] }
  } finally {
    await base.close()
    await foreground.close()
    await disposeVideoMattingModel({ model: request.model })
  }
}
let started = false
parentPort?.on('message', ({ data }) => {
  if (data === 'cancel') {
    controller.abort()
    return
  }
  if (started || !data || typeof data !== 'object') return
  started = true
  void matte(data as MattingRequest)
    .then((result) => parentPort.postMessage({ type: 'result', ...result }))
    .catch((error: unknown) =>
      parentPort.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : String(error)
      })
    )
})
