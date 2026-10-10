import { BrowserWindow, WebContentsView } from 'electron'
import {
  nativeDockImageIds,
  validateNativeDockImages,
  type NativeDockRequest
} from '../../lib/native-dock'
import type { BrowserStripOverlayRequest } from '../../lib/browser-overlay'
import {
  loadRendererDocument,
  resolveAppTheme,
  resolveChildWindowPreload
} from './child-window-support'
import { sendToRenderer } from '../ipc/renderer-delivery'

/** A bounded view receives native hover and clicks in the application's key window. */
export class NativeStripView {
  private view: WebContentsView | null = null
  private request: BrowserStripOverlayRequest | null = null
  private dock: NativeDockRequest | null = null
  private deliveredImages = new Set<string>()
  private ready = false
  private hideTimer: ReturnType<typeof setTimeout> | undefined
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private readonly reposition = (): void => this.position()
  constructor(private readonly parent: BrowserWindow) {
    parent.on('resize', this.reposition)
    parent.once('closed', () => this.dispose())
  }
  owns(id: number): boolean {
    return this.view?.webContents.id === id
  }
  currentStrip(): BrowserStripOverlayRequest | null {
    return this.request
  }
  currentDocks(): NativeDockRequest[] {
    return this.dock ? [this.dock] : []
  }
  applyDock(request: NativeDockRequest | null): boolean {
    if (!request) {
      this.dock = null
      this.deliveredImages.clear()
      return this.apply(null)
    }
    clearTimeout(this.hideTimer)
    clearTimeout(this.idleTimer)
    this.request = null
    const images: Record<string, string> = {}
    for (const id of nativeDockImageIds(request.nodes)) {
      const source = request.images?.[id] ?? this.dock?.images?.[id]
      if (!source) throw new TypeError('Native sidebar image is missing')
      images[id] = source
    }
    this.dock = { ...request, images: validateNativeDockImages(images) }
    const view = this.ensure()
    if (!view) return false
    this.position()
    this.raise()
    if (this.ready) this.publishDock(view)
    return true
  }
  private publishDock(view: WebContentsView): void {
    const dock = this.dock
    if (!dock) {
      sendToRenderer(view.webContents, 'browser:overlay:docks', [])
      return
    }
    const images: Record<string, string> = {}
    for (const id of this.deliveredImages) if (!dock.images?.[id]) this.deliveredImages.delete(id)
    for (const [id, source] of Object.entries(dock.images ?? {})) {
      if (!this.deliveredImages.has(id)) images[id] = source
      this.deliveredImages.add(id)
    }
    sendToRenderer(view.webContents, 'browser:overlay:docks', [{ ...dock, images }])
  }
  apply(request: BrowserStripOverlayRequest | null): boolean {
    clearTimeout(this.hideTimer)
    clearTimeout(this.idleTimer)
    this.request = request
    if (request) {
      const view = this.ensure()
      if (!view) return false
      this.position()
      this.raise()
      if (this.ready) sendToRenderer(view.webContents, 'browser:overlay:strip', request)
    } else if (this.view) {
      sendToRenderer(this.view.webContents, 'browser:overlay:strip', null)
      this.publishDock(this.view)
      // Leave the view attached only until its short exit transition completes.
      this.hideTimer = setTimeout(() => {
        if (this.request || this.dock || !this.view || this.parent.isDestroyed()) return
        const view = this.view
        const restoreFocus = view.webContents.isFocused() && this.parent.isFocused()
        this.parent.contentView.removeChildView(view)
        if (restoreFocus) this.parent.webContents.focus()
        this.idleTimer = setTimeout(() => {
          if (!this.request && !this.dock) this.disposeView()
        }, 15_000)
        this.idleTimer.unref()
      }, 160)
    }
    return true
  }
  raise(): void {
    if ((this.request || this.dock) && this.view && !this.parent.isDestroyed())
      this.parent.contentView.addChildView(this.view)
  }
  dispose(): void {
    this.parent.removeListener('resize', this.reposition)
    this.disposeView()
  }
  private disposeView(): void {
    clearTimeout(this.hideTimer)
    clearTimeout(this.idleTimer)
    const view = this.view
    this.view = null
    this.ready = false
    this.deliveredImages.clear()
    if (!view) return
    if (!this.parent.isDestroyed()) this.parent.contentView.removeChildView(view)
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }
  private position(): void {
    if (!this.view || (!this.request && !this.dock) || this.parent.isDestroyed()) return
    const content = this.parent.getContentBounds()
    this.view.setBounds({
      x: 0,
      y: Math.round(this.dock?.bounds.y ?? this.request?.top ?? 0),
      width: Math.round(
        Math.min(content.width, this.dock?.bounds.width ?? this.request?.width ?? 0)
      ),
      height: Math.max(
        1,
        Math.round(this.dock?.bounds.height ?? content.height - (this.request?.top ?? 0))
      )
    })
  }
  private ensure(): WebContentsView | null {
    if (this.view && !this.view.webContents.isDestroyed()) return this.view
    if (this.parent.isDestroyed()) return null
    const view = new WebContentsView({
      webPreferences: {
        preload: resolveChildWindowPreload(),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    })
    this.view = view
    view.setBackgroundColor('#00000000')
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    view.webContents.on('before-input-event', (_event, input) => {
      if (!this.dock || (!input.meta && !input.control)) return
      sendToRenderer(this.parent.webContents, 'browser:overlay:dockKey', {
        id: this.dock.id,
        type: input.type === 'keyDown' ? 'keydown' : 'keyup',
        key: input.key,
        code: input.code,
        control: input.control,
        shift: input.shift,
        alt: input.alt,
        meta: input.meta,
        isAutoRepeat: input.isAutoRepeat
      })
    })
    view.webContents.on('did-finish-load', () => {
      if (this.view !== view) return
      this.ready = true
      this.deliveredImages.clear()
      sendToRenderer(view.webContents, 'browser:overlay:strip', this.request)
      this.publishDock(view)
    })
    void loadRendererDocument(view.webContents, 'browser-overlay.html', {
      theme: resolveAppTheme(),
      surface: 'strip'
    })
    return view
  }
}
