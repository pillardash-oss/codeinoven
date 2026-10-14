// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRawSnippet, flushSync, mount, unmount } from 'svelte'
import DockRow from '$lib/components/ui/DockRow.svelte'
import TooltipHost from '$lib/components/ui/TooltipHost.svelte'
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
  clear: vi.fn()
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
    clearOcclusion: bridge.clear
  }
}))
vi.mock('$lib/system/renderer-logger', () => ({ logRendererError: vi.fn() }))
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
  bridge.invoke.mockClear()
  bridge.publish.mockClear()
  bridge.listeners.clear()
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
  it('projects tooltip content passively without hiding the browser or claiming focus', async () => {
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
    bridge.listeners.get('browser:overlay:dockDrawn')?.({
      id: request.id,
      revision: request.revision
    })
    flushSync()
    expect(bridge.invoke).not.toHaveBeenCalledWith('browser:focusDockOverlay', request.id)
    expect(bridge.publish).not.toHaveBeenCalled()
    expect(target.querySelector('[role="tooltip"]')?.textContent?.trim()).toBe('Restore the panel')
  })
  it('avoids recursively projecting a tooltip already inside a native renderer', async () => {
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
