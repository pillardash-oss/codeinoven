/**
 * The plumbing every annotatable surface shares for the selection menu.
 *
 * Two things are shared by a conversation, an annotated document and a studio
 * document: who owns the right-click inside their own text, and how the menu
 * stays in step with a selection the user is still shaping with the keyboard.
 * The menu itself is `SelectionActionMenu`; what lives here is only the wiring,
 * so no component has to know about the other surfaces.
 */

/**
 * A surface's claim on a right-click that landed in the text it annotates.
 *
 * The claim is asked before the app's generic text menu resolves, so a surface
 * that takes the event has already prevented the default: an annotatable
 * passage offers the annotation menu, which carries the same actions a
 * highlight does, rather than the plain copy menu.
 */
export type SelectionAnnotationClaim = (event: MouseEvent) => boolean

const claims = new Set<SelectionAnnotationClaim>()

/** Register a surface's claim. Returns the disposer that withdraws it. */
export function registerSelectionAnnotationClaim(claim: SelectionAnnotationClaim): () => void {
  claims.add(claim)
  return () => {
    claims.delete(claim)
  }
}

/**
 * Let a registered surface take a right-click.
 *
 * Returns true when a surface handled the event, which is the signal for the
 * generic text menu to stay out of the way.
 */
export function claimSelectionAnnotationMenu(event: MouseEvent): boolean {
  for (const claim of claims) {
    if (claim(event)) return true
  }
  return false
}

/** Fields that own their own editing menu: cut, paste and select all. */
const EDITING_SELECTOR = 'input, textarea, [contenteditable="true"], [contenteditable=""]'

/** Whether a right-click landed in a field rather than in annotatable prose. */
export function isEditingTarget(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null
  return Boolean(element?.closest(EDITING_SELECTOR))
}

/**
 * Follow the live document selection until the returned disposer is called.
 *
 * A selection is not only made with the mouse: shift and an arrow key extends or
 * trims it, and the menu or anchor that quotes the passage has to be the text
 * that is highlighted now, not the text that was highlighted when the pointer
 * came up. `selectionchange` fires for every step of that, so the capture runs
 * once per frame at most, which keeps a held-down arrow key from measuring the
 * selection dozens of times a frame. `apply(null)` reports a selection that
 * collapsed or left the surface.
 */
export function trackLiveSelection<T>(
  capture: () => T | null,
  apply: (candidate: T | null) => void
): () => void {
  let frame = 0
  const onSelectionChange = (): void => {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      apply(capture())
    })
  }
  document.addEventListener('selectionchange', onSelectionChange)
  return () => {
    document.removeEventListener('selectionchange', onSelectionChange)
    if (frame) cancelAnimationFrame(frame)
  }
}
