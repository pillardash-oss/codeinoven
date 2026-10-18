// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync } from 'svelte'
import { NativeFloatingPanel } from '$lib/native-floating-panel.svelte'
import { NativeDockController } from '$lib/native-dock-controller.svelte'
import type { NativeDockRequest } from '$shared/native-dock'
import { OVERLAY_ACK_TIMEOUT_MS } from '$shared/browser-overlay'
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
vi.mock('$lib/system/renderer-logger', () => ({ logRendererError: vi.fn() }))
vi.mock('$lib/terminal/host-registry', () => ({ terminalEntryForHost: () => undefined }))
let iframe: HTMLIFrameElement
let popup: Window
let panel: NativeFloatingPanel
let root: HTMLDivElement
let release: () => void
const bounds = { x: 30, y: 40, width: 400, height: 220 }
beforeEach(() => {
  vi.useFakeTimers()
  bridge.invoke
    .mockReset()
    .mockImplementation(async (channel: string) =>
      channel === 'app:prepareFloatingPanel' ? 'panel-token' : true
    )
  iframe = document.createElement('iframe')
  document.body.append(iframe)
  popup = iframe.contentWindow!
  vi.spyOn(popup, 'focus').mockImplementation(() => {})
  vi.spyOn(window, 'focus').mockImplementation(() => {})
  vi.spyOn(window, 'open').mockReturnValue(popup)
  Object.defineProperty(HTMLElement.prototype, 'checkVisibility', {
    configurable: true,
    value: () => true
  })
  root = document.createElement('div')
  root.innerHTML = '<textarea data-floating-document>Draft</textarea><button>Save</button>'
  document.body.append(root)
  panel = new NativeFloatingPanel('floating-test')
  release = panel.mount(root)
})
afterEach(async () => {
  release()
  flushSync()
  await Promise.resolve()
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.useRealTimers()
  Reflect.deleteProperty(HTMLElement.prototype, 'checkVisibility')
})
async function open() {
  panel.update(true, true, bounds)
  await vi.advanceTimersByTimeAsync(60)
  flushSync()
}
describe('live floating panel controller', () => {
  it('adopts the original editor into a native host without replacing its DOM or draft', async () => {
    const editor = root.querySelector('textarea')!
    editor.value = 'Unsaved draft'
    const input = vi.fn()
    editor.addEventListener('input', input)
    await open()
    expect(panel.failed).toBe(false)
    expect(panel.live).toBe(true)
    expect(root.ownerDocument).toBe(popup.document)
    expect(popup.document.querySelector('textarea')).toBe(editor)
    expect(editor.value).toBe('Unsaved draft')
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    expect(input).toHaveBeenCalledOnce()
    expect(bridge.invoke).toHaveBeenCalledWith('app:updateFloatingPanel', panel.id, bounds, true)
    expect(
      bridge.invoke.mock.calls.some(([channel]) => String(channel).startsWith('browser:'))
    ).toBe(false)
  })
  it('reuses the host through minimize and restore without losing the draft', async () => {
    await open()
    const editor = root.querySelector('textarea')!
    editor.value = 'Keep me'
    panel.update(true, false, bounds)
    await vi.advanceTimersByTimeAsync(20)
    expect(bridge.invoke).toHaveBeenCalledWith('app:updateFloatingPanel', panel.id, bounds, false)
    panel.update(true, true, bounds)
    await vi.advanceTimersByTimeAsync(20)
    expect(
      bridge.invoke.mock.calls.filter(([channel]) => channel === 'app:prepareFloatingPanel')
    ).toHaveLength(1)
    expect(root.querySelector('textarea')).toBe(editor)
    expect(editor.value).toBe('Keep me')
  })
  it('does not refocus the native window when only its geometry changes', async () => {
    await open()
    const focus = vi.mocked(popup.focus)
    focus.mockClear()
    panel.update(true, true, { ...bounds, x: 150 })
    await vi.advanceTimersByTimeAsync(30)
    expect(focus).not.toHaveBeenCalled()
    expect(bridge.invoke).toHaveBeenCalledWith(
      'app:updateFloatingPanel',
      panel.id,
      { ...bounds, x: 150 },
      true
    )
  })
  it('restores the original node and releases the native window on disposal', async () => {
    await open()
    release()
    expect(root.ownerDocument).toBe(document)
    expect(root.parentElement).toBe(document.body)
    expect(panel.live).toBe(false)
    expect(bridge.invoke).toHaveBeenCalledWith('app:releaseFloatingPanel', panel.id)
  })
  it('releases a prepared host if the panel closes before preparation answers', async () => {
    let answer: ((token: string) => void) | undefined
    bridge.invoke.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          answer = resolve
        })
    )
    panel.update(true, true, bounds)
    release()
    answer!('late-token')
    await vi.advanceTimersByTimeAsync(30)
    expect(window.open).not.toHaveBeenCalled()
    expect(bridge.invoke).toHaveBeenCalledWith('app:releaseFloatingPanel', panel.id)
  })
})

describe('native dock acknowledgement', () => {
  let dockRoot: HTMLDivElement
  let controller: NativeDockController
  let releaseDock: () => void

  beforeEach(() => {
    bridge.listeners.clear()
    bridge.invoke.mockReset().mockResolvedValue(true)
    dockRoot = document.createElement('div')
    dockRoot.innerHTML = '<button>Restore panel</button>'
    document.body.append(dockRoot)
    controller = new NativeDockController(
      'dock-test',
      () => {},
      () => ({ x: 0, y: 0, width: 200, height: 40 })
    )
    releaseDock = controller.mount(dockRoot)
    controller.update(true, { x: 0, y: 0, width: 200, height: 40 })
  })

  afterEach(() => releaseDock())

  /** The most recent projection the controller published. */
  async function projection(): Promise<NativeDockRequest> {
    await vi.advanceTimersByTimeAsync(40)
    const calls = bridge.invoke.mock.calls.filter(
      ([channel, , request]) => channel === 'browser:setDockOverlay' && request
    )
    if (!calls.length) throw new Error('The dock did not publish a native projection')
    return calls.at(-1)![2] as NativeDockRequest
  }

  it('gives a host that has never answered the generous window instead of the short one', async () => {
    const request = await projection()
    // The old, unconditional two-second deadline would have fallen back here.
    await vi.advanceTimersByTimeAsync(2100)
    expect(controller.failed).toBe(false)
    bridge.listeners.get('browser:overlay:dockDrawn')?.({
      id: request.id,
      revision: request.revision
    })
    expect(controller.failed).toBe(false)
    expect(controller.ready).toBe(true)
  })

  it('holds a proven host to the short deadline on a later frame', async () => {
    const first = await projection()
    bridge.listeners.get('browser:overlay:dockDrawn')?.({ id: first.id, revision: first.revision })
    dockRoot.querySelector('button')!.disabled = true
    const next = await projection()
    expect(next.revision).toBeGreaterThan(first.revision)
    await vi.advanceTimersByTimeAsync(2100)
    expect(controller.failed).toBe(true)
  })

  it('still refuses a host that never answers at all', async () => {
    await projection()
    await vi.advanceTimersByTimeAsync(OVERLAY_ACK_TIMEOUT_MS + 100)
    expect(controller.failed).toBe(true)
  })
})
