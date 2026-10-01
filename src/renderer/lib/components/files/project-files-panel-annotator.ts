import { offsetsForRange } from '$lib/selection-anchors'
import type { ResponseReferenceAnchor } from '$lib/stores/response-references.svelte'

/**
 * Turning a selection in a rendered document into an annotation on the chat.
 *
 * An annotation is a composer reference like a response selection, so it travels
 * to the model exactly the same way; what differs is what it names. A response
 * selection is anchored to a message range, while a document annotation is
 * anchored to character offsets inside the rendered document and carries the
 * document's path in its label, which is what makes the agent read the right
 * file. Everything the panel needs from live DOM ranges is captured here.
 */

/** Widest the selection action bubble may be before the viewport clamps it. */
const SELECTION_BUBBLE_WIDTH = 430
const SELECTION_BUBBLE_HEIGHT = 48
const VIEWPORT_MARGIN = 12

/** How much of an annotated document rides along as a side chat's context. The
 *  same bound the spec studios use; past it the document is cut and the cut is
 *  stated, rather than quietly shrinking the evidence. */
const DOCUMENT_CONTEXT_LIMIT = 90_000

export interface DocumentSelectionCandidate {
  /** The selected passage, trimmed. */
  text: string
  /** The live range, so the highlight can be published before the document
   *  re-renders and the offsets are resolved again. */
  range: Range
  startOffset: number
  endOffset: number
  /** Where the action bubble goes, in viewport coordinates. */
  x: number
  y: number
}

/** The rendered Markdown a document's preview is showing, if it is mounted. */
function selectionRoot(node: Node | null, root: HTMLElement | null): HTMLElement | null {
  if (!root || !node) return null
  return root.contains(node) ? root : null
}

/**
 * Turn the current document selection into an annotation candidate. Returns null
 * when nothing is selected, when the selection reaches outside the rendered
 * document, or when it cannot be measured. The bubble is anchored above the
 * selection so it does not collide with the native right-click menu, which opens
 * at the cursor below the selection, falling back below when there is no room.
 */
export function captureDocumentSelection(
  root: HTMLElement | null
): DocumentSelectionCandidate | null {
  if (!root) return null
  const selection = document.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null
  const anchorRoot = selectionRoot(selection.anchorNode, root)
  const focusRoot = selectionRoot(selection.focusNode, root)
  if (!anchorRoot || anchorRoot !== focusRoot) return null
  const text = selection.toString().trim()
  if (!text) return null
  const range = selection.getRangeAt(0)
  const { startOffset, endOffset } = offsetsForRange(root, range)
  if (endOffset <= startOffset) return null
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
  return {
    text,
    range: range.cloneRange(),
    startOffset,
    endOffset,
    x,
    y
  }
}

/**
 * The context a side chat opened from a document passage is pinned to.
 *
 * A passage read on its own is often unreadable without the section around it, so
 * the document rides with the selection. The path is part of the context because
 * it is the one thing that lets the agent go and read the live file when the
 * snapshot here is stale: the panel shows whatever the document said when it was
 * rendered, which is not necessarily what it says on disk now.
 */
export function documentAnnotationChatContext(path: string, markdown: string): string {
  const bounded =
    markdown.length <= DOCUMENT_CONTEXT_LIMIT
      ? markdown
      : `${markdown.slice(0, DOCUMENT_CONTEXT_LIMIT)}\n\n[Document truncated for context limit]`
  return [
    `The user is reading a project document in the file panel and selected a passage of it. Treat it as read-only project context for questions about the attached passage, and read the file itself when the passage refers to anything outside it.`,
    `<document-file path="${path}">`,
    bounded,
    '</document-file>'
  ].join('\n\n')
}

/**
 * The composer reference for one annotated passage.
 *
 * The label is the document's project-relative path, not a number: the store
 * only numbers a response selection, and the path is what the agent needs in
 * order to find the passage again.
 */
export function documentAnnotationReference(
  id: string,
  path: string,
  selection: DocumentSelectionCandidate
): ResponseReferenceAnchor {
  return {
    id,
    kind: 'file',
    label: path,
    text: selection.text,
    filePath: path,
    startOffset: selection.startOffset,
    endOffset: selection.endOffset
  }
}
