/**
 * The DOM contract for the layers drawn above the app's modals.
 *
 * Three kinds of layer sit above every modal in the app (the modals' own
 * stacking is `z-60`), so all of them must stay usable while a modal is open,
 * and all of them must be locatable by the two places below:
 *
 *   - svelte-sonner's toaster, stacked at `z-index: 999999999`.
 *   - Vite's development error overlay (`vite-error-overlay`, `z-index: 99999`),
 *     the card a compile error paints over the whole window during `bun run
 *     dev`. It is appended to `document.body` exactly like the toaster.
 *   - anything that marks itself with `data-layer-above-modal`, which is how a
 *     surface declares the same thing from its own markup instead of being named
 *     here. The shared text/terminal context menu is that surface today.
 *
 * `app.css` opts each layer back into pointer events, because a modal bits-ui
 * Dialog locks the whole page with `body { pointer-events: none }` (bits-ui's
 * `BodyScrollLock`), and pointer events inherit: a layer above the modal is
 * then painted but completely dead to the mouse. For the toaster that stranded
 * a toast on screen; for the dev error overlay it made the card undismissable,
 * because a press meant for it fell through to whatever sat underneath; for the
 * context menu it meant the menu could be neither pressed nor even seen.
 *
 * The dev error overlay needs a second escape the toaster does not: the app
 * header and every panel header are `-webkit-app-region: drag` strips, and a
 * drag region is computed from layout, not paint order, so a `drag` rectangle
 * underneath the full-screen overlay put the window's own drag ahead of the
 * card and swallowed the press that was meant to dismiss it. `app.css` gives
 * the overlay `-webkit-app-region: no-drag`, the same subtraction the header's
 * own controls use through `titlebar-no-drag`.
 *
 * `ui/Modal.svelte` ignores outside interactions that start inside any of these
 * layers, so a press aimed at a toast, at the dev error card or at the context
 * menu never dismisses the modal they float over.
 */

/** The element svelte-sonner renders its toasts into. */
export const TOAST_LAYER_SELECTOR = '[data-sonner-toaster]'

/** The custom element Vite's development compile-error overlay mounts as. */
export const DEV_ERROR_OVERLAY_SELECTOR = 'vite-error-overlay'

/**
 * Marker for any other surface the app draws over a modal.
 *
 * It is how a surface declares itself a layer above the modals instead of
 * naming it in this module: the shared text/terminal context menu is the one
 * that needs it. Its menu is a window-level surface, because the terminal it
 * serves can be a full screen action's output or another modal's embedded
 * shell, and the point of the menu is to be pressed from there. See
 * `components/shared/TextSelectionContextMenu.svelte` for why it carries this
 * and `app.css` for the pointer-events escape it comes with.
 */
export const ABOVE_MODAL_MARKER_SELECTOR = '[data-layer-above-modal]'

/** Selector for both layers, for a single `closest()` lookup. */
const LAYER_ABOVE_MODAL_SELECTOR = `${TOAST_LAYER_SELECTOR}, ${DEV_ERROR_OVERLAY_SELECTOR}, ${ABOVE_MODAL_MARKER_SELECTOR}`

/** True when an event target sits inside any layer drawn above a modal, so a
 *  press that lands there is never a backdrop press. */
export function isWithinLayerAboveModal(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(LAYER_ABOVE_MODAL_SELECTOR) !== null
}
