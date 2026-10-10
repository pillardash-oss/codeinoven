import { BrowserWindow, WebContentsView, screen } from 'electron'
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
  /** Whether the browser view is mounted and expects the panel to be instant. */
  private warm = false
  /**
   * Whether the real cursor is over the panel, and the poll that keeps it true.
   *
   * The host cannot answer this itself. A view that is attached under a cursor
   * that never moved receives no enter, and the leave Chromium synthesises for
   * the surface it replaced arrives as the pointer walking away. The cursor and
   * the view's own rectangle are both known here, so the answer is measured
   * rather than inferred from events the host may never see.
   *
   * The measurement is re-sent every cycle rather than only when it changes. The
   * app window assumes the pointer is on the panel while the host loads, so a
   * one-off "outside" that races that assumption would never be corrected and the
   * panel would stay up with the pointer nowhere near it.
   */
  private pointerTimer: ReturnType<typeof setInterval> | undefined
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
  /**
   * Load the host ahead of the gesture that needs it.
   *
   * The floating sidebar is revealed by a pointer reaching the window edge, and
   * the panel has to be there in a frame. A host created on that hover spends its
   * first few hundred milliseconds loading a renderer, which is a visible pause.
   * While a browser view is on screen this keeps the host loaded and attached to
   * nothing, so the first reveal draws immediately.
   */
  setWarm(warm: boolean): boolean {
    this.warm = warm
    clearTimeout(this.idleTimer)
    if (warm) return this.ensure() !== null
    // Nothing is asked of this surface any more: let it go once its exit
    // transition has finished, exactly as it would after a hide.
    if (!this.request && !this.dock) this.scheduleIdle()
    return true
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
        this.stopPointerWatch()
        if (restoreFocus) this.parent.webContents.focus()
        this.scheduleIdle()
      }, 160)
    }
    return true
  }
  private scheduleIdle(): void {
    if (this.warm) return
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      if (!this.request && !this.dock && !this.warm) this.disposeView()
    }, 15_000)
    this.idleTimer.unref()
  }
  raise(): void {
    if ((this.request || this.dock) && this.view && !this.parent.isDestroyed()) {
      this.parent.contentView.addChildView(this.view)
      this.watchPointer()
    }
  }
  /** Measure the pointer against the panel while the panel is on screen. */
  private watchPointer(): void {
    if (this.pointerTimer !== undefined) return
    this.pointerTimer = setInterval(() => this.reportPointer(), 120)
    this.pointerTimer.unref()
    this.reportPointer()
  }
  private stopPointerWatch(): void {
    if (this.pointerTimer !== undefined) clearInterval(this.pointerTimer)
    this.pointerTimer = undefined
  }
  private reportPointer(): void {
    const view = this.view
    if (!view || this.parent.isDestroyed() || (!this.dock && !this.request)) return
    const bounds = view.getBounds()
    const content = this.parent.getContentBounds()
    const cursor = screen.getCursorScreenPoint()
    const over =
      cursor.x >= content.x + bounds.x &&
      cursor.x < content.x + bounds.x + bounds.width &&
      cursor.y >= content.y + bounds.y &&
      cursor.y < content.y + bounds.y + bounds.height
    sendToRenderer(this.parent.webContents, 'browser:overlay:stripEvent', {
      kind: 'pointer',
      over
    })
  }
  dispose(): void {
    this.parent.removeListener('resize', this.reposition)
    this.stopPointerWatch()
    this.disposeView()
  }
  private disposeView(): void {
    clearTimeout(this.hideTimer)
    clearTimeout(this.idleTimer)
    this.stopPointerWatch()
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
