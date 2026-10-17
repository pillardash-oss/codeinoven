/**
 * The menu bar figure for working threads: its labels, and the exact grid the
 * menu bar strip is cut on.
 *
 * The tray art ships as one wide strip per resolution, holding every figure the
 * icon can show, and the main process cuts the cell it needs out of it (see
 * `BackgroundLifecycleService.loadTrayCountImage`). Both ends therefore have to
 * agree on the cell grid to the pixel, which is why the grid lives here: the
 * generator that draws the strip and the reader that crops it call the same
 * functions instead of each deriving the layout for itself.
 *
 * The layout is the mark's own frame, unchanged, with the figure added in the
 * slot the attention exclamation occupies: the mark keeps the size and position
 * it has in the plain icon, and the figure is appended to its right, so a busy
 * menu bar reads as "[mark] 12" rather than a shrunken mark. The strip is drawn
 * in pixel space at one target height, so every value below is a whole number
 * and a hundred cells tile without rounding drift.
 */

/**
 * The highest figure written out in full. A larger count is written as
 * {@link TRAY_COUNT_OVERFLOW_LABEL}, which is also the widest figure the strip
 * contains, so three glyphs is the widest a cell ever gets.
 */
export const TRAY_COUNT_DISPLAY_MAX = 99

/** What a count above {@link TRAY_COUNT_DISPLAY_MAX} is written as. */
export const TRAY_COUNT_OVERFLOW_LABEL = '99+'

/**
 * The side of the square macOS renders the mark's own `viewBox` into.
 *
 * The macOS tray art squares the mark's viewBox about its own centre before
 * rendering, which is what puts the visible ink in the middle of the native
 * menu bar slot. The figure is laid out against that same square, so the mark
 * lands exactly where the plain icon puts it.
 */
const MAC_FRAME_EXTENT = 82

/**
 * The mark's ink height, stroke included, in artwork units. Measured from the
 * rendered master rather than read off the paths, because the strokes and the
 * mitred joins add to the geometry.
 */
const MARK_INK_HEIGHT_UNITS = 71.03

/** The figure's cap height as a fraction of the mark's ink height. */
const FIGURE_CAP_OF_MARK = 0.55

/**
 * JetBrains Mono Bold metrics, as fractions of the font size: the cap height of
 * a digit, and its advance. Measured from the bundled face at build time. The
 * advance is applied by hand (one `text` per glyph at a fixed step) so the cell
 * width is exactly `characters * applier` and never depends on the shaper.
 */
const CAP_RATIO = 0.76
const ADVANCE_RATIO = 0.6

/** Clear space between the mark's ink and the figure, in artwork units. */
const GAP_UNITS = 12

/** A menu bar resolution the strip is generated for. */
export type TrayCountScale = 1 | 2

/** The cell grid for one menu bar resolution, in pixels. */
export interface TrayCountMetrics {
  /** Height of the strip, and of the mark's square slot within it. */
  readonly height: number
  /** Width reserved for the mark plus the clear space before the figure. */
  readonly baseWidth: number
  /** Width one figure glyph occupies. */
  readonly charWidth: number
  /** Type size of the figure, in pixels. */
  readonly fontSize: number
  /** Baseline of the figure, in pixels from the top of the strip. */
  readonly baseline: number
}

/** One cell of the strip: which figure it holds, and where it sits. */
export interface TrayCountCell {
  readonly label: string
  /** Left edge of the cell, in pixels from the left of the strip. */
  readonly x: number
  /** Cell width, in pixels: {@link TrayCountMetrics.baseWidth} plus one glyph
   *  per character. */
  readonly width: number
}

/** Every label the strip holds, in cell order: 1..99, then the overflow. */
export const TRAY_COUNT_LABELS: readonly string[] = [
  ...Array.from({ length: TRAY_COUNT_DISPLAY_MAX }, (_, index) => String(index + 1)),
  TRAY_COUNT_OVERFLOW_LABEL
]

/** The stored figure for a count: nothing while none work, the number itself
 *  while it is writable, and the overflow label beyond that. */
export function trayCountLabel(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null
  const whole = Math.floor(count)
  if (whole <= TRAY_COUNT_DISPLAY_MAX) return String(whole)
  return TRAY_COUNT_OVERFLOW_LABEL
}

/**
 * The cell grid for one resolution.
 *
 * The height is the height of the plain macOS menu bar template, so the mark
 * renders at exactly the size and place it does today; everything else is
 * derived from that height and rounded to whole pixels.
 */
export function trayCountMetrics(scale: TrayCountScale): TrayCountMetrics {
  const height = 16 * scale
  const unit = height / MAC_FRAME_EXTENT
  const capHeight = Math.max(1, Math.round(FIGURE_CAP_OF_MARK * MARK_INK_HEIGHT_UNITS * unit))
  const fontSize = capHeight / CAP_RATIO
  return {
    height,
    baseWidth: height + Math.max(1, Math.round(GAP_UNITS * unit)),
    charWidth: Math.max(1, Math.round(fontSize * ADVANCE_RATIO)),
    fontSize,
    // The mark's ink is centred in its frame, which puts its optical centre on
    // the middle of the strip; the figure's cap is centred on the same line.
    baseline: height / 2 + capHeight / 2
  }
}

/** The strip cut into cells, left to right. */
export function trayCountCells(scale: TrayCountScale): TrayCountCell[] {
  const metrics = trayCountMetrics(scale)
  const cells: TrayCountCell[] = []
  let x = 0
  for (const label of TRAY_COUNT_LABELS) {
    const width = metrics.baseWidth + label.length * metrics.charWidth
    cells.push({ label, x, width })
    x += width
  }
  return cells
}

/** Total strip width in pixels for one resolution. */
export function trayCountStripWidth(scale: TrayCountScale): number {
  const cells = trayCountCells(scale)
  const last = cells[cells.length - 1]
  return last ? last.x + last.width : 0
}
