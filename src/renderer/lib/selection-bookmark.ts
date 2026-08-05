export interface ElementSelectionBookmark {
  element: HTMLElement
  anchor: number
  focus: number
}

function nodeLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent?.length ?? 0
  if (node instanceof HTMLBRElement) return 1
  return Array.from(node.childNodes).reduce((total, child) => total + nodeLength(child), 0)
}

function pointOffset(root: Node, target: Node, targetOffset: number): number | null {
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

function pointAtOffset(root: Node, requestedOffset: number): { node: Node; offset: number } {
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
    for (const child of Array.from(node.childNodes)) {
      const point = visit(child)
      if (point) return point
    }
    return null
  }

  return visit(root) ?? { node: root, offset: root.childNodes.length }
}

export function captureElementSelection(element: HTMLElement): ElementSelectionBookmark | null {
  const selection = window.getSelection()
  if (
    !selection?.anchorNode ||
    !selection.focusNode ||
    !element.contains(selection.anchorNode) ||
    !element.contains(selection.focusNode)
  ) {
    return null
  }

  const anchor = pointOffset(element, selection.anchorNode, selection.anchorOffset)
  const focus = pointOffset(element, selection.focusNode, selection.focusOffset)
  return anchor === null || focus === null ? null : { element, anchor, focus }
}

export function restoreElementSelection(bookmark: ElementSelectionBookmark): boolean {
  if (!bookmark.element.isConnected) return false

  bookmark.element.focus({ preventScroll: true })
  const selection = window.getSelection()
  if (!selection) return true

  const anchor = pointAtOffset(bookmark.element, bookmark.anchor)
  const focus = pointAtOffset(bookmark.element, bookmark.focus)
  selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset)
  return true
}
