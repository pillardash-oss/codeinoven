import { BrowserWindow } from 'electron'
import { join, relative } from 'node:path'
import { rm, rename } from 'node:fs/promises'
import { videoCaptureUrl } from '../../lib/video/project'
import { videoCaptionsSrt } from '../../lib/video/studio'
import { atomicWrite } from '../../lib/utils'
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

/** Export from a dedicated hidden renderer. One frame and one pipe write at a time. */
export async function exportVideo(
  root: string,
  folder: string,
  previews: DirectoryPreviewService,
  context: VideoJobContext
): Promise<{ files: string[] }> {
  context.update(0, 'Validating composition')
  const manifest = await loadCompositionManifest(folder, relative(root, folder))
  if (manifest.width * manifest.height > 3840 * 2160)
    throw new Error('Export supports up to 4K pixel count')
  const studio = await readVideoStudio(folder)
  const directory = await videoOutput(root, 'exports')
  const partial = join(directory, 'render.partial.mp4'),
    final = join(directory, 'render.mp4')
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
    const first = await window.webContents.capturePage(undefined, {
      stayHidden: true,
      stayAwake: true
    })
    const size = first.getSize()
    if (size.width * size.height > 3840 * 2160 * 4)
      throw new Error('Capture exceeds the bounded frame size')
    const args = [
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
      'yuv420p',
      '-t',
      String(manifest.duration),
      '-movflags',
      '+faststart',
      '-y',
      partial
    )
    encoder = await startVideoProcess(args, root, context.signal)
    encoder.child.stdout.resume()
    const frames = Math.ceil(manifest.duration * manifest.fps)
    for (let frame = 0; frame < frames; frame += 1) {
      context.signal.throwIfAborted()
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
      context.update((frame / frames) * 0.95, `Rendering frame ${frame + 1} of ${frames}`)
    }
    encoder.child.stdin.end()
    context.update(0.96, 'Finalizing video and audio')
    await encoder.done
    context.signal.throwIfAborted()
    await rename(partial, final)
    const files = [relative(root, final).replaceAll('\\', '/')]
    if (studio.captions.length) {
      const subtitles = join(directory, 'captions.srt')
      await atomicWrite(subtitles, videoCaptionsSrt(studio.captions))
      files.push(relative(root, subtitles).replaceAll('\\', '/'))
    }
    return { files }
  } finally {
    context.signal.removeEventListener('abort', abortWindow)
    encoder?.child.kill('SIGKILL')
    if (encoder) await encoder.done.catch(() => undefined)
    if (!window.isDestroyed()) window.destroy()
    await rm(partial, { force: true })
  }
}
