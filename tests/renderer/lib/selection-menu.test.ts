// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  claimSelectionAnnotationMenu,
  isEditingTarget,
  registerSelectionAnnotationClaim,
  trackLiveSelection
} from '$lib/selection-menu'

/** Frames scheduled by the tracker, so a test drives them explicitly. */
let frames: FrameRequestCallback[] = []

function flushFrame(): void {
  const pending = frames
  frames = []
  for (const callback of pending) callback(0)
}

/** A right-click, as the surfaces receive it. */
function contextMenu(target: Element): MouseEvent {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'target', { value: target })
  return event
}

beforeEach(() => {
  document.body.innerHTML = ''
  frames = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
    frames = frames.filter((_, index) => index + 1 !== handle)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('selection annotation claims', () => {
  it('lets the first surface that takes the right-click own it', () => {
    const taken: string[] = []
    const disposers = [
      registerSelectionAnnotationClaim(() => {
        taken.push('declines')
        return false
      }),
      registerSelectionAnnotationClaim(() => {
        taken.push('takes')
        return true
      })
    ]
    expect(claimSelectionAnnotationMenu(contextMenu(document.body))).toBe(true)
    expect(taken).toEqual(['declines', 'takes'])
    for (const dispose of disposers) dispose()
  })

  it('ignores a claim a surface withdrew, so an unmounted view owns nothing', () => {
    const dispose = registerSelectionAnnotationClaim(() => true)
    dispose()
    expect(claimSelectionAnnotationMenu(contextMenu(document.body))).toBe(false)
  })
})

describe('isEditingTarget', () => {
  it('recognises fields, which keep their own menu', () => {
    document.body.innerHTML =
      '<div contenteditable="true"><p><span id="inside">note</span></p></div>' +
      '<input id="field" />' +
      '<p><span id="prose">a passage</span></p>'
    expect(isEditingTarget(document.getElementById('inside'))).toBe(true)
    expect(isEditingTarget(document.getElementById('field'))).toBe(true)
    expect(isEditingTarget(document.getElementById('prose'))).toBe(false)
    expect(isEditingTarget(null)).toBe(false)
  })
})

describe('trackLiveSelection', () => {
  it('reports the selection once per frame while the user shapes it', () => {
    let captured = 'first'
    const reported: string[] = []
    const stop = trackLiveSelection(
      () => captured,
      (candidate) => reported.push(candidate ?? 'none')
    )

    // Shift and an arrow key, three times: one frame's worth of work.
    captured = 'second'
    document.dispatchEvent(new Event('selectionchange'))
    captured = 'third'
    document.dispatchEvent(new Event('selectionchange'))
    flushFrame()
    expect(reported).toEqual(['third'])

    captured = 'fourth'
    document.dispatchEvent(new Event('selectionchange'))
    flushFrame()
    expect(reported).toEqual(['third', 'fourth'])

    stop()
  })

  it('reports a selection that collapsed, so the menu can close', () => {
    const reported: Array<string | null> = []
    const stop = trackLiveSelection(
      () => null,
      (candidate) => reported.push(candidate)
    )
    document.dispatchEvent(new Event('selectionchange'))
    flushFrame()
    expect(reported).toEqual([null])
    stop()
  })

  it('stops watching once disposed', () => {
    const reported: string[] = []
    const stop = trackLiveSelection(
      () => 'passage',
      (candidate) => reported.push(candidate ?? 'none')
    )
    stop()
    document.dispatchEvent(new Event('selectionchange'))
    flushFrame()
    expect(reported).toEqual([])
  })
})
