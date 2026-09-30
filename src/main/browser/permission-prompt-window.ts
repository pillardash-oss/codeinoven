import { BrowserWindow } from 'electron'
import type { BrowserPermissionRequest } from '../../lib/ipc-contract'
import { TOAST_CARD_WIDTH, TOAST_STACK_RIGHT } from '../../lib/browser-overlay'
import {
  loadRendererDocument,
  resolveAppTheme,
  resolveChildWindowPreload
} from './child-window-support'
import { sendToRenderer } from '../ipc/renderer-delivery'

/** Window-content anchor for the popup, in density-independent pixels. */
interface PromptAnchor {
  x: number
  y: number
  width: number
}

/** One permission request on display in the popup, with everything the
 *  document needs: the request itself, the queue depth, and the owning
 *  project/thread label (null when the records are unavailable). */
export interface PromptRequestContext {
  request: BrowserPermissionRequest
  queueSize: number
  projectLabel: string | null
}

/** The card is as wide as a toast card, plus the translucent margins its shadow
 *  needs; the document's own padding mirrors these numbers
 *  (`src/renderer/permission-prompt.html`). The height fits the tallest card the
 *  content can make   a three-line request at the largest base font size   so
 *  the buttons are never clipped; the rest of the window is transparent. */
const POPUP_SIDE_PAD = 12
const POPUP_WIDTH = TOAST_CARD_WIDTH + POPUP_SIDE_PAD * 2
const POPUP_HEIGHT = 176
const POPUP_MARGIN = 8

/**
 * Owns the frameless child window that shows browser permission requests.
 *
 * The browser page is a native WebContentsView that floats above every DOM
 * surface of the main window, so the previous DOM permission modal forced the
 * main process to detach the whole view (blanking the page) whenever a site
 * asked for the camera or microphone. A real OS popup composites above the
 * view, so the page stays live and interactive while the prompt is open.
 *
 * The prompt is drawn as a card of the app's own   a toast card's width, tokens
 * and type hierarchy   so it reads as the same surface the user already meets at
 * the window's corner rather than as a foreign one. This window is only the
 * transparent frame around that card, which is why it holds no background of
 * its own.
 *
 * Delivery is pull-based: the document invokes `browser:popupReady` once its
 * permission listener is bound, and main resolves the invoke with the request
 * on display. Pushing the first request after `loadURL` raced document
 * subscription AND the renderer-delivery load-state guards (which see
 * `isLoadingMainFrame()` still true after load settles), repeatedly dropping
 * the first prompt and leaving an empty "wants to use ." shell. An invoke
 * reply cannot hit that race, so the document always pulls its payload.
 */
export class PermissionPromptWindow {
  private popup: BrowserWindow | null = null
  private anchor: PromptAnchor | null = null
  /** Request currently on display; resolved to the document when it pulls via
   *  `browser:popupReady`, and cleared when the prompt hides. */
  private current: PromptRequestContext | null = null
  /** True while a request is on display; the reposition tracker only re-shows
   *  the popup when this is set so a resolved (hidden) prompt never returns. */
  private active = false

  constructor(
    private readonly parent: BrowserWindow,
    private readonly preloadPath: string = resolveChildWindowPreload(),
    private readonly resolveTheme: () => 'light' | 'dark' = resolveAppTheme
  ) {}

  /** Show (or update) the prompt for `context`; kept until the prompt hides. */
  show(context: PromptRequestContext, contentAnchor: PromptAnchor | null): void {
    this.current = context
    this.anchor = contentAnchor
    this.active = true
    if (this.popup && !this.popup.isDestroyed()) {
      const existing = this.popup
      this.position(existing)
      if (!existing.isVisible()) existing.show()
      // The document is already listening; push the update immediately. The
      // pull path only covers first-load delivery, where push races.
      this.deliver()
      return
    }
    if (!this.parent || this.parent.isDestroyed()) return
    const popup = new BrowserWindow({
      width: POPUP_WIDTH,
      height: POPUP_HEIGHT,
      show: false,
      frame: false,
      // The document paints one rounded card and nothing else, so the window is
      // transparent: the card floats over the page on its own shadow, in the
      // shape it actually has, instead of sitting in an opaque rectangle.
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
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
      // First-load delivery is pull-based: the document invokes
      // `browser:popupReady` and main resolves with `current`. A push here
      // races the document subscription and the load-state guards.
    })
  }

  /** The request on display, resolved to the document's `browser:popupReady`
   *  invoke. No-op returns null when nothing is on display. */
  currentContext(): PromptRequestContext | null {
    if (!this.current || !this.active) return null
    return this.current
  }

  /** Hide the popup (e.g. last request resolved); the window stays reusable. */
  hide(): void {
    this.active = false
    this.current = null
    const popup = this.popup
    if (!popup || popup.isDestroyed()) return
    if (popup.isVisible()) popup.hide()
  }

  dispose(): void {
    const popup = this.popup
    this.popup = null
    this.anchor = null
    this.current = null
    this.active = false
    if (popup && !popup.isDestroyed()) popup.destroy()
  }

  private deliver(): void {
    const popup = this.popup
    const context = this.current
    if (!popup || popup.isDestroyed() || this.parent.isDestroyed()) return
    if (!context) return
    sendToRenderer(popup.webContents, 'browser:popup:permission', context.request, {
      queueSize: context.queueSize,
      projectLabel: context.projectLabel
    })
  }

  private load(popup: BrowserWindow): Promise<void> {
    return loadRendererDocument(popup, 'permission-prompt.html', { theme: this.resolveTheme() })
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

  /** Place the popup inside the parent's content area, centred over the browser
   *  content it belongs to.
   *
   *  It used to sit at the top right of that content, which is where the toast
   *  stack lives: a toast is drawn by a child window of its own while a page
   *  covers that corner (`browser-overlay-window.ts`), so a centred card on a
   *  narrow window would sit under the stack. It now stops short of the stack's
   *  band instead of drifting into it, and is exactly centred on every window
   *  wide enough for the two to clear each other. */
  private position(popup: BrowserWindow): void {
    if (this.parent.isDestroyed()) return
    const content = this.parent.getContentBounds()
    const anchor = this.anchor
    const centre = anchor ? anchor.x + anchor.width / 2 : content.width / 2
    const top = anchor ? anchor.y : 0
    const stackLeft = content.x + content.width - TOAST_STACK_RIGHT - TOAST_CARD_WIDTH
    const left = content.x + POPUP_MARGIN
    const rightLimit = Math.max(left, stackLeft - POPUP_MARGIN - POPUP_WIDTH)
    const centred = Math.round(content.x + centre - POPUP_WIDTH / 2)
    const x = Math.min(Math.max(centred, left), rightLimit)
    const y = Math.max(content.y, content.y + top + POPUP_MARGIN)
    popup.setBounds({ x, y, width: POPUP_WIDTH, height: POPUP_HEIGHT })
  }
}
