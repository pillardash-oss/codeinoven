import {
  STATUS_BUBBLE_DELAY_MS,
  browserStatusOverlayPlacement,
  type BrowserStatusOverlay
} from '../../../lib/browser-overlay'
import type { BrowserService } from '../browser-service'

/**
 * The two surfaces drawn above a page: the link preview and the toast stack.
 *
 * A native view covers the app's own DOM, so a preview or a toast that must be seen over
 * a page is drawn by the overlay window instead   and, as a safety net, by parking the
 * active view for as long as the stack needs.
 */

/**
 * What `browser-service-status-overlay` reads off the browser service.
 *
 * Each member is the service's own declaration, so this unit and the composition
 * root cannot drift apart: a changed signature is a compile error here.
 */
export interface StatusOverlayHost {
  readonly activeTabBounds: BrowserService['activeTabBounds']
  readonly activeTabId: BrowserService['activeTabId']
  readonly overlay: BrowserService['overlay']
  readonly parkedViewportFor: BrowserService['parkedViewportFor']
  readonly parkTab: BrowserService['parkTab']
  readonly popupWindows: BrowserService['popupWindows']
  readonly showActiveView: BrowserService['showActiveView']
  statusDelayElapsed: BrowserService['statusDelayElapsed']
  statusOverlay: BrowserService['statusOverlay']
  statusShowTimer: BrowserService['statusShowTimer']
  readonly tabs: BrowserService['tabs']
  targetUrl: BrowserService['targetUrl']
  targetUrlTabId: BrowserService['targetUrlTabId']
  toastVisible: BrowserService['toastVisible']
  readonly window: BrowserService['window']
}

/**
 * What the link preview should show for a target the page reported, or null when
 * there is nothing useful to say.
 *
 * A `javascript:` link navigates nowhere, so Chromium leaves its own status
 * bubble empty for one and this does the same. An address that will not parse is
 * dropped for the same reason: it is not a place the user is about to visit.
 */
export function statusTextForTarget(url: string): string | null {
  if (url.length === 0) return null
  try {
    return new URL(url).protocol === 'javascript:' ? null : url
  } catch {
    return null
  }
}

export class BrowserServiceStatusOverlay {
  constructor(private readonly host: StatusOverlayHost) {}

  /** Pull a tab out of the app window when a toast has nowhere else to go, and
   *  put it back afterwards, so the DOM toast composites normally without the page
   *  losing its viewport. */
  setToastVisible(visible: boolean): void {
    this.host.toastVisible = visible
    // The DOM toast replaces the overlay window's own content, so the preview
    // steps aside with it rather than drawing over the toast.
    if (visible) this.dismissStatusOverlay()
    // A popup window's page is a native view too, so a DOM toast under it would be
    // invisible. It steps aside with the tab's page and comes back at the same
    // frame, which is what keeps a momentary toast from resizing a page.
    this.host.popupWindows.setSuspended(visible)
    if (!this.host.activeTabId) return
    const tab = this.host.tabs.get(this.host.activeTabId)
    if (!tab) return
    if (visible) {
      // The on-screen frame is the whole point of this park: the toast is on screen
      // for a moment and the page must come back at the size the user left it at.
      this.host.parkTab(this.host.activeTabId, {
        size: this.host.activeTabBounds ?? this.host.parkedViewportFor(tab),
        keepActive: true
      })
      return
    }
    this.host.showActiveView()
  }

  /**
   * Show or drop the link preview for a report from a page's pointer.
   *
   * `update-target-url` carries the resolved address under the pointer and an
   * empty string once it leaves the link, which is the one signal that takes the
   * bubble down. Only the page actually on screen can be hovered, so a report
   * from a parked or background tab is dropped rather than drawn over another.
   * A fresh target earns the bubble only after `STATUS_BUBBLE_DELAY_MS` of rest,
   * so a pointer sweeping across a page shows nothing; a bubble already up
   * follows the pointer between links at once.
   */
  onTargetUrlReport(tabId: string, url: string): void {
    const target = statusTextForTarget(url)
    if (target === null) {
      if (this.host.targetUrlTabId === tabId) this.dismissStatusOverlay()
      return
    }
    if (this.host.window.isDestroyed()) return
    if (this.host.activeTabId !== tabId || this.host.toastVisible) return
    // A repeated report for the pointer's current target is not a new hover: an
    // armed delay is left to run and an elapsed one stays up. Only a target the
    // pointer has newly moved onto restarts the wait.
    if (this.host.targetUrl === target && this.host.targetUrlTabId === tabId) {
      if (this.host.statusDelayElapsed) this.refreshStatusOverlay()
      return
    }
    this.host.targetUrl = target
    this.host.targetUrlTabId = tabId
    // A bubble already on screen follows the pointer between links at once, the
    // way a native browser does; the delay guards only the first appearance.
    if (this.host.statusDelayElapsed) {
      this.refreshStatusOverlay()
      return
    }
    this.armStatusDelay()
  }

  /**
   * Start the resting delay that earns the pointer a bubble.
   *
   * The timer is armed for the newest target only: a pointer crossing onto
   * another link re-arms it, so a link it merely swept past never shows.
   */
  armStatusDelay(): void {
    this.clearStatusDelay()
    this.host.statusDelayElapsed = false
    this.host.statusShowTimer = setTimeout(() => {
      this.host.statusShowTimer = null
      this.host.statusDelayElapsed = true
      this.refreshStatusOverlay()
    }, STATUS_BUBBLE_DELAY_MS)
  }

  /** Cancel any pending resting delay. */
  clearStatusDelay(): void {
    if (this.host.statusShowTimer === null) return
    clearTimeout(this.host.statusShowTimer)
    this.host.statusShowTimer = null
  }

  /**
   * Re-place the preview from the tab and frame that are current, or take it down
   * when there is nothing it can be drawn against.
   *
   * Called on a hover, a tab switch, a frame change, and the page leaving the
   * screen, so a bubble only ever belongs to the page the pointer is over and
   * never lingers after it. A frame that produces the same placement is not a
   * repaint, which matters because a surface animation re-reports its frame every
   * frame it runs.
   */
  refreshStatusOverlay(): void {
    if (this.host.window.isDestroyed()) return
    const bounds = this.host.activeTabBounds
    const target = this.host.targetUrl
    if (
      target === null ||
      !this.host.statusDelayElapsed ||
      this.host.targetUrlTabId !== this.host.activeTabId ||
      this.host.toastVisible ||
      bounds === null
    ) {
      this.setStatusOverlay(null)
      return
    }
    const placement = browserStatusOverlayPlacement(
      bounds,
      this.host.window.getContentBounds().height
    )
    const current = this.host.statusOverlay
    if (
      current !== null &&
      current.url === target &&
      current.left === placement.left &&
      current.bottom === placement.bottom
    ) {
      return
    }
    this.setStatusOverlay({ url: target, left: placement.left, bottom: placement.bottom })
  }

  /** Send the preview to the overlay window, tracking what is on display. */
  setStatusOverlay(request: BrowserStatusOverlay | null): void {
    this.host.statusOverlay = request
    this.host.overlay.applyStatus(request)
  }

  /** Drop the preview, for the page that owns it leaving the screen. */
  dismissStatusOverlay(): void {
    this.clearStatusDelay()
    this.host.statusDelayElapsed = false
    if (this.host.targetUrl === null && this.host.targetUrlTabId === null) return
    this.host.targetUrl = null
    this.host.targetUrlTabId = null
    this.refreshStatusOverlay()
  }
}
