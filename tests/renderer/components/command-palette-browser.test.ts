// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import CommandPalette from '$lib/components/actions/CommandPalette.svelte'
import SpotlightHarness from './stubs/SpotlightHarness.svelte'
import type { NativeDockRequest } from '$shared/native-dock'

/**
 * The Cmd+K spotlight is a `Modal` that the native projection draws above the
 * browser's page view, so opening it must never detach the browser. A palette
 * that opts out of the native presentation falls back to the app window's DOM,
 * where the only way its panel can be seen is to hide the page underneath it
 * (see `browserVisibility.hideWhile`). These tests pin that regression: the
 * spotlight keeps publishing a native projection, and the browser is never
 * suppressed while it is open.
 */
const bridge = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(true),
  listeners: new Map<string, (payload: unknown) => void>(),
  hideWhile: vi.fn<(key: string, reason: string, hidden: boolean) => () => void>(() => () => {})
}))
vi.mock('$lib/ipc.svelte', async (importOriginal) => {
  // `subscribeGuarded` is kept real: it is the guard the stores and the app
  // wiring subscribe through, and stubbing it would hide whether a subscription
  // is actually made.
  const actual = await importOriginal<typeof import('$lib/ipc.svelte')>()
  return {
    ...actual,
    invoke: bridge.invoke,
    subscribe: (name: string, callback: (payload: unknown) => void) => {
      bridge.listeners.set(name, callback)
      return () => bridge.listeners.delete(name)
    }
  }
})
vi.mock('$lib/stores/browser-visibility.svelte', () => ({
  browserVisibility: { hideWhile: bridge.hideWhile }
}))
const logger = vi.hoisted(() => ({ logRendererError: vi.fn(), logRendererDev: vi.fn() }))
vi.mock('$lib/system/renderer-logger', () => logger)

const instances: ReturnType<typeof mount>[] = []

function renderPalette(screenKey = 'actions') {
  const target = document.createElement('div')
  document.body.append(target)
  const instance = mount(CommandPalette, {
    target,
    props: {
      open: true,
      screenKey,
      actions: [],
      onSelect: vi.fn(),
      onClose: vi.fn()
    }
  })
  instances.push(instance)
  flushSync()
  return instance
}

function projection(): NativeDockRequest {
  const call = bridge.invoke.mock.calls.find(
    ([channel, , request]) => channel === 'browser:setDockOverlay' && request
  )
  if (!call) throw new Error('The spotlight published no native projection')
  return call[2] as NativeDockRequest
}

beforeEach(() => {
  vi.useFakeTimers()
  bridge.invoke.mockClear()
  bridge.hideWhile.mockClear()
  logger.logRendererError.mockClear()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  )
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    value: () => ({
      cancel() {},
      onfinish: null,
      effect: null,
      currentTime: 0,
      playState: 'finished'
    })
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(10, 10, 600, 400)
  )
  Object.defineProperty(HTMLElement.prototype, 'checkVisibility', {
    configurable: true,
    value: () => true
  })
})
afterEach(async () => {
  for (const instance of instances.splice(0)) await unmount(instance)
  document.body.replaceChildren()
  bridge.listeners.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
  Reflect.deleteProperty(HTMLElement.prototype, 'checkVisibility')
  Reflect.deleteProperty(Element.prototype, 'animate')
  vi.unstubAllGlobals()
})

describe('the Cmd+K spotlight keeps the browser up', () => {
  it('draws through the native projection so it never has to hide the page', async () => {
    renderPalette()
    await vi.advanceTimersByTimeAsync(40)
    const request = projection()
    expect(request.modal).toBe(true)
    expect(request.nodes.length).toBeGreaterThan(0)
  })

  it('never suppresses the browser while it is open, before or after the host draws', async () => {
    renderPalette()
    await vi.advanceTimersByTimeAsync(40)
    const request = projection()
    expect(bridge.hideWhile).toHaveBeenCalled()
    expect(bridge.hideWhile.mock.calls.every((call) => call[2] === false)).toBe(true)
    bridge.listeners.get('browser:overlay:dockDrawn')?.({
      id: request.id,
      revision: request.revision
    })
    flushSync()
    await vi.advanceTimersByTimeAsync(2100)
    expect(bridge.hideWhile.mock.calls.every((call) => call[2] === false)).toBe(true)
  })

  it('keeps one query input focused across a screen change', async () => {
    const target = document.createElement('div')
    document.body.append(target)
    const harness = mount(SpotlightHarness, {
      target,
      props: { initialScreenKey: 'actions' }
    })
    instances.push(harness)
    flushSync()
    await vi.advanceTimersByTimeAsync(40)
    const before = document.querySelector<HTMLInputElement>('input[aria-label]')
    expect(before).not.toBeNull()
    before?.focus()
    expect(document.activeElement).toBe(before)
    harness.setScreenKey('files')
    flushSync()
    const after = document.querySelector<HTMLInputElement>('input[aria-label]')
    expect(after).toBe(before)
    expect(document.activeElement).toBe(before)
  })
})
