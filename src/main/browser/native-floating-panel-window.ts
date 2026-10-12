import { randomUUID } from 'node:crypto'
import type {
  BrowserWindow,
  IpcMainInvokeEvent,
  WebContents,
  WindowOpenHandlerResponse
} from 'electron'
import type { NativeFloatingPanelBounds } from '../../lib/native-floating-panel'
import { trustedIpcMain } from '../ipc/trusted-ipc-main'
import { sendToRenderer } from '../ipc/renderer-delivery'
import { isCloseShortcut } from '../bootstrap/keyboard-shortcuts'

const MAX_PANELS = 8
const PREPARATION_TTL_MS = 10_000
const managers = new WeakMap<WebContents, NativeFloatingPanelWindow>()
let handlersRegistered = false

interface Panel {
  token: string
  bounds: NativeFloatingPanelBounds
  visible: boolean
  consumed: boolean
  expiresAt: number
  timer?: ReturnType<typeof setTimeout>
  window?: BrowserWindow
}

function validateId(id: unknown): string {
  if (typeof id !== 'string' || !id.length || id.length > 256) {
    throw new Error('Invalid floating panel id')
  }
  return id
}

function validateBounds(value: unknown): NativeFloatingPanelBounds {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid panel bounds')
  const bounds = value as Record<string, unknown>
  const { x, y, width, height } = bounds
  if (
    typeof x !== 'number' ||
    !Number.isFinite(x) ||
    typeof y !== 'number' ||
    !Number.isFinite(y) ||
    typeof width !== 'number' ||
    !Number.isFinite(width) ||
    width <= 0 ||
    typeof height !== 'number' ||
    !Number.isFinite(height) ||
    height <= 0
  )
    throw new Error('Invalid panel bounds')
  return { x, y, width, height }
}

function managerFor(event: IpcMainInvokeEvent): NativeFloatingPanelWindow {
  const manager = managers.get(event.sender)
  if (!manager || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('Floating panels require the owning app main frame')
  }
  return manager
}

function registerHandlers(): void {
  if (handlersRegistered) return
  handlersRegistered = true
  trustedIpcMain.handle('app:prepareFloatingPanel', (event, id: unknown, bounds: unknown) =>
    managerFor(event).prepare(validateId(id), validateBounds(bounds))
  )
  trustedIpcMain.handle(
    'app:updateFloatingPanel',
    (event, id: unknown, bounds: unknown, visible: unknown) => {
      if (typeof visible !== 'boolean') throw new Error('Invalid panel visibility')
      return managerFor(event).update(validateId(id), validateBounds(bounds), visible)
    }
  )
  trustedIpcMain.handle('app:releaseFloatingPanel', (event, id: unknown) =>
    managerFor(event).release(validateId(id))
  )
}

/** Owns live about:blank hosts opened by one renderer, never serialized UI copies. */
export class NativeFloatingPanelWindow {
  private readonly panels = new Map<string, Panel>()

  constructor(private readonly parent: BrowserWindow) {
    registerHandlers()
    managers.set(parent.webContents, this)
    parent.webContents.on('did-create-window', (child, details) => {
      const entry = [...this.panels.entries()].find(
        ([, panel]) => panel.token === details.frameName
      )
      if (!entry) {
        if (details.frameName.startsWith('cio-floating-')) child.destroy()
        return
      }
      const [id, panel] = entry
      if (!panel.consumed || panel.window || details.url !== 'about:blank') {
        child.destroy()
        return
      }
      clearTimeout(panel.timer)
      panel.timer = undefined
      panel.window = child
      child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      child.webContents.on('will-navigate', (event) => event.preventDefault())
      child.webContents.on('will-frame-navigate', (event) => event.preventDefault())
      child.webContents.on('will-redirect', (event) => event.preventDefault())
      child.webContents.on('before-input-event', (event, input) => {
        if (isCloseShortcut(input)) {
          event.preventDefault()
          if (!parent.isDestroyed() && !parent.webContents.isDestroyed()) {
            sendToRenderer(parent.webContents, 'window:closeShortcut')
          }
        }
      })
      child.on('closed', () => {
        if (this.panels.get(id) === panel) this.panels.delete(id)
      })
      this.synchronize(panel)
    })
    const sync = (): void => {
      for (const panel of this.panels.values()) this.synchronize(panel)
    }
    parent.on('move', sync)
    parent.on('resize', sync)
    parent.on('show', sync)
    parent.on('hide', sync)
    parent.on('minimize', sync)
    parent.on('restore', sync)
    parent.webContents.on('zoom-changed', sync)
    parent.webContents.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => {
      if (mainFrame) this.dispose()
    })
    parent.webContents.on('render-process-gone', () => this.dispose())
    parent.on('closed', () => {
      this.dispose()
      managers.delete(parent.webContents)
    })
  }

  prepare(id: string, bounds: NativeFloatingPanelBounds): string {
    const existing = this.panels.get(id)
    if (existing && (existing.window || existing.expiresAt > Date.now())) {
      existing.bounds = bounds
      return existing.token
    }
    if (existing) this.release(id)
    if (this.panels.size >= MAX_PANELS) throw new Error('Floating panel limit reached')
    const panel: Panel = {
      token: `cio-floating-${randomUUID()}`,
      bounds,
      visible: false,
      consumed: false,
      expiresAt: Date.now() + PREPARATION_TTL_MS
    }
    panel.timer = setTimeout(() => {
      if (this.panels.get(id) === panel && !panel.window) this.release(id)
    }, PREPARATION_TTL_MS)
    this.panels.set(id, panel)
    return panel.token
  }

  /** Undefined means this request belongs to the parent's ordinary link handler. */
  handleWindowOpen(details: {
    url: string
    frameName: string
  }): WindowOpenHandlerResponse | undefined {
    const panel = [...this.panels.values()].find((entry) => entry.token === details.frameName)
    if (!panel)
      return details.frameName.startsWith('cio-floating-') ? { action: 'deny' } : undefined
    if (details.url !== 'about:blank' || panel.consumed || panel.expiresAt <= Date.now()) {
      return { action: 'deny' }
    }
    panel.consumed = true
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        parent: this.parent,
        show: false,
        transparent: true,
        backgroundColor: '#00000000',
        frame: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        hasShadow: false,
        skipTaskbar: true,
        roundedCorners: false,
        ...this.screenBounds(panel.bounds),
        webPreferences: {
          // Empty string explicitly replaces the parent's privileged preload.
          preload: '',
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          nodeIntegrationInSubFrames: false,
          nodeIntegrationInWorker: false,
          webSecurity: true
        }
      }
    }
  }

  update(id: string, bounds: NativeFloatingPanelBounds, visible: boolean): boolean {
    const panel = this.panels.get(id)
    if (!panel?.window || panel.window.isDestroyed()) return false
    panel.bounds = bounds
    panel.visible = visible
    this.synchronize(panel)
    return true
  }

  private screenBounds(bounds: NativeFloatingPanelBounds): NativeFloatingPanelBounds {
    const content = this.parent.getContentBounds()
    const zoom = this.parent.webContents.getZoomFactor()
    const width = Math.max(1, Math.min(content.width, Math.round(bounds.width * zoom)))
    const height = Math.max(1, Math.min(content.height, Math.round(bounds.height * zoom)))
    return {
      x: content.x + Math.max(0, Math.min(content.width - width, Math.round(bounds.x * zoom))),
      y: content.y + Math.max(0, Math.min(content.height - height, Math.round(bounds.y * zoom))),
      width,
      height
    }
  }

  private synchronize(panel: Panel): void {
    const child = panel.window
    if (!child || child.isDestroyed() || this.parent.isDestroyed()) return
    child.setBounds(this.screenBounds(panel.bounds), false)
    child.webContents.setZoomFactor(this.parent.webContents.getZoomFactor())
    if (panel.visible && this.parent.isVisible() && !this.parent.isMinimized()) {
      if (!child.isVisible()) child.showInactive()
    } else if (child.isVisible()) child.hide()
  }

  release(id: string): void {
    const panel = this.panels.get(id)
    if (!panel) return
    this.panels.delete(id)
    clearTimeout(panel.timer)
    if (panel.window && !panel.window.isDestroyed()) panel.window.destroy()
  }

  private dispose(): void {
    for (const id of this.panels.keys()) this.release(id)
  }
}
