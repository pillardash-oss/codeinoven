import { app, BrowserWindow, nativeTheme } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BrowserPermissionRequest } from '../../lib/ipc-contract'
import { sendToRenderer } from '../ipc/renderer-delivery'

/** Window-content anchor for the popup, in density-independent pixels. */
interface PromptAnchor {
  x: number
  y: number
  width: number
}

const POPUP_WIDTH = 360
const POPUP_HEIGHT = 208
const POPUP_MARGIN = 8

/** Resolve the app preload bundle (same lookup as the main window). */
function defaultPreloadPath(): string {
  const dir = join(fileURLToPath(import.meta.url), '../../preload')
  for (const name of ['index.mjs', 'index.js', 'index.cjs']) {
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return join(dir, 'index.js')
}

/** First-paint theme hint; the popup document refines via `config:get`. */
function defaultResolveTheme(): 'light' | 'dark' {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

/**
 * Owns the frameless child window that shows browser permission requests.
 *
 * The browser page is a native WebContentsView that floats above every DOM
 * surface of the main window, so the previous DOM permission modal forced the
 * main process to detach the whole view (blanking the page) whenever a site
 * asked for the camera or microphone. A real OS popup composites above the
 * view, so the page stays live and interactive while the prompt is open.
 */
export class PermissionPromptWindow {
  private popup: BrowserWindow | null = null
  private anchor: PromptAnchor | null = null
  /** True while a request is on display; the reposition tracker only re-shows
   *  the popup when this is set so a resolved (hidden) prompt never returns. */
  private active = false

  constructor(
    private readonly parent: BrowserWindow,
    private readonly preloadPath: string = defaultPreloadPath(),
    private readonly resolveTheme: () => 'light' | 'dark' = defaultResolveTheme
  ) {}

  /** Show (or update) the prompt for `request`; `queueSize` covers queued siblings. */
  show(request: BrowserPermissionRequest, queueSize: number, contentAnchor: PromptAnchor | null): void {
    this.anchor = contentAnchor
    this.active = true
    if (this.popup && !this.popup.isDestroyed()) {
      const existing = this.popup
      this.position(existing)
      if (!existing.isVisible()) existing.show()
      this.deliver(request, queueSize)
      return
    }
    if (!this.parent || this.parent.isDestroyed()) return
    const theme = this.resolveTheme()
    const popup = new BrowserWindow({
      width: POPUP_WIDTH,
      height: POPUP_HEIGHT,
      show: false,
      frame: false,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      parent: this.parent,
      // Stay composited above the parent (and its WebContentsView) without
      // covering other apps' floating windows.
      alwaysOnTop: true,
      backgroundColor: theme === 'dark' ? '#0b0b0d' : '#f7f6f2',
      title: 'Browser permission',
      webPreferences: {
        preload: this.preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: false
      }
    })
    this.popup = popup
    popup.setAlwaysOnTop(true, 'floating')
    popup.on('closed', () => {
      if (this.popup === popup) this.popup = null
    })
    this.trackParentMovement(popup)
    void this.load(popup).finally(() => {
      if (popup.isDestroyed()) return
      this.position(popup)
      popup.show()
      this.deliver(request, queueSize)
    })
  }

  /** Hide the popup (e.g. last request resolved); the window stays reusable. */
  hide(): void {
    this.active = false
    const popup = this.popup
    if (!popup || popup.isDestroyed()) return
    if (popup.isVisible()) popup.hide()
  }

  dispose(): void {
    const popup = this.popup
    this.popup = null
    this.anchor = null
    if (popup && !popup.isDestroyed()) popup.destroy()
  }

  private deliver(request: BrowserPermissionRequest, queueSize: number): void {
    const popup = this.popup
    if (!popup || popup.isDestroyed() || this.parent.isDestroyed()) return
    sendToRenderer(popup.webContents, 'browser:popup:permission', request, { queueSize })
  }

  private load(popup: BrowserWindow): Promise<void> {
    const theme = this.resolveTheme()
    if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
      const url = new URL('browser-popup.html', `${process.env['ELECTRON_RENDERER_URL']}/`)
      url.searchParams.set('theme', theme)
      return popup.loadURL(url.href).catch(() => {})
    }
    const document = join(fileURLToPath(import.meta.url), '../../renderer/browser-popup.html')
    return popup
      .loadFile(document, { query: { theme } })
      .catch(() => {})
  }

  /** Keep the prompt glued to the parent: reposition on move/resize and hide
   *  it when the parent is minimized (child windows cannot minimize along). */
  private trackParentMovement(popup: BrowserWindow): void {
    const reposition = (): void => {
      if (popup.isDestroyed() || this.parent.isDestroyed()) return
      if (this.parent.isMinimized()) {
        if (popup.isVisible()) popup.hide()
        return
      }
      this.position(popup)
      if (this.active && this.popup === popup && !popup.isVisible() && this.anchor !== null) {
        popup.show()
      }
    }
    this.parent.on('move', reposition)
    this.parent.on('resize', reposition)
    this.parent.on('minimize', () => {
      if (!popup.isDestroyed() && popup.isVisible()) popup.hide()
    })
    this.parent.on('restore', reposition)
    this.parent.once('closed', () => {
      if (!popup.isDestroyed()) popup.destroy()
    })
  }

  /** Place the popup inside the parent's content area, top-right of the active
   *  browser content when its bounds are known (clear of top-right toasts,
   *  which render at the window edge), otherwise of the whole window. */
  private position(popup: BrowserWindow): void {
    if (this.parent.isDestroyed()) return
    const content = this.parent.getContentBounds()
    const anchor = this.anchor
    const right = anchor ? content.x + anchor.x + anchor.width : content.x + content.width
    const top = anchor ? content.y + anchor.y : content.y
    const x = Math.max(content.x, right - POPUP_WIDTH - POPUP_MARGIN)
    const y = Math.max(content.y, top + POPUP_MARGIN)
    popup.setBounds({ x, y, width: POPUP_WIDTH, height: POPUP_HEIGHT })
  }
}
