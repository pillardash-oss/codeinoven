// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync } from 'svelte'
import { NativeFloatingPanel } from '$lib/native-floating-panel.svelte'
const bridge = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue(true) }))
vi.mock('$lib/ipc.svelte', () => ({ invoke: bridge.invoke }))
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
