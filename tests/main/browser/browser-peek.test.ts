import { describe, expect, it } from 'vitest'
import {
  parsePeekProbeAnswer,
  peekPointInFrame,
  peekProbePoint,
  peekProbeScript,
  resolvePeekOrigin
} from '../../../src/main/browser/browser-service/browser-peek'

const FRAME = { x: 100, y: 50, width: 1_000, height: 700 }

describe('peek origin resolution', () => {
  it('starts a flight on the link the probe found, moved to where the page is on screen', () => {
    expect(
      resolvePeekOrigin({
        link: { x: 40, y: 20, width: 180, height: 22 },
        point: { x: 240, y: 130 },
        frame: FRAME,
        zoomFactor: 1
      })
    ).toEqual({ x: 140, y: 70, width: 180, height: 22 })
  })

  it('starts a flight on the click alone when the page named no link', () => {
    const origin = resolvePeekOrigin({
      link: null,
      point: { x: 600, y: 400 },
      frame: FRAME,
      zoomFactor: 1
    })
    expect(origin.width).toBe(origin.height)
    expect(origin.x + origin.width / 2).toBe(600)
    expect(origin.y + origin.height / 2).toBe(400)
  })

  it('clips a link that is half scrolled off the frame', () => {
    expect(
      resolvePeekOrigin({
        link: { x: 20, y: -60, width: 200, height: 100 },
        point: { x: 220, y: 80 },
        frame: FRAME,
        zoomFactor: 1
      })
    ).toEqual({ x: 120, y: 50, width: 200, height: 40 })
  })

  it('cuts a link the size of the whole page back to a box around the click', () => {
    const origin = resolvePeekOrigin({
      link: { x: 0, y: 0, width: 4_000, height: 3_000 },
      point: { x: 800, y: 450 },
      frame: FRAME,
      zoomFactor: 1
    })
    expect(origin.width).toBe(FRAME.width / 2)
    expect(origin.height).toBe(FRAME.height / 2)
    expect(origin.x).toBeLessThanOrEqual(800)
    expect(origin.x + origin.width).toBeGreaterThanOrEqual(800)
    expect(origin.y).toBeLessThanOrEqual(450)
    expect(origin.y + origin.height).toBeGreaterThanOrEqual(450)
  })

  it('turns the page CSS pixels a zoomed page answers in back into the view own pixels', () => {
    expect(
      resolvePeekOrigin({
        link: { x: 40, y: 20, width: 90, height: 11 },
        point: { x: 340, y: 190 },
        frame: FRAME,
        zoomFactor: 2
      })
    ).toEqual({ x: 180, y: 90, width: 180, height: 22 })
  })

  it('keeps an origin inside the frame even for a click outside it', () => {
    const origin = resolvePeekOrigin({
      link: null,
      point: { x: 5_000, y: 5_000 },
      frame: FRAME,
      zoomFactor: 1
    })
    expect(origin.x + origin.width).toBeLessThanOrEqual(FRAME.x + FRAME.width)
    expect(origin.y + origin.height).toBeLessThanOrEqual(FRAME.y + FRAME.height)
    expect(origin.width).toBeGreaterThanOrEqual(1)
    expect(origin.height).toBeGreaterThanOrEqual(1)
  })

  it('ignores a zoom factor it cannot use', () => {
    expect(peekProbePoint({ x: 40, y: 20 }, 0)).toEqual({ x: 40, y: 20 })
    expect(peekProbePoint({ x: 40, y: 20 }, Number.NaN)).toEqual({ x: 40, y: 20 })
    expect(peekProbePoint({ x: 40, y: 20 }, 2)).toEqual({ x: 20, y: 10 })
  })
})

describe('peek probe answers', () => {
  it('accepts a rectangle a page reported', () => {
    expect(parsePeekProbeAnswer({ x: 1, y: 2, width: 3, height: 4 })).toEqual({
      x: 1,
      y: 2,
      width: 3,
      height: 4
    })
  })

  it('refuses anything that is not a finite rectangle', () => {
    expect(parsePeekProbeAnswer(null)).toBeNull()
    expect(parsePeekProbeAnswer('a rectangle')).toBeNull()
    expect(parsePeekProbeAnswer([1, 2, 3, 4])).toBeNull()
    expect(parsePeekProbeAnswer({ x: 1, y: 2, width: 3 })).toBeNull()
    expect(parsePeekProbeAnswer({ x: 1, y: 2, width: '3', height: 4 })).toBeNull()
    expect(parsePeekProbeAnswer({ x: 1, y: 2, width: Number.NaN, height: 4 })).toBeNull()
    expect(parsePeekProbeAnswer({ x: 1, y: 2, width: 0, height: 4 })).toBeNull()
    expect(parsePeekProbeAnswer({ x: 1, y: 2, width: 3, height: -4 })).toBeNull()
  })

  it('asks the page for the anchor under the point and nothing else', () => {
    const script = peekProbeScript({ x: 12, y: 34 })
    expect(script).toContain('elementFromPoint(12, 34)')
    expect(script).toContain("closest('a[href]')")
  })
})

describe('peek pointer points', () => {
  it('reports a pointer over the page and refuses one that is not', () => {
    expect(peekPointInFrame({ x: 10, y: 20 }, FRAME)).toEqual({ x: 10, y: 20 })
    expect(peekPointInFrame({ x: -1, y: 20 }, FRAME)).toBeNull()
    expect(peekPointInFrame({ x: 10, y: -1 }, FRAME)).toBeNull()
    expect(peekPointInFrame({ x: FRAME.width, y: 20 }, FRAME)).toBeNull()
    expect(peekPointInFrame({ x: 10, y: FRAME.height }, FRAME)).toBeNull()
  })
})
