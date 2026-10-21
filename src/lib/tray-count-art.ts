/**
 * Labels and the shared crop grid for the menu bar's working-thread strip.
 * Oven Box numeral outlines live in scripts/tray-count-digits.ts and are baked
 * into template PNGs at build time. The runtime only crops those images.
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
 * The square the mark is rendered into, in artwork units: its own viewBox
 * squared about its centre, which is what puts the visible ink in the middle of
 * the native menu bar slot. Mirrors `icon-mono-small.svg`; the generator fails
 * if the master no longer matches it.
 */
const FRAME = { x: 10, y: 7, extent: 82 } as const

/** Oven Box outlines fit this artwork box using one uniform scale. */
export const TRAY_COUNT_GLYPH = {
  capHeight: 40,
  width: 25,
  advance: 33
} as const

/** Left edge of the figure, in artwork units, measured from the artwork's own
 *  origin like the frame above. It clears the mark's ink by the same daylight
 *  the attention exclamation keeps, so the figure and the exclamation land in
 *  the slot with the same rhythm. */
const FIGURE_LEFT = 98

/** Dead space after the last glyph, in artwork units, so the figure does not
 *  kiss the edge of the menu bar item. */
const FIGURE_RIGHT_PAD = 6

/** A menu bar resolution the strip is generated for. */
export type TrayCountScale = 1 | 2

/**
 * The grid for one menu bar resolution.
 *
 * `height` is the only value that depends on the resolution; the artwork
 * geometry is in artwork units and is scaled by the generator, which is what
 * lets both resolutions be drawn from the same vectors instead of resampled.
 */
export interface TrayCountMetrics {
  /** Height of the strip, and of the mark's square slot within it. */
  readonly height: number
  /** The square the mark is rendered into, in artwork units. */
  readonly frame: { readonly x: number; readonly y: number; readonly extent: number }
  /** Left edge of the figure, in artwork units. */
  readonly figureLeft: number
  /** Top edge of the figure's glyph box, in artwork units. */
  readonly figureTop: number
  /** Ink width of one glyph, in artwork units. */
  readonly glyphWidth: number
  /** Step from one glyph's origin to the next, in artwork units. */
  readonly glyphAdvance: number
  /** Dead space after the last glyph, in artwork units. */
  readonly rightPad: number
}

/** One cell of the strip: which figure it holds, and where it sits. */
export interface TrayCountCell {
  readonly label: string
  /** Left edge of the cell, in pixels from the left of the strip. */
  readonly x: number
  /** Cell width, in pixels. */
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

/** The grid for one resolution. */
export function trayCountMetrics(scale: TrayCountScale): TrayCountMetrics {
  return {
    height: 16 * scale,
    frame: FRAME,
    figureLeft: FIGURE_LEFT,
    // The mark's ink is centred on the frame, so the figure's cap is centred on
    // the same line rather than hung from a baseline.
    figureTop: FRAME.y + FRAME.extent / 2 - TRAY_COUNT_GLYPH.capHeight / 2,
    glyphWidth: TRAY_COUNT_GLYPH.width,
    glyphAdvance: TRAY_COUNT_GLYPH.advance,
    rightPad: FIGURE_RIGHT_PAD
  }
}

/** Ink width of a figure of `glyphs` glyphs, in artwork units. */
function figureInkWidth(glyphs: number): number {
  return (glyphs - 1) * TRAY_COUNT_GLYPH.advance + TRAY_COUNT_GLYPH.width
}

/**
 * Width one cell needs, in pixels, rounded up so the artwork can never be
 * clipped by the crop that reads it back.
 */
function cellWidth(glyphs: number, scale: TrayCountScale): number {
  const metrics = trayCountMetrics(scale)
  const unit = metrics.height / FRAME.extent
  const artworkWidth = FIGURE_LEFT + figureInkWidth(glyphs) + metrics.rightPad - FRAME.x
  return Math.ceil(artworkWidth * unit)
}

/** The strip cut into cells, left to right. */
export function trayCountCells(scale: TrayCountScale): TrayCountCell[] {
  const cells: TrayCountCell[] = []
  let x = 0
  for (const label of TRAY_COUNT_LABELS) {
    const width = cellWidth([...label].length, scale)
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
