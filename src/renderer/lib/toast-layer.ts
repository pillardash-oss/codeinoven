/**
 * The toast layer's DOM contract.
 *
 * svelte-sonner stacks its toaster above every surface in the app. Its own
 * `z-index` is `999999999`, far above the modals' `z-60`, so a toast is drawn
 * over a modal and has to stay usable while one is open. Two places depend on
 * being able to locate that layer, and they must agree on the same element:
 *
 *   - `app.css` opts the toaster back into pointer events, because a modal
 *     bits-ui Dialog locks the whole page with `body { pointer-events: none }`
 *     (bits-ui's `BodyScrollLock`), and pointer events inherit. Without that,
 *     a toast above a modal is painted but completely dead to the mouse.
 *   - `ui/Modal.svelte` ignores outside interactions that start inside the
 *     layer, so pressing a toast's close button never dismisses the modal the
 *     toast is floating over.
 */

/** The element svelte-sonner renders its toasts into. */
export const TOAST_LAYER_SELECTOR = '[data-sonner-toaster]'

/** True when an event target sits inside the toast layer. */
export function isWithinToastLayer(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(TOAST_LAYER_SELECTOR) !== null
}
