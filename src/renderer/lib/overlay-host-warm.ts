import { invoke } from '$lib/ipc.svelte'
import { logRendererDev } from '$lib/system/renderer-logger'

/**
 * The gestures that prove a session is being used.
 *
 * `pointermove` is the one that carries lead time: it precedes the click that
 * opens a dialog by however long the user takes to aim, which is the window the
 * overlay's document needs to load before the dialog is projected into it. The
 * other two cover a session driven from the keyboard or by automation, where the
 * pointer never moves first.
 */
const GESTURES = ['pointermove', 'pointerdown', 'keydown'] as const

/**
 * Load the native overlay host on the session's first gesture, and keep it.
 *
 * Every canonical modal is projected into this shared window
 * (`components/ui/Modal.svelte`), and the window is created on demand
 * (`main/browser/browser-overlay-window.ts`). A host whose document only begins
 * loading on the gesture that opened the dialog leaves the app window painting
 * nothing meanwhile, because the DOM panel is held back as the projection source
 * until the host refuses, and the scrim is skipped with it.
 *
 * A boot warm used to cover that, and was removed because it held a whole second
 * renderer for every session, including one that only reads a thread. The first
 * gesture is where that trade flips: the user is here, so the host is loaded and
 * kept for the session, exactly as the browser view keeps it while it is on
 * screen. An untouched session still holds no renderer for it.
 *
 * Fire and forget in both directions. `invoke` waits for the feature graph, so a
 * gesture that lands before the main process answers costs nothing; a warm that
 * fails costs the first modal its native presentation, which falls back to the
 * app window's own panel as it does today, and the listeners stay for the next
 * gesture to retry.
 *
 * @returns A detach for the listeners, for a caller that wants to stop waiting.
 */
export function warmOverlayHostOnFirstGesture(target: Window = window): () => void {
  let warmed = false
  let warming = false

  const release = (): void => {
    for (const type of GESTURES) target.removeEventListener(type, warm, { capture: true })
  }

  const warm = (): void => {
    if (warmed || warming) return
    warming = true
    void invoke('browser:warmOverlayHostForSession')
      .then(() => {
        warmed = true
        release()
        // Once per session, so a report of a slow first dialog can be read
        // against whether the host was asked for at all.
        logRendererDev('The native overlay host was warmed for the session')
      })
      .catch(() => {})
      .finally(() => {
        warming = false
      })
  }

  for (const type of GESTURES) {
    target.addEventListener(type, warm, { capture: true, passive: true })
  }
  return release
}
