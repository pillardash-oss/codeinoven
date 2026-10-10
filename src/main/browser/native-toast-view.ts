import { BrowserWindow, WebContentsView, webContents, type WebContents } from 'electron'
import type { ToastOverlayRequestStack } from '../../lib/browser-overlay'
import { TOAST_CARD_WIDTH, TOAST_STACK_RIGHT, TOAST_STACK_TOP } from '../../lib/browser-overlay'
import {
  loadRendererDocument,
  resolveAppTheme,
  resolveChildWindowPreload
} from './child-window-support'
import { sendToRenderer } from '../ipc/renderer-delivery'

/** A bounded native view receives normal mouse input in the parent's key window. */
export class NativeToastView {
  private view: WebContentsView | null = null
  private stack: ToastOverlayRequestStack | null = null
  private height = 0
  private ready = false
  private focusBeforeToast: WebContents | null = null
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private host: BrowserWindow
  private readonly reposition = (): void => this.position()
  constructor(private readonly parent: BrowserWindow) {
    this.host = parent
    this.host.on('resize', this.reposition)
    parent.once('closed', () => this.dispose())
  }
  setHost(host: BrowserWindow): void {
    if (host === this.host) return
    this.host.removeListener('resize', this.reposition)
    if (this.view && !this.host.isDestroyed()) this.host.contentView.removeChildView(this.view)
    this.host = host
    this.host.on('resize', this.reposition)
    this.position()
    this.raise()
  }
  owns(contentsId: number): boolean {
    return this.view?.webContents.id === contentsId
  }
  currentStack(): ToastOverlayRequestStack | null {
    return this.stack
  }
  apply(stack: ToastOverlayRequestStack | null): boolean {
    if (stack?.toasts.length) clearTimeout(this.idleTimer)
    const focused = webContents.getFocusedWebContents()
    if (
      focused &&
      focused !== this.view?.webContents &&
      (focused === this.parent.webContents ||
        this.parent.contentView.children.some(
          (child) => child instanceof WebContentsView && child.webContents === focused
        ))
    )
      this.focusBeforeToast = focused
    this.stack = stack
    if (!this.view && !stack?.toasts.length) return true
    const view = this.ensure()
    if (!view) return false
    if (this.ready) sendToRenderer(view.webContents, 'browser:overlay:stack', stack)
    return true
  }
  setHeight(height: number): void {
    if (!Number.isFinite(height) || height < 0 || height > 100_000)
      throw new TypeError('Invalid native toast height')
    this.height = Math.ceil(height)
    this.position()
    if (height) this.raise()
    else if (this.view && !this.host.isDestroyed()) {
      const view = this.view
      const restore = view.webContents.isFocused() && this.host.isFocused()
      this.host.contentView.removeChildView(view)
      const target = this.host === this.parent ? this.focusBeforeToast : this.host.webContents
      if (restore && target && !target.isDestroyed()) target.focus()
      clearTimeout(this.idleTimer)
      this.idleTimer = setTimeout(() => {
        if (this.height || this.stack?.toasts.length || this.view !== view) return
        this.view = null
        this.ready = false
        if (!view.webContents.isDestroyed()) view.webContents.close()
      }, 15_000)
      this.idleTimer.unref()
    }
  }
  raise(): void {
    if (this.height && this.view && !this.host.isDestroyed())
      this.host.contentView.addChildView(this.view)
  }
  dispose(): void {
    clearTimeout(this.idleTimer)
    this.host.removeListener('resize', this.reposition)
    const view = this.view
    this.view = null
    this.ready = false
    if (!view) return
    if (!this.host.isDestroyed()) this.host.contentView.removeChildView(view)
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }
  private position(): void {
    if (!this.view || this.host.isDestroyed()) return
    const content = this.host.getContentBounds()
    const width = Math.min(content.width, TOAST_CARD_WIDTH + TOAST_STACK_RIGHT + 32)
    const bounds = {
      x: content.width - width,
      y: TOAST_STACK_TOP - 16,
      width,
      height: Math.max(1, Math.min(this.height, content.height - TOAST_STACK_TOP + 16))
    }
    const old = this.view.getBounds()
    if (
      old.x !== bounds.x ||
      old.y !== bounds.y ||
      old.width !== bounds.width ||
      old.height !== bounds.height
    )
      this.view.setBounds(bounds)
  }
  private ensure(): WebContentsView | null {
    if (this.view && !this.view.webContents.isDestroyed()) return this.view
    if (this.parent.isDestroyed()) return null
    const view = new WebContentsView({
      webPreferences: {
        preload: resolveChildWindowPreload(),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    this.view = view
    view.setBackgroundColor('#00000000')
    this.position()
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    view.webContents.on('did-finish-load', () => {
      if (this.view !== view) return
      this.ready = true
      sendToRenderer(view.webContents, 'browser:overlay:stack', this.stack)
    })
    void loadRendererDocument(view.webContents, 'browser-overlay.html', {
      theme: resolveAppTheme(),
      surface: 'toasts'
    })
    return view
  }
}
