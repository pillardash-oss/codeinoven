import {
  nativeDockImageIds,
  validateNativeDockImages,
  type NativeDockCommit,
  type NativeDockRequest
} from '../../lib/native-dock'
import { BrowserWindow, screen } from 'electron'
import { Logger } from '../system/logger'
import { sendToRenderer } from '../ipc/renderer-delivery'
import {
  browserOverlayWindowBounds,
  type BrowserOverlaySnapshot,
  type BrowserStatusOverlay,
  type BrowserStripOverlayRequest,
  type ToastOverlayCursor,
  type ToastOverlayRequestStack
} from '../../lib/browser-overlay'
import {
  loadRendererDocument,
  resolveAppTheme,
  resolveChildWindowPreload
} from './child-window-support'

/**
 * Owns the frameless child window that draws the app's overlay content over a
 * browser page.
 *
 * The page is a native `WebContentsView` and composites above every DOM node of
 * the app window, so a toast, or the browser's floating tab strip, drawn in the
 * app's DOM would be painted under it. Whatever the page would cover therefore
 * moves into this window: same place, same content, same state, and the page
 * stays live and interactive underneath.
 *
 * The window spans the whole content area below the application header, because
 * it hosts more than one region: the toast stack in the top right corner, and the
 * tab strip down the left band when it floats. Only the pixels a region paints
 * are opaque; everywhere else the window passes clicks through to the page.
 *
 * Three properties make it behave like part of the app window rather than like a
 * second window:
 *
 *   - it is parented to the app window, follows it, and is hidden with it when
 *     the app window is minimized, so it can never outlive or float away from
 *     what it belongs to;
 *   - it never takes the keyboard (`focusable: false`), so pressing a card's
 *     action or a tab row never pulls focus out of the page the user was typing
 *     in;
 *   - it swallows a click only where drawn content actually is. Everywhere else,
 *     which is most of the window, `setIgnoreMouseEvents` passes the click
 *     through to the page below, so the strip of screen it covers stays usable.
 *
 * The window is created on the first toast or floating strip that needs it and
 * kept, hidden, while a page keeps needing it. That keeps a second renderer's
 * memory off the books until it is actually needed, at the cost of the first
 * surface of a browsing session appearing a moment later than the ones after it.
 *
 * Delivery is pull-based for the first paint and push after it, exactly like the
 * permission prompt: a push straight after `loadURL` loses the race against the
 * document's own subscription and the renderer-delivery load-state guards.
 */
export class BrowserOverlayWindow {
  private popup: BrowserWindow | null = null
  /** The stack on display, or null while none is. */
  private stack: ToastOverlayRequestStack | null = null
  /** The floating tab strip on display, or null while none is. */
  private strip: BrowserStripOverlayRequest | null = null
  /** The link preview on display, or null while none is. Paint-only, so it is
   *  never part of the click-through decision. */
  private status: BrowserStatusOverlay | null = null
  private docks = new Map<string, NativeDockRequest>()
  private deliveredDockImages = new Map<string, Set<string>>()
  /** True while the document has finished loading and may be sent content. */
  private ready = false
  /** Tracked rather than read back, because the toggle is only ever a change. */
  private pointerOverContent = false
  /** The click-through state the window server was last given, so it is only
   *  ever told about a change: a needless call re-evaluates the window under
   *  the pointer and hands the document an event it would misread. */
  private ignoringMouse = true

  constructor(
    private readonly parent: BrowserWindow,
    private readonly preloadPath: string = resolveChildWindowPreload()
  ) {}

  /**
   * Draw `stack`, or take it down with null.
   *
   * An empty stack means the page still covers the stack's corner but no card is
   * showing: the window is hidden and kept, so the next toast is instant.
   *
   * Answers false only when the window is genuinely unavailable, which is the
   * caller's cue to fall back to parking the page rather than leaving the toast
   * behind it.
   */
  applyStack(request: ToastOverlayRequestStack | null): boolean {
    if (request !== null && request.toasts.length > 0) {
      const popup = this.ensure()
      if (!popup) return false
      this.stack = request
      this.reveal(popup)
      this.publish(popup)
      return true
    }
    this.stack = request
    this.settle()
    return true
  }

  /**
   * Draw the floating tab strip, or take it down with null.
   *
   * Answers false only when the window could not be created, which is what makes
   * the app renderer keep the strip in its own DOM and let it occlude the page
   * instead.
   */
  applyStrip(request: BrowserStripOverlayRequest | null): boolean {
    if (request !== null) {
      const popup = this.ensure()
      if (!popup) return false
      this.strip = request
      this.reveal(popup)
      this.publish(popup)
      return true
    }
    this.strip = null
    this.settle()
    return true
  }

  /**
   * Draw the link preview at the page's bottom-left, or take it down with null.
   *
   * The bubble is not interactive: it is painted, never pressed, which is why it
   * stays out of `applyClickThrough` and the page underneath stays live. Answers
   * false only when the window could not be created, which the caller reads as
   * "no preview" rather than parking the page.
   */
  applyStatus(request: BrowserStatusOverlay | null): boolean {
    if (request !== null) {
      const popup = this.ensure()
      if (!popup) return false
      this.status = request
      this.reveal(popup)
      this.publish(popup)
      return true
    }
    this.status = null
    this.settle()
    return true
  }

  /**
   * The toaster's release: no page covers the stack's corner any more, so the
   * stack belongs back in the app's own DOM.
   *
   * The window itself only goes when nothing else is using it: a floating tab
   * strip may still be drawing in it, and a window torn down under a live strip
   * would take the panel with it.
   */
  releaseStack(): void {
    this.stack = null
    this.settle()
    if (!this.hasContent()) this.dispose()
  }

  /** Dock chips share this window with toasts and the floating browser strip. */
  applyDock(id: string, request: NativeDockRequest | null): boolean {
    if (request === null) {
      this.docks.delete(id)
      this.deliveredDockImages.delete(id)
      this.settle()
      // Keep the one tooltip overlay warm between hovers instead of creating
      // and destroying a renderer for every title. It stays hidden and inert.
      if (!this.hasContent() && id !== 'app-tooltip' && id !== 'thread-switcher') this.dispose()
      return true
    }
    if (!this.docks.has(id) && this.docks.size >= 32) return false
    const popup = this.ensure()
    if (!popup) return false
    const previous = this.docks.get(id)?.images ?? {}
    const images: Record<string, string> = {}
    for (const imageId of nativeDockImageIds(request.nodes)) {
      const source = request.images?.[imageId] ?? previous[imageId]
      if (!source) throw new TypeError('Native dock image is missing')
      images[imageId] = source
    }
    this.docks.set(id, { ...request, images: validateNativeDockImages(images) })
    this.reveal(popup)
    this.publish(popup)
    return true
  }

  /** Everything on display, resolved to the document's own pull on first load. */
  currentState(): BrowserOverlaySnapshot {
    return {
      stack: this.stack,
      strip: this.strip,
      docks: [...this.docks.values()],
      status: this.status
    }
  }

  /** Settle selection in the window that actually saw the latest mouse move. */
  commitDock(request: NativeDockCommit): boolean {
    const popup = this.popup
    if (!popup || popup.isDestroyed() || !this.ready || !this.docks.get(request.id)?.modal)
      return false
    sendToRenderer(popup.webContents, 'browser:overlay:dockCommit', request)
    return true
  }

  /** Whether the pointer is over drawn content, which decides click-through. */
  setPointerOverContent(over: boolean): void {
    this.pointerOverContent = over
    this.applyClickThrough()
  }

  /**
   * Where the pointer is, in this window's own client coordinates.
   *
   * Read from the window server rather than from the events this window is sent,
   * because those events cannot be trusted about it: this window ignores the
   * mouse until content is under the pointer, and every call that changes that is
   * what makes the window server re-evaluate the window under the pointer and
   * send back a mouseout that reads as a departure. Answered null while there is
   * no window to measure, which the document takes as "nothing to say" rather
   * than as "the pointer is nowhere".
   */
  pointerInClientSpace(): ToastOverlayCursor | null {
    const popup = this.popup
    if (!popup || popup.isDestroyed()) return null
    const point = screen.getCursorScreenPoint()
    const bounds = popup.getContentBounds()
    return { x: point.x - bounds.x, y: point.y - bounds.y }
  }

  dispose(): void {
    const popup = this.popup
    this.popup = null
    this.stack = null
    this.strip = null
    this.status = null
    this.docks.clear()
    this.deliveredDockImages.clear()
    this.ready = false
    this.pointerOverContent = false
    this.ignoringMouse = true
    if (popup && !popup.isDestroyed()) popup.destroy()
  }

  /**
   * Show the window without ever making it the active one, and settle where the
   * pointer stands the moment it appears.
   *
   * The window is shown before content is published, not after: the document
   * answers a publish by asking where the pointer is and asserting the
   * click-through state, and a window that arms click-through afterwards would
   * overwrite that answer and put content under the pointer back into
   * click-through, where its buttons are dead. Never `show()`: the overlay must
   * not become the active window, or the page the user was typing in would lose
   * the keyboard to a card.
   */
  private reveal(popup: BrowserWindow): void {
    this.position(popup)
    if (popup.isVisible()) return
    this.pointerOverContent = false
    popup.showInactive()
    this.applyClickThrough()
  }

  /**
   * Tell the document what is left to draw, and hide the window once nothing is.
   *
   * The publish happens even as the last region leaves, because the document has
   * to be told to take it down: a hidden window still holds its renderer, and
   * content left in that renderer would be there the next time it is shown.
   */
  private settle(): void {
    const popup = this.popup
    if (!popup || popup.isDestroyed()) return
    this.publish(popup)
    if (this.hasContent()) return
    this.pointerOverContent = false
    this.applyClickThrough()
    if (popup.isVisible()) popup.hide()
  }

  /**
   * Hand the window server the one click-through state that follows from what
   * this window is showing and where the pointer is.
   *
   * Painted content is the only thing here that is not transparent, so every
   * pixel outside it belongs to the page underneath and a click there has to pass
   * through. Called only on a change: `setIgnoreMouseEvents` makes the window
   * server re-evaluate the window under the pointer, and the events that come
   * back are exactly what a document cannot distinguish from the pointer having
   * left.
   */
  private applyClickThrough(): void {
    const popup = this.popup
    if (!popup || popup.isDestroyed()) return
    const ignore = !(this.pointerOverContent && this.hasContent())
    if (ignore === this.ignoringMouse) return
    this.ignoringMouse = ignore
    popup.setIgnoreMouseEvents(ignore, { forward: true })
  }

  /** Whether anything is on screen in this window to be seen or pressed. */
  private hasContent(): boolean {
    return (
      (this.stack !== null && this.stack.toasts.length > 0) ||
      this.strip !== null ||
      this.status !== null ||
      this.docks.size > 0
    )
  }

  /** The regions the overlay would draw right now, for the document's pull. */
  private publish(popup: BrowserWindow): void {
    if (!this.ready) return
    sendToRenderer(popup.webContents, 'browser:overlay:stack', this.stack)
    sendToRenderer(popup.webContents, 'browser:overlay:strip', this.strip)
    sendToRenderer(popup.webContents, 'browser:overlay:status', this.status)
    const docks = [...this.docks.values()].map((dock) => {
      const delivered = this.deliveredDockImages.get(dock.id) ?? new Set<string>()
      const images: Record<string, string> = {}
      const currentIds = new Set(Object.keys(dock.images ?? {}))
      for (const id of delivered) if (!currentIds.has(id)) delivered.delete(id)
      for (const [id, source] of Object.entries(dock.images ?? {})) {
        if (!delivered.has(id)) images[id] = source
        delivered.add(id)
      }
      this.deliveredDockImages.set(dock.id, delivered)
      return { ...dock, images }
    })
    sendToRenderer(popup.webContents, 'browser:overlay:docks', docks)
  }

  private ensure(): BrowserWindow | null {
    const existing = this.popup
    if (existing && !existing.isDestroyed()) return existing
    this.popup = null
    this.ready = false
    if (this.parent.isDestroyed()) return null
    try {
      const popup = this.create()
      this.popup = popup
      return popup
    } catch (error: unknown) {
      Logger.error('The browser overlay window could not be created:', error)
      return null
    }
  }

  private create(): BrowserWindow {
    const bounds = browserOverlayWindowBounds(this.parent.getContentBounds())
    const popup = new BrowserWindow({
      width: bounds.width,
      height: bounds.height,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      // Never key: pressing a card or a tab row is handled without taking the
      // keyboard away from the page underneath, and `acceptFirstMouse` makes that
      // first click press the control instead of being spent activating the
      // window.
      focusable: false,
      acceptFirstMouse: true,
      parent: this.parent,
      alwaysOnTop: true,
      title: 'Overlay',
      webPreferences: {
        preload: this.preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: false
      }
    })
    // Above the app window and its native page views, without covering another
    // application's floating windows.
    popup.setAlwaysOnTop(true, 'floating')
    popup.setMenuBarVisibility(false)
    // An invisible window must never swallow a click meant for the page: the
    // document arms this off, and back on only over drawn content.
    this.ignoringMouse = true
    popup.setIgnoreMouseEvents(true, { forward: true })
    this.position(popup)
    popup.webContents.on('did-finish-load', () => {
      // A new overlay document has no resource cache yet, including after HMR.
      this.deliveredDockImages.clear()
      this.ready = true
      this.publish(popup)
    })
    popup.webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, url, isMainFrame) => {
        // -3 is an aborted load (the window was taken down mid-load), not a fault.
        if (!isMainFrame || errorCode === -3) return
        Logger.error('The browser overlay document did not load:', {
          errorCode,
          errorDescription,
          url
        })
        if (this.popup === popup) this.dispose()
      }
    )
    popup.on('closed', () => {
      if (this.popup === popup) {
        this.popup = null
        this.ready = false
      }
    })
    this.trackParent(popup)
    void loadRendererDocument(popup, 'browser-overlay.html', { theme: resolveAppTheme() })
    return popup
  }

  /** Keep the overlay glued to the app window: it moves with it, hides while it
   *  is minimized, and is destroyed with it. */
  private trackParent(popup: BrowserWindow): void {
    const reposition = (): void => {
      if (popup.isDestroyed() || this.parent.isDestroyed()) return
      if (this.parent.isMinimized()) {
        if (popup.isVisible()) popup.hide()
        return
      }
      this.position(popup)
      if (this.hasContent() && !popup.isVisible()) popup.showInactive()
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

  private position(popup: BrowserWindow): void {
    if (this.parent.isDestroyed()) return
    popup.setBounds(browserOverlayWindowBounds(this.parent.getContentBounds()))
  }
}
