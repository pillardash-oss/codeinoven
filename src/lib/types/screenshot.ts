/**
 * One desktop region capture, as the renderer attaches it to a prompt.
 *
 * The shortcut belongs to the operating system rather than to the window, so a
 * capture can be taken while another app owns the keyboard. `width`/`height`
 * are the dimensions of the file on disk (already fitted for a vision model),
 * and `sourceWidth`/`sourceHeight` are what the selection was before that fit,
 * which is the only way the user can tell a truly tight crop from a screenshot
 * that was shrunk to fit.
 */
export interface ScreenshotCapture {
  /** The optimized PNG the composer attaches. */
  path: string
  width: number
  height: number
  sourceWidth: number
  sourceHeight: number
  capturedAt: number
}

/** What one capture attempt did. */
export type ScreenshotCaptureStatus = 'captured' | 'cancelled' | 'busy' | 'failed'

export interface ScreenshotCaptureOutcome {
  status: ScreenshotCaptureStatus
  /** The capture, present only when `status` is `captured`. */
  capture?: ScreenshotCapture
  /** Why the attempt did not produce a capture, phrased for a toast. */
  reason?: string
}

/** What registering the global shortcut did. */
export interface ScreenshotShortcutRegistration {
  registered: boolean
  /** Why it is not registered, when it is not. */
  reason?: string
}
