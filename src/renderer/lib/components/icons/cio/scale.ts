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
