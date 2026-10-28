import { BrowserWindow } from 'electron'
import type { VideoProjectManifest } from '../../lib/video/project'
import { videoClipThumbnailDocument, type VideoFrameThumbnail } from '../../lib/video/frame-grid'
import type { VideoStudioDocument } from '../../lib/video/studio'
import { videoCaptureUrl } from '../../lib/video/project'
import {
  compositionRenderReadyScript,
  compositionTransportScript
} from '../browser/browser-service/browser-transport-script'

/** Short-lived, silent thumbnail renderer, separate from the user's playhead. */
export class VideoFramePreview {
  private window: BrowserWindow | null = null
  private queued = 0
  private tail = Promise.resolve()
  private disposed = false

  async render(
    url: string,
    manifest: VideoProjectManifest,
    times: number[],
    document?: VideoStudioDocument,
    clipIds?: string[]
  ): Promise<VideoFrameThumbnail[]> {
    if (this.disposed || this.queued >= 2) return []
    this.queued += 1
    const previous = this.tail
    let release = (): void => {}
    this.tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      if (this.disposed) return []
      return await this.capture(url, manifest, times, document, clipIds)
    } finally {
      this.queued -= 1
      release()
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.window && !this.window.isDestroyed()) this.window.destroy()
  }

  private async capture(
    url: string,
    manifest: VideoProjectManifest,
    times: number[],
    document?: VideoStudioDocument,
    clipIds?: string[]
  ): Promise<VideoFrameThumbnail[]> {
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
        partition: 'video-frame-preview'
      }
    })
    this.window = window
    window.webContents.setAudioMuted(true)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event) => event.preventDefault())
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        (async () => {
          await window.loadURL(videoCaptureUrl(url, 0))
          const ready: unknown = await window.webContents.executeJavaScript(
            compositionRenderReadyScript()
          )
          if (ready !== true) throw new Error('Frame previews are waiting for the composition')
          await window.webContents.executeJavaScript(
            compositionTransportScript({
              duration: manifest.duration,
              fps: manifest.fps,
              autoplay: false
            })
          )
          if (document)
            await window.webContents.executeJavaScript(`(async () => {
              globalThis.__cioEditPreviewDisabled = true;
              if (globalThis.CIOVideo?.setStudio) await globalThis.CIOVideo.setStudio(${JSON.stringify(document)}, null);
            })()`)
          const frames: VideoFrameThumbnail[] = []
          let previousClip = ''
          for (const [index, time] of times.entries()) {
            const clipId = clipIds?.[index]
            if (document?.edit && clipId && previousClip !== clipId) {
              const isolated = videoClipThumbnailDocument(document, clipId)
              await window.webContents.executeJavaScript(
                `globalThis.CIOVideo.setStudio(${JSON.stringify(isolated)}, null)`
              )
              previousClip = clipId
            }
            if (this.disposed || window.isDestroyed()) break
            const image: unknown = await window.webContents.executeJavaScript(`(async () => {
              const transport = globalThis.__cioTransport;
              const state = ${JSON.stringify(clipId !== undefined)} ? (await globalThis.cioRenderFrame(${JSON.stringify(time)}), {}) : await transport.freezeAt(${JSON.stringify(time)});
              if (state.error) throw new Error(state.error);
              const canvases = document.querySelectorAll('canvas');
              const source = globalThis.cioVideoCanvas || (canvases.length === 1 ? canvases[0] : null);
              if (!source) { await transport.settle(); return null; }
              try {
                const canvas = document.createElement('canvas');
                const scale = Math.min(160 / ${manifest.width}, 90 / ${manifest.height});
                canvas.width = Math.max(1, Math.round(${manifest.width} * scale));
                canvas.height = Math.max(1, Math.round(${manifest.height} * scale));
                canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
                return canvas.toDataURL('image/jpeg', 0.65);
              } catch { await transport.settle(); return null; }
            })()`)
            if (typeof image === 'string' && image.length < 128000)
              frames.push({ time, image, ...(clipId ? { clipId } : {}) })
            else if (image === null) {
              const scale = Math.min(160 / manifest.width, 90 / manifest.height)
              // Chromium scales DOM previews before IPC. Full-frame native
              // bitmaps never accumulate in Electron's main process.
              const debuggerSession = window.webContents.debugger
              if (!debuggerSession.isAttached()) debuggerSession.attach('1.3')
              const captured: unknown = await debuggerSession.sendCommand(
                'Page.captureScreenshot',
                {
                  format: 'jpeg',
                  quality: 65,
                  fromSurface: true,
                  clip: { x: 0, y: 0, width: manifest.width, height: manifest.height, scale }
                }
              )
              const data =
                captured && typeof captured === 'object'
                  ? (captured as Record<string, unknown>)['data']
                  : null
              if (typeof data === 'string' && data.length < 128000)
                frames.push({
                  time,
                  image: `data:image/jpeg;base64,${data}`,
                  ...(clipId ? { clipId } : {})
                })
            }
          }
          return frames
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Frame previews timed out')), 15000)
        })
      ])
    } finally {
      clearTimeout(timer)
      if (!window.isDestroyed()) window.destroy()
      this.window = null
    }
  }
}
