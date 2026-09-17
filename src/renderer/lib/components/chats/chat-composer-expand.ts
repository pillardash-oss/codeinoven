/**
 * Geometry for the chat composer's maximize control.
 *
 * The composer sits in a centred column (`max-w-3xl` / `max-w-4xl`) inside a
 * padded gutter, so growing it to 150% of that column overflows both its own
 * parent and the gutter. The only box that can clip the result is the
 * conversation pane the composer floats inside, and that pane is not reachable
 * from CSS inside the composer (the composer establishes its own inline-size
 * query container), so the expanded width is measured here instead.
 */

/** The maximized composer is 1.5× the width of the collapsed one. */
export const COMPOSER_EXPAND_WIDTH_RATIO = 1.5

/** Inset kept between the maximized composer and the pane it floats inside, so
 *  the expansion never lands flush against the pane's own edges. */
export const COMPOSER_EXPAND_PANE_INSET = 8

export interface ComposerExpandBounds {
  /** Width the composer occupies while collapsed   its parent's content box. */
  collapsedWidth: number
  /** Width of the conversation pane the composer floats inside. */
  paneWidth: number
}

/**
 * Expanded width in pixels: 150% of the collapsed width, clamped to the room
 * the pane actually offers and never narrower than the composer already is.
 */
export function expandedComposerWidth(bounds: ComposerExpandBounds): number {
  const target = bounds.collapsedWidth * COMPOSER_EXPAND_WIDTH_RATIO
  const ceiling = bounds.paneWidth - COMPOSER_EXPAND_PANE_INSET * 2
  return Math.round(Math.min(target, Math.max(ceiling, bounds.collapsedWidth)))
}

/**
 * The conversation pane the composer floats inside, when its host renders one.
 * Same anchor the drop overlay resolves against, so both agree on which region
 * the composer belongs to.
 */
export function composerConversationPane(composer: HTMLElement): HTMLElement | null {
  return composer.closest<HTMLElement>('[data-drop-region="conversation"]')
}

/**
 * Measured expansion bounds for a mounted composer, or null when the composer
 * has no laid-out parent yet (a pane that is still hidden reports zero width).
 */
export function measureComposerExpansion(composer: HTMLElement): ComposerExpandBounds | null {
  const collapsedWidth = composer.parentElement?.clientWidth ?? 0
  if (collapsedWidth <= 0) return null
  const pane = composerConversationPane(composer)
  // A host that renders the composer outside a conversation region (a
  // standalone surface) clamps against the window instead of not expanding.
  const paneWidth = pane ? pane.clientWidth : window.innerWidth
  if (paneWidth <= 0) return null
  return { collapsedWidth, paneWidth }
}
