/**
 * Registry of the chat composers currently mounted.
 *
 * A shortcut that focuses "the chat composer" must not know which component
 * rendered it: the main conversation, the Chats empty state, a side chat, or a
 * temporary chat can all own one. Each `ChatComposer` registers its root while
 * mounted and owns how it takes focus (it restores the saved caret, and refuses
 * focus while the composer is disabled).
 */

export interface ComposerFocusTarget {
  /** The composer's root element, used as the visibility probe. */
  root: HTMLElement
  /** Move keyboard focus into this composer's editor, and report whether it
   *  accepted focus (a disabled composer does not). */
  focus: () => boolean
}

const targets = new Map<HTMLElement, ComposerFocusTarget>()

/** Register a mounted composer. Returns the unregister function. */
export function registerComposerFocusTarget(target: ComposerFocusTarget): () => void {
  targets.set(target.root, target)
  return () => {
    if (targets.get(target.root) === target) targets.delete(target.root)
  }
}

/**
 * Focus the composer the user can actually see, and report whether one took
 * focus. The composer that comes first in document order wins, so the main
 * conversation composer beats a side chat opened in the right sidebar; mount
 * order cannot decide that, because switching threads remounts the main
 * composer. A composer on a CSS-hidden surface (Settings, Scope) is skipped:
 * it has no box, so focus would land off screen.
 */
export function focusVisibleComposer(): boolean {
  const candidates = Array.from(targets.values()).filter((target) => isRendered(target.root))
  candidates.sort((a, b) => (isBefore(a.root, b.root) ? -1 : 1))
  for (const candidate of candidates) {
    if (candidate.focus()) return true
  }
  return false
}

/** Whether `element` precedes `other` in document order. */
function isBefore(element: HTMLElement, other: HTMLElement): boolean {
  return (element.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
}

function isRendered(element: HTMLElement): boolean {
  return element.isConnected && element.checkVisibility() && element.getClientRects().length > 0
}
