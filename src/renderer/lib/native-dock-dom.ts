/** Update projected controls in place so hover and a pending mouse press survive a paint. */
export function patchNativeDockChildren(parent: Element, next: readonly Node[]): void {
  const keyed = new Map<string, Node>()
  for (const child of parent.childNodes) {
    const key = nodeKey(child)
    if (key) keyed.set(key, child)
  }
  let cursor = parent.firstChild
  for (const candidate of next) {
    const key = nodeKey(candidate)
    const existing = key ? keyed.get(key) : cursor && !nodeKey(cursor) ? cursor : undefined
    const node =
      existing && compatible(existing, candidate) ? patch(existing, candidate) : candidate
    if (node !== cursor) parent.insertBefore(node, cursor)
    cursor = node.nextSibling
  }
  while (cursor) {
    const following = cursor.nextSibling
    parent.removeChild(cursor)
    cursor = following
  }
}

function nodeKey(node: Node): string | null {
  if (!(node instanceof Element)) return null
  return (
    node.getAttribute('data-native-dock-key') ??
    node.getAttribute('data-native-dock-action') ??
    node.getAttribute('data-native-dock-scroll')
  )
}

function compatible(current: Node, next: Node): boolean {
  return (
    current.nodeType === next.nodeType &&
    (!(current instanceof Element) ||
      (next instanceof Element &&
        current.localName === next.localName &&
        current.namespaceURI === next.namespaceURI))
  )
}

function patch(current: Node, next: Node): Node {
  if (current instanceof Element && next instanceof Element) {
    for (const attribute of [...current.attributes]) {
      if (!next.hasAttribute(attribute.name) && attribute.name !== 'data-native-modal-row')
        current.removeAttribute(attribute.name)
    }
    for (const attribute of next.attributes) {
      if (current.getAttribute(attribute.name) !== attribute.value)
        current.setAttribute(attribute.name, attribute.value)
    }
    patchNativeDockChildren(current, [...next.childNodes])
  } else if (current.nodeValue !== next.nodeValue) {
    current.nodeValue = next.nodeValue
  }
  return current
}
