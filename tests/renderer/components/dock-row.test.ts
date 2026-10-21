// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRawSnippet, flushSync, mount, unmount } from 'svelte'
import DockRow from '$lib/components/ui/DockRow.svelte'
import TooltipHost from '$lib/components/ui/TooltipHost.svelte'
import { logRendererError } from '$lib/system/renderer-logger'
import type { NativeDockNode, NativeDockRequest } from '$shared/native-dock'
vi.mock('$lib/components/ui/tooltip-manager.svelte', () => ({
  TOOLTIP_ID: 'tooltip-test',
  tooltipState: {
    visible: true,
    request: {
      content: 'Restore the panel',
      keys: [],
      side: 'top',
      sideOffset: 8,
      anchorX: 500,
      anchorY: 300
    }
  },
  attachTitleTooltipDelegation: () => () => {},
  patchSuppressedTooltipTitle: () => false
}))
const bridge = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(true),
  listeners: new Map<string, (payload: unknown) => void>(),
  publish: vi.fn(),
  clear: vi.fn(),
  overlapsNative: vi.fn()
}))
vi.mock('$lib/ipc.svelte', () => ({
  invoke: bridge.invoke,
  subscribe: (name: string, callback: (payload: unknown) => void) => {
    bridge.listeners.set(name, callback)
    return () => bridge.listeners.delete(name)
  }
}))
vi.mock('$lib/stores/browser-visibility.svelte', () => ({
  browserVisibility: {
    canUseNativeDock: true,
    publishOcclusion: bridge.publish,
    clearOcclusion: bridge.clear,
    overlapsNative: bridge.overlapsNative
  }
}))
vi.mock('$lib/system/renderer-logger', () => ({
  logRendererError: vi.fn(),
  logRendererDev: vi.fn()
}))
let instance: ReturnType<typeof mount> | undefined
const restore = vi.fn()
const children = createRawSnippet(() => ({
  render: () => '<button data-test-restore>Restore panel</button>',
  setup: (element) => {
    const button = element as HTMLButtonElement
    button.addEventListener('click', restore)
    return () => button.removeEventListener('click', restore)
  }
}))
const key = 'test-dock'
beforeEach(() => {
  vi.useFakeTimers()
  bridge.invoke.mockReset()
  bridge.invoke.mockResolvedValue(true)
  bridge.publish.mockClear()
  bridge.clear.mockClear()
  bridge.overlapsNative.mockReset()
  bridge.overlapsNative.mockReturnValue(false)
  bridge.listeners.clear()
  vi.mocked(logRendererError).mockClear()
  restore.mockClear()
  localStorage.clear()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  )
  vi.stubGlobal('PointerEvent', MouseEvent)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(20, 20, 220, 40)
  )
})
afterEach(async () => {
  if (instance) await unmount(instance)
  instance = undefined
  document.body.replaceChildren()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
async function render() {
  const target = document.createElement('div')
  document.body.append(target)
  instance = mount(DockRow, {
    target,
    props: { storageKey: key, label: 'Move docked panel', children }
  })
  flushSync()
  await vi.advanceTimersByTimeAsync(50)
  const call = bridge.invoke.mock.calls.find(
    ([channel, , value]) => channel === 'browser:setDockOverlay' && value
  )
  if (!call) throw new Error('Dock did not publish to its native overlay')
  return call[2] as NativeDockRequest
}
function action(nodes: Array<NativeDockNode | string>): string | undefined {
  for (const node of nodes) {
    if (typeof node === 'string') continue
    if (node.attributes['data-test-restore']) return node.attributes['data-native-dock-action']
    if (node.tag === 'button' && node.children.includes('Restore panel'))
      return node.attributes['data-native-dock-action']
    const found = action(node.children)
    if (found) return found
  }
}
describe('native dock chips', () => {
  it('projects a non-modal dock without occluding the browser or taking keyboard focus', async () => {
    const request = await render()
    expect(request.modal).toBe(false)
    expect(bridge.publish).not.toHaveBeenCalled()
    bridge.listeners.get('browser:overlay:dockDrawn')?.({
      id: request.id,
      revision: request.revision
    })
    flushSync()
    expect(bridge.invoke).not.toHaveBeenCalledWith('browser:focusDockOverlay', request.id)
    expect(bridge.publish).not.toHaveBeenCalled()
  })
  it('restores the source panel when its native chip is clicked', async () => {
    const request = await render()
    const id = action(request.nodes)
    expect(id).toBeDefined()
    bridge.listeners.get('browser:overlay:dockEvent')?.({
      id: request.id,
      kind: 'click',
      action: id
    })
    expect(restore).toHaveBeenCalledOnce()
  })
  it('snaps and persists native drag and arrow-key edge changes', async () => {
    const request = await render()
    bridge.listeners.get('browser:overlay:dockEvent')?.({
      id: request.id,
      kind: 'edge',
      key: 'ArrowLeft'
    })
    flushSync()
    expect(JSON.parse(localStorage.getItem(`${key}.dockPlacement`)!)).toMatchObject({
      edge: 'left'
    })
    bridge.listeners.get('browser:overlay:dockEvent')?.({
      id: request.id,
      kind: 'drag',
      dx: 5000,
      dy: -300,
      done: true
    })
    flushSync()
    expect(JSON.parse(localStorage.getItem(`${key}.dockPlacement`)!)).toMatchObject({
      edge: 'right'
    })
    expect(bridge.publish).not.toHaveBeenCalled()
  })
  it('removes only its own native projection on unmount', async () => {
    const request = await render()
    await unmount(instance!)
    instance = undefined
    expect(bridge.invoke).toHaveBeenCalledWith('browser:setDockOverlay', request.id, null)
    expect(bridge.listeners.size).toBe(0)
  })
})

describe('native tooltip source', () => {
  it('projects a tooltip the page would cover, passively and without focus', async () => {
    bridge.overlapsNative.mockReturnValue(true)
    const target = document.createElement('div')
    document.body.append(target)
    instance = mount(TooltipHost, { target })
    flushSync()
    await vi.advanceTimersByTimeAsync(50)
    const call = bridge.invoke.mock.calls.find(
      ([channel, id, request]) =>
        channel === 'browser:setDockOverlay' && id === 'app-tooltip' && request
    )
    expect(call).toBeDefined()
    const request = call![2] as NativeDockRequest
    expect(request.passive).toBe(true)
    expect(request.modal).toBe(false)
    const host = target.querySelector<HTMLElement>('[data-tooltip-host]')
    expect(host?.style.opacity).toBe('1')
    bridge.listeners.get('browser:overlay:dockDrawn')?.({
      id: request.id,
      revision: request.revision
    })
    flushSync()
    // The native document owns the tooltip once it has proved it drew it.
    expect(host?.style.opacity).toBe('0')
    expect(bridge.invoke).not.toHaveBeenCalledWith('browser:focusDockOverlay', request.id)
    expect(bridge.publish).not.toHaveBeenCalled()
    expect(target.querySelector('[role="tooltip"]')?.textContent?.trim()).toBe('Restore the panel')
  })
  it('draws the tooltip in the DOM while no native page would cover it', async () => {
    const target = document.createElement('div')
    document.body.append(target)
    instance = mount(TooltipHost, { target })
    flushSync()
    await vi.advanceTimersByTimeAsync(50)
    expect(bridge.invoke).not.toHaveBeenCalled()
    const host = target.querySelector<HTMLElement>('[data-tooltip-host]')
    expect(host?.style.opacity).toBe('1')
    expect(target.querySelector('[role="tooltip"]')?.textContent?.trim()).toBe('Restore the panel')
    // Six seconds is past every acknowledgement deadline: a tooltip here never
    // armed one, so nothing has to expire or fall back.
    await vi.advanceTimersByTimeAsync(6_000)
    expect(bridge.invoke).not.toHaveBeenCalled()
    expect(logRendererError).not.toHaveBeenCalled()
    expect(host?.style.opacity).toBe('1')
  })
  it('projects a covered tooltip on Linux too, so the page cannot clip it', async () => {
    vi.stubGlobal('api', { windowInfo: { platform: 'linux' } })
    bridge.overlapsNative.mockReturnValue(true)
    const target = document.createElement('div')
    document.body.append(target)
    instance = mount(TooltipHost, { target })
    flushSync()
    await vi.advanceTimersByTimeAsync(50)
    expect(
      bridge.invoke.mock.calls.filter(
        ([channel, id, request]) =>
          channel === 'browser:setDockOverlay' && id === 'app-tooltip' && request
      )
    ).toHaveLength(1)
    expect(target.querySelector('[role="tooltip"]')?.textContent?.trim()).toBe('Restore the panel')
  })
  it('keeps the DOM tooltip visible when a host refuses the projection', async () => {
    bridge.overlapsNative.mockReturnValue(true)
    bridge.invoke.mockImplementation(
      async (channel: string) => channel !== 'browser:setDockOverlay'
    )
    const target = document.createElement('div')
    document.body.append(target)
    instance = mount(TooltipHost, { target })
    flushSync()
    await vi.advanceTimersByTimeAsync(50)
    expect(logRendererError).toHaveBeenCalledWith(
      "The native dock 'app-tooltip' fell back to the app window: its host could not take the projection"
    )
    expect(bridge.invoke).toHaveBeenCalledWith('browser:setDockOverlay', 'app-tooltip', null)
    const host = target.querySelector<HTMLElement>('[data-tooltip-host]')
    expect(host?.style.opacity).toBe('1')
    expect(target.querySelector('[role="tooltip"]')?.textContent?.trim()).toBe('Restore the panel')
    await vi.advanceTimersByTimeAsync(10_000)
    // A refused dock is never retried, so a dead host cannot keep a tooltip
    // waiting or flood the log on every hover.
    expect(logRendererError).toHaveBeenCalledOnce()
  })
  it('avoids recursively projecting a tooltip already inside a native renderer', async () => {
    bridge.overlapsNative.mockReturnValue(true)
    const target = document.createElement('div')
    document.body.append(target)
    instance = mount(TooltipHost, { target, props: { nativeOverlay: false } })
    flushSync()
    await vi.advanceTimersByTimeAsync(50)
    expect(
      bridge.invoke.mock.calls.filter(
        ([channel, , request]) => channel === 'browser:setDockOverlay' && request
      )
    ).toHaveLength(0)
    expect(target.querySelector('[role="tooltip"]')).not.toBeNull()
  })
})
