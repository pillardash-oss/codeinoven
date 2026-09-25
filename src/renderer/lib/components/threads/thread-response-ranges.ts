import type { ResponseReferenceAnchor } from '$lib/stores/response-references.svelte'

/**
 * DOM geometry for quoted response annotations.
 *
 * Everything here works on live DOM ranges: turning a selection into a
 * candidate anchor, rebuilding a highlight range from persisted offsets, and
 * measuring where the comment bubble for each anchor belongs. No component
 * state lives in this module, so the geometry can be reasoned about on its own.
 */

export const RESPONSE_HIGHLIGHT_NAME = 'response-annotation'
export const RESPONSE_BUBBLE_SIZE = 44
export const RESPONSE_BUBBLE_HEIGHT = 24
/** Widest the selection action bubble may be before the viewport clamps it. */
const SELECTION_BUBBLE_WIDTH = 430
const SELECTION_BUBBLE_HEIGHT = 48
const VIEWPORT_MARGIN = 12
const BUBBLE_EDGE_MARGIN = 8

export interface ResponseSelectionCandidate {
  text: string
  messageId: string
  range: Range
  startOffset: number
  endOffset: number
  x: number
  y: number
}

export interface ResponseBubblePosition {
  x: number
  y: number
  visible: boolean
}

/** The assistant response element that owns a DOM node, if any. */
export function responseElementFor(node: Node | null): HTMLElement | null {
  const element = node instanceof Element ? node : node?.parentElement
  const response = element?.closest<HTMLElement>('[data-assistant-response]')
  return response ?? null
}

/** Character offset of a DOM point inside a response element. */
export function textOffsetWithin(root: HTMLElement, node: Node, offset: number): number | null {
  try {
    const prefix = document.createRange()
    prefix.selectNodeContents(root)
    prefix.setEnd(node, offset)
    return prefix.toString().length
  } catch {
    return null
  }
}

export function textPointAtOffset(
  root: HTMLElement,
  requestedOffset: number
): { node: Node; offset: number } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let remaining = Math.max(0, requestedOffset)
  let node = walker.nextNode()
  while (node) {
    const length = node.textContent?.length ?? 0
    if (remaining <= length) return { node, offset: remaining }
    remaining -= length
    node = walker.nextNode()
  }
  return { node: root, offset: root.childNodes.length }
}

/** Rebuild the live range for a persisted anchor, or null when it cannot be found. */
export function responseRangeFor(
  container: ParentNode | null | undefined,
  reference: ResponseReferenceAnchor
): Range | null {
  const response = Array.from(
    container?.querySelectorAll<HTMLElement>('[data-assistant-response]') ?? []
  ).find((element) => element.dataset.messageId === reference.messageId)
  if (!response) return null
  const start = textPointAtOffset(response, reference.startOffset)
  const end = textPointAtOffset(response, reference.endOffset)
  try {
    const range = document.createRange()
    range.setStart(start.node, start.offset)
    range.setEnd(end.node, end.offset)
    return range
  } catch {
    return null
  }
}

/**
 * Turn the current document selection into an anchor candidate. Returns null
 * when the selection is empty, spans more than one response, or cannot be
 * measured. The bubble is anchored above the selection so the native
 * right-click menu (which appears at the cursor, usually below the selection)
 * opens beneath it without colliding, falling back below when there is no room.
 */
export function captureResponseSelection(): ResponseSelectionCandidate | null {
  const selection = document.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null
  const anchorResponse = responseElementFor(selection.anchorNode)
  const focusResponse = responseElementFor(selection.focusNode)
  if (!anchorResponse || anchorResponse !== focusResponse) return null
  const text = selection.toString().trim()
  const messageId = anchorResponse.dataset.messageId
  if (!text || !messageId) return null
  const range = selection.getRangeAt(0).cloneRange()
  const startOffset = textOffsetWithin(anchorResponse, range.startContainer, range.startOffset)
  const endOffset = textOffsetWithin(anchorResponse, range.endContainer, range.endOffset)
  if (startOffset === null || endOffset === null) return null
  const rect = range.getBoundingClientRect()
  const x = Math.max(
    VIEWPORT_MARGIN,
    Math.min(rect.left, window.innerWidth - SELECTION_BUBBLE_WIDTH - VIEWPORT_MARGIN)
  )
  const y =
    rect.top - SELECTION_BUBBLE_HEIGHT >= VIEWPORT_MARGIN
      ? rect.top - SELECTION_BUBBLE_HEIGHT
      : Math.max(
          VIEWPORT_MARGIN,
          Math.min(rect.bottom + 8, window.innerHeight - SELECTION_BUBBLE_HEIGHT - 8)
        )
  return { text, messageId, range, startOffset, endOffset, x, y }
}

/**
 * Whether a live range still describes the annotation it was built for.
 *
 * A range survives a re-render only while its text nodes stay in the document:
 * Svelte replaces nodes when a block is rebuilt (the newest answer moving out of
 * the working trace into its final-answer block, history windowing mounting a
 * message, markdown re-rendering once its images or citations resolve), and a
 * range pointing at those detached nodes paints nothing and measures a zero
 * rect. Text drift is checked too, because an in-place text update keeps the
 * node connected while the stored offsets no longer describe it.
 */
export function responseRangeIsCurrent(
  range: Range | null | undefined,
  reference: ResponseReferenceAnchor
): boolean {
  if (!range) return false
  if (!range.startContainer.isConnected || !range.endContainer.isConnected) return false
  return range.toString().trim() === reference.text.trim()
}

/**
 * Publish the live highlight ranges to the CSS Custom Highlight registry.
 *
 * The registry is document-global and keyed by one name, so ownership is
 * tracked: only the view that published the current highlight may clear it.
 * Without that, a conversation view being torn down (a thread switch, a side
 * chat panel closing) wiped the highlight a sibling view had just published for
 * its own thread, leaving the annotations unhighlighted until something else
 * re-published them.
 */
let highlightPublisher: object | null = null

export function applyResponseHighlights(
  ranges: ReadonlyMap<string, Range>,
  publisher: object
): void {
  if (typeof Highlight === 'undefined' || !CSS.highlights) return
  if (ranges.size === 0) {
    if (highlightPublisher === publisher) {
      CSS.highlights.delete(RESPONSE_HIGHLIGHT_NAME)
      highlightPublisher = null
    }
    return
  }
  CSS.highlights.set(RESPONSE_HIGHLIGHT_NAME, new Highlight(...ranges.values()))
  highlightPublisher = publisher
}

/** Drop this view's highlight, leaving any other view's registration intact. */
export function releaseResponseHighlights(publisher: object): void {
  if (highlightPublisher !== publisher) return
  CSS.highlights?.delete(RESPONSE_HIGHLIGHT_NAME)
  highlightPublisher = null
}

/**
 * Recompute the viewport position of each reference's comment bubble from the
 * live highlight ranges so the bubbles track scroll and layout.
 */
export function measureResponseBubblePositions(
  container: HTMLElement | null | undefined,
  ranges: ReadonlyMap<string, Range>
): Record<string, ResponseBubblePosition> {
  const next: Record<string, ResponseBubblePosition> = {}
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
        Math.round(rect.left + rect.width / 2 - RESPONSE_BUBBLE_SIZE / 2),
        window.innerWidth - RESPONSE_BUBBLE_SIZE - BUBBLE_EDGE_MARGIN
      )
    )
    const above = rect.top - RESPONSE_BUBBLE_HEIGHT - 1
    const below = rect.bottom + 6
    const y = Math.max(
      BUBBLE_EDGE_MARGIN,
      Math.min(
        above >= BUBBLE_EDGE_MARGIN ? above : below,
        window.innerHeight - RESPONSE_BUBBLE_HEIGHT - BUBBLE_EDGE_MARGIN
      )
    )
    next[id] = { x, y, visible }
  }
  return next
}
