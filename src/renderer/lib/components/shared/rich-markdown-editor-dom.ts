export interface SelectionBookmark {
  anchor: number
  focus: number
}

export const BLOCK_BOUNDARY_SELECTOR =
  'p, div, li, ul, ol, blockquote, h1, h2, h3, h4, h5, h6, pre, table, tr'

export const INLINE_BOUNDARY_TAGS = new Set([
  'CODE',
  'STRONG',
  'B',
  'EM',
  'I',
  'DEL',
  'S',
  'STRIKE'
])

/** Length a non-editable inline token occupies in serialized markdown: inline
 *  badges keep their stored value, footnote superscripts their `[^label]`. */
export function inlineTokenLength(node: HTMLElement): number | null {
  if (node.dataset.editorInlineBadge === 'true') return node.dataset.editorValue?.length ?? 0
  const footnote = node.dataset.editorFootnoteRef
  if (footnote !== undefined) return footnote.length + 3
  return null
}

export function nodeLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent?.length ?? 0
  if (node instanceof HTMLBRElement) return 1
  if (node instanceof HTMLElement) {
    const tokenLength = inlineTokenLength(node)
    if (tokenLength !== null) return tokenLength
  }
  return Array.from(node.childNodes).reduce((total, child) => total + nodeLength(child), 0)
}

export function pointOffset(root: Node, target: Node, targetOffset: number): number | null {
  let offset = 0

  function visit(node: Node): boolean {
    if (node === target) {
      if (node.nodeType === Node.TEXT_NODE) {
        offset += Math.min(targetOffset, node.textContent?.length ?? 0)
      } else {
        const children = Array.from(node.childNodes).slice(0, targetOffset)
        offset += children.reduce((total, child) => total + nodeLength(child), 0)
      }
      return true
    }
    if (node.nodeType === Node.TEXT_NODE) {
      offset += node.textContent?.length ?? 0
      return false
    }
    if (node instanceof HTMLBRElement) {
      offset += 1
      return false
    }
    for (const child of Array.from(node.childNodes)) {
      if (visit(child)) return true
    }
    return false
  }

  return visit(root) ? offset : null
}

export function pointAtOffset(root: Node, requestedOffset: number): { node: Node; offset: number } {
  let remaining = Math.max(0, requestedOffset)

  function visit(node: Node): { node: Node; offset: number } | null {
    if (node.nodeType === Node.TEXT_NODE) {
      const length = node.textContent?.length ?? 0
      if (remaining <= length) return { node, offset: remaining }
      remaining -= length
      return null
    }
    if (node instanceof HTMLBRElement) {
      if (remaining === 0 && node.parentNode) {
        return {
          node: node.parentNode,
          offset: Array.from(node.parentNode.childNodes).indexOf(node)
        }
      }
      remaining = Math.max(0, remaining - 1)
      return null
    }
    if (node instanceof HTMLElement && inlineTokenLength(node) !== null) {
      const parent = node.parentNode
      const index = parent ? Array.from(parent.childNodes).indexOf(node) : -1
      const length = inlineTokenLength(node) ?? 0
      if (parent && index >= 0 && remaining <= length) {
        return { node: parent, offset: index + (remaining === 0 ? 0 : 1) }
      }
      remaining = Math.max(0, remaining - length)
      return null
    }
    for (const child of Array.from(node.childNodes)) {
      const point = visit(child)
      if (point) return point
    }
    return null
  }

  return visit(root) ?? { node: root, offset: root.childNodes.length }
}

/** Visible characters in a text node: zero-width caret anchors are stripped by
 *  serialization, so they must never shift a bookmark across a serialize then
 *  re-render round trip (which always drops them from the DOM). */
export function visibleTextLength(text: string | null | undefined): number {
  return (text ?? '').replace(/\u200b/g, '').length
}

/** Characters of a node up to an offset, ignoring zero-width anchors. */
export function visibleCharsBefore(text: string, offset: number): number {
  let count = 0
  const length = Math.min(offset, text.length)
  for (let index = 0; index < length; index += 1) {
    if (text.charCodeAt(index) !== 0x200b) count += 1
  }
  return count
}

export function nodeVisibleLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return visibleTextLength(node.textContent)
  if (node instanceof HTMLBRElement) return 1
  if (node instanceof HTMLElement) {
    const tokenLength = inlineTokenLength(node)
    if (tokenLength !== null) return tokenLength
  }
  return Array.from(node.childNodes).reduce((total, child) => total + nodeVisibleLength(child), 0)
}

/** Caret position measured in the same coordinates a freshly re-rendered editor
 *  will use (zero-width anchors are absent there), so a bookmark taken on the old
 *  DOM lands exactly where the caret belongs after `replaceEditorContent`. */
export function pointVisibleOffset(root: Node, target: Node, targetOffset: number): number | null {
  let offset = 0

  function visit(node: Node): boolean {
    if (node === target) {
      if (node.nodeType === Node.TEXT_NODE) {
        offset += visibleCharsBefore(node.textContent ?? '', targetOffset)
      } else {
        const children = Array.from(node.childNodes).slice(0, targetOffset)
        offset += children.reduce((total, child) => total + nodeVisibleLength(child), 0)
      }
      return true
    }
    if (node.nodeType === Node.TEXT_NODE) {
      offset += visibleTextLength(node.textContent)
      return false
    }
    if (node instanceof HTMLBRElement) {
      offset += 1
      return false
    }
    for (const child of Array.from(node.childNodes)) {
      if (visit(child)) return true
    }
    return false
  }

  return visit(root) ? offset : null
}

/** Bookmarks the current caret in visible coordinates so it survives a full
 *  re-render of the editor content. */
export function captureVisibleSelection(editor: HTMLElement): SelectionBookmark | null {
  const selection = window.getSelection()
  if (
    !selection?.anchorNode ||
    !selection.focusNode ||
    !editor.contains(selection.anchorNode) ||
    !editor.contains(selection.focusNode)
  ) {
    return null
  }
  const anchor = pointVisibleOffset(editor, selection.anchorNode, selection.anchorOffset)
  const focus = pointVisibleOffset(editor, selection.focusNode, selection.focusOffset)
  return anchor === null || focus === null ? null : { anchor, focus }
}

/**
 * Flattens editor content up to the caret, inserting '\n' at block
 * boundaries and `<br>`s. `Range.toString()` only concatenates text nodes,
 * so without this the first line gets glued to the second and the
 * `(^|\s)`-anchored slash/mention patterns stop matching off the first line.
 */
export function flattenWithNewlines(node: Node): string {
  if (node instanceof Text) return node.data
  if (node instanceof Element && node.tagName === 'BR') return '\n'
  let text = ''
  for (const child of node.childNodes) {
    const childText = flattenWithNewlines(child)
    if (
      childText !== '' &&
      text !== '' &&
      !text.endsWith('\n') &&
      child instanceof Element &&
      child.matches(BLOCK_BOUNDARY_SELECTOR)
    ) {
      text += '\n'
    }
    text += childText
  }
  return text
}

export function nodeHasVisibleContent(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent ?? '').replace(/[\u200b\u00a0]/g, '').trim().length > 0
  }
  if (node instanceof HTMLBRElement) return false
  return true
}

/** Rewrites macOS smart-punctuation substitutions back to the literal ASCII
 *  characters the user typed. A dev workspace needs real characters, not
 *  typographic ones. */
export function demoteSmartPunctuation(text: string): string {
  return text
    .replaceAll('…', '...')
    .replaceAll(/[\u2018\u2019\u201b]/gu, "'")
    .replaceAll(/[\u201c\u201d\u201f]/gu, '"')
    .replaceAll('\u2013', '-')
    .replaceAll('\u2014', '--')
}

export function nodeHasText(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '').length > 0
  if (node instanceof HTMLElement) return Array.from(node.childNodes).some(nodeHasText)
  return false
}

export function childIndexOf(parent: Node, child: Node): number {
  return Array.from(parent.childNodes).findIndex((node) => node === child)
}

export function hasTextBefore(root: HTMLElement, container: Node, offset: number): boolean {
  if (container.nodeType === Node.TEXT_NODE) {
    if (offset > 0) return true
    const parent = container.parentNode
    return parent ? hasTextBefore(root, parent, childIndexOf(parent, container)) : false
  }
  const children = Array.from(container.childNodes)
  for (let index = offset - 1; index >= 0; index -= 1) {
    if (nodeHasText(children[index])) return true
  }
  if (container === root) return false
  const parent = container.parentNode
  return parent ? hasTextBefore(root, parent, childIndexOf(parent, container)) : false
}

export function hasTextAfter(root: HTMLElement, container: Node, offset: number): boolean {
  if (container.nodeType === Node.TEXT_NODE) {
    if (offset < (container.textContent?.length ?? 0)) return true
    const parent = container.parentNode
    return parent ? hasTextAfter(root, parent, childIndexOf(parent, container) + 1) : false
  }
  const children = Array.from(container.childNodes)
  for (let index = offset; index < children.length; index += 1) {
    if (nodeHasText(children[index])) return true
  }
  if (container === root) return false
  const parent = container.parentNode
  return parent ? hasTextAfter(root, parent, childIndexOf(parent, container) + 1) : false
}

export function isCursorAtBoundary(element: HTMLElement, start: boolean): boolean {
  const selection = window.getSelection()
  if (!selection?.rangeCount || !element.contains(selection.anchorNode)) return false
  const range = selection.getRangeAt(0)
  return start
    ? !hasTextBefore(element, range.startContainer, range.startOffset)
    : !hasTextAfter(element, range.endContainer, range.endOffset)
}

/** The inline element whose very start (left) or very end (right) the collapsed
 *  caret is sitting at, or null when the caret is not on such a boundary. */
export function inlineElementAtBoundary(editor: HTMLElement, left: boolean): HTMLElement | null {
  const selection = window.getSelection()
  if (!selection?.isCollapsed || !selection.anchorNode) return null
  const anchor = selection.anchorNode
  let element: HTMLElement | null
  if (anchor instanceof Text) {
    element = anchor.parentElement
  } else if (anchor instanceof HTMLElement) {
    // Caret collapsed directly inside an inline element that has no text child at the
    // caret, e.g. an empty <code></code>. The element itself is the anchor node.
    element = anchor
  } else {
    return null
  }
  if (!(element instanceof HTMLElement) || !editor.contains(element)) return null
  if (!INLINE_BOUNDARY_TAGS.has(element.tagName)) return null
  // Ignore <code> inside <pre>: code-block content has its own boundary rules.
  if (element.parentElement?.tagName === 'PRE') return null
  const offset = selection.anchorOffset
  // A boundary is the position where no text remains before (left) or after (right)
  // the caret inside the element, even if the element ends in a <br> or is empty.
  const boundary = left
    ? !hasTextBefore(element, anchor, offset)
    : !hasTextAfter(element, anchor, offset)
  if (!boundary) return null
  return element
}

export function hasRealAdjacentContent(element: HTMLElement, left: boolean): boolean {
  let sibling = left ? element.previousSibling : element.nextSibling
  while (sibling) {
    if (nodeHasVisibleContent(sibling)) return true
    sibling = left ? sibling.previousSibling : sibling.nextSibling
  }
  return false
}

export function moveCaretOutOfInlineElement(left: boolean, element: HTMLElement): void {
  let anchor: Text | null
  if (left) {
    const prev = element.previousSibling
    if (prev instanceof Text && /^[\u200b]+$/u.test(prev.data)) {
      anchor = prev
    } else {
      element.before(document.createTextNode('\u200b'))
      anchor = element.previousSibling instanceof Text ? element.previousSibling : null
    }
  } else {
    const next = element.nextSibling
    if (next instanceof Text && /^[\u200b]+$/u.test(next.data)) {
      anchor = next
    } else {
      element.after(document.createTextNode('\u200b'))
      anchor = element.nextSibling instanceof Text ? element.nextSibling : null
    }
  }
  if (!anchor) return
  const selection = window.getSelection()
  if (!selection) return
  const range = document.createRange()
  range.setStart(anchor, left ? 0 : 1)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
}
