import { describe, expect, it } from 'vitest'
import {
  PEEK_CLOSE_MS,
  PEEK_EXPAND_MS,
  PEEK_OPEN_MS,
  peekFlightFor,
  peekFlightKeyframes,
  peekFlightStartTransform,
  peekLandingFor,
  peekPageOnScreen,
  peekRectTransform,
  type PeekRect
} from '$lib/components/browser/browser-peek-transition'

const PANEL: PeekRect = { x: 120, y: 80, width: 900, height: 640 }
const LINK: PeekRect = { x: 300, y: 400, width: 180, height: 22 }
const ROW: PeekRect = { x: 16, y: 220, width: 240, height: 34 }

describe('peek flight plans', () => {
  it('opens the panel itself out of the link, carrying its loading state', () => {
    const flight = peekFlightFor({
      phase: 'opening',
      pictured: false,
      origin: LINK,
      panel: PANEL,
      target: null
    })
    expect(flight).toMatchObject({
      from: LINK,
      to: PANEL,
      anchor: 'to',
      carries: 'loading',
      durationMs: PEEK_OPEN_MS,
      fadesOnLanding: false
    })
  })

  it('grows out of a box at its own centre when nothing named a source', () => {
    const flight = peekFlightFor({
      phase: 'opening',
      pictured: false,
      origin: null,
      panel: PANEL,
      target: null
    })
    expect(flight?.from.width).toBeLessThan(PANEL.width)
    expect(flight?.from.height).toBeLessThan(PANEL.height)
    expect((flight?.from.x ?? 0) + (flight?.from.width ?? 0) / 2).toBe(PANEL.x + PANEL.width / 2)
    expect((flight?.from.y ?? 0) + (flight?.from.height ?? 0) / 2).toBe(PANEL.y + PANEL.height / 2)
  })

  it('carries the page back into the link on close, and flies the panel when there is nothing to picture', () => {
    const closed = peekFlightFor({
      phase: 'closing',
      pictured: true,
      origin: LINK,
      panel: PANEL,
      target: null
    })
    expect(closed).toMatchObject({
      from: PANEL,
      to: LINK,
      anchor: 'from',
      carries: 'picture',
      durationMs: PEEK_CLOSE_MS
    })
    expect(
      peekFlightFor({
        phase: 'closing',
        pictured: false,
        origin: LINK,
        panel: PANEL,
        target: null
      })
    ).toMatchObject({ from: PANEL, carries: 'loading' })
  })

  it('carries the page into the tab row on expand, and dissolves as it lands there', () => {
    expect(
      peekFlightFor({
        phase: 'expanding',
        pictured: true,
        origin: LINK,
        panel: PANEL,
        target: ROW
      })
    ).toMatchObject({
      from: PANEL,
      to: ROW,
      anchor: 'from',
      carries: 'picture',
      durationMs: PEEK_EXPAND_MS,
      fadesOnLanding: true
    })
  })

  it('flies in place on expand when the strip cannot say where the row is', () => {
    expect(
      peekFlightFor({
        phase: 'expanding',
        pictured: true,
        origin: LINK,
        panel: PANEL,
        target: null
      })
    ).toBeNull()
  })

  it('animates nothing once the peek is where it belongs', () => {
    expect(
      peekFlightFor({
        phase: 'open',
        pictured: true,
        origin: LINK,
        panel: PANEL,
        target: ROW
      })
    ).toBeNull()
  })

  it('starts an exit from the panel own rectangle whatever a flight before it had reached', () => {
    expect(
      peekFlightFor({
        phase: 'closing',
        pictured: false,
        origin: LINK,
        panel: PANEL,
        target: null
      })?.from
    ).toEqual(PANEL)
  })
})

describe('peek flight frames', () => {
  const flight = {
    from: LINK,
    to: PANEL,
    anchor: 'to' as const,
    carries: 'loading' as const,
    durationMs: PEEK_OPEN_MS,
    easing: 'linear',
    fadesOnLanding: false
  }

  it('draws an element between two rectangles with one transform around its top left', () => {
    expect(peekRectTransform(PANEL, LINK)).toBe(
      `translate(${LINK.x - PANEL.x}px, ${LINK.y - PANEL.y}px) scale(${LINK.width / PANEL.width}, ${LINK.height / PANEL.height})`
    )
    expect(peekRectTransform(PANEL, PANEL)).toBe('translate(0px, 0px) scale(1, 1)')
  })

  it('starts an arrival flight away from where it lands and finishes on its own box', () => {
    const frames = peekFlightKeyframes(flight)
    expect(frames).toHaveLength(2)
    expect(frames[0]?.transform).toBe(peekFlightStartTransform(flight))
    expect(frames[0]?.transform).toBe(peekRectTransform(PANEL, LINK))
    expect(frames[1]?.transform).toBe('translate(0px, 0px) scale(1, 1)')
  })

  it('starts an exit flight on the box it was laid out at, so its first frame stands in for the surface', () => {
    const exit = {
      from: PANEL,
      to: LINK,
      anchor: 'from' as const,
      carries: 'picture' as const,
      durationMs: PEEK_CLOSE_MS,
      easing: 'linear',
      fadesOnLanding: false
    }
    const frames = peekFlightKeyframes(exit)
    expect(frames[0]?.transform).toBe('translate(0px, 0px) scale(1, 1)')
    expect(frames[1]?.transform).toBe(peekRectTransform(PANEL, LINK))
  })

  it('dissolves the last stretch of a flight that lands on chrome of its own', () => {
    const frames = peekFlightKeyframes({ ...flight, fadesOnLanding: true })
    expect(frames).toHaveLength(3)
    expect(frames[2]?.opacity).toBe(0)
    const offsets = frames.map((frame) => frame.offset)
    expect(offsets[1]).toBeGreaterThan(0)
    expect(offsets[2]).toBe(1)
  })

  it('never divides by a zero sized rectangle', () => {
    expect(peekRectTransform(PANEL, { x: 0, y: 0, width: 0, height: 0 })).toBe(
      `translate(${-PANEL.x}px, ${-PANEL.y}px) scale(0, 0)`
    )
    expect(peekRectTransform({ x: 0, y: 0, width: 0, height: 0 }, PANEL)).toBe(
      `translate(${PANEL.x}px, ${PANEL.y}px) scale(${PANEL.width}, ${PANEL.height})`
    )
  })
})

describe('peek landing decisions', () => {
  it('maps each phase onto the step it finishes', () => {
    expect(peekLandingFor('opening')).toBe('open')
    expect(peekLandingFor('closing')).toBe('close')
    expect(peekLandingFor('expanding')).toBe('expand')
    expect(peekLandingFor('open')).toBeNull()
  })
})

describe('peek page on screen', () => {
  it('keeps an empty view covered until the opening flight has landed', () => {
    expect(peekPageOnScreen({ landed: false, documentSeen: true, loading: false })).toBe(false)
  })

  it('keeps the page covered while it has no document, or is still loading', () => {
    expect(peekPageOnScreen({ landed: true, documentSeen: false, loading: false })).toBe(false)
    expect(peekPageOnScreen({ landed: true, documentSeen: true, loading: true })).toBe(false)
  })

  it('puts the page on screen once it has landed with a document and no load', () => {
    expect(peekPageOnScreen({ landed: true, documentSeen: true, loading: false })).toBe(true)
  })
})
