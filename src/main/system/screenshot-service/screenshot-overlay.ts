import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { MAX_SCREENSHOT_DIMENSION } from '../../../lib/image-payload'
import {
  SCREENSHOT_OVERLAY_CHANNELS as CHANNELS,
  type ScreenshotFrame,
  type ScreenshotSelection
} from '../../../lib/screenshot/overlay-bridge'
import { getMainBundleDirectory } from '../../bootstrap/bundle-directory'
import { loadRendererDocument } from '../../browser/child-window-support'
import { captureDisplayFrames, type DisplayFrame } from './screenshot-frames'
import { pngSize, writePicture, type RegionSelection } from './screenshot-files'

/**
 * The Windows and X11 selector: one opaque window per display showing its still.
 *
 * Opaque on purpose, because transparency needs a compositor that X11 does not
 * promise. Windows exist only while a selection is in progress.
 */

/** An overlay that never painted must not leave the capture busy. */
const READY_TIMEOUT_MS = 10_000
/** An abandoned overlay must not cover the screen forever. */
const SELECTION_TIMEOUT_MS = 120_000
/** Raw RGBA of the largest fitted picture, with room for PNG framing. */
const MAX_PNG_BYTES = MAX_SCREENSHOT_DIMENSION ** 2 * 4 + 1024 * 1024

type OverlayResult =
  | { status: 'selected'; selection: ScreenshotSelection }
  | { status: 'cancelled' }
  | { status: 'failed'; reason: string }

function isSelection(value: unknown): value is ScreenshotSelection {
  if (typeof value !== 'object' || value === null) return false
  const { png, sourceWidth, sourceHeight } = value as Partial<ScreenshotSelection>
  if (!(png instanceof Uint8Array) || png.byteLength > MAX_PNG_BYTES) return false
  if (!Number.isSafeInteger(sourceWidth) || !Number.isSafeInteger(sourceHeight)) return false
  const size = pngSize(png)
  return !!size && Math.max(size.width, size.height) <= MAX_SCREENSHOT_DIMENSION
}

function createOverlay({ display }: DisplayFrame): BrowserWindow {
  const linux = process.platform === 'linux'
  const overlay = new BrowserWindow({
    ...display.bounds,
    show: false,
    frame: false,
    thickFrame: false,
    roundedCorners: false,
    hasShadow: false,
    backgroundColor: '#000000',
    // X11 window managers refuse fullscreen to a window that cannot resize.
    resizable: linux,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: linux,
    skipTaskbar: true,
    enableLargerThanScreen: true,
    title: 'Select a region',
    webPreferences: {
      preload: join(getMainBundleDirectory(import.meta.url), '../preload/screenshot-overlay.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false
    }
  })
  overlay.setAlwaysOnTop(true, 'screen-saver')
  overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  overlay.webContents.on('will-navigate', (event) => event.preventDefault())
  return overlay
}

function revealOverlay(overlay: BrowserWindow, display: Electron.Display): void {
  // Windows sizes a new window by the primary monitor's scale, so the bounds are
  // applied again once it is on the monitor it belongs to.
  overlay.setBounds(display.bounds)
  overlay.show()
  overlay.setBounds(display.bounds)
  // X11 window managers keep an ordinary window off their panels.
  if (process.platform === 'linux') overlay.setFullScreen(true)
}

function showOverlays(frames: DisplayFrame[]): Promise<OverlayResult> {
  return new Promise((resolveResult) => {
    const overlays: BrowserWindow[] = []
    let waiting = frames.length
    let settled = false

    const settle = (result: OverlayResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      screen.off('display-added', cancel)
      screen.off('display-removed', cancel)
      for (const overlay of overlays) {
        if (!overlay.isDestroyed()) overlay.destroy()
      }
      resolveResult(result)
    }
    const cancel = (): void => settle({ status: 'cancelled' })
    let timer = setTimeout(
      () => settle({ status: 'failed', reason: 'The region selector did not open in time.' }),
      READY_TIMEOUT_MS
    )

    // Every display appears at once, so a drag cannot start on a half-built set.
    const revealAll = (): void => {
      clearTimeout(timer)
      timer = setTimeout(cancel, SELECTION_TIMEOUT_MS)
      for (const [index, overlay] of overlays.entries()) {
        revealOverlay(overlay, frames[index]!.display)
      }
      // Escape has to reach the display the pointer is on.
      const current = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id
      const active = overlays[frames.findIndex((frame) => frame.display.id === current)]
      active?.focus()
    }

    screen.on('display-added', cancel)
    screen.on('display-removed', cancel)

    try {
      for (const frame of frames) {
        const overlay = createOverlay(frame)
        overlays.push(overlay)
        const contents = overlay.webContents
        let ready = false
        contents.ipc.handle(CHANNELS.frame, (): ScreenshotFrame => {
          const { width, height } = frame.image.getSize()
          return { pixels: new Uint8Array(frame.image.toBitmap()), width, height }
        })
        contents.ipc.on(CHANNELS.ready, () => {
          if (ready || settled) return
          ready = true
          waiting -= 1
          if (waiting === 0) revealAll()
        })
        contents.ipc.on(CHANNELS.cancel, cancel)
        contents.ipc.on(CHANNELS.select, (_event, value: unknown) => {
          settle(
            isSelection(value)
              ? { status: 'selected', selection: value }
              : { status: 'failed', reason: 'The region selector returned an invalid picture.' }
          )
        })
        contents.ipc.on(CHANNELS.fail, (_event, reason: unknown) => {
          settle({ status: 'failed', reason: String(reason).slice(0, 500) })
        })
        contents.on('render-process-gone', () =>
          settle({ status: 'failed', reason: 'The region selector stopped unexpectedly.' })
        )
        overlay.on('closed', cancel)
        void loadRendererDocument(contents, 'screenshot-overlay.html')
      }
    } catch (error) {
      settle({ status: 'failed', reason: error instanceof Error ? error.message : String(error) })
    }
  })
}

export async function selectRegionWithOverlay(directory: string): Promise<RegionSelection> {
  const result = await showOverlays(await captureDisplayFrames())
  if (result.status !== 'selected') return result
  const { png, sourceWidth, sourceHeight } = result.selection
  const size = pngSize(png)
  if (!size) return { status: 'failed', reason: 'The selected picture could not be read.' }
  const path = await writePicture(png, directory)
  return { status: 'selected', path, ...size, sourceWidth, sourceHeight }
}
