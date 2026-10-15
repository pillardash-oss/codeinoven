// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import BrowserOverlayDock from '$lib/components/ui/BrowserOverlayDock.svelte'
import type { NativeDockRequest } from '$shared/native-dock'

const bridge = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue({ x: 0, y: 0 }),
  listeners: new Map<string, (payload: unknown) => void>()
}))
vi.mock('$lib/ipc.svelte', () => ({
  invoke: bridge.invoke,
  subscribe: (name: string, callback: (payload: unknown) => void) => {
    bridge.listeners.set(name, callback)
    return () => bridge.listeners.delete(name)
  }
}))
const instances: ReturnType<typeof mount>[] = []
const dock: NativeDockRequest = {
  id: 'dialog-test',
  revision: 7,
  modal: true,
  theme: 'dark',
  bounds: { x: 20, y: 30, width: 500, height: 400 },
  nodes: [
    {
      tag: 'div',
      attributes: {},
      children: [
        {
          tag: 'input',
          attributes: {
            'data-native-dock-field': 'title',
            'data-native-dock-value': 'Original',
            type: 'text'
          },
          children: []
        },
        {
          tag: 'button',
          attributes: { 'data-native-dock-action': 'apply', 'data-modal-primary': '' },
          children: ['Apply']
        },
        {
          tag: 'button',
          attributes: { 'data-native-dock-action': 'disabled', disabled: '' },
          children: ['Disabled']
        }
      ]
    }
  ]
}
function render(request: NativeDockRequest = dock) {
  const target = document.createElement('div')
  document.body.append(target)
  instances.push(
    mount(BrowserOverlayDock, { target, props: { dock: request, onDragging: () => {} } })
  )
  flushSync()
  return target
}
beforeEach(() => {
  bridge.invoke.mockClear()
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
  Object.defineProperty(HTMLElement.prototype, 'checkVisibility', {
    configurable: true,
    value: () => true
  })
})
afterEach(async () => {
  for (const instance of instances.splice(0)) await unmount(instance)
  document.body.replaceChildren()
  bridge.listeners.clear()
  Reflect.deleteProperty(Element.prototype, 'animate')
  Reflect.deleteProperty(HTMLElement.prototype, 'checkVisibility')
})
describe('native overlay drawing and interactions', () => {
  it('acknowledges only after the projected controls exist and focuses the first input', () => {
    const target = render()
    expect(target.querySelector('input')?.value).toBe('Original')
    expect(document.activeElement).toBe(target.querySelector('input'))
    expect(bridge.invoke).toHaveBeenCalledWith('browser:overlayDockDrawn', {
      id: dock.id,
      revision: 7
    })
  })
  it('reports input and enabled button presses to their original owners', () => {
    const target = render()
    const input = target.querySelector('input')!
    input.value = 'Updated'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    expect(bridge.invoke).toHaveBeenCalledWith('browser:overlayDockInteract', {
      id: dock.id,
      kind: 'field',
      field: 'title',
      value: 'Updated',
      version: 1
    })
    target.querySelector<HTMLButtonElement>('[data-native-dock-action="apply"]')!.click()
    expect(bridge.invoke).toHaveBeenCalledWith(
      'browser:overlayDockInteract',
      expect.objectContaining({ id: dock.id, kind: 'click', action: 'apply' })
    )
    bridge.invoke.mockClear()
    target.querySelector<HTMLButtonElement>('[data-native-dock-action="disabled"]')!.click()
    expect(bridge.invoke).not.toHaveBeenCalledWith(
      'browser:overlayDockInteract',
      expect.objectContaining({ action: 'disabled' })
    )
  })
  it('reports backdrop dismissal without altering the browser document', () => {
    const target = render()
    target.querySelector<HTMLButtonElement>('[aria-label="Dismiss dialog"]')!.click()
    expect(bridge.invoke).toHaveBeenCalledWith('browser:overlayDockInteract', {
      id: dock.id,
      kind: 'dismiss'
    })
  })
  it('commits Ctrl+Tab selection from the native document', () => {
    render()
    bridge.listeners.get('browser:overlay:dockCommit')?.({
      id: dock.id,
      selectedKey: 'thread-2',
      keyboardAt: Date.now()
    })
    expect(bridge.invoke).toHaveBeenCalledWith('browser:overlayDockInteract', {
      id: dock.id,
      kind: 'commit',
      key: 'thread-2'
    })
  })
})

describe('passive tooltips and non-modal overlay panels', () => {
  it('draws passive tooltip content without a backdrop or keyboard focus', () => {
    const request: NativeDockRequest = {
      ...dock,
      id: 'app-tooltip',
      modal: false,
      passive: true,
      nodes: [{ tag: 'span', attributes: {}, children: ['Tooltip'] }]
    }
    const target = render(request)
    expect(target.textContent?.trim()).toBe('Tooltip')
    expect(
      target
        .querySelector('[data-native-overlay-passive]')
        ?.classList.contains('pointer-events-none')
    ).toBe(true)
    expect(target.querySelector('[aria-label="Dismiss dialog"]')).toBeNull()
    expect(document.activeElement).toBe(document.body)
    expect(bridge.invoke).toHaveBeenCalledWith('browser:overlayDockDrawn', {
      id: request.id,
      revision: request.revision
    })
  })
  it('draws non-modal panels without the full-window modal backdrop', () => {
    const request = { ...dock, id: 'floating-sidebar', modal: false, panel: true }
    const target = render(request)
    expect(target.querySelector('[data-native-modal-panel]')).toBeNull()
    expect(target.querySelector('[aria-label="Dismiss dialog"]')).toBeNull()
    expect(target.querySelector('input')?.value).toBe('Original')
    expect(bridge.invoke).toHaveBeenCalledWith('browser:overlayDockDrawn', {
      id: request.id,
      revision: request.revision
    })
  })
})
