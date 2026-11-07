/**
 * Geometry and rules for the compose control both clients draw the same way.
 *
 * The desktop composer sits in a centred column (`max-w-3xl` / `max-w-4xl`)
 * inside a padded gutter, so growing it to 150% of that column overflows both
 * its own parent and the gutter. The only box that can clip the result is the
 * conversation pane the composer floats inside, and that pane is not reachable
 * from CSS inside the composer (the composer establishes its own inline-size
 * query container), so the expanded width is measured here instead.
 *
 * The phone has no column to widen: its ceiling is the screen. What the two
 * clients do share is the rule that asks for the control at all, and the caps
 * the field grows to. They live here so a second composer cannot invent a third
 * threshold.
 */

/** The maximized composer is 1.5× the width of the collapsed one. */
export const COMPOSER_EXPAND_WIDTH_RATIO = 1.5

/** Inset kept between the maximized composer and the pane it floats inside, so
 *  the expansion never lands flush against the pane's own edges. */
export const COMPOSER_EXPAND_PANE_INSET = 8

/**
 * Rendered lines the field may hold before the compose control appears: the
 * third line is what asks for it, on either client.
 */
export const COMPOSER_EXPAND_LINE_THRESHOLD = 2

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

/**
 * Has the field grown past its second rendered line? One pixel of tolerance
 * absorbs the rounding a line-height in fractional rem produces.
 */
export function composerHasThirdLine(contentHeight: number, lineHeight: number): boolean {
  return contentHeight > lineHeight * COMPOSER_EXPAND_LINE_THRESHOLD + 1
}

/**
 * The control is drawn while the writing is long enough for it and stays drawn
 * while expanded, so collapsing is always reachable   including after the
 * expanded field has been cleared back to one line.
 */
export function composerShowsExpandControl(hasThirdLine: boolean, expanded: boolean): boolean {
  return hasThirdLine || expanded
}
