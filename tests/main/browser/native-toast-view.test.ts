import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { ToastOverlayRequestStack } from '../../../src/lib/browser-overlay'

const mocks = vi.hoisted(() => ({
  focused: vi.fn(),
  preload: vi.fn(() => '/app/out/preload/index.cjs'),
  load: vi.fn().mockResolvedValue(undefined),
  send: vi.fn(),
  options: [] as unknown[]
}))
class Contents extends EventEmitter {
  id = 1
  isDestroyed = vi.fn(() => false)
  isFocused = vi.fn(() => false)
  focus = vi.fn()
  close = vi.fn()
  setWindowOpenHandler = vi.fn()
}
class View {
  webContents = new Contents()
  bounds = { x: 0, y: 0, width: 0, height: 0 }
  constructor(options?: unknown) {
    mocks.options.push(options)
  }
  setBackgroundColor = vi.fn()
  getBounds() {
    return this.bounds
  }
  setBounds(bounds: typeof this.bounds) {
    this.bounds = bounds
  }
}
vi.mock('electron', () => ({
  BrowserWindow: class {},
  WebContentsView: View,
  webContents: { getFocusedWebContents: mocks.focused }
}))
vi.mock('../../../src/main/browser/child-window-support', () => ({
  resolveChildWindowPreload: mocks.preload,
  resolveAppTheme: () => 'dark',
  loadRendererDocument: mocks.load
}))
vi.mock('../../../src/main/ipc/renderer-delivery', () => ({ sendToRenderer: mocks.send }))
const { NativeToastView } = await import('../../../src/main/browser/native-toast-view')

function windowFixture() {
  const window = new EventEmitter()
  const browser = new View()
  const children: View[] = [browser]
  const remove = vi.fn((view: View) => {
    const index = children.indexOf(view)
    if (index >= 0) children.splice(index, 1)
  })
  const add = vi.fn((view: View) => {
    const index = children.indexOf(view)
    if (index >= 0) children.splice(index, 1)
    children.push(view)
  })
  return Object.assign(window, {
    webContents: new Contents(),
    contentView: { children, addChildView: add, removeChildView: remove },
    getContentBounds: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
    isDestroyed: () => false,
    isFocused: () => true,
    browser
  })
}
const stack: ToastOverlayRequestStack = {
  revision: 1,
  theme: 'dark',
  toasts: [{ id: 'toast-1', kind: 'success', title: 'Saved' }]
}
const hosts: InstanceType<typeof NativeToastView>[] = []
afterEach(() => {
  hosts.splice(0).forEach((host) => host.dispose())
  vi.clearAllMocks()
  mocks.options.length = 0
})

describe('native Sonner toast host', () => {
  it('loads the native toast document with the app preload and isolation', () => {
    const window = windowFixture()
    const host = new NativeToastView(window as unknown as BrowserWindow)
    hosts.push(host)
    host.apply(stack)
    expect(mocks.preload).toHaveBeenCalledOnce()
    expect(mocks.options.at(-1)).toEqual({
      webPreferences: {
        preload: '/app/out/preload/index.cjs',
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    expect(mocks.load).toHaveBeenCalledWith(expect.any(Contents), 'browser-overlay.html', {
      surface: 'toasts',
      theme: 'dark'
    })
  })

  it('raises toasts above the browser and removes only the toast view on dismissal', () => {
    const window = windowFixture()
    mocks.focused.mockReturnValue(window.browser.webContents)
    const host = new NativeToastView(window as unknown as BrowserWindow)
    hosts.push(host)
    host.apply(stack)
    host.setHeight(180)
    const toast = window.contentView.children.at(-1)!
    expect(toast).not.toBe(window.browser)
    expect(window.contentView.children[0]).toBe(window.browser)
    expect(window.contentView.removeChildView).not.toHaveBeenCalledWith(window.browser)
    expect(window.browser.webContents.focus).not.toHaveBeenCalled()
    toast.webContents.emit('did-finish-load')
    expect(mocks.send).toHaveBeenCalledWith(toast.webContents, 'browser:overlay:stack', stack)
    window.emit('resize')
    expect(window.contentView.children).toContain(window.browser)
    host.setHeight(0)
    expect(window.contentView.children).toEqual([window.browser])
    expect(window.contentView.removeChildView).toHaveBeenCalledWith(toast)
    expect(window.browser.webContents.close).not.toHaveBeenCalled()
  })

  it('moves toasts above a native modal without removing the browser from its original host', () => {
    const window = windowFixture()
    const modal = windowFixture()
    const host = new NativeToastView(window as unknown as BrowserWindow)
    hosts.push(host)
    host.apply(stack)
    host.setHeight(160)
    const toast = window.contentView.children.at(-1)!
    host.setHost(modal as unknown as BrowserWindow)
    expect(window.contentView.children).toEqual([window.browser])
    expect(modal.contentView.children.at(-1)).toBe(toast)
    host.setHost(window as unknown as BrowserWindow)
    expect(window.contentView.children.at(-1)).toBe(toast)
    expect(window.contentView.removeChildView).not.toHaveBeenCalledWith(window.browser)
  })
})
