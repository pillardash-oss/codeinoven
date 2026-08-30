import { describe, expect, it } from 'vitest'
import { SCROLL_AT_BOTTOM_THRESHOLD, isAtLatest, mayReanchorToLatest } from '$lib/scroll-anchor'

function extents(
  overrides: Partial<{ scrollHeight: number; scrollTop: number; clientHeight: number }> = {}
): { scrollHeight: number; scrollTop: number; clientHeight: number } {
  return { scrollHeight: 10_000, scrollTop: 0, clientHeight: 800, ...overrides }
}

describe('isAtLatest', () => {
  it('is true when the viewport is exactly at the bottom', () => {
    const bottom = 10_000 - 800
    expect(isAtLatest(extents({ scrollTop: bottom }))).toBe(true)
  })

  it('is true within the tolerance above the bottom', () => {
    const bottom = 10_000 - 800
    expect(isAtLatest(extents({ scrollTop: bottom - SCROLL_AT_BOTTOM_THRESHOLD + 1 }))).toBe(true)
  })

  it('is false once the reader scrolls beyond the tolerance', () => {
    const bottom = 10_000 - 800
    expect(isAtLatest(extents({ scrollTop: bottom - SCROLL_AT_BOTTOM_THRESHOLD }))).toBe(false)
  })

  it('is false at the top of a long conversation', () => {
    expect(isAtLatest(extents())).toBe(false)
  })

  it('is true when the content is shorter than the viewport (no scrolling)', () => {
    expect(isAtLatest(extents({ scrollHeight: 400, scrollTop: 0, clientHeight: 800 }))).toBe(true)
  })
})

describe('mayReanchorToLatest', () => {
  it('follows new content while the reader is still at the bottom', () => {
    expect(mayReanchorToLatest(false)).toBe(true)
  })

  it('never moves the viewport once the reader scrolled up — no fighting, no jumping', () => {
    expect(mayReanchorToLatest(true)).toBe(false)
  })
})
