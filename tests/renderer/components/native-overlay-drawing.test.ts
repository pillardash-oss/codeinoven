// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import { SvelteMap } from 'svelte/reactivity'
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
/**
 * A dock whose scroll host the app mirrors: one scrolling list, the shape every
 * long panel in the app projects.
 */
function scrollDock(top: string, revision = 7): NativeDockRequest {
  return {
    id: 'dialog-scroll',
    revision,
    modal: true,
    theme: 'dark',
    bounds: { x: 20, y: 30, width: 500, height: 400 },
    nodes: [
      {
        tag: 'div',
        attributes: {
          'data-native-dock-scroll': 'list',
          'data-native-dock-scroll-top': top,
          style: 'height: 300px; max-height: 300px;'
        },
        children: [{ tag: 'div', attributes: {}, children: ['row'] }]
      }
    ]
  }
}
/**
 * Mount a scrollable dock and hand back its scroll host together with the way a
 * new revision arrives. The request is read through a reactive cell because the
 * drive is reactive: publishing the next frame re-runs the dock's draw
 * attachment, exactly as the host's own `{#each docks}` does.
 */
function renderScrollDock(request: NativeDockRequest) {
  const cell = new SvelteMap<string, NativeDockRequest>([['dock', request]])
  const target = document.createElement('div')
  document.body.append(target)
  instances.push(
    mount(BrowserOverlayDock, {
      target,
      props: {
        get dock() {
          return cell.get('dock') ?? request
        },
        onDragging: () => {}
      }
    })
  )
  flushSync()
  return {
    host: target.querySelector<HTMLElement>('[data-native-dock-scroll="list"]')!,
    publish: (next: NativeDockRequest) => {
      cell.set('dock', next)
      flushSync()
    }
  }
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

describe('mirrored scrolling', () => {
  /**
   * The regression this guards: the app mirrors every position reported from
   * here, so its next frame carries that position back as
   * `data-native-dock-scroll-top`. Writing it back one round trip late dragged a
   * live gesture backwards on every frame, and the list shook and crawled
   * instead of scrolling.
   */
  it('keeps the position the user scrolled to instead of the echo the app mirrors back', () => {
    const { host, publish } = renderScrollDock(scrollDock('0'))
    expect(host.scrollTop).toBe(0)
    host.scrollTop = 246
    host.dispatchEvent(new Event('scroll'))
    expect(bridge.invoke).toHaveBeenCalledWith('browser:overlayDockInteract', {
      id: 'dialog-scroll',
      kind: 'scroll',
      target: 'list',
      top: 246
    })
    bridge.invoke.mockClear()
    // The gesture has moved on by the time the mirrored frame lands.
    host.scrollTop = 258
    publish(scrollDock('246', 8))
    expect(host.scrollTop).toBe(258)
    expect(bridge.invoke).not.toHaveBeenCalledWith(
      'browser:overlayDockInteract',
      expect.objectContaining({ kind: 'scroll' })
    )
  })

  it('applies a position the app scrolled itself', () => {
    const { host, publish } = renderScrollDock(scrollDock('0'))
    host.scrollTop = 246
    host.dispatchEvent(new Event('scroll'))
    host.scrollTop = 258
    // A position this document never reported is the app moving the container
    // (a search result reached, a list reset), which must win over the gesture.
    publish(scrollDock('12', 8))
    expect(host.scrollTop).toBe(12)
  })

  it('reports a host that scrolls back to a position it already reported', () => {
    const { host } = renderScrollDock(scrollDock('0'))
    host.scrollTop = 120
    host.dispatchEvent(new Event('scroll'))
    host.scrollTop = 0
    host.dispatchEvent(new Event('scroll'))
    const positions = bridge.invoke.mock.calls
      .filter(([channel]) => channel === 'browser:overlayDockInteract')
      .map(([, report]) => (report as { top?: number }).top)
    expect(positions).toEqual([120, 0])
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
