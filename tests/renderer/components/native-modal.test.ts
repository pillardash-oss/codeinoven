// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRawSnippet, flushSync, mount, unmount, type Snippet } from 'svelte'
import Modal from '$lib/components/ui/Modal.svelte'
import { activateTopModalPrimaryAction } from '$lib/modal-primary-action.svelte'
import type { NativeDockNode, NativeDockRequest } from '$shared/native-dock'

const bridge = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(true),
  listeners: new Map<string, (payload: unknown) => void>(),
  hideWhile: vi.fn<(key: string, reason: string, hidden: boolean) => () => void>(() => () => {})
}))
vi.mock('$lib/ipc.svelte', () => ({
  invoke: bridge.invoke,
  subscribe: (name: string, callback: (payload: unknown) => void) => {
    bridge.listeners.set(name, callback)
    return () => bridge.listeners.delete(name)
  }
}))
vi.mock('$lib/stores/browser-visibility.svelte', () => ({
  browserVisibility: { hideWhile: bridge.hideWhile }
}))
const logger = vi.hoisted(() => ({ logRendererError: vi.fn(), logRendererDev: vi.fn() }))
vi.mock('$lib/system/renderer-logger', () => logger)
const instances: ReturnType<typeof mount>[] = []
const children = createRawSnippet(() => ({
  render: () =>
    '<div><input aria-label="Title" value="Note"><button data-modal-primary>Apply</button></div>'
}))
function renderModalWith(content: Snippet) {
  const target = document.createElement('div')
  document.body.append(target)
  const onClose = vi.fn()
  instances.push(
    mount(Modal, { target, props: { open: true, title: 'Edit note', onClose, children: content } })
  )
  flushSync()
  return onClose
}
function renderModal() {
  return renderModalWith(children)
}
function projection(): NativeDockRequest {
  const call = bridge.invoke.mock.calls.find(
    ([channel, , request]) => channel === 'browser:setDockOverlay' && request
  )
  if (!call) throw new Error('Modal did not publish a native projection')
  return call[2] as NativeDockRequest
}
beforeEach(() => {
  vi.useFakeTimers()
  bridge.invoke.mockClear()
  bridge.hideWhile.mockClear()
  logger.logRendererError.mockClear()
  logger.logRendererDev.mockClear()
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
  bridge.listeners.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
  Reflect.deleteProperty(HTMLElement.prototype, 'checkVisibility')
  Reflect.deleteProperty(Element.prototype, 'animate')
  vi.unstubAllGlobals()
})
describe('canonical native modal', () => {
  it('ignores acknowledgements for another modal or an old revision', async () => {
    renderModal()
    await vi.advanceTimersByTimeAsync(40)
    const request = projection()
    bridge.listeners.get('browser:overlay:dockDrawn')?.({
      id: 'another-modal',
      revision: request.revision
    })
    bridge.listeners.get('browser:overlay:dockDrawn')?.({
      id: request.id,
      revision: request.revision - 1
    })
    expect(bridge.invoke).not.toHaveBeenCalledWith('browser:focusDockOverlay', request.id)
    bridge.listeners.get('browser:overlay:dockDrawn')?.({
      id: request.id,
      revision: request.revision
    })
    expect(bridge.invoke).toHaveBeenCalledWith('browser:focusDockOverlay', request.id)
  })

  it('delivers native edits to the source input and rejects foreign modal events', async () => {
    renderModal()
    await vi.advanceTimersByTimeAsync(40)
    const request = projection()
    function fieldId(nodes: Array<NativeDockNode | string>): string | undefined {
      for (const node of nodes) {
        if (typeof node === 'string') continue
        const found = node.attributes['data-native-dock-field'] ?? fieldId(node.children)
        if (found) return found
      }
    }
    const field = fieldId(request.nodes)
    expect(field).toBeDefined()
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Title"]')!
    const changed = vi.fn()
    input.addEventListener('input', changed)
    bridge.listeners.get('browser:overlay:dockEvent')?.({
      id: 'another-modal',
      kind: 'field',
      field,
      value: 'Foreign',
      version: 1
    })
    expect(input.value).toBe('Note')
    bridge.listeners.get('browser:overlay:dockEvent')?.({
      id: request.id,
      kind: 'field',
      field,
      value: 'Updated',
      version: 1
    })
    expect(input.value).toBe('Updated')
    expect(changed).toHaveBeenCalledOnce()
  })

  it('publishes native content without suppressing the browser before or after drawing', async () => {
    renderModal()
    await vi.advanceTimersByTimeAsync(40)
    const request = projection()
    expect(request.modal).toBe(true)
    expect(request.nodes.length).toBeGreaterThan(0)
    expect(document.querySelector<HTMLElement>('[role="dialog"]')?.parentElement?.inert).toBe(true)
    bridge.listeners.get('browser:overlay:dockDrawn')?.({
      id: request.id,
      revision: request.revision
    })
    flushSync()
    expect(bridge.invoke).toHaveBeenCalledWith('browser:focusDockOverlay', request.id)
    expect(bridge.hideWhile.mock.calls.every((call) => call[2] === false)).toBe(true)
    await vi.advanceTimersByTimeAsync(2100)
    expect(bridge.hideWhile.mock.calls.every((call) => call[2] === false)).toBe(true)
  })

  it('runs the primary action even though its projection source is inert', async () => {
    renderModal()
    await vi.advanceTimersByTimeAsync(40)
    const apply = document.querySelector<HTMLButtonElement>('[data-modal-primary]')!
    const clicked = vi.fn()
    apply.addEventListener('click', clicked)
    expect(activateTopModalPrimaryAction()).toBe(true)
    expect(clicked).toHaveBeenCalledOnce()
  })

  it('forwards native Escape to the owning modal', async () => {
    const close = renderModal()
    await vi.advanceTimersByTimeAsync(40)
    const request = projection()
    bridge.listeners.get('browser:overlay:dockKey')?.({
      id: request.id,
      type: 'keydown',
      key: 'Escape',
      code: 'Escape',
      control: false,
      shift: false,
      meta: false,
      alt: false,
      isAutoRepeat: false
    })
    expect(close).toHaveBeenCalledOnce()
  })

  it('removes its native projection and browser block when destroyed', async () => {
    renderModal()
    await vi.advanceTimersByTimeAsync(40)
    const request = projection()
    await unmount(instances.pop()!)
    expect(bridge.invoke).toHaveBeenCalledWith('browser:setDockOverlay', request.id, null)
    expect(bridge.listeners.size).toBe(0)
  })

  it('projects a modal whose picker keeps its menu inside the panel', async () => {
    const snippet = createRawSnippet(() => ({
      render: () =>
        '<div><button aria-expanded="false">Filter</button><div><button>All projects</button><button>Project one</button></div></div>'
    }))
    renderModalWith(snippet)
    await vi.advanceTimersByTimeAsync(40)
    const request = projection()
    expect(request.nodes.length).toBeGreaterThan(0)
    expect(logger.logRendererDev).not.toHaveBeenCalled()
    expect(logger.logRendererError).not.toHaveBeenCalled()
  })

  it('reports a popup-backed fallback at dev level, never as an error', async () => {
    const snippet = createRawSnippet(() => ({
      render: () => '<div><button aria-haspopup="menu">Menu</button></div>'
    }))
    renderModalWith(snippet)
    await vi.advanceTimersByTimeAsync(40)
    expect(logger.logRendererDev).toHaveBeenCalledTimes(1)
    const message = String(logger.logRendererDev.mock.calls[0]?.[0])
    expect(message).toContain('fell back to the app window')
    expect(message).toContain('opens its own popup')
    expect(logger.logRendererError).not.toHaveBeenCalled()
  })

  it('carries an inert SVG theme style instead of refusing the modal for it', async () => {
    const snippet = createRawSnippet(() => ({
      render: () =>
        '<div><svg viewBox="0 0 10 10"><style>.ink { fill: currentColor; }</style><path class="ink" d="M0 0h10v10H0z" /></svg></div>'
    }))
    renderModalWith(snippet)
    await vi.advanceTimersByTimeAsync(40)
    const request = projection()
    expect(request.nodes.length).toBeGreaterThan(0)
    expect(logger.logRendererDev).not.toHaveBeenCalled()
    expect(logger.logRendererError).not.toHaveBeenCalled()
  })
})
