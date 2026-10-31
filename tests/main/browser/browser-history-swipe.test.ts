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

function fakeContents(): FakeContents & { back: number; forward: number } {
  const state = {
    back: 0,
    forward: 0,
    isDestroyed: () => false,
    executeJavaScriptInIsolatedWorld: (
      _worldId: number,
      sources: { code: string }[]
    ): Promise<unknown> => {
      const source = sources[0]?.code ?? 'null'
      return Promise.resolve(new Function(`return (${source})`)())
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
    isFocused: () => true,
    focus: () => {}
  }
  return state
}

/** jsdom marks every synthetic event untrusted, so the observer gets a raw one. */
class FakeWheelEvent {
  static DOM_DELTA_PIXEL = 0
  public isTrusted = true
  public deltaY = 0
  public deltaMode = 0
  public ctrlKey = false
  public metaKey = false
  public altKey = false
  public shiftKey = false
  public buttons = 0
  public defaultPrevented = false
  public composedPath = (): EventTarget[] => []
  constructor(public deltaX: number) {}
}

type WheelHandler = (event: FakeWheelEvent) => void
let wheelHandler: WheelHandler | null = null

beforeEach(() => {
  wheelHandler = null
  delete (window as Window & { __cioHistorySwipe?: unknown }).__cioHistorySwipe
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

/** One dispatched wheel event plus the microtask its observer defers into. */
async function spin(deltaX: number, gapMs: number): Promise<void> {
  expect(wheelHandler).not.toBeNull()
  wheelHandler?.(new FakeWheelEvent(deltaX))
  await wait(gapMs)
}

async function spinMany(deltaX: number, frames: number, gapMs: number): Promise<void> {
  for (let index = 0; index < frames; index += 1) await spin(deltaX, gapMs)
}

async function arm(): Promise<void> {
  await wait(0)
  expect(typeof wheelHandler).toBe('function')
}

describe('browser history swipe', () => {
  it('walks history for a trackpad swipe', async () => {
    const contents = fakeContents()
    installBrowserHistorySwipe(contents as unknown as WebContents)
    await arm()
    await spinMany(-8, 24, 1)
    await wait(20)
    expect(contents.back).toBe(1)
  })

  it('leaves a tilt wheel to the page instead of navigating history', async () => {
    const contents = fakeContents()
    installBrowserHistorySwipe(contents as unknown as WebContents)
    await arm()
    await spinMany(40, 10, 40)
    await wait(40)
    expect(contents.back).toBe(0)
    expect(contents.forward).toBe(0)
  })

  it('never navigates for a tilt wheel even after it keeps turning', async () => {
    const contents = fakeContents()
    installBrowserHistorySwipe(contents as unknown as WebContents)
    await arm()
    await spinMany(-40, 10, 40)
    await wait(40)
    expect(contents.back).toBe(0)
  })

  it('treats a fine stepped tilt wheel as a wheel too', async () => {
    const contents = fakeContents()
    installBrowserHistorySwipe(contents as unknown as WebContents)
    await arm()
    await spinMany(-9, 25, 40)
    await wait(40)
    expect(contents.back).toBe(0)
  })

  it('navigates for a swipe that follows an idle wheel', async () => {
    const contents = fakeContents()
    installBrowserHistorySwipe(contents as unknown as WebContents)
    await arm()
    await spinMany(-40, 6, 40)
    await wait(400)
    expect(contents.back).toBe(0)
    await spinMany(8, 24, 1)
    await wait(20)
    expect(contents.forward).toBe(1)
  })
})
