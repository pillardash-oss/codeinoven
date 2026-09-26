import {
  isResponseSelection,
  type ResponseReferenceAnchor
} from '$lib/stores/response-references.svelte'

/**
 * DOM geometry for quoted response annotations.
 *
 * Everything here works on live DOM ranges of an assistant response: turning a
 * response selection into a candidate anchor and rebuilding a highlight range
 * from persisted offsets. The parts that any annotated surface shares (offsets,
 * range rebuilding, highlight publishing, bubble measurement) live in
 * `$lib/selection-anchors`; what stays here is the response-specific half: which
 * element owns a selection, and how a selection action bubble is placed.
 */

export const RESPONSE_HIGHLIGHT_NAME = 'response-annotation'
/** Widest the selection action bubble may be before the viewport clamps it. */
const SELECTION_BUBBLE_WIDTH = 430
const SELECTION_BUBBLE_HEIGHT = 48
const VIEWPORT_MARGIN = 12

export interface ResponseSelectionCandidate {
  text: string
  messageId: string
  range: Range
  startOffset: number
  endOffset: number
  x: number
  y: number
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
  // Only an excerpt of an assistant response has a range inside the
  // conversation: a design reference points at an element in a served page and a
  // document annotation at a passage of a file, so neither is rebuilt here.
  if (!isResponseSelection(reference)) return null
  if (reference.messageId === undefined) return null
  if (reference.startOffset === undefined || reference.endOffset === undefined) return null
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
