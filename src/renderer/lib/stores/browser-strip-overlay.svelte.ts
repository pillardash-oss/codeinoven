import { invoke, subscribe } from '$lib/ipc.svelte'
import {
  OVERLAY_ACK_TIMEOUT_MS,
  type BrowserOverlayAck,
  type BrowserStripOverlayAction,
  type BrowserStripOverlayInteraction,
  type BrowserStripOverlayStrip
} from '$shared/browser-overlay'
import { GLOBAL_BROWSER_PROJECT_ID } from '$shared/ipc-contract'
import { logRendererError } from '$lib/system/renderer-logger'
import { globalBrowser } from './global-browser.svelte'
import { browserTabLabel, DEFAULT_BOX_NAME } from './global-browser-types'
import { browserBookmarks } from './browser-bookmarks.svelte'
import { installStoreExtensionOffer, storeExtensionOffer } from './browser-extension-store-offer'
import {
  browserSiteHost,
  browserSiteOrigin,
  openBrowserSiteMenuAt
} from '$lib/components/browser/browser-chrome-menus'
import { sidebarState } from './sidebar.svelte'

/**
 * The app renderer's side of the browser's floating tab strip in the native
 * overlay window.
 *
 * The in-app browser's page is a native `WebContentsView` painted above every
 * DOM node of the window, so while a page covers the band a hovered sidebar
 * occupies, the strip is drawn by the overlay window instead. This store owns
 * that decision's protocol half: it publishes the projected strip, waits for the
 * overlay to confirm the revision it drew, and takes the strip back the moment
 * the round trip cannot be trusted   because a row in the overlay has no handler
 * of its own and pressing one only works while the overlay can still reach this
 * renderer.
 *
 * The geometry half stays in the component that owns the panel
 * (`BrowserTabsSidebar.svelte`), which is the only place that knows the sidebar's
 * own state and the window's size. This store never decides whether to mirror;
 * it only carries out the decision and reports the pointer's own entry and exit.
 */

/** The grace the panel gets when the pointer leaves it, matching the DOM
 *  panel's own close delay so the pointer's feel does not change with the
 *  handover. */
const HOVER_GRACE_MS = 260

class BrowserStripOverlayState {
  /**
   * True while the overlay window is drawing the strip, which is exactly when
   * the app window must not draw it as well.
   */
  live = $state(false)

  /**
   * Whether the overlay's reports can reach this window at all.
   *
   * The reports travel over IPC channels the preload has to expose, and a preload
   * older than this bundle does not expose them: the subscription below would
   * then throw as it is made. Set here, once, and kept for the session: a window
   * that cannot hear the overlay never uses it, and the floating panel keeps
   * drawing in the app window and letting the page park, which is the behaviour
   * that has always worked.
   */
  unavailable = $state(false)

  /** The palette the overlay should draw the strip in, tracked here so the
   *  component's publish effect does not need its own observer. */
  theme = $state<'light' | 'dark'>(
    document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  )

  /** The revision stamped on the next strip this window publishes. */
  private nextRevision = 0

  /** The revision the overlay has been asked for and has not confirmed, or 0. */
  private awaitedRevision = 0

  private ackTimer: ReturnType<typeof setTimeout> | undefined
  private closeTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * The last request this store sent, as a value to compare against.
   *
   * Deliberately not reactive state: the component's effect must not re-run
   * because of what it itself last sent, and the strip is republished on every
   * change to any tab, which would otherwise repeat a request that says nothing
   * new.
   */
  private sentSignature = 'none'

  /** Bumped by every publish, so an answer to a superseded request is dropped. */
  private requestToken = 0

  /** Whether the pointer was last reported inside the strip. */
  private pointerInside = false

  private reports: Array<() => void> = []
  private themeObserver: MutationObserver | undefined

  /**
   * Subscribe to the overlay's reports, and follow the app's palette.
   *
   * Called from the component's own lifecycle, before anything can publish a
   * strip: a subscription that throws inside this call must be caught here, or it
   * would take the rest of the caller's lifecycle with it.
   */
  start(): () => void {
    if (this.themeObserver === undefined) {
      this.themeObserver = new MutationObserver(() => {
        this.theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light'
      })
      this.themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class']
      })
    }
    if (this.reports.length > 0 || this.unavailable) return () => {}
    try {
      this.reports = [
        subscribe('browser:overlay:drawn', (ack) => this.noteDrawn(ack)),
        subscribe('browser:overlay:stripEvent', (report) => this.noteInteraction(report))
      ]
    } catch (error) {
      this.unavailable = true
      logRendererError(
        'This window cannot hear the browser overlay, so the floating tab strip keeps the page-parking path.',
        error
      )
      this.reports = []
    }
    return () => {
      for (const off of this.reports) off()
      this.reports = []
      this.stopAckWatch()
      if (this.closeTimer !== undefined) clearTimeout(this.closeTimer)
      this.closeTimer = undefined
      this.themeObserver?.disconnect()
      this.themeObserver = undefined
    }
  }

  /**
   * Draw `strip` in the overlay, or take it down with null.
   *
   * Three outcomes: no page covers the panel's band, so null releases the strip
   * and the DOM panel draws as it always has; the overlay accepts and confirms,
   * so the DOM panel steps aside; or the overlay cannot serve it for any reason
   * (this window cannot hear it, its window could not be created, its request was
   * refused, or it never confirmed), in which case the store stops using the
   * overlay for the session and the DOM panel keeps drawing with the page
   * parking, which is far better than a panel that is invisible or whose rows do
   * nothing.
   */
  async publish(strip: BrowserStripOverlayStrip | null): Promise<void> {
    const signature = strip === null ? 'release' : JSON.stringify(strip)
    if (signature === this.sentSignature) return
    this.sentSignature = signature
    const token = (this.requestToken += 1)
    if (strip === null) {
      this.stopAckWatch()
      this.live = false
      this.pointerInside = false
      void invoke('browser:setStripOverlay', null).catch(() => {})
      return
    }
    if (this.unavailable) return
    // The user just hovered the edge zone, which is inside the panel's own band,
    // so the pointer starts out inside it: a report saying so would only arrive
    // later, and the panel must not close before the first real report does.
    this.pointerInside = true
    const revision = (this.nextRevision += 1)
    try {
      const available = await invoke('browser:setStripOverlay', { ...strip, revision })
      if (token !== this.requestToken) return
      if (!available) {
        this.abandon('its window could not be created')
        return
      }
      this.live = true
      this.armAckWatch(revision)
    } catch {
      if (token !== this.requestToken) return
      this.abandon('a request to draw the strip was refused')
    }
  }

  /**
   * Stop using the overlay for the rest of the session, and let the DOM panel
   * take over.
   *
   * Every reason the overlay cannot serve the strip ends the same way: the panel
   * stays in the app window and publishes its occlusion, so the page parks while
   * it is up. That blink is the fallback's whole cost, and it is logged rather
   * than shown, because the panel itself still works.
   */
  private abandon(reason: string): void {
    this.stopAckWatch()
    if (this.unavailable) return
    this.unavailable = true
    this.live = false
    logRendererError(
      `The native browser overlay was abandoned for the floating tab strip: ${reason}. The panel is drawn in the app window again, and a browser page it covers is parked for as long as it is open.`
    )
    void invoke('browser:setStripOverlay', null).catch(() => {})
  }

  /**
   * Wait for the overlay to confirm the revision it was given.
   *
   * The deadline belongs to the first strip that went unanswered, not to the
   * newest one: a window that never confirms would otherwise keep its watch
   * moving every time a tab changed. Any confirmation clears it, because a
   * revision only stays unconfirmed while the overlay is silent.
   */
  private armAckWatch(revision: number): void {
    this.awaitedRevision = revision
    if (this.ackTimer !== undefined) return
    this.ackTimer = setTimeout(() => {
      this.ackTimer = undefined
      if (this.awaitedRevision === 0) return
      this.abandon('it never confirmed the strip it was given')
    }, OVERLAY_ACK_TIMEOUT_MS)
  }

  private stopAckWatch(): void {
    if (this.ackTimer !== undefined) clearTimeout(this.ackTimer)
    this.ackTimer = undefined
    this.awaitedRevision = 0
  }

  /** The overlay drew the revision this window published, so the path works. */
  private noteDrawn(ack: BrowserOverlayAck): void {
    if (ack.stripRevision === undefined || ack.stripRevision !== this.awaitedRevision) return
    this.stopAckWatch()
  }

  /**
   * What the user did to the strip the overlay drew.
   *
   * A report naming a tab that has since closed is answered by doing nothing,
   * which is what keeps the overlay's own state from turning into a loop: the
   * store looks the tab up through the methods that own selection and closing,
   * and both already ignore an id they no longer hold.
   */
  private noteInteraction(report: BrowserStripOverlayInteraction): void {
    if (report.kind === 'pointer') {
      if (report.over) {
        this.pointerInside = true
        if (this.closeTimer !== undefined) clearTimeout(this.closeTimer)
        this.closeTimer = undefined
        return
      }
      this.pointerInside = false
      this.scheduleClose()
      return
    }
    if (report.kind === 'action') {
      this.runAction(report.action, report.x, report.y)
      return
    }
    if (report.kind === 'select') {
      globalBrowser.switchTo(report.tabId)
      return
    }
    globalBrowser.close(report.tabId)
  }

  /**
   * Run a chrome control the overlay's address row reported.
   *
   * The overlay holds no handlers, so every press is looked up against the live
   * active tab here, exactly as a tab row's is: a tab that has gone since the row
   * was drawn makes the action a no-op rather than an error.
   */
  private runAction(action: BrowserStripOverlayAction, x: number, y: number): void {
    const tab = globalBrowser.activeTab
    if (!tab) return
    switch (action) {
      case 'back':
        void invoke('browser:goBack', tab.id).catch(() => {})
        return
      case 'forward':
        void invoke('browser:goForward', tab.id).catch(() => {})
        return
      case 'reload':
        void invoke('browser:reload', tab.id).catch(() => {})
        return
      case 'stop':
        void invoke('browser:stop', tab.id).catch(() => {})
        return
      case 'open-address':
        globalBrowser.openAddressSpotlight()
        return
      case 'toggle-bookmark':
        if (tab.url !== '')
          browserBookmarks.toggle(tab.url, browserTabLabel(tab), tab.favicon, tab.boxId)
        return
      case 'open-site-menu':
        // The overlay document shares the app window's content coordinates, so
        // the point is already in the app renderer's own space. The box comes
        // along because the padlock clears the jar it was opened from, which for
        // the global browser is the active tab's own box.
        void openBrowserSiteMenuAt(
          GLOBAL_BROWSER_PROJECT_ID,
          browserSiteHost(tab.url),
          browserSiteOrigin(tab.url),
          x,
          y,
          globalBrowser.activeTabBoxId,
          globalBrowser.boxById(globalBrowser.activeTabBoxId)?.name ?? DEFAULT_BOX_NAME
        )
        return
      case 'act-on-store-offer': {
        const offer = storeExtensionOffer()
        if (!offer) return
        if (offer.installed) globalBrowser.showExtensionsSidebar()
        else void installStoreExtensionOffer()
      }
    }
  }

  /** Close the panel once the pointer has left the strip, after the same grace
   *  the DOM panel gives, so a pointer that merely crosses the edge of the panel
   *  does not flicker it away. */
  private scheduleClose(): void {
    if (this.closeTimer !== undefined) return
    this.closeTimer = setTimeout(() => {
      this.closeTimer = undefined
      if (this.pointerInside) return
      sidebarState.hoverOpen = false
    }, HOVER_GRACE_MS)
  }
}

export const browserStripOverlay = new BrowserStripOverlayState()
