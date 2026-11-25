/**
 * The private bridge between main and one region-selection overlay.
 *
 * These channels are handled on each overlay's own `webContents.ipc` and exposed
 * by its own preload, so the overlay never holds the app's IPC surface. Nothing
 * else may import runtime values into the preload: a sandboxed one cannot load
 * a shared chunk.
 */

export const SCREENSHOT_OVERLAY_CHANNELS = {
  frame: 'screenshot-overlay:frame',
  ready: 'screenshot-overlay:ready',
  select: 'screenshot-overlay:select',
  cancel: 'screenshot-overlay:cancel',
  fail: 'screenshot-overlay:fail'
} as const

/** One display as it looked when the chord was pressed, as raw BGRA pixels. */
export interface ScreenshotFrame {
  pixels: Uint8Array<ArrayBuffer>
  width: number
  height: number
}

/** The region the overlay cropped, fitted and encoded in its own process. */
export interface ScreenshotSelection {
  png: Uint8Array<ArrayBuffer>
  sourceWidth: number
  sourceHeight: number
}

export interface ScreenshotOverlayBridge {
  frame(): Promise<ScreenshotFrame | null>
  ready(): void
  select(selection: ScreenshotSelection): void
  cancel(): void
  fail(reason: string): void
}
