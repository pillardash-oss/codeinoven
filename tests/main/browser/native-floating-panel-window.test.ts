import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { NativeFloatingPanelWindow } from '../../../src/main/browser/native-floating-panel-window'
const mocks = vi.hoisted(() => ({ handle: vi.fn(), send: vi.fn() }))
vi.mock('../../../src/main/ipc/trusted-ipc-main', () => ({
  trustedIpcMain: { handle: mocks.handle }
}))
vi.mock('../../../src/main/ipc/renderer-delivery', () => ({ sendToRenderer: mocks.send }))
vi.mock('../../../src/main/bootstrap/keyboard-shortcuts', () => ({ isCloseShortcut: () => false }))
function fixture() {
  let visible = true
  const webContents = Object.assign(new EventEmitter(), {
    getZoomFactor: () => 1.5,
    setZoomFactor: vi.fn(),
    isDestroyed: () => false,
    focus: vi.fn(),
    setWindowOpenHandler: vi.fn()
  })
  const bounds = { x: 0, y: 0, width: 1, height: 1 }
  return Object.assign(new EventEmitter(), {
    webContents,
    isDestroyed: () => false,
    isVisible: () => visible,
    isMinimized: () => false,
    getContentBounds: () => ({ x: 100, y: 80, width: 1000, height: 800 }),
    getBounds: () => bounds,
    setBounds: vi.fn((next: typeof bounds) => Object.assign(bounds, next)),
    showInactive: vi.fn(() => {
      visible = true
    }),
    hide: vi.fn(() => {
      visible = false
    }),
    focus: vi.fn(),
    destroy: vi.fn()
  })
}
const managers: NativeFloatingPanelWindow[] = []
afterEach(() => {
  managers.splice(0).forEach((manager) => manager.release('panel'))
  vi.restoreAllMocks()
})
function setup() {
  const parent = fixture()
  const child = fixture()
  child.hide()
  child.hide.mockClear()
  const manager = new NativeFloatingPanelWindow(parent as unknown as BrowserWindow)
  managers.push(manager)
  const bounds = { x: 20, y: 30, width: 400, height: 200 }
  const token = manager.prepare('panel', bounds)
  return { parent, child, manager, bounds, token }
}
function attach(test: ReturnType<typeof setup>) {
  expect(test.manager.handleWindowOpen({ url: 'about:blank', frameName: test.token })?.action).toBe(
    'allow'
  )
  test.parent.webContents.emit('did-create-window', test.child, {
    url: 'about:blank',
    frameName: test.token
  })
}
describe('native floating window host', () => {
  it('allows only a prepared one-use about:blank host with an isolated, unprivileged child', () => {
    const test = setup()
    expect(
      test.manager.handleWindowOpen({ url: 'https://example.com', frameName: test.token })?.action
    ).toBe('deny')
    const result = test.manager.handleWindowOpen({ url: 'about:blank', frameName: test.token })!
    expect(result.action).toBe('allow')
    expect(result.overrideBrowserWindowOptions).toMatchObject({
      parent: test.parent,
      show: false,
      frame: false,
      transparent: true,
      webPreferences: {
        preload: '',
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true
      }
    })
    expect(
      test.manager.handleWindowOpen({ url: 'about:blank', frameName: test.token })?.action
    ).toBe('deny')
    expect(
      test.manager.handleWindowOpen({ url: 'about:blank', frameName: 'cio-floating-unknown' })
        ?.action
    ).toBe('deny')
  })
  it('shows the child above the browser without hiding the parent and activates only on expansion', () => {
    const test = setup()
    attach(test)
    test.manager.update('panel', test.bounds, true)
    expect(test.child.showInactive).toHaveBeenCalledOnce()
    expect(test.child.focus).toHaveBeenCalledOnce()
    expect(test.parent.hide).not.toHaveBeenCalled()
    test.manager.update('panel', { ...test.bounds, x: 40 }, true)
    test.parent.emit('resize')
    test.parent.emit('move')
    expect(test.child.focus).toHaveBeenCalledOnce()
    expect(test.parent.hide).not.toHaveBeenCalled()
    test.manager.update('panel', test.bounds, false)
    expect(test.child.hide).toHaveBeenCalledOnce()
    test.manager.update('panel', test.bounds, true)
    expect(test.child.focus).toHaveBeenCalledTimes(2)
  })
  it('scales and clamps bounds inside the parent at its zoom level', () => {
    const test = setup()
    attach(test)
    test.manager.update('panel', { x: 9999, y: -20, width: 400, height: 200 }, true)
    expect(test.child.setBounds).toHaveBeenLastCalledWith(
      { x: 500, y: 80, width: 600, height: 300 },
      false
    )
  })
  it('reuses prepared identity and destroys only its child on release', () => {
    const test = setup()
    attach(test)
    expect(test.manager.prepare('panel', test.bounds)).toBe(test.token)
    test.manager.release('panel')
    expect(test.child.destroy).toHaveBeenCalledOnce()
    expect(test.parent.destroy).not.toHaveBeenCalled()
    expect(test.manager.update('panel', test.bounds, true)).toBe(false)
  })
  it('destroys stale native windows when the app renderer navigates', () => {
    const test = setup()
    attach(test)
    test.parent.webContents.emit('did-start-navigation', {}, 'app://new', false, true)
    expect(test.child.destroy).toHaveBeenCalledOnce()
  })
})
