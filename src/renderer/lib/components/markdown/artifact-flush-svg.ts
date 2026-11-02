/**
 * The inline artifact's canvas, trimmed to the drawing it actually holds.
 *
 * An artifact is drawn flush in the conversation, inside the message column. The
 * column owns the gutter, so an artifact that also baked its own horizontal
 * margin into its canvas shows a second inset inside the message: a status board
 * drawn on a 1200 wide canvas from `x=40` to `x=1160` reads as a padded, narrower
 * picture while every other message in the thread starts at the column edge.
 *
 * Nothing inside the renderer adds that inset, so nothing inside the renderer can
 * take it away except the canvas itself: the drawing is measured, and the
 * picture's `viewBox` is narrowed to the width the drawing occupies. Only the
 * sides are trimmed. Vertical air at the top of a board is the artifact's own
 * composition rather than a misaligned edge, and nothing in the message column
 * runs alongside it to line up with.
 *
 * The artifact's own markup is untouched, which is what lets the expanded viewer
 * restore the authored canvas and show the picture exactly as it was designed.
 *
 * Only an SVG is trimmed. A document's page padding is already dropped by the
 * stage sheet, and anything else an HTML artifact insets is its own layout.
 */

/** A rectangle in the artifact's own user units, which is what a `viewBox` takes. */
export interface SvgContentBox {
  x: number
  y: number
  width: number
  height: number
}

/**
 * How far outside the canvas a shape may still be the canvas.
 *
 * A background rectangle is authored against the canvas it fills, and a rounding
 * difference of a fraction of a unit must not turn it into content.
 */
const CANVAS_FILL_TOLERANCE = 0.5

/**
 * Room kept outside the measured drawing so a stroke on the outermost element is
 * painted whole instead of clipped in half.
 *
 * It is one user unit, which on a typical artifact canvas is well under a CSS
 * pixel: invisible as an inset, enough to keep a border intact.
 */
const EDGE_ALLOWANCE = 1

/**
 * A box read through the geometry API, mapped into the artifact's canvas units.
 *
 * `getBBox` answers in the element's own user space, so a group that carries a
 * transform (the usual way an artifact insets its whole drawing) would otherwise
 * be measured where it would have been without one. The element's screen matrix
 * composed with the canvas's inverse puts every box back in the units the
 * `viewBox` is written in, which is what a group and a shape both need.
 */
function geometryOf(element: SVGGraphicsElement, toCanvas: DOMMatrix): SvgContentBox | null {
  try {
    const box = element.getBBox()
    if (box.width <= 0 && box.height <= 0) return null
    const ctm = element.getScreenCTM()
    const matrix = ctm ? toCanvas.multiply(ctm) : null
    return matrix
      ? mappedBox(matrix, { x: box.x, y: box.y, width: box.width, height: box.height })
      : { x: box.x, y: box.y, width: box.width, height: box.height }
  } catch {
    return null
  }
}

/** A box taken through a matrix, as the axis-aligned box that contains it. */
function mappedBox(matrix: DOMMatrix, box: SvgContentBox): SvgContentBox {
  const corners = [
    [box.x, box.y],
    [box.x + box.width, box.y],
    [box.x, box.y + box.height],
    [box.x + box.width, box.y + box.height]
  ].map(([x, y]) => ({
    x: matrix.a * x + matrix.c * y + matrix.e,
    y: matrix.b * x + matrix.d * y + matrix.f
  }))
  const x = Math.min(...corners.map((corner) => corner.x))
  const y = Math.min(...corners.map((corner) => corner.y))
  return {
    x,
    y,
    width: Math.max(...corners.map((corner) => corner.x)) - x,
    height: Math.max(...corners.map((corner) => corner.y)) - y
  }
}

function unionWith(left: SvgContentBox, right: SvgContentBox): SvgContentBox {
  const x = Math.min(left.x, right.x)
  const y = Math.min(left.y, right.y)
  return {
    x,
    y,
    width: Math.max(left.x + left.width, right.x + right.width) - x,
    height: Math.max(left.y + left.height, right.y + right.height) - y
  }
}

/**
 * Whether a shape is the canvas itself rather than a thing drawn on it.
 *
 * Only an unstroked rectangle that covers the whole canvas qualifies: that is the
 * shape an artifact paints its background with, and measuring it would answer
 * "the drawing fills the canvas" for every artifact that has one. A bordered or
 * rounded card is content even when it happens to reach the edges, and stays in
 * the measurement so its corners are never cut off.
 */
function isCanvasFill(
  child: SVGGraphicsElement,
  canvas: SvgContentBox,
  toCanvas: DOMMatrix
): boolean {
  if (child.tagName.toLowerCase() !== 'rect') return false
  if (child.childElementCount > 0) return false
  const box = geometryOf(child, toCanvas)
  if (!box) return false
  const coversCanvas =
    box.x <= canvas.x + CANVAS_FILL_TOLERANCE &&
    box.y <= canvas.y + CANVAS_FILL_TOLERANCE &&
    box.x + box.width >= canvas.x + canvas.width - CANVAS_FILL_TOLERANCE &&
    box.y + box.height >= canvas.y + canvas.height - CANVAS_FILL_TOLERANCE
  if (!coversCanvas) return false
  const stroke = getComputedStyle(child).stroke
  return stroke === '' || stroke === 'none'
}

/** The authored canvas, read from the `viewBox` the artifact declared. */
function canvasOf(svg: SVGSVGElement): SvgContentBox | null {
  if (!svg.hasAttribute('viewBox')) return null
  const box = svg.viewBox.baseVal
  if (box.width <= 0 || box.height <= 0) return null
  return { x: box.x, y: box.y, width: box.width, height: box.height }
}

/**
 * The box the artifact's drawing occupies across the canvas, or `null` when the
 * drawing already reaches both edges.
 *
 * A `null` answer is the ordinary case for an artifact authored flush: there is
 * nothing to trim, and the picture keeps its own canvas.
 */
export function svgContentBox(svg: SVGSVGElement): SvgContentBox | null {
  const canvas = canvasOf(svg)
  if (!canvas) return null
  const screen = svg.getScreenCTM()
  // An artifact that is not laid out (detached, or still hidden) has no box to
  // measure, and trimming it would answer with the geometry of nothing.
  if (!screen) return null
  const toCanvas = screen.inverse()
  let drawing: SvgContentBox | null = null
  for (const child of svg.children) {
    if (!(child instanceof SVGGraphicsElement)) continue
    if (isCanvasFill(child, canvas, toCanvas)) continue
    const box = geometryOf(child, toCanvas)
    if (!box) continue
    drawing = drawing ? unionWith(drawing, box) : box
  }
  if (!drawing) return null
  const trimmed = {
    x: drawing.x - EDGE_ALLOWANCE,
    y: canvas.y,
    width: drawing.width + EDGE_ALLOWANCE * 2,
    height: canvas.height
  }
  return trimmed.width >= canvas.width - EDGE_ALLOWANCE ? null : trimmed
}

/**
 * Narrow an inline picture's canvas to its drawing.
 *
 * The attribute is set on the mounted element rather than rewritten into the
 * artifact's source, so the source the reader copies, and the picture the
 * expanded viewer shows, stay exactly what the artifact declared.
 */
export function flushSvgViewBox(svg: SVGSVGElement): void {
  const box = svgContentBox(svg)
  if (!box) return
  const round = (value: number) => Math.round(value * 100) / 100
  svg.setAttribute(
    'viewBox',
    `${round(box.x)} ${round(box.y)} ${round(box.width)} ${round(box.height)}`
  )
}
