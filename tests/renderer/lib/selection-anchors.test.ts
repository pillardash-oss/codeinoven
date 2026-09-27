// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import {
  anchorTextMatches,
  applyAnnotationHighlights,
  rangeForAnnotation,
  releaseAnnotationHighlights
} from '$lib/selection-anchors'

/**
 * A rendered document, as the annotate view mounts it: block elements with no
 * whitespace text nodes between them.
 */
function documentRoot(markup: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = markup
  document.body.appendChild(root)
  return root
}

/** The live range a selection produces, used to prove a rebuild landed on it. */
function rangeBetween(root: HTMLElement, startOffset: number, endOffset: number): Range {
  const nodes: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node) {
    if (node instanceof Text) nodes.push(node)
    node = walker.nextNode()
  }
  let cursor = 0
  const range = document.createRange()
  for (const text of nodes) {
    const next = cursor + text.data.length
    if (range.startContainer === range.endContainer && startOffset <= next) {
      if (startOffset >= cursor) range.setStart(text, startOffset - cursor)
      if (endOffset <= next) {
        range.setEnd(text, endOffset - cursor)
        break
      }
    }
    cursor = next
  }
  return range
}

const CROSS_BLOCK_MARKUP = '<p>Alpha beta gamma.</p><p>Delta epsilon zeta.</p>'
/** What `Selection.toString()` stores for a passage crossing a block boundary. */
const CROSS_BLOCK_QUOTE = 'beta gamma.\n\nDelta'

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('anchorTextMatches', () => {
  it('ignores the break a selection serializer inserts at a block boundary', () => {
    const root = documentRoot(CROSS_BLOCK_MARKUP)
    const range = rangeBetween(root, 6, 22)
    expect(range.toString()).toBe('beta gamma.Delta')
    expect(anchorTextMatches(range, CROSS_BLOCK_QUOTE)).toBe(true)
  })

  it('rejects a range that no longer spans the quote', () => {
    const root = documentRoot(CROSS_BLOCK_MARKUP)
    expect(anchorTextMatches(rangeBetween(root, 0, 3), CROSS_BLOCK_QUOTE)).toBe(false)
  })
})

describe('rangeForAnnotation', () => {
  it('re-anchors a cross-block passage from its stored offsets', () => {
    const root = documentRoot(CROSS_BLOCK_MARKUP)
    const range = rangeForAnnotation(root, {
      startOffset: 6,
      endOffset: 22,
      quote: CROSS_BLOCK_QUOTE
    })
    expect(range?.toString()).toBe('beta gamma.Delta')
  })

  it('finds the passage by quote when the stored offsets no longer describe it', () => {
    const root = documentRoot(CROSS_BLOCK_MARKUP)
    const range = rangeForAnnotation(root, {
      startOffset: 0,
      endOffset: 3,
      quote: CROSS_BLOCK_QUOTE
    })
    expect(range?.toString()).toBe('beta gamma.Delta')
  })

  it('returns null for a passage the document no longer contains', () => {
    const root = documentRoot(CROSS_BLOCK_MARKUP)
    expect(
      rangeForAnnotation(root, { startOffset: 6, endOffset: 22, quote: 'a rewritten passage' })
    ).toBeNull()
  })
})

describe('annotation highlights', () => {
  const name = 'test-annotation-anchor'
  const originalCss = Reflect.get(globalThis, 'CSS')
  const originalHighlight = Reflect.get(globalThis, 'Highlight')
  /**
   * The registry handed to the stubbed `CSS.highlights`, kept typed here so the
   * assertions can read back what the module published without widening the
   * DOM's `HighlightRegistry` to a `Map`.
   */
  let registry: Map<string, { ranges: readonly Range[] }>

  beforeEach(() => {
    class StubHighlight {
      readonly ranges: readonly Range[]
      constructor(...ranges: Range[]) {
        this.ranges = ranges
      }
    }
    registry = new Map<string, StubHighlight>()
    Reflect.set(globalThis, 'Highlight', StubHighlight)
    Reflect.set(globalThis, 'CSS', { ...(originalCss ?? {}), highlights: registry })
  })

  afterEach(() => {
    Reflect.set(globalThis, 'Highlight', originalHighlight)
    Reflect.set(globalThis, 'CSS', originalCss)
  })

  function publishedRanges(): readonly Range[] {
    return registry.get(name)?.ranges ?? []
  }

  it('keeps every publisher of one name, so two views can draw it at once', () => {
    const root = documentRoot(CROSS_BLOCK_MARKUP)
    const first = new Map([['a', rangeBetween(root, 0, 3)]])
    const second = new Map([['b', rangeBetween(root, 6, 22)]])
    const sidebar = {}
    const fullscreen = {}

    applyAnnotationHighlights(first, sidebar, name)
    applyAnnotationHighlights(second, fullscreen, name)
    expect(publishedRanges()).toHaveLength(2)

    // Closing the fullscreen reader must not take the sidebar's highlight with it.
    releaseAnnotationHighlights(fullscreen, name)
    expect(publishedRanges()).toHaveLength(1)

    releaseAnnotationHighlights(sidebar, name)
    expect(publishedRanges()).toHaveLength(0)
  })
})
