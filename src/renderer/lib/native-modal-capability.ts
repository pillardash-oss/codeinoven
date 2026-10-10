import { MAX_NATIVE_DOCK_NODES, NATIVE_DOCK_TAGS } from '$shared/native-dock'

/** Only promote dialogs whose complete visible content and actions can be projected. */
export function supportsNativeModal(root: HTMLElement): boolean {
  let count = 0
  function visit(node: Node, depth: number): boolean {
    if (++count > MAX_NATIVE_DOCK_NODES || depth > 24) return false
    if (!(node instanceof Element)) return true
    if (node.classList.contains('hidden') || node.hasAttribute('hidden')) return true
    const field = node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement
    if (
      !NATIVE_DOCK_TAGS.has(node.localName) ||
      (node instanceof HTMLInputElement &&
        !['text', 'search', 'url', 'email', 'tel', 'range', 'color'].includes(node.type)) ||
      node.hasAttribute('contenteditable') ||
      (node.hasAttribute('aria-haspopup') && node.getAttribute('aria-haspopup') !== 'false') ||
      (!field &&
        node.localName !== 'button' &&
        (node.getAttribute('role') === 'button' ||
          (node.hasAttribute('tabindex') && Number(node.getAttribute('tabindex')) >= 0)))
    )
      return false
    for (const child of node.childNodes) if (!visit(child, depth + 1)) return false
    return true
  }
  return visit(root, 0)
}
