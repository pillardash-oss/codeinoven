import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { NativeDockRequest } from '../../../src/lib/native-dock'
const mocks = vi.hoisted(() => ({ send: vi.fn(), load: vi.fn().mockResolvedValue(undefined) }))
class Contents extends EventEmitter {
  isDestroyed = () => false
  isFocused = () => false
  getBackgroundThrottling = () => true
  setBackgroundThrottling = vi.fn()
  focus = vi.fn()
}
const windows: WindowFixture[] = []
class WindowFixture extends EventEmitter {
  static getFocusedWindow() {
    return windows[0]
  }
  webContents = new Contents()
  visible = false
  focusable = false
  options: unknown
  constructor(options?: unknown) {
    super()
    this.options = options
    windows.push(this)
  }
  getContentBounds = () => ({ x: 100, y: 80, width: 1000, height: 800 })
  isDestroyed = () => false
  isMinimized = () => false
  isFocused = () => false
  isFocusable = () => this.focusable
  isVisible = () => this.visible
  setBounds = vi.fn()
  setAlwaysOnTop = vi.fn()
  setMenuBarVisibility = vi.fn()
  setIgnoreMouseEvents = vi.fn()
  setFocusable = vi.fn((value: boolean) => {
    this.focusable = value
  })
  showInactive = vi.fn(() => {
    this.visible = true
  })
  show = vi.fn(() => {
    this.visible = true
  })
  hide = vi.fn(() => {
    this.visible = false
  })
  focus = vi.fn()
  destroy = vi.fn()
}
vi.mock('electron', () => ({
  BrowserWindow: WindowFixture,
  screen: { getCursorScreenPoint: () => ({ x: 5000, y: 5000 }) },
  webContents: { getFocusedWebContents: () => null }
}))
vi.mock('../../../src/main/browser/child-window-support', () => ({
  resolveChildWindowPreload: () => '/app/out/preload/index.cjs',
  resolveAppTheme: () => 'dark',
  loadRendererDocument: mocks.load
}))
vi.mock('../../../src/main/ipc/renderer-delivery', () => ({ sendToRenderer: mocks.send }))
vi.mock('../../../src/main/system/logger', () => ({ Logger: { error: vi.fn() } }))
const { BrowserOverlayWindow } = await import('../../../src/main/browser/browser-overlay-window')
const hosts: InstanceType<typeof BrowserOverlayWindow>[] = []
const request: NativeDockRequest = {
  id: 'modal',
  revision: 1,
  modal: true,
  theme: 'dark',
  bounds: { x: 20, y: 30, width: 400, height: 200 },
  nodes: [
    { tag: 'button', attributes: { 'data-native-dock-action': 'apply' }, children: ['Apply'] }
  ]
}
function setup() {
  const parent = new WindowFixture()
  const changed = vi.fn()
  const host = new BrowserOverlayWindow(parent as unknown as BrowserWindow, undefined, changed)
  hosts.push(host)
  return { parent, host, changed }
}
afterEach(() => {
  hosts.splice(0).forEach((host) => host.dispose())
  windows.length = 0
  vi.clearAllMocks()
  vi.useRealTimers()
})
describe('native browser overlay window', () => {
  it('loads a secure native child and reveals it without hiding or focusing the browser', () => {
    const { parent, host } = setup()
    expect(host.applyDock(request.id, request)).toBe(true)
    const popup = windows[1]
    expect(popup.options).toMatchObject({
      parent,
      show: false,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      webPreferences: {
        preload: '/app/out/preload/index.cjs',
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    expect(popup.showInactive).not.toHaveBeenCalled()
    popup.webContents.emit('did-finish-load')
    expect(popup.showInactive).toHaveBeenCalledOnce()
    expect(parent.hide).not.toHaveBeenCalled()
    expect(popup.focus).not.toHaveBeenCalled()
    expect(popup.setAlwaysOnTop).toHaveBeenCalledWith(true, 'floating')
    expect(mocks.send).toHaveBeenCalledWith(popup.webContents, 'browser:overlay:docks', [
      expect.objectContaining({ id: request.id, revision: request.revision })
    ])
  })
  it('keeps tooltips click-through and gives only a modal keyboard ownership', () => {
    const { host, parent } = setup()
    host.applyDock('app-tooltip', { ...request, id: 'app-tooltip', passive: true, modal: false })
    const popup = windows[1]
    popup.webContents.emit('did-finish-load')
    expect(popup.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true })
    expect(popup.focus).not.toHaveBeenCalled()
    host.applyDock(request.id, request)
    expect(popup.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, { forward: true })
    expect(host.focusDock(request.id)).toBe(true)
    expect(popup.focus).toHaveBeenCalledOnce()
    expect(parent.hide).not.toHaveBeenCalled()
  })
  it('routes native key input to the source modal and leaves the browser attached', () => {
    const { host, parent } = setup()
    host.applyDock(request.id, request)
    const popup = windows[1]
    popup.webContents.emit('did-finish-load')
    const preventDefault = vi.fn()
    popup.webContents.emit(
      'before-input-event',
      { preventDefault },
      {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        meta: true,
        control: false,
        shift: false,
        alt: false,
        isAutoRepeat: false
      }
    )
    expect(preventDefault).not.toHaveBeenCalled()
    expect(mocks.send).toHaveBeenCalledWith(parent.webContents, 'browser:overlay:dockKey', {
      id: request.id,
      type: 'keydown',
      key: 'Enter',
      code: 'Enter',
      meta: true,
      control: false,
      shift: false,
      alt: false,
      isAutoRepeat: false,
      target: null
    })
    expect(parent.hide).not.toHaveBeenCalled()
  })
  it('removes the modal and restores click-through after the bounded exit', async () => {
    vi.useFakeTimers()
    const { host, parent } = setup()
    host.applyDock(request.id, request)
    const popup = windows[1]
    popup.webContents.emit('did-finish-load')
    host.applyDock(request.id, null)
    await vi.advanceTimersByTimeAsync(180)
    expect(host.currentState().docks).toEqual([])
    expect(popup.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true })
    expect(parent.hide).not.toHaveBeenCalled()
    expect(parent.destroy).not.toHaveBeenCalled()
  })
})

it('keeps native link previews passive and click-through', () => {
  const { parent, host } = setup()
  const status = { url: 'https://example.com', left: 10, bottom: 4 }
  host.applyStatus(status)
  const popup = windows[1]
  popup.webContents.emit('did-finish-load')
  expect(host.currentState().status).toEqual(status)
  expect(popup.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true })
  expect(popup.focus).not.toHaveBeenCalled()
  expect(parent.hide).not.toHaveBeenCalled()
  host.applyStatus(null)
  expect(host.currentState().status).toBeNull()
})

const { PermissionPromptWindow } =
  await import('../../../src/main/browser/permission-prompt-window')
it('keeps native browser permission prompts above the page and never revives a resolved prompt', async () => {
  const parent = new WindowFixture()
  const prompt = new PermissionPromptWindow(parent as unknown as BrowserWindow)
  const context = {
    request: {
      id: 'permission-1',
      tabId: 'tab-1',
      projectId: 'project-1',
      origin: 'https://example.com',
      permission: 'media',
      mediaTypes: ['audio']
    },
    queueSize: 1,
    projectLabel: null,
    systemAccessDenied: false
  }
  try {
    prompt.show(context, { x: 0, y: 0, width: 800 })
    await Promise.resolve()
    await Promise.resolve()
    const popup = windows[1]
    expect(popup.options).toMatchObject({
      parent,
      alwaysOnTop: true,
      webPreferences: {
        preload: '/app/out/preload/index.cjs',
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    expect(prompt.currentContext()).toEqual(context)
    expect(parent.hide).not.toHaveBeenCalled()
    prompt.hide()
    popup.show.mockClear()
    parent.emit('resize')
    parent.emit('move')
    expect(prompt.currentContext()).toBeNull()
    expect(popup.show).not.toHaveBeenCalled()
  } finally {
    prompt.dispose()
  }
})
