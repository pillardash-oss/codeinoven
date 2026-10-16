import { BrowserWindow } from 'electron'
import { join, relative } from 'node:path'
import { rm, rename } from 'node:fs/promises'
import { videoCaptureUrl, type VideoProjectManifest } from '../../lib/video/project'
import { videoCaptionsSrt } from '../../lib/video/studio'
import { atomicWrite } from '../../lib/utils'
import {
  VIDEO_EXPORT_ENCODER_GLOBAL,
  videoExportEncoderSource,
  type VideoExportEncoderDrain,
  type VideoExportEncoderSupport
} from './video-export-encoder'
import { checkVideoExport, keepFailedExport, type VideoExportCheck } from './video-export-check'
import { videoFile, readVideoStudio, videoOutput } from './video-paths'
import { loadCompositionManifest } from './video-manifest'
import { startVideoProcess } from './video-process'
import type { VideoJobContext } from './video-jobs'
import type { DirectoryPreviewService } from '../preview/directory-preview-service'
import { servedFileUrl, resolveServedEntry } from '../preview/served-folder'

async function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Frame readiness timed out')), 15000)
        abort = () => reject(new Error('Video export cancelled'))
        signal.addEventListener('abort', abort, { once: true })
      })
    ])
  } finally {
    clearTimeout(timer)
    if (abort) signal.removeEventListener('abort', abort)
  }
}

/** Where one export's frames come from, and how big they are. */
interface FrameSource {
  /** `renderer` encodes in the export window; `capture` streams raw frames from main. */
  kind: 'renderer' | 'capture'
  width: number
  height: number
  encoderGlobal: string
}

/**
 * Choose how this export gets its frames.
 *
 * The renderer path is preferred and only needs the composition's output canvas:
 * the window encodes H.264 itself and returns compressed chunks, so no full-frame
 * bitmap is ever built in the main process. A composition that draws with DOM and
 * CSS instead, or a machine whose Chromium reports no usable H.264 annex-b
 * configuration, falls back to per-frame capture, which is what export did before.
 */
async function prepareFrameSource(
  window: BrowserWindow,
  manifest: VideoProjectManifest,
  signal: AbortSignal
): Promise<FrameSource> {
  const request = JSON.stringify({
    width: manifest.width,
    height: manifest.height,
    fps: manifest.fps
  })
  const support = (await bounded(
    window.webContents.executeJavaScript(
      `(async () => { ${videoExportEncoderSource()} return await globalThis.${VIDEO_EXPORT_ENCODER_GLOBAL}.supported(${request}) })()`
    ),
    signal
  )) as VideoExportEncoderSupport
  if (support.ok)
    return {
      kind: 'renderer',
      width: manifest.width,
      height: manifest.height,
      encoderGlobal: VIDEO_EXPORT_ENCODER_GLOBAL
    }
  const image = await window.webContents.capturePage(undefined, {
    stayHidden: true,
    stayAwake: true
  })
  const size = image.getSize()
  return {
    kind: 'capture',
    width: size.width,
    height: size.height,
    encoderGlobal: VIDEO_EXPORT_ENCODER_GLOBAL
  }
}

/** Draw, paint and encode one frame in the export window, returning its chunks. */
function encoderFrameScript(name: string, seconds: number): string {
  return `(async () => await globalThis.${name}.frame(${JSON.stringify(seconds)}))()`
}

/** Flush the window's encoder and return the tail of the stream. */
function encoderFinishScript(name: string): string {
  return `(async () => await globalThis.${name}.finish())()`
}

/**
 * How an export moved its frames, reported so a caller can see whether the main
 * process had to handle full-frame bitmaps (`capture`) or only encoded chunks
 * (`renderer`).
 */
export type VideoExportEncoderPath = 'renderer' | 'capture'

/** Export from a dedicated hidden renderer. One frame and one pipe write at a time. */
export async function exportVideo(
  root: string,
  folder: string,
  previews: DirectoryPreviewService,
  context: VideoJobContext
): Promise<{ files: string[]; encoder: VideoExportEncoderPath; check: VideoExportCheck }> {
  context.update(0, 'Validating composition')
  const manifest = await loadCompositionManifest(folder, relative(root, folder))
  if (manifest.width * manifest.height > 3840 * 2160)
    throw new Error('Export supports up to 4K pixel count')
  const studio = await readVideoStudio(folder)
  const directory = await videoOutput(root, 'exports')
  const partial = join(directory, 'render.partial.mp4'),
    final = join(directory, 'render.mp4'),
    failed = join(directory, 'render.failed.mp4')
  context.update(0, 'Preparing composition preview')
  const registration = await previews.open(folder)
  const entry = await resolveServedEntry(folder, 'index.html')
  context.update(0, 'Creating export renderer')
  const window = new BrowserWindow({
    show: false,
    width: manifest.width,
    height: manifest.height,
    useContentSize: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      partition: `video-export-${Date.now()}`
    }
  })
  context.update(0, 'Preparing export renderer')
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.setAudioMuted(true)
  const abortWindow = (): void => {
    if (!window.isDestroyed()) window.destroy()
  }
  context.signal.addEventListener('abort', abortWindow, { once: true })
  let encoder: Awaited<ReturnType<typeof startVideoProcess>> | undefined
  try {
    context.update(0, 'Loading composition')
    await bounded(
      window.loadURL(videoCaptureUrl(servedFileUrl(registration.url, entry), 0)),
      context.signal
    )
    await bounded(
      window.webContents.executeJavaScript(`(async () => {
      await document.fonts.ready;
      if (globalThis.CIOVideo) await globalThis.CIOVideo.ready;
      const images = [...document.images];
      await Promise.all(images.map(image => image.decode()));
      for (let attempt=0; attempt<100 && typeof globalThis.cioRenderFrame !== 'function'; attempt++)
        await new Promise(resolve => setTimeout(resolve, 50));
      if (typeof globalThis.cioRenderFrame !== 'function') throw new Error('No cioRenderFrame function');
    })()`),
      context.signal
    )
    await bounded(
      window.webContents.executeJavaScript('Promise.resolve(globalThis.cioRenderFrame(0))'),
      context.signal
    )
    const renderer = await prepareFrameSource(window, manifest, context.signal)
    const size = { width: renderer.width, height: renderer.height }
    if (size.width * size.height > 3840 * 2160 * 4)
      throw new Error('Capture exceeds the bounded frame size')
    // The renderer hands over an encoded H.264 elementary stream, so ffmpeg reads
    // it straight from the pipe and only muxes; the fallback still streams raw
    // frames at the captured size.
    const args =
      renderer.kind === 'renderer'
        ? ['-f', 'h264', '-framerate', String(manifest.fps), '-i', 'pipe:0']
        : [
            '-f',
            'rawvideo',
            '-pixel_format',
            'bgra',
            '-video_size',
            `${size.width}x${size.height}`,
            '-framerate',
            String(manifest.fps),
            '-i',
            'pipe:0'
          ]
    const tracks = studio.audioTracks.length
      ? studio.audioTracks
      : manifest.audio.map((source) => ({
          source,
          start: 0,
          trim: 0,
          duration: manifest.duration,
          gain: 1
        }))
    for (const track of tracks) args.push('-i', await videoFile(folder, track.source))
    if (tracks.length) {
      const filters = tracks.map(
        (track, index) =>
          `[${index + 1}:a]atrim=start=${track.trim}:duration=${track.duration},asetpts=PTS-STARTPTS,volume=${track.gain},adelay=${Math.round(track.start * 1000)}:all=1[a${index}]`
      )
      filters.push(
        `${tracks.map((_, index) => `[a${index}]`).join('')}amix=inputs=${tracks.length}:normalize=0,alimiter=limit=0.95[audio]`
      )
      args.push(
        '-filter_complex',
        filters.join(';'),
        '-map',
        '0:v:0',
        '-map',
        '[audio]',
        '-c:a',
        'aac'
      )
    } else args.push('-an')
    if (renderer.kind === 'renderer') args.push('-c:v', 'copy')
    else
      args.push(
        '-vf',
        `scale=${manifest.width}:${manifest.height}`,
        '-c:v',
        'libx264',
        '-threads',
        '2',
        '-preset',
        'fast',
        '-crf',
        '20',
        '-pix_fmt',
        'yuv420p'
      )
    args.push('-t', String(manifest.duration), '-movflags', '+faststart', '-y', partial)
    encoder = await startVideoProcess(args, root, context.signal)
    encoder.child.stdout.resume()
    const frames = Math.ceil(manifest.duration * manifest.fps)
    const writeChunks = async (chunks: string[]): Promise<void> => {
      if (!chunks.length) return
      const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk, 'base64')))
      await bounded(
        new Promise<void>((resolve, reject) =>
          encoder!.child.stdin.write(buffer, (error) => (error ? reject(error) : resolve()))
        ),
        context.signal
      )
    }
    for (let frame = 0; frame < frames; frame += 1) {
      context.signal.throwIfAborted()
      if (renderer.kind === 'renderer') {
        // One round trip per frame, and only compressed bytes come back: the draw,
        // the paint at the authored size and the encode all happen in the renderer.
        const drawn = (await bounded(
          window.webContents.executeJavaScript(
            encoderFrameScript(renderer.encoderGlobal, frame / manifest.fps)
          ),
          context.signal
        )) as VideoExportEncoderDrain
        if (drawn.error) throw new Error(`Video encoder failed: ${drawn.error}`)
        await writeChunks(drawn.chunks)
      } else {
        if (frame > 0)
          await bounded(
            window.webContents.executeJavaScript(
              `Promise.resolve(globalThis.cioRenderFrame(${frame / manifest.fps}))`
            ),
            context.signal
          )
        // Two paint ticks after the asynchronous draw; fonts and media have settled above.
        await bounded(
          window.webContents.executeJavaScript(
            'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
          ),
          context.signal
        )
        const image = await window.webContents.capturePage(undefined, {
          stayHidden: true,
          stayAwake: true
        })
        if (image.getSize().width !== size.width || image.getSize().height !== size.height)
          throw new Error('Composition changed capture size during export')
        await bounded(
          new Promise<void>((resolve, reject) =>
            encoder!.child.stdin.write(image.toBitmap(), (error) =>
              error ? reject(error) : resolve()
            )
          ),
          context.signal
        )
      }
      context.update((frame / frames) * 0.95, `Rendering frame ${frame + 1} of ${frames}`)
    }
    if (renderer.kind === 'renderer') {
      const flushed = (await bounded(
        window.webContents.executeJavaScript(encoderFinishScript(renderer.encoderGlobal)),
        context.signal
      )) as VideoExportEncoderDrain
      if (flushed.error) throw new Error(`Video encoder failed: ${flushed.error}`)
      await writeChunks(flushed.chunks)
    }
    encoder.child.stdin.end()
    context.update(0.96, 'Finalizing video and audio')
    await encoder.done
    context.signal.throwIfAborted()
    await rename(partial, final)
    context.update(0.98, 'Checking the exported file')
    let check: VideoExportCheck
    try {
      check = await checkVideoExport(
        root,
        final,
        {
          width: manifest.width,
          height: manifest.height,
          fps: manifest.fps,
          duration: manifest.duration,
          audio: manifest.audioPolicy ?? (tracks.length ? 'required' : 'silent'),
          audioFrom: tracks.length ? Math.min(...tracks.map((track) => track.start)) : 0
        },
        context.signal
      )
    } catch (error) {
      // A file that failed its check must not sit where a deliverable belongs, but
      // it is the only evidence of what went wrong, so it is renamed, not deleted.
      const kept = await keepFailedExport(root, final, failed, context.signal)
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(
        kept
          ? `${reason} That render was kept as ${kept} for inspection; the composition is unchanged.`
          : reason,
        { cause: error }
      )
    }
    const files = [relative(root, final).replaceAll('\\', '/')]
    if (studio.captions.length) {
      const subtitles = join(directory, 'captions.srt')
      await atomicWrite(subtitles, videoCaptionsSrt(studio.captions))
      files.push(relative(root, subtitles).replaceAll('\\', '/'))
    }
    return { files, encoder: renderer.kind, check }
  } finally {
    context.signal.removeEventListener('abort', abortWindow)
    encoder?.child.kill('SIGKILL')
    if (encoder) await encoder.done.catch(() => undefined)
    if (!window.isDestroyed()) window.destroy()
    await rm(partial, { force: true })
  }
}
