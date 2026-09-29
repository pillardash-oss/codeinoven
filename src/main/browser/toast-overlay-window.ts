import { BrowserWindow } from 'electron'
import { Logger } from '../system/logger'
import { sendToRenderer } from '../ipc/renderer-delivery'
import {
  TOAST_OVERLAY_HEIGHT,
  TOAST_OVERLAY_WIDTH,
  toastOverlayWindowBounds,
  type ToastOverlayStack
} from '../../lib/toast-overlay'
import {
  loadRendererDocument,
  resolveAppTheme,
  resolveChildWindowPreload
} from './child-window-support'

/**
 * Owns the frameless child window that draws the toast stack over a browser page.
 *
 * The page is a native `WebContentsView` and composites above every DOM node of
 * the app window, so a toast drawn in the app's DOM is painted under it. The
 * stack therefore moves into this window while a page covers the corner the
 * toaster occupies: same place, same cards, same state, and the page stays live
 * and interactive underneath.
 *
 * Three properties make it behave like part of the app window rather than like a
 * second window:
 *
 *   - it is parented to the app window, follows it, and is hidden with it when
 *     the app window is minimized, so it can never outlive or float away from
 *     what it belongs to;
 *   - it never takes the keyboard (`focusable: false`), so clicking a toast's
 *     action never pulls focus out of the page the user was typing in;
 *   - it swallows a click only where a card actually is. Everywhere else, which
 *     is most of the window, `setIgnoreMouseEvents` passes the click through to
 *     the page below, so the strip of screen it covers stays fully usable.
 *
 * The window is created on the first toast that needs it and kept, hidden, while
 * the page keeps covering the corner. That keeps a second renderer's memory off
 * the books until it is actually needed, at the cost of the first toast of a
 * browsing session appearing a moment later than the ones after it.
 *
 * Delivery is pull-based for the first paint and push after it, exactly like the
 * permission prompt: a push straight after `loadURL` loses the race against the
 * document's own subscription and the renderer-delivery load-state guards.
 */
export class ToastOverlayWindow {
  private popup: BrowserWindow | null = null
  /** The stack on display, or null while nothing is showing. */
  private stack: ToastOverlayStack | null = null
  /** True while the document has finished loading and may be sent a stack. */
  private ready = false
  /** Tracked rather than read back, because the toggle is only ever a change. */
  private pointerOverToast = false

  constructor(
    private readonly parent: BrowserWindow,
    private readonly preloadPath: string = resolveChildWindowPreload()
  ) {}

  /**
   * Draw `stack`, or hide the window when the stack has emptied.
   *
   * The window is kept, hidden, through an empty stack: a page that still covers
   * the toaster's corner will very likely raise another toast, and recreating a
   * renderer for each one would cost more than it saves.
   *
   * Answers false only when the overlay is genuinely unavailable, which is the
   * caller's cue to fall back to parking the page rather than leaving the toast
   * behind it.
   */
  apply(stack: ToastOverlayStack): boolean {
    if (stack.toasts.length === 0) {
      this.hide()
      return true
    }
    const popup = this.ensure()
    if (!popup) return false
    this.stack = stack
    this.position(popup)
    this.publish(popup)
    if (!popup.isVisible()) {
      // Never `show()`: the overlay must not become the active window, or the
      // page the user was typing in would lose the keyboard to a card.
      popup.showInactive()
      this.pointerOverToast = false
      popup.setIgnoreMouseEvents(true, { forward: true })
    }
    return true
  }

  /** The stack on display, resolved to the document's own pull on first load. */
  currentStack(): ToastOverlayStack | null {
    return this.stack
  }

  /** Whether the pointer is over a card, which decides click-through. */
  setPointerOverToast(overToast: boolean): void {
    if (overToast === this.pointerOverToast) return
    this.pointerOverToast = overToast
    const popup = this.popup
    if (!popup || popup.isDestroyed()) return
    popup.setIgnoreMouseEvents(!overToast, { forward: true })
  }

  /** Hide the window while keeping it ready for the next toast. */
  hide(): void {
    this.stack = null
    this.pointerOverToast = false
    const popup = this.popup
    if (!popup || popup.isDestroyed()) return
    popup.setIgnoreMouseEvents(true, { forward: true })
    if (popup.isVisible()) popup.hide()
  }

  /** Take the overlay down for good.
   *
   * No page covers the toaster's corner any more, so the stack belongs back in
   * the app's own DOM and this window, and the renderer it holds, are released. */
  release(): void {
    this.hide()
    this.dispose()
  }

  dispose(): void {
    const popup = this.popup
    this.popup = null
    this.stack = null
    this.ready = false
    this.pointerOverToast = false
    if (popup && !popup.isDestroyed()) popup.destroy()
  }

  /** The stack the overlay would draw right now, for the document's pull. */
  private publish(popup: BrowserWindow): void {
    const stack = this.stack
    if (!this.ready || !stack) return
    sendToRenderer(popup.webContents, 'browser:toastOverlay:stack', stack)
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
      Logger.error('The toast overlay window could not be created:', error)
      return null
    }
  }

  private create(): BrowserWindow {
    const popup = new BrowserWindow({
      width: TOAST_OVERLAY_WIDTH,
      height: TOAST_OVERLAY_HEIGHT,
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
      // Never key: a click on a card is handled without taking the keyboard away
      // from the page underneath, and `acceptFirstMouse` makes that first click
      // press the button instead of being spent activating the window.
      focusable: false,
      acceptFirstMouse: true,
      parent: this.parent,
      alwaysOnTop: true,
      title: 'Toasts',
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
    // document arms this off, and back on only over a card.
    popup.setIgnoreMouseEvents(true, { forward: true })
    this.position(popup)
    popup.webContents.on('did-finish-load', () => {
      this.ready = true
      this.publish(popup)
    })
    popup.webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, url, isMainFrame) => {
        // -3 is an aborted load (the window was taken down mid-load), not a fault.
        if (!isMainFrame || errorCode === -3) return
        Logger.error('The toast overlay document did not load:', {
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
    void loadRendererDocument(popup, 'toast-overlay.html', { theme: resolveAppTheme() })
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
      if (this.stack && this.stack.toasts.length > 0 && !popup.isVisible()) popup.showInactive()
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
    popup.setBounds(toastOverlayWindowBounds(this.parent.getContentBounds()))
  }
}
