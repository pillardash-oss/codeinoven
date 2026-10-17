/**
 * The icon scale.
 *
 * Every icon in the app is drawn at one of these sizes. A call site names the
 * context it sits in rather than picking a number, so the sizes stay progressive
 * from the densest surface to the largest one and two surfaces that sit beside
 * each other cannot drift apart.
 *
 * The steps are roughly a quarter apart, which is as much as an eye reads as a
 * deliberate difference at these sizes: below that a larger icon looks like a
 * mistake rather than a bigger one.
 */
export const ICON_SIZE = {
  /** Inside a chip or a badge, beside 10 to 11px text. */
  inline: 13,
  /** A context tab, a menu row, a control in a dense toolbar. */
  row: 15,
  /** The app header, a panel header, the composer, a dialog action. */
  control: 17,
  /** A button on the view rail or the context dock. */
  rail: 19,
  /** An empty state, a dialog head, a feature mark. */
  feature: 22
} as const

/** A step of the scale, for a prop that takes one. */
export type IconSize = (typeof ICON_SIZE)[keyof typeof ICON_SIZE]

/**
 * The weight a mark is drawn at on a rail.
 *
 * Size and weight are one decision, because the same number reads heavier the
 * smaller it gets: the assistant's own tiers step down as they grow (1.8 at rail
 * size, 1.6 at a medium mark). The rail draws the largest mark in the app out of
 * the same 24-unit box every other icon uses, and the set's 1.8 there read
 * heavier and larger than the marks around it, so the rail asks for one step
 * under the set's default.
 */
export const RAIL_ICON_STROKE = 1.6
