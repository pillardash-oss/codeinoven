// @vitest-environment jsdom
import type { WebContents } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/main/system/logger', () => ({ Logger: { dev: () => {} } }))

import { installBrowserHistorySwipe } from '../../../src/main/browser/browser-service/browser-history-swipe'

interface FakeContents {
  isDestroyed: () => boolean
  executeJavaScriptInIsolatedWorld: (
    worldId: number,
    sources: { code: string }[]
  ) => Promise<unknown>
  navigationHistory: {
    canGoBack: () => boolean
    canGoForward: () => boolean
    goBack: () => void
    goForward: () => void
  }
  isFocused: () => boolean
  focus: () => void
}

/**
 * The page half runs for real: both scripts main sends are evaluated in this
 * jsdom window, so the test drives one observer and the service's answer to it.
 */
function fakeContents(): FakeContents & { back: number; forward: number; focused: () => void } {
  let focused = false
  const state = {
    back: 0,
    forward: 0,
    focused: () => {
      focused = true
    },
    isDestroyed: () => false,
    executeJavaScriptInIsolatedWorld: (
      _worldId: number,
      sources: { code: string }[]
    ): Promise<unknown> => {
      const source = sources[0]?.code ?? 'null'
      try {
        return Promise.resolve(new Function(`return (${source})`)())
      } catch (error) {
        return Promise.reject(error)
      }
    },
    navigationHistory: {
      canGoBack: () => true,
      canGoForward: () => true,
      goBack: () => {
        state.back += 1
      },
      goForward: () => {
        state.forward += 1
      }
    },
    isFocused: () => focused,
    focus: () => {
      focused = true
    }
  }
  return state
}

/** jsdom marks every synthetic event untrusted, so the reporter gets a raw one. */
class FakeWheelEvent {
  static DOM_DELTA_PIXEL = 0
  public isTrusted = true
  public deltaMode = 0
  public ctrlKey = false
  public metaKey = false
  public altKey = false
  public shiftKey = false
  public buttons = 0
  public defaultPrevented = false
  public composedPath = (): EventTarget[] => []
  constructor(
    public deltaX: number,
    public momentum: boolean,
    public deltaY: number
  ) {}
}

interface Spin {
  deltaX: number
  /** macOS reports a momentum phase only for a scroll whose fingers lifted. */
  momentum?: boolean
  deltaY?: number
  /** Time spent before this event, in milliseconds. */
  gapMs: number
}

type WheelHandler = (event: FakeWheelEvent) => void
let wheelHandler: WheelHandler | null = null

beforeEach(() => {
  wheelHandler = null
  delete (globalThis as { __cioHistorySwipeRelay?: unknown }).__cioHistorySwipeRelay
  vi.stubGlobal('WheelEvent', FakeWheelEvent)
  vi.spyOn(window, 'addEventListener').mockImplementation(((
    type: string,
    listener: unknown
  ): void => {
    if (type === 'wheel') wheelHandler = listener as WheelHandler
  }) as typeof window.addEventListener)
})

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Enough turns for the service to receive a report and re-arm its wait. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) await wait(0)
}

async function spinAll(gestures: Spin[]): Promise<void> {
  for (const gesture of gestures) {
    expect(wheelHandler).not.toBeNull()
    wheelHandler?.(
      new FakeWheelEvent(gesture.deltaX, gesture.momentum === true, gesture.deltaY ?? 0)
    )
    await wait(gesture.gapMs)
  }
}

/** Repeated identical steps, the shape of one gesture on one device. */
function repeat(count: number, step: Spin): Spin[] {
  return Array.from({ length: count }, () => ({ ...step }))
}

async function install(
  platform: NodeJS.Platform = 'darwin'
): Promise<FakeContents & { back: number; forward: number }> {
  const contents = fakeContents()
  installBrowserHistorySwipe(contents as unknown as WebContents, platform)
  await settle()
  expect(typeof wheelHandler).toBe('function')
  return contents
}

describe('browser history gesture, end to end', () => {
  it('walks back for a trackpad swipe that ends in inertia', async () => {
    const contents = await install()
    await spinAll(repeat(10, { deltaX: -8, gapMs: 4 }))
    await spinAll(repeat(10, { deltaX: -12, momentum: true, gapMs: 1 }))
    await settle()
    await wait(200)
    expect(contents.back).toBe(1)
  })

  it('walks forward only once for one swipe that keeps reporting', async () => {
    const contents = await install()
    await spinAll(repeat(18, { deltaX: 14, momentum: true, gapMs: 1 }))
    await settle()
    await wait(200)
    expect(contents.forward).toBe(1)
  })

  it('leaves a tilt wheel to the page even when it never pauses', async () => {
    const contents = await install()
    await spinAll(repeat(30, { deltaX: -40, gapMs: 40 }))
    await settle()
    await wait(200)
    expect(contents.back).toBe(0)
    expect(contents.forward).toBe(0)
  })

  it('leaves a fine smooth-scrolled tilt wheel to the page', async () => {
    const contents = await install()
    // Logitech's smooth scrolling: small, varied, close-packed deltas that look
    // exactly like a fine trackpad scroll, and no momentum because no finger
    // ever lifted off a trackpad.
    const magnitudes = [-5, -9, -7, -11, -6, -10, -8, -12]
    await spinAll(
      [...magnitudes, ...magnitudes, ...magnitudes].map((deltaX) => ({ deltaX, gapMs: 4 }))
    )
    await settle()
    await wait(200)
    expect(contents.back).toBe(0)
  })

  it('treats a diagonal inertial scroll as the page pan it is', async () => {
    const contents = await install()
    await spinAll(repeat(30, { deltaX: -12, deltaY: -40, momentum: true, gapMs: 1 }))
    await settle()
    await wait(200)
    expect(contents.back).toBe(0)
  })

  it('cancels a swipe that reverses direction', async () => {
    const contents = await install()
    await spinAll(repeat(10, { deltaX: -20, gapMs: 1 }))
    await spinAll(repeat(20, { deltaX: 20, momentum: true, gapMs: 1 }))
    await settle()
    await wait(200)
    expect(contents.back).toBe(0)
    expect(contents.forward).toBe(0)
  })

  it('navigates once even when two swipes arrive back to back inside the cooldown', async () => {
    const contents = await install()
    await spinAll(repeat(18, { deltaX: -14, momentum: true, gapMs: 1 }))
    await settle()
    await wait(400)
    // The second swipe starts inside the cooldown and outlasts its end, the way
    // one does on a slow machine where each step of the stream takes longer.
    await spinAll(
      Array.from({ length: 18 }, (_, index) => ({
        deltaX: index % 2 === 0 ? -12 : -16,
        momentum: true,
        gapMs: 25
      }))
    )
    await settle()
    await wait(200)
    expect(contents.back).toBe(1)
  })

  it('walks history for a fine trackpad swipe where no inertia is reported', async () => {
    const contents = await install('win32')
    await spinAll(repeat(24, { deltaX: -8, gapMs: 1 }))
    await settle()
    await wait(200)
    expect(contents.back).toBe(1)
  })

  it('leaves a tick-based tilt wheel to the page off macOS', async () => {
    const contents = await install('win32')
    await spinAll(repeat(10, { deltaX: 40, gapMs: 40 }))
    await settle()
    await wait(200)
    expect(contents.back).toBe(0)
  })
})
