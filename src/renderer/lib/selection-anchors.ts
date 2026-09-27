/**
 * DOM geometry shared by every surface that anchors a note to selected text.
 *
 * Two surfaces anchor notes: a conversation, where an annotation quotes an
 * excerpt of an assistant response, and a rendered document (the file
 * annotator, the studio panels), where it quotes a passage of that document.
 * What they share lives here: turning a live selection into character offsets,
 * rebuilding a range from persisted offsets, publishing the anchored ranges as
 * CSS highlights, and measuring where the comment bubble for each range belongs.
 * No component state is held here, so the geometry can be reasoned about on its
 * own.
 */

export interface TextAnchor {
  quote?: string
  startOffset?: number
  endOffset?: number
}

function textNodesWithin(root: HTMLElement): Text[] {
  const nodes: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let current = walker.nextNode()
  while (current) {
    if (current instanceof Text) nodes.push(current)
    current = walker.nextNode()
  }
  return nodes
}

export function offsetsForRange(
  root: HTMLElement,
  range: Range
): { startOffset: number; endOffset: number } {
  const start = document.createRange()
  const end = document.createRange()
  start.selectNodeContents(root)
  end.selectNodeContents(root)
  try {
    start.setEnd(range.startContainer, range.startOffset)
    end.setEnd(range.endContainer, range.endOffset)
  } catch {
    return { startOffset: 0, endOffset: range.toString().length }
  }
  return { startOffset: start.toString().length, endOffset: end.toString().length }
}

export function offsetsForQuote(
  root: HTMLElement | null,
  quote: string
): { startOffset: number; endOffset: number } {
  const startOffset = root?.textContent?.indexOf(quote) ?? -1
  return startOffset < 0
    ? { startOffset: 0, endOffset: quote.length }
    : { startOffset, endOffset: startOffset + quote.length }
}

function rangeForOffsets(root: HTMLElement, startOffset: number, endOffset: number): Range | null {
  let cursor = 0
  let startNode: Text | null = null
  let endNode: Text | null = null
  let localStart = 0
  let localEnd = 0
  for (const node of textNodesWithin(root)) {
    const next = cursor + node.data.length
    if (!startNode && startOffset >= cursor && startOffset <= next) {
      startNode = node
      localStart = Math.min(startOffset - cursor, node.data.length)
    }
    if (endOffset >= cursor && endOffset <= next) {
      endNode = node
      localEnd = Math.min(endOffset - cursor, node.data.length)
      break
    }
    cursor = next
  }
  if (!startNode || !endNode) return null
  const range = document.createRange()
  range.setStart(startNode, localStart)
  range.setEnd(endNode, localEnd)
  return range
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function whitespaceFree(value: string): string {
  return value.replace(/\s+/g, '')
}

/**
 * Whether a live range still describes the quote it was built for.
 *
 * The two serializations of the same passage disagree about whitespace:
 * `Range.toString()` concatenates the text nodes the range spans, so a passage
 * crossing a block boundary reads `beta gamma.Delta`, while the
 * `Selection.toString()` that stored the quote inserts a line break there and
 * reads `beta gamma.\n\nDelta`. Comparing the two literally marked every
 * cross-block annotation as moved and dropped its range, which is what left a
 * freshly added annotation without a highlight, a bubble or a comment editor.
 * Dropping whitespace compares the characters the reader actually selected.
 */
export function anchorTextMatches(range: Range, quote: string): boolean {
  return whitespaceFree(range.toString()) === whitespaceFree(quote)
}

/**
 * Locate a stored quote in a document's text content.
 *
 * The exact search is the common case: the quote is a contiguous slice of the
 * document and has not moved. When it has moved, or when the serialization
 * whitespace never existed in the document at all, the passage is searched for
 * again with its whitespace runs optional, so `a b` still finds `a b` and a
 * quote carrying a block separator still finds the text the separator never
 * belonged to.
 */
function locateQuote(
  text: string,
  quote: string
): { startOffset: number; endOffset: number } | null {
  const trimmed = quote.trim()
  if (!trimmed) return null
  const exact = text.indexOf(trimmed)
  if (exact >= 0) return { startOffset: exact, endOffset: exact + trimmed.length }
  const pattern = trimmed.split(/\s+/).map(escapeRegExp).join('\\s*')
  const match = new RegExp(pattern).exec(text)
  return match ? { startOffset: match.index, endOffset: match.index + match[0].length } : null
}

/**
 * Rebuild the live range for a persisted anchor, or null when it cannot be
 * found. The stored offsets are the primary anchor, because they are measured
 * in the same text-node coordinates this rebuild works in; the quote is the
 * check that the offsets still describe the intended passage, and the fallback
 * when the document was rewritten around it.
 */
export function rangeForAnnotation(root: HTMLElement, annotation: TextAnchor): Range | null {
  if (annotation.startOffset !== undefined && annotation.endOffset !== undefined) {
    const range = rangeForOffsets(root, annotation.startOffset, annotation.endOffset)
    if (range && (!annotation.quote || anchorTextMatches(range, annotation.quote))) {
      return range
    }
  }
  const quote = annotation.quote?.trim()
  if (!quote) return null
  const located = locateQuote(root.textContent ?? '', quote)
  return located ? rangeForOffsets(root, located.startOffset, located.endOffset) : null
}

export async function waitForScrollSettle(scroller: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    const startedAt = performance.now()
    let previousTop = scroller.scrollTop
    let stableFrames = 0
    const check = (): void => {
      const currentTop = scroller.scrollTop
      stableFrames = Math.abs(currentTop - previousTop) < 0.5 ? stableFrames + 1 : 0
      previousTop = currentTop
      if (stableFrames >= 3 || performance.now() - startedAt >= 900) return resolve()
      requestAnimationFrame(check)
    }
    requestAnimationFrame(check)
  })
}

/** Viewport position of one annotation's comment bubble. */
export interface AnnotationBubblePosition {
  x: number
  y: number
  visible: boolean
}

export const ANNOTATION_BUBBLE_SIZE = 44
export const ANNOTATION_BUBBLE_HEIGHT = 24
const BUBBLE_EDGE_MARGIN = 8

/**
 * Recompute the viewport position of each annotation's comment bubble from the
 * live highlight ranges so the bubbles track scroll and layout.
 */
export function measureAnnotationBubbles(
  container: HTMLElement | null | undefined,
  ranges: ReadonlyMap<string, Range>
): Record<string, AnnotationBubblePosition> {
  const next: Record<string, AnnotationBubblePosition> = {}
  const containerRect = container?.getBoundingClientRect()
  for (const [id, range] of ranges) {
    const rect = range.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) continue
    const visible = containerRect
      ? rect.top < containerRect.bottom - 8 && rect.bottom > containerRect.top + 8
      : true
    const x = Math.max(
      BUBBLE_EDGE_MARGIN,
      Math.min(
        Math.round(rect.left + rect.width / 2 - ANNOTATION_BUBBLE_SIZE / 2),
        window.innerWidth - ANNOTATION_BUBBLE_SIZE - BUBBLE_EDGE_MARGIN
      )
    )
    const above = rect.top - ANNOTATION_BUBBLE_HEIGHT - 1
    const below = rect.bottom + 6
    const y = Math.max(
      BUBBLE_EDGE_MARGIN,
      Math.min(
        above >= BUBBLE_EDGE_MARGIN ? above : below,
        window.innerHeight - ANNOTATION_BUBBLE_HEIGHT - BUBBLE_EDGE_MARGIN
      )
    )
    next[id] = { x, y, visible }
  }
  return next
}

/**
 * The ranges each view contributed to a highlight name.
 *
 * The registry is document-global and keyed by name, and more than one view can
 * draw the same annotation kind at once: the file panel's annotate view is
 * mounted twice while its fullscreen surface is open, once in the sidebar and
 * once in the modal. Each builds ranges in its own copy of the document, so a
 * name holds the union of every publisher's ranges. Registering only the last
 * publisher erased the other one's highlight, and a teardown erased it for good,
 * because a view whose dependencies did not change never republished: closing
 * the fullscreen reader left the sidebar's annotations unhighlighted. A range
 * from a detached tree simply paints nothing, so a stale contribution is
 * harmless until its view releases it.
 */
const highlightPublishers = new Map<string, Map<object, ReadonlyMap<string, Range>>>()

function publishHighlights(name: string): void {
  const publishers = highlightPublishers.get(name)
  const ranges: Range[] = []
  for (const contribution of publishers?.values() ?? []) ranges.push(...contribution.values())
  if (typeof Highlight === 'undefined' || !CSS.highlights) return
  if (ranges.length === 0) {
    CSS.highlights.delete(name)
    return
  }
  CSS.highlights.set(name, new Highlight(...ranges))
}

export function applyAnnotationHighlights(
  ranges: ReadonlyMap<string, Range>,
  publisher: object,
  name: string
): void {
  const publishers = highlightPublishers.get(name) ?? new Map<object, ReadonlyMap<string, Range>>()
  if (ranges.size === 0) publishers.delete(publisher)
  else publishers.set(publisher, ranges)
  if (publishers.size === 0) highlightPublishers.delete(name)
  else highlightPublishers.set(name, publishers)
  publishHighlights(name)
}

/** Drop this view's ranges, leaving every other publisher's highlight intact. */
export function releaseAnnotationHighlights(publisher: object, name: string): void {
  const publishers = highlightPublishers.get(name)
  if (!publishers?.delete(publisher)) return
  if (publishers.size === 0) highlightPublishers.delete(name)
  publishHighlights(name)
}
