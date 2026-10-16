/**
 * The shared shape and weight math behind every CIO glyph.
 *
 * Every glyph is drawn in a 24 box and grouped with a fit transform that scales
 * its own drawing up to that box, which is how one set reads at 12, 16 and 20px
 * without redrawing. The transform scales the stroke with the geometry, so a
 * group must divide the weight it wants by its own scale to land on it.
 */

/** What every CIO glyph component accepts, the same shape a Lucide glyph does. */
export interface CioGlyphProps {
  /** Square edge in pixels. */
  size?: number
  /** The weight the call site asks for, in a 24 box. */
  strokeWidth?: number
  class?: string
}

/** The weight call sites pass, and the weight the fit math below is anchored to. */
const REFERENCE_STROKE = 1.8

/** The weight the set is drawn at in the 24 box: a notch firmer than Lucide. */
const DRAWN_STROKE = 1.9

/**
 * The pre-transform stroke a fitted group must carry so the glyph lands on the
 * drawn weight at the call site's own stroke, whatever that call site passes.
 */
export function cioStrokeWidth(requested: number, fitScale: number): number {
  return (requested / REFERENCE_STROKE) * (DRAWN_STROKE / fitScale)
}
