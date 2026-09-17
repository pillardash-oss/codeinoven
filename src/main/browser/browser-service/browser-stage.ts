/**
 * Offscreen parking for browser tabs.
 *
 * A `WebContentsView` only keeps a real viewport and keeps producing frames
 * while its content rect intersects a *shown* window. Measured on Electron
 * 44/macOS: a view attached to a visible window but positioned outside that
 * window's content rect reports `visibilityState=hidden`, gets a 0x0 viewport,
 * never fires `requestAnimationFrame` or IntersectionObserver, and cannot be
 * captured ("Current display surface not available"). Any non-empty
 * intersection is enough, and a view keeps the exact size it was given, so a
 * parked view is laid out at its own viewport while only its edge sits inside
 * the stage window.
 *
 * Parked tabs therefore share ONE invisible stage window, parented to the app
 * window so it lives in the app's window group: the app window never becomes
 * occluded, its own rendering never pauses, the stage follows the app into
 * macOS fullscreen, and it never floats above other applications. Opacity 0
 * keeps it out of sight while macOS still counts the window as shown.
 *
 * The stage is a `BaseWindow`, not a `BrowserWindow`: it needs a content view
 * but no page of its own, and a real `BrowserWindow` would take part in
 * `BrowserWindow.getAllWindows()`, where the app looks for its focused or main
 * window and broadcasts renderer events.
 *
 * One shared window rather than one per tab is deliberate. With a window per
 * parked tab, macOS stopped treating more than two of them as visible as soon
 * as the app was not the active application, which silently froze the extra
 * pages; six views in one window stayed visible in every state measured,
 * including while the app was in the background.
 */

import { BaseWindow, screen, type WebContentsView } from 'electron'
import { Logger } from '../../system/logger'
import type { BrowserViewport } from './browser-types'

/** How much of each parked view stays inside the stage window. Liveness only
 *  needs a non-empty intersection, so the views sit mostly outside the window
 *  and overlap each other while keeping their own full size. */
const TILE_STRIP = 160
/** Offset between rounds of tiles, so tiles that share a corner do not sit
 *  exactly on top of one another. */
const TILE_SHIFT = 40

interface ParkedTab {
  view: WebContentsView
  viewport: BrowserViewport
}

function isUsableViewport(viewport: BrowserViewport): boolean {
  return (
    Number.isFinite(viewport.width) &&
    Number.isFinite(viewport.height) &&
    viewport.width > 0 &&
    viewport.height > 0
  )
}

/**
 * Position for parked view n: the four corners of the stage window inset by
 * `TILE_STRIP` (so the view's top-left is inside the window and the view is
 * therefore live), then the same four corners shifted a little for the next
 * round. The shift stays strictly inside the window even on a tiny display.
 */
function tilePosition(index: number, width: number, height: number): { x: number; y: number } {
  const limitedWidth = Math.max(1, width)
  const limitedHeight = Math.max(1, height)
  const insetX = Math.max(0, limitedWidth - TILE_STRIP)
  const insetY = Math.max(0, limitedHeight - TILE_STRIP)
  const corners = [
    { x: 0, y: 0 },
    { x: insetX, y: 0 },
    { x: 0, y: insetY },
    { x: insetX, y: insetY }
  ]
  const corner = corners[index % corners.length]
  const round = Math.floor(index / corners.length)
  const shift = Math.min(
    (round * TILE_SHIFT) % TILE_STRIP,
    Math.max(0, limitedWidth - 1),
    Math.max(0, limitedHeight - 1)
  )
  return { x: corner.x + shift, y: corner.y + shift }
}

export class BrowserTabStage {
  /** Parked tabs in the order they were parked, which also assigns tile slots. */
  private readonly parked = new Map<number, ParkedTab>()
  private stageWindow: BaseWindow | null = null
  private disposed = false
  /** Parked views must be re-laid out when screens change: a smaller work area
   *  would push tiles outside the stage window, which freezes pages. */
  private readonly onDisplayChange = (): void => this.relayout()
  /** The stage must go when the app window does, or it would outlive the app
   *  (native child windows are not destroyed with their parent) and keep the
   *  process alive. */
  private readonly onAppWindowClosed = (): void => this.dispose()

  constructor(private readonly appWindow: BaseWindow) {
    screen.on('display-metrics-changed', this.onDisplayChange)
    screen.on('display-added', this.onDisplayChange)
    screen.on('display-removed', this.onDisplayChange)
    appWindow.on('closed', this.onAppWindowClosed)
  }

  isParked(view: WebContentsView): boolean {
    return this.parked.has(view.webContents.id)
  }

  /**
   * Mount a tab in the stage window at its parked viewport. Safe to call for an
   * already parked view: the viewport is re-applied and the view is re-attached,
   * which also rescues a view whose stage was rebuilt underneath it.
   */
  park(view: WebContentsView, viewport: BrowserViewport): void {
    if (this.disposed || view.webContents.isDestroyed()) return
    if (!isUsableViewport(viewport)) {
      Logger.error('Browser tab parked with an unusable viewport:', viewport)
      return
    }
    const window = this.ensureWindow()
    if (!window) return
    const id = view.webContents.id
    const entry = this.parked.get(id)
    if (entry) entry.viewport = viewport
    else this.parked.set(id, { view, viewport })
    window.contentView.addChildView(view)
    this.placeView(view, viewport, this.tileIndexFor(id))
    this.ensureShown()
  }

  /**
   * Unmount a tab from the stage window. The caller decides where the view goes
   * next (the app window) or leaves it detached, which stops it rendering.
   */
  release(view: WebContentsView): void {
    const id = view.webContents.id
    if (!this.parked.has(id)) return
    this.parked.delete(id)
    const window = this.stageWindow
    if (window && !window.isDestroyed()) window.contentView.removeChildView(view)
  }

  /**
   * Re-assert that a parked tab is still being shown and report whether its page
   * still sees itself as visible. A page that does not can be repaired with
   * `restart`.
   */
  async verifyVisible(view: WebContentsView): Promise<boolean> {
    const entry = this.parked.get(view.webContents.id)
    if (!entry || view.webContents.isDestroyed()) return false
    if (!this.ensureWindow() || !this.ensureShown()) return false
    this.placeView(entry.view, entry.viewport, this.tileIndexFor(view.webContents.id))
    try {
      const state: unknown = await view.webContents.executeJavaScript('document.visibilityState')
      return state === 'visible'
    } catch {
      return false
    }
  }

  /**
   * Rebuild the stage window, for a parked page that stopped seeing itself as
   * visible. Every parked tab is re-mounted, not just the one that looked
   * broken: the window they were all riding in is the thing being replaced.
   * Rebuilding happens a tick later, because creating a window in the same tick
   * as destroying one at the same place leaves the new window unshown, and a
   * view in an unshown window stays dead.
   */
  restart(view: WebContentsView, viewport: BrowserViewport): void {
    if (this.disposed) return
    const target = this.parked.get(view.webContents.id)
    if (target) target.viewport = viewport
    else this.parked.set(view.webContents.id, { view, viewport })
    const restored = [...this.parked.values()]
    this.parked.clear()
    this.destroyWindow()
    setImmediate(() => {
      if (this.disposed) return
      for (const entry of restored) {
        if (!entry.view.webContents.isDestroyed()) this.park(entry.view, entry.viewport)
      }
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.parked.clear()
    screen.off('display-metrics-changed', this.onDisplayChange)
    screen.off('display-added', this.onDisplayChange)
    screen.off('display-removed', this.onDisplayChange)
    if (!this.appWindow.isDestroyed()) this.appWindow.off('closed', this.onAppWindowClosed)
    this.destroyWindow()
  }

  private tileIndexFor(id: number): number {
    let index = 0
    for (const key of this.parked.keys()) {
      if (key === id) return index
      index++
    }
    return index
  }

  private placeView(view: WebContentsView, viewport: BrowserViewport, index: number): void {
    const window = this.stageWindow
    if (!window || window.isDestroyed() || view.webContents.isDestroyed()) return
    const { width, height } = window.getContentBounds()
    const position = tilePosition(index, width, height)
    try {
      view.setBounds({
        x: position.x,
        y: position.y,
        width: viewport.width,
        height: viewport.height
      })
    } catch (error: unknown) {
      // Bounds must never leave the stage inconsistent: a view that failed to
      // place is still tracked and is re-placed on the next park or relayout.
      Logger.error('Browser parked view could not be placed:', error)
    }
  }

  /** Re-apply the window size and every tile, after the displays changed. */
  private relayout(): void {
    if (this.disposed) return
    const window = this.stageWindow
    if (!window || window.isDestroyed()) return
    this.applyWindowBounds(window)
    let index = 0
    for (const entry of this.parked.values()) {
      this.placeView(entry.view, entry.viewport, index++)
    }
    this.ensureShown()
  }

  private ensureWindow(): BaseWindow | null {
    if (this.disposed || this.appWindow.isDestroyed()) return null
    const existing = this.stageWindow
    if (existing && !existing.isDestroyed()) return existing
    const workArea = screen.getPrimaryDisplay().workArea
    const stage = new BaseWindow({
      width: workArea.width,
      height: workArea.height,
      x: workArea.x,
      y: workArea.y,
      show: false,
      frame: false,
      opacity: 0,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      acceptFirstMouse: false,
      // A parented stage shares the app window's window group, so it never
      // occludes the app window and follows it into macOS fullscreen.
      parent: this.appWindow
    })
    // An invisible window must never swallow a click meant for the app.
    stage.setIgnoreMouseEvents(true)
    stage.setMenuBarVisibility(false)
    this.stageWindow = stage
    // Show it before anything is parked in it: a view added to a window that was
    // never shown does not get a display surface.
    this.ensureShown()
    return stage
  }

  private applyWindowBounds(window: BaseWindow): void {
    const workArea = screen.getPrimaryDisplay().workArea
    const bounds = window.getBounds()
    if (
      bounds.width === workArea.width &&
      bounds.height === workArea.height &&
      bounds.x === workArea.x &&
      bounds.y === workArea.y
    ) {
      return
    }
    window.setBounds(workArea)
  }

  private ensureShown(): boolean {
    const window = this.stageWindow
    if (!window || window.isDestroyed()) return false
    if (window.isVisible()) return true
    // Never force a stage visible while the app itself is out of the way: showing
    // a child of a minimized window would drag the app back on screen, and parked
    // pages legitimately pause while the app window is not on screen.
    if (this.appWindow.isDestroyed() || this.appWindow.isMinimized()) return false
    if (!this.appWindow.isVisible()) return false
    try {
      // `showInactive` keeps keyboard focus in the app window.
      window.showInactive()
      return true
    } catch (error: unknown) {
      Logger.error('Browser stage window could not be shown:', error)
      return false
    }
  }

  private destroyWindow(): void {
    const window = this.stageWindow
    this.stageWindow = null
    if (!window || window.isDestroyed()) return
    try {
      window.destroy()
    } catch (error: unknown) {
      Logger.dev('Browser stage window was already gone:', error)
    }
  }
}
