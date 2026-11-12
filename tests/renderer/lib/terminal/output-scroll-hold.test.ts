// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type { Terminal } from 'ghostty-web'
import { createOutputScrollHold } from '$lib/terminal/output-scroll-hold'

/**
 * A terminal that behaves like ghostty-web on write: new rows push older ones
 * into the scrollback and the library snaps the viewport back to the newest
 * line, which is exactly the snap this hold exists to undo.
 */
function fakeTerminal(rowsInView: number, scrollback: number, viewportY: number) {
  const state = {
    scrollback,
    viewportY,
    targetViewportY: viewportY,
    snapCount: 0,
    /** Absolute buffer row of the top visible line: the content the reader is
     *  looking at, whatever the scroll offset currently is. */
    get topAbsoluteRow(): number {
      return state.scrollback - state.viewportY
    }
  }
  const term = {
    getViewportY: (): number => state.viewportY,
    getScrollbackLength: (): number => state.scrollback,
    scrollToLine: (line: number): void => {
      state.viewportY = Math.max(0, Math.min(state.scrollback, line))
      state.targetViewportY = state.viewportY
    },
    write: (text: string): void => {
      const rows = text.split('\n').length - 1
      state.scrollback += rows
      // ghostty-web: `viewportY !== 0 && scrollToBottom()`.
      if (state.viewportY !== 0) {
        state.viewportY = 0
        state.snapCount += 1
      }
    }
  }
  return { term: term as unknown as Terminal, state, rowsInView }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('createOutputScrollHold', () => {
  it('keeps following the output while the reader is at the bottom', () => {
    const { term, state } = fakeTerminal(24, 0, 0)
    const host = document.createElement('div')
    document.body.append(host)
    const hold = createOutputScrollHold(term, host)

    hold.write('line\n')
    expect(state.scrollback).toBe(1)
    expect(state.viewportY).toBe(0)

    hold.dispose()
  })

  it('holds the reader’s place in a streaming log instead of snapping to the newest line', () => {
    const { term, state } = fakeTerminal(24, 100, 40)
    const host = document.createElement('div')
    document.body.append(host)
    const hold = createOutputScrollHold(term, host)
    const reading = state.topAbsoluteRow

    hold.write('one\ntwo\nthree\n')

    expect(state.viewportY).toBe(43)
    expect(state.topAbsoluteRow).toBe(reading)
    // The library still snaps internally; the hold puts the offset back.
    expect(state.snapCount).toBe(1)

    hold.dispose()
  })

  it('holds the viewport under a drag even at the bottom of the buffer', () => {
    const { term, state } = fakeTerminal(24, 100, 0)
    const host = document.createElement('div')
    document.body.append(host)
    const hold = createOutputScrollHold(term, host)
    const selected = state.topAbsoluteRow

    host.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }))
    hold.write('one\ntwo\n')
    expect(state.topAbsoluteRow).toBe(selected)

    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    hold.write('three\n')
    // Released: the reader keeps the place the drag anchored them to instead
    // of being yanked back to the newest line.
    expect(state.topAbsoluteRow).toBe(selected)

    hold.dispose()
  })

  it('never anchors past the oldest row the scrollback still holds', () => {
    const { term, state } = fakeTerminal(24, 10, 10)
    const host = document.createElement('div')
    document.body.append(host)
    const hold = createOutputScrollHold(term, host)

    hold.write('one\ntwo\n')

    expect(state.viewportY).toBe(12)
    expect(state.viewportY).toBeLessThanOrEqual(state.scrollback)

    hold.dispose()
  })
})
