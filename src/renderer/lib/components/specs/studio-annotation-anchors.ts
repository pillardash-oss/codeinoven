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
