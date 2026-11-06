// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRawSnippet, flushSync, mount, unmount } from 'svelte'
import Modal from '$lib/components/ui/Modal.svelte'
import type { NativeDockRequest } from '$shared/native-dock'

const bridge = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(true),
  listeners: new Map<string, (payload: unknown) => void>()
}))

vi.mock('$lib/ipc.svelte', () => ({
  invoke: bridge.invoke,
  subscribe: (name: string, callback: (payload: unknown) => void) => {
    bridge.listeners.set(name, callback)
    return () => bridge.listeners.delete(name)
  }
}))

vi.mock('$lib/stores/browser-visibility.svelte', () => ({
  browserVisibility: { hideWhile: () => () => {} }
}))

const logger = vi.hoisted(() => ({ logRendererError: vi.fn(), logRendererDev: vi.fn() }))
vi.mock('$lib/system/renderer-logger', () => logger)

const children = createRawSnippet(() => ({
  render: () => '<div><input aria-label="Title" value="Note"><button>Apply</button></div>'
}))

const instances: ReturnType<typeof mount>[] = []

function renderModal(): void {
  const target = document.createElement('div')
  document.body.append(target)
  instances.push(
    mount(Modal, {
      target,
      props: { open: true, title: 'Edit note', onClose: () => {}, children }
    })
  )
  flushSync()
}

/** The frame the overlay window drew, which is what the host acknowledges. */
function projection(): NativeDockRequest {
  const call = bridge.invoke.mock.calls.find(
    ([channel, , request]) => channel === 'browser:setDockOverlay' && request
  )
  if (!call) throw new Error('Modal did not publish a native projection')
  return call[2] as NativeDockRequest
}

/** The panel and the wrapper that holds it back while a host owns the screen. */
function panel(): { dialog: HTMLElement; frame: HTMLElement } {
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
  const frame = dialog?.parentElement
  if (!dialog || !frame) throw new Error('Modal rendered no dialog panel')
  return { dialog, frame }
}

/** What the user actually gets: a painted, pressable panel in this window. */
function presentedInAppWindow(): boolean {
  const { frame } = panel()
  return frame.style.opacity !== '0' && !frame.inert
}

function acknowledgeDraw(): void {
  const request = projection()
  bridge.listeners.get('browser:overlay:dockDrawn')?.({
    id: request.id,
    revision: request.revision
  })
  flushSync()
}

beforeEach(() => {
  vi.useFakeTimers()
  bridge.invoke.mockClear()
  bridge.listeners.clear()
  logger.logRendererError.mockClear()
  logger.logRendererDev.mockClear()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
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
    new DOMRect(10, 10, 500, 400)
  )
  Object.defineProperty(HTMLElement.prototype, 'checkVisibility', {
    configurable: true,
    value: () => true
  })
})

afterEach(async () => {
  for (const instance of instances.splice(0)) await unmount(instance)
  document.body.replaceChildren()
  vi.useRealTimers()
  vi.restoreAllMocks()
  Reflect.deleteProperty(HTMLElement.prototype, 'checkVisibility')
  Reflect.deleteProperty(Element.prototype, 'animate')
  vi.unstubAllGlobals()
})

describe('the canonical modal appears on the press that opened it', () => {
  it('paints its own panel before any host has confirmed a frame', async () => {
    renderModal()
    await vi.advanceTimersByTimeAsync(40)
    // The host accepted the projection but has not said it drew anything.
    expect(projection()).toBeDefined()
    expect(presentedInAppWindow()).toBe(true)
  })

  it('hands the panel to the host only once the host confirms it drew', async () => {
    renderModal()
    await vi.advanceTimersByTimeAsync(40)
    acknowledgeDraw()
    // The native document owns the screen now, so the app window's copy is
    // neither painted nor pressable.
    const { frame } = panel()
    expect(frame.style.opacity).toBe('0')
    expect(frame.inert).toBe(true)
  })

  it('settles into the app window when the host never confirms, instead of holding the panel', async () => {
    renderModal()
    await vi.advanceTimersByTimeAsync(40)
    // A little past the unproven-host budget: an unanswering host is given up on
    // rather than left holding a panel the user opened minutes ago.
    await vi.advanceTimersByTimeAsync(1_300)
    expect(presentedInAppWindow()).toBe(true)
    expect(bridge.invoke).toHaveBeenCalledWith('browser:setDockOverlay', expect.anything(), null)
  })

  it('returns the panel to this window when the host document dies mid-show', async () => {
    renderModal()
    await vi.advanceTimersByTimeAsync(40)
    acknowledgeDraw()
    expect(presentedInAppWindow()).toBe(false)
    bridge.listeners.get('browser:overlay:failed')?.({})
    flushSync()
    expect(presentedInAppWindow()).toBe(true)
  })
})
