import { open, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

interface MattingRequest {
  source: string
  output: string
  cache: string
  model: 'modnet' | 'ben2-base'
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

/** GPU inference and positional encoding writes never run on Electron main. */
async function matte(request: MattingRequest): Promise<{ files: string[] }> {
  const { env } = await import('@huggingface/transformers')
  env.cacheDir = request.cache
  await mkdir(request.cache, { recursive: true })
  const { registerMediabunnyServer } = await import('@mediabunny/server')
  const {
    canUseVideoMatting,
    downloadVideoMattingModel,
    separateVideoLayers,
    disposeVideoMattingModel
  } = await import('@remotion/video-matting')
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
