import type { WebContents } from 'electron'
import { Logger } from '../../system/logger'

/**
 * Whether a browser page has ever been activated by the user.
 *
 * A camera or microphone prompt belongs to an action the user took: pressing
 * "Join", starting a recording, uploading a photo. Without that, a page can ask
 * for a device the moment it loads, which is how a plain sign-in page ended up
 * raising a camera prompt the user never caused.
 *
 * `navigator.userActivation.hasBeenActive` is Chromium's own answer to this: it
 * turns true on the first real activation (a click, a key press, a tap) and
 * stays true for the document. It is read from the page's main world, and the
 * read is bounded: a page that is mid-navigation or wedged must not hold the
 * permission callback open.
 */

/** How long the page has to answer before the request is treated as passive. */
const ACTIVATION_PROBE_TIMEOUT_MS = 1_500

const ACTIVATION_SCRIPT =
  '(() => { try { return navigator.userActivation ? navigator.userActivation.hasBeenActive === true : false } catch { return false } })()'

export function pageHasUserActivation(contents: WebContents): Promise<boolean> {
  if (contents.isDestroyed()) return Promise.resolve(false)
  const frame = contents.mainFrame
  if (!frame) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), ACTIVATION_PROBE_TIMEOUT_MS)
    frame.executeJavaScript(ACTIVATION_SCRIPT, false).then(
      (answer: unknown) => finish(answer === true),
      (error: unknown) => {
        Logger.dev('Browser user-activation probe failed:', error)
        finish(false)
      }
    )
  })
}
