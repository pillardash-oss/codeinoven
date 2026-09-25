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

export function rangeForAnnotation(root: HTMLElement, annotation: TextAnchor): Range | null {
  if (annotation.startOffset !== undefined && annotation.endOffset !== undefined) {
    const range = rangeForOffsets(root, annotation.startOffset, annotation.endOffset)
    if (range && (!annotation.quote || range.toString().trim() === annotation.quote.trim())) {
      return range
    }
  }
  const quote = annotation.quote?.trim()
  if (!quote) return null
  const startOffset = (root.textContent ?? '').indexOf(quote)
  return startOffset < 0 ? null : rangeForOffsets(root, startOffset, startOffset + quote.length)
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
 * Publish the live annotation ranges to the CSS Custom Highlight registry.
 *
 * The registry is document-global and keyed by name, so ownership is tracked per
 * name: only the view that published a name's current highlight may clear it.
 * Without that, a conversation view being torn down (a thread switch, a side
 * chat panel closing) wiped the highlight a sibling view had just published for
 * its own thread, leaving the annotations unhighlighted until something else
 * re-published them. The name is explicit because a conversation and a document
 * can both be on screen at once, each owning its own set of highlights.
 */
const highlightPublishers = new Map<string, object>()

export function applyAnnotationHighlights(
  ranges: ReadonlyMap<string, Range>,
  publisher: object,
  name: string
): void {
  if (typeof Highlight === 'undefined' || !CSS.highlights) return
  if (ranges.size === 0) {
    if (highlightPublishers.get(name) === publisher) {
      CSS.highlights.delete(name)
      highlightPublishers.delete(name)
    }
    return
  }
  CSS.highlights.set(name, new Highlight(...ranges.values()))
  highlightPublishers.set(name, publisher)
}

/** Drop this view's highlight, leaving any other name's registration intact. */
export function releaseAnnotationHighlights(publisher: object, name: string): void {
  if (highlightPublishers.get(name) !== publisher) return
  CSS.highlights?.delete(name)
  highlightPublishers.delete(name)
}
