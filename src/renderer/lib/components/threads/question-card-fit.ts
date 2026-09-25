import type { Attachment } from 'svelte/attachments'

/**
 * Fit for the agent question card.
 *
 * The card is the last child of the bottom-anchored composer gutter, so it grows
 * upward: a question with a long option list (or a conversation pane shortened
 * by a docked context panel) pushes the card past the top of the pane, which
 * then clips the hidden options with no way to reach them. The pane is the only
 * box that knows the room available, and it is not reachable from CSS inside the
 * card, so the ceiling is measured here and written onto the card as the
 * `--question-card-max-height` custom property. The card's option body scrolls
 * inside that ceiling, which is what keeps every option reachable.
 */

/**
 * Conversation height kept above the card, so the transcript behind it never
 * collapses into a sliced sliver. It yields before the card does: a pane too
 * short to hold both shrinks this reserve down to zero.
 */
export const QUESTION_CARD_TRANSCRIPT_RESERVE = 64

/** Smallest usable card: its own header and footer, plus a scrollable sliver. */
export const QUESTION_CARD_MIN_HEIGHT = 160

const MAX_HEIGHT_PROPERTY = '--question-card-max-height'

/**
 * The conversation pane the card floats inside. The same anchor the composer's
 * expansion and the drop overlay resolve against, so all three agree on which
 * region the card belongs to.
 */
export function questionCardConversationPane(card: HTMLElement): HTMLElement | null {
  return card.closest<HTMLElement>('[data-drop-region="conversation"]')
}

/** A computed length, or zero when the browser reports nothing usable. */
function pixels(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Vertical padding and borders the card's host stacks around it, summed from
 *  the card up to (but excluding) the pane's own content box. */
function hostVerticalInset(card: HTMLElement, pane: HTMLElement): number {
  let inset = 0
  for (let node = card.parentElement; node && node !== pane; node = node.parentElement) {
    const style = getComputedStyle(node)
    inset += pixels(style.paddingTop) + pixels(style.paddingBottom)
    inset += pixels(style.borderTopWidth) + pixels(style.borderBottomWidth)
  }
  return inset
}

/**
 * The tallest the card may be and still fit whole, or null when nothing is laid
 * out yet (a hidden pane reports zero height) or the card has no conversation
 * region to fit into, so the caller leaves the CSS fallback in charge.
 *
 * Measured from the pane's own box rather than the card's current rect: the card
 * grows upward from the gutter, so its own geometry is a result of this ceiling,
 * and reading it back would feed the measurement its own answer.
 */
export function questionCardMaxHeight(card: HTMLElement): number | null {
  const pane = questionCardConversationPane(card)
  if (!pane) return null
  const paneHeight = pane.clientHeight
  if (paneHeight <= 0) return null
  const room = paneHeight - hostVerticalInset(card, pane)
  const reserve = Math.min(
    QUESTION_CARD_TRANSCRIPT_RESERVE,
    Math.max(room - QUESTION_CARD_MIN_HEIGHT, 0)
  )
  return Math.max(room - reserve, QUESTION_CARD_MIN_HEIGHT)
}

/**
 * Keeps the card inside the conversation pane it floats in, for as long as it
 * stays mounted. The pane resizes with the sidebars, the bottom context dock and
 * the window (no `resize` event fires for the first two), so the pane itself is
 * observed; a host without a conversation region keeps the CSS viewport clamp.
 */
export const fitQuestionCard: Attachment<HTMLElement> = (card) => {
  const apply = (): void => {
    const maxHeight = questionCardMaxHeight(card)
    if (maxHeight === null) card.style.removeProperty(MAX_HEIGHT_PROPERTY)
    else card.style.setProperty(MAX_HEIGHT_PROPERTY, `${maxHeight}px`)
  }
  const pane = questionCardConversationPane(card)
  if (!pane) return
  apply()
  const observer = new ResizeObserver(apply)
  observer.observe(pane)
  return () => observer.disconnect()
}
