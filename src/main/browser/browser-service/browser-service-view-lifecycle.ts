import { screen } from 'electron'
import type { BrowserViewBounds } from '../../../lib/ipc-contract'
import { Logger } from '../../system/logger'
import { type BrowserTab, type BrowserViewport, type ParkBrowserTabOptions } from './browser-types'
import { liveContents } from './browser-view-contents'
import {
  AGENT_REVEAL_GRACE_MS,
  DEFAULT_PARKED_VIEWPORT,
  MAX_ABANDONED_REVEALS,
  MAX_PARKED_TABS,
  RELAX_COOLDOWN_MS,
  RENDERER_PARK_GRACE_MS,
  isSameBounds
} from './browser-validation'
import type { BrowserService } from '../browser-service'

/**
 * Where a tab's view is put on screen, where it waits offscreen, and who holds the
 * keyboard.
 *
 * A native `WebContentsView` floats above every DOM surface, so the app attaches exactly
 * one at a time and parks the rest at a deterministic size offscreen. This unit owns the
 * attach/detach decision, the LRU cap on parked tabs, the keyboard handover, and the
 * reveal bookkeeping that notices when a tab an agent surfaced was ignored.
 */

/**
 * What `browser-service-view-lifecycle` reads off the browser service.
 *
 * Each member is the service's own declaration, so this unit and the composition
 * root cannot drift apart: a changed signature is a compile error here.
 */
export interface ViewLifecycleHost {
  readonly abandonedReveals: BrowserService['abandonedReveals']
  activeTabBounds: BrowserService['activeTabBounds']
  activeTabId: BrowserService['activeTabId']
  readonly agentReveals: BrowserService['agentReveals']
  readonly captureTabHistory: BrowserService['captureTabHistory']
  readonly dismissStatusOverlay: BrowserService['dismissStatusOverlay']
  displayedTab: BrowserService['displayedTab']
  keyboardOwnerTabId: BrowserService['keyboardOwnerTabId']
  readonly nativeStrip: BrowserService['nativeStrip']
  readonly nativeToasts: BrowserService['nativeToasts']
  readonly overlay: BrowserService['overlay']
  readonly parkedOrder: BrowserService['parkedOrder']
  pendingPageFocusTabId: BrowserService['pendingPageFocusTabId']
  readonly pendingParks: BrowserService['pendingParks']
  readonly raisePageChrome: BrowserService['raisePageChrome']
  readonly relaxedUntil: BrowserService['relaxedUntil']
  restorePageFocusTabId: BrowserService['restorePageFocusTabId']
  readonly sendTransport: BrowserService['sendTransport']
  readonly stage: BrowserService['stage']
  readonly tabs: BrowserService['tabs']
  readonly targetUrlTabId: BrowserService['targetUrlTabId']
  toastVisible: BrowserService['toastVisible']
  readonly window: BrowserService['window']
}

export class BrowserServiceViewLifecycle {
  constructor(private readonly host: ViewLifecycleHost) {}

  /**
   * Detach the native view when the app renderer goes away, so a reload can never
   * leave the browser floating over the app, and take down every overlay surface
   * that renderer had published.
   *
   * The renderer is the only thing that knows which tab belongs on screen and at
   * which frame, and the compositor paints the view ABOVE every DOM surface. A
   * reload throws that knowledge away (the full screen browser is renderer state,
   * and the sidebar browser starts hidden), while the view stays parented to the
   * app window at the last frame it was given. Main only ever moves a view on the
   * next `browser:show`, so without this the frame the user was looking at keeps
   * covering the window and swallowing every click, with no DOM surface left that
   * would ever ask for a different frame.
   *
   * The tab itself is kept alive and parked offscreen, exactly as if the user had
   * left it, and the next renderer re-attaches it when it reports a frame. A
   * crashed renderer is handled the same way: nothing will report a frame again
   * until Electron reloads it, and an inert app must not sit under a live page.
   */
  guardAgainstStrandedView(): void {
    const contents = this.host.window.webContents
    contents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) this.releaseRendererSurfaces()
    })
    contents.on('render-process-gone', () => this.releaseRendererSurfaces())
  }

  /**
   * Take down everything the app renderer had put on screen natively, so a reload
   * or a renderer that died can never leave a native surface behind.
   *
   * The page view is only one of them. Toasts, the floating tab strip, tooltips
   * and the modals the app draws over a page all live in views and child windows
   * that outlive the document which published them, and only that document ever
   * takes them down (each surface sends its own `null` when its component
   * unmounts, which a document reload never runs). Nothing in the new document
   * knows they exist: svelte-sonner starts empty and does not publish an empty
   * stack at boot, and no panel re-opens itself, so a stale toast card sits over
   * the app and a stale modal keeps its whole window opaque to the mouse, which
   * reads as an app that stopped responding until it is restarted.
   */
  releaseRendererSurfaces(): void {
    this.detachDisplayedView()
    // The toast card is bounded but its own dismissal lives in the renderer that
    // published it, so it would otherwise stay until something else raised one.
    this.host.nativeToasts.apply(null)
    this.host.nativeToasts.setHeight(0)
    // One call retires the floating strip and the panel dock it hosts, because a
    // dock leaving re-applies the strip that came with it.
    this.host.nativeStrip.applyDock(null)
    this.host.overlay.clearRendererSurfaces()
    // The permission prompt is deliberately left alone: it is the main process
    // asking a question the main process still owns, and hiding it would leave a
    // pending decision nobody can answer.
  }

  /**
   * Take the view off the app window without touching a tab the stage already
   * released: reviving an inert tab would spend frames on a page nobody is
   * looking at, which is the state `enforceParkedCap` deliberately created. The
   * window's own child list is the authority on what is on screen, so this
   * cannot strand a view that no record happens to mention.
   */
  detachDisplayedView(): void {
    // The toast hold is published by DOM that a reload or a crash has taken with
    // it, so keeping it would strand the browser offscreen for a toast that no
    // longer exists.
    this.host.toastVisible = false
    const parented = new Set(this.host.window.contentView.children)
    for (const [tabId, tab] of this.host.tabs) {
      if (parented.has(tab.view)) {
        this.parkTab(tabId)
      }
    }
  }

  /**
   * The viewport a tab is laid out at while it is parked offscreen.
   *
   * The newest of the two records wins, because the newest one is the size
   * something actually asked the page to be: an agent's explicit request, or the
   * frame the user was reading the tab at. A tab that was never displayed and
   * never asked for a viewport is mounted at `DEFAULT_PARKED_VIEWPORT`.
   */
  parkedViewportFor(tab: BrowserTab): BrowserViewport {
    const requested = tab.requestedViewport
    const displayed = tab.displayedViewport
    if (displayed && (!requested || requested.at <= displayed.at)) return displayed.viewport
    return requested?.viewport ?? DEFAULT_PARKED_VIEWPORT
  }

  /**
   * Carry out a hide the renderer asked for after a short grace window, so a show
   * that lands inside it cancels the park instead of being served a view that was
   * pulled out from under it for a frame.
   *
   * See `RENDERER_PARK_GRACE_MS`: the renderer's answer to "is this surface still
   * showing the page" is recomputed every frame and flaps, and a park that a
   * re-attach follows a few milliseconds later is a visible flicker of a page
   * nothing asked to move. A hide no show ever contradicts still parks, a few
   * frames after the decision that produced it.
   */
  schedulePark(tabId: string): void {
    if (this.host.pendingParks.has(tabId)) return
    const handle = setTimeout(() => {
      this.host.pendingParks.delete(tabId)
      this.parkTab(tabId)
    }, RENDERER_PARK_GRACE_MS)
    this.host.pendingParks.set(tabId, handle)
  }

  /**
   * Forget a deferred hide, because the tab is being shown again after all, or
   * because its park is settled some other way: the park itself, and the tab
   * being destroyed.
   */
  dropPendingPark(tabId: string): void {
    const handle = this.host.pendingParks.get(tabId)
    if (handle === undefined) return
    clearTimeout(handle)
    this.host.pendingParks.delete(tabId)
  }

  /**
   * Park a tab in an invisible stage window, where it keeps a real viewport and
   * keeps producing frames no matter what the user is looking at.
   *
   * The page is laid out at `options.size` when a caller has one to insist on
   * (the toast case, which must preserve the frame the user is looking at), and at
   * the tab's own parked viewport otherwise.
   */
  parkTab(tabId: string, options: ParkBrowserTabOptions = {}): void {
    // The park this timer was going to do is happening now, so it is spent.
    this.dropPendingPark(tabId)
    const tab = this.host.tabs.get(tabId)
    if (!tab) return
    // A deferred hide can land after the app window is gone (the app is quitting),
    // and there is no child list left to take the view out of.
    if (this.host.window.isDestroyed()) return
    // A tab whose page destroyed itself has nothing left to park, and leaving the
    // records that name it in place poisoned every attach after it: a show parks
    // the outgoing tab before it attaches the next one, so one dead record made
    // every page in the app blank until it restarted. Retire them and return.
    if (!liveContents(tab.view)) {
      this.host.stage.release(tab.view)
      this.forgetParked(tabId)
      if (this.host.displayedTab?.tabId === tabId) this.host.displayedTab = null
      if (this.host.activeTabId === tabId) {
        this.host.activeTabId = null
        this.host.activeTabBounds = null
      }
      return
    }
    // Leaving a tab is one of the two moments its stack has to be written down:
    // the view keeps running offscreen, but the app must not depend on that. The
    // write is coalesced, so a run of parks as the user moves around is one write.
    this.host.captureTabHistory(tabId, tab)
    // A switch waiting for this tab is spent only when the park is a real
    // departure. A keep-active park (a toast holding the view off) leaves the tab
    // as the one on screen, so the switch has to survive until the page comes back
    // and `showActiveView` can honour it.
    if (!options.keepActive && this.host.pendingPageFocusTabId === tabId) {
      this.host.pendingPageFocusTabId = null
    }
    const viewport = options.size ?? this.parkedViewportFor(tab)
    // A composition the user has moved away from must not keep playing. Parking
    // leaves the page running at a real viewport in the stage window, so a
    // transport left playing carries on with its sound from a surface nobody can
    // see, and the film is found mid-way through when the tab comes back. Only a
    // departure pauses: a surface that stepped aside for an overlay it will be
    // back in front of has not left its page, and stopping the film under a menu
    // would be the panel dying while the user reaches for its own controls.
    if (options.pausePlayback === true && tab.composition !== null && tab.transport !== null) {
      void this.host.sendTransport(tabId, 'pause', 0).catch(() => null)
    }
    this.host.window.contentView.removeChildView(tab.view)
    // The view is leaving the window, so whatever frame it was displayed at no
    // longer describes where it is.
    if (this.host.displayedTab?.tabId === tabId) this.host.displayedTab = null
    this.host.stage.park(tab.view, viewport)
    this.markParked(tabId)
    if (this.host.targetUrlTabId === tabId) this.host.dismissStatusOverlay()
    if (this.host.activeTabId === tabId && !options.keepActive) {
      this.host.activeTabId = null
      this.host.activeTabBounds = null
    }
    this.enforceParkedCap(tabId)
    // A stage window the window server stopped showing would silently freeze the
    // page (that is how a parked view dies), so confirm it once per park and hand
    // the tab a fresh window if it did not take. Fire and forget: parking must
    // not block the caller.
    void this.host.stage.verifyVisible(tab.view).then((visible) => {
      if (visible || !this.host.stage.isParked(tab.view)) return
      Logger.dev('Reparking a browser tab whose stage window stopped rendering', { tabId })
      const current = this.host.tabs.get(tabId)
      this.host.stage.restart(tab.view, current ? this.parkedViewportFor(current) : viewport)
    })
  }

  /**
   * Deliver the current pointer position to a page that has just come back on
   * screen.
   *
   * While a tab is parked its view sits in the stage window, so the pointer is not
   * over the page any more and the page is told the pointer left. Chromium
   * rebuilds hover state and the cursor shape only from an input event, so without
   * this the page keeps what it decided back then: `cursor: pointer` never comes
   * back, hover menus stay shut, and drag affordances stay inert until the user
   * physically moves the mouse. One real mouse move, at the position the pointer
   * is actually at, restores the state the user can already see they are in.
   */
  primePagePointer(tab: BrowserTab, bounds: BrowserViewBounds | null): void {
    if (bounds === null || this.host.window.isDestroyed()) return
    const contents = liveContents(tab.view)
    if (!contents) return
    const cursor = screen.getCursorScreenPoint()
    const content = this.host.window.getContentBounds()
    const x = Math.round(cursor.x - content.x - bounds.x)
    const y = Math.round(cursor.y - content.y - bounds.y)
    // A pointer that is not over the page must not be reported as if it were: the
    // page would gain a hover the user is not pointing at.
    if (x < 0 || y < 0 || x >= bounds.width || y >= bounds.height) return
    contents.sendInputEvent({ type: 'mouseMove', x, y })
  }

  /** Mount the current active tab in the app window at its display bounds. */
  showActiveView(): void {
    if (!this.host.activeTabId || this.host.toastVisible) return
    const tabId = this.host.activeTabId
    const tab = this.host.tabs.get(tabId)
    if (!tab) return
    const contents = liveContents(tab.view)
    if (!contents) return
    const bounds = this.host.activeTabBounds
    const displayed = this.host.displayedTab
    // Both records must agree before a repeat can be skipped. The stage's parked
    // set is the authority on a view that is offscreen, and the stage re-parks
    // views on its own when it has to rebuild its stage window, which can land
    // between two of the renderer's per-frame reports. A view the stage holds has
    // to be re-parented, so this re-attaches rather than trusting `displayedTab`
    // alone; skipping here would leave it parked with nothing that ever recovers
    // it.
    if (
      displayed !== null &&
      displayed.tabId === tabId &&
      !this.host.stage.isParked(tab.view) &&
      // The window's child list is the authority on what is on screen, never the
      // bookkeeping alone: a view that left the window without a park (a
      // window-server teardown, a detach the record did not see) is invisible
      // while `displayedTab` still names it, and skipping the attach here is what
      // left the tab dark instead of re-parenting it.
      this.host.window.contentView.children.includes(tab.view)
    ) {
      // Already mounted: only a moved frame needs a native call, so the entry
      // loop's repeats cost one bounds comparison each instead of a re-parent.
      this.forgetParked(tabId)
      if (bounds !== null && !isSameBounds(displayed.bounds, bounds)) {
        this.host.displayedTab = { tabId, bounds }
        tab.view.setBounds(bounds)
      }
      // The page is already on screen, which is the one moment a held switch can
      // be honoured without waiting for another show.
      this.takePendingPageFocus(tabId)
      return
    }
    // A view the stage was holding is off the window, so the page has already been
    // told the pointer left it and needs the pointer position again once it is
    // back.
    this.host.stage.release(tab.view)
    this.forgetParked(tabId)
    this.host.window.contentView.addChildView(tab.view)
    this.host.raisePageChrome()
    if (bounds !== null) {
      this.host.displayedTab = { tabId, bounds }
      tab.view.setBounds(bounds)
    }
    // A view that comes back from the stage window lands on a new surface, and
    // Chromium can keep painting the frame it had in the window it left: the page
    // reads as blank until something else changes the child list or the document
    // paints again, which is why closing another tab or reloading brought such a
    // page back. Asking for a repaint is what makes the returning page draw its
    // own frame at once.
    contents.invalidate()
    // A page that has just landed needs the pointer delivered again. Chromium
    // rebuilds hover and the cursor shape only from an input event, and the page
    // may have been told the pointer left while it was off screen: that is true
    // of a park, and equally of a view the parked cap evicted or one being
    // attached for the first time under a resting pointer. So this runs on every
    // attach, not only a stage re-attach, or `cursor: pointer` never comes back
    // until the user physically moves the mouse.
    this.primePagePointer(tab, bounds)
    // A page that just landed is on screen now, so a switch that was waiting for
    // it takes the keyboard here.
    this.takePendingPageFocus(tabId)
  }

  /**
   * Give a tab's page the keyboard, or remember that it wants it.
   *
   * The page is a native view above the DOM, so DOM focus in the app chrome never
   * lands on it and a tab switch has to hand it over deliberately. A page that is
   * not the one on screen yet   a show still in flight, a toast holding the view
   * off, a tab main has not even heard of   keeps the intent until it is shown.
   */
  focusPage(tabId: string): void {
    const tab = this.host.tabs.get(tabId)
    if (tab && liveContents(tab.view) && this.isPageOnScreen(tabId)) {
      this.host.pendingPageFocusTabId = null
      this.focusPageView(tabId, tab)
      return
    }
    this.host.pendingPageFocusTabId = tabId
  }

  /**
   * Hand a page the keyboard and re-deliver the pointer to it.
   *
   * Focus alone is not enough: moving focus away from the page and back leaves
   * the cursor whatever the app chrome set, and Chromium rebuilds hover and the
   * cursor shape only from an input event. So a focus handover is followed by the
   * same prime a re-attach uses, which is what makes `cursor: pointer` come back
   * the moment a switch lands on the tab rather than at the next mouse move.
   */
  focusPageView(tabId: string, tab: BrowserTab): void {
    const contents = liveContents(tab.view)
    if (!contents) return
    this.host.keyboardOwnerTabId = tabId
    contents.focus()
    this.primePagePointer(tab, this.host.activeTabId === tabId ? this.host.activeTabBounds : null)
  }

  /**
   * Hand the keyboard back to the page the user was in before the app window
   * lost focus.
   *
   * Called on the window's `focus`. The capture happens at `blur` (see
   * {@link restorePageFocusTabId}), so a page that was not the last surface the
   * user worked in is left alone. A page that is no longer the one on screen is
   * skipped as well: the surface may have changed to another tab or away from
   * the browser while the app was in the background, and focus must not follow a
   * page the user can no longer see.
   */
  restorePageFocus(): void {
    const tabId = this.host.restorePageFocusTabId
    this.host.restorePageFocusTabId = null
    if (!tabId) return
    // The reactivated window settles its own focus a beat after the event, so
    // the handover waits a turn; otherwise the window's focus lands last and the
    // page loses the race it was just won.
    setImmediate(() => {
      if (this.host.window.isDestroyed()) return
      const tab = this.host.tabs.get(tabId)
      if (!tab || !liveContents(tab.view)) return
      if (!this.isPageOnScreen(tabId)) return
      this.focusPageView(tabId, tab)
    })
  }

  /** Whether a tab's page is the native view the window is currently showing. */
  isPageOnScreen(tabId: string): boolean {
    if (this.host.toastVisible || this.host.activeTabId !== tabId) return false
    const tab = this.host.tabs.get(tabId)
    if (!tab || !liveContents(tab.view)) return false
    return this.host.displayedTab?.tabId === tabId && !this.host.stage.isParked(tab.view)
  }

  /** Focus the page a switch asked for, now that it is the one on screen. The
   *  intent is spent either way it resolves, so a stale one cannot fire later. */
  takePendingPageFocus(tabId: string): void {
    if (this.host.pendingPageFocusTabId !== tabId) return
    this.host.pendingPageFocusTabId = null
    const tab = this.host.tabs.get(tabId)
    if (!tab || !liveContents(tab.view)) return
    this.focusPageView(tabId, tab)
  }

  markParked(tabId: string): void {
    this.forgetParked(tabId)
    this.host.parkedOrder.push(tabId)
  }

  forgetParked(tabId: string): void {
    const index = this.host.parkedOrder.indexOf(tabId)
    if (index >= 0) this.host.parkedOrder.splice(index, 1)
  }

  /** Keep an agent's working tab from being evicted ahead of idle parked tabs. */
  touchParkedTab(tabId: string): void {
    const tab = this.host.tabs.get(tabId)
    if (tab && this.host.stage.isParked(tab.view)) this.markParked(tabId)
  }

  /**
   * Cap how many tabs render offscreen at once. Every parked tab renders like a
   * displayed one, so an unbounded parked set would burn CPU and battery for
   * pages nobody is using. The oldest parked tab loses its stage window and goes
   * inert; the next operation on it parks it again.
   */
  enforceParkedCap(keep: string): void {
    while (this.host.parkedOrder.length > MAX_PARKED_TABS) {
      const candidate = this.host.parkedOrder.find(
        (id) => id !== keep && id !== this.host.activeTabId
      )
      if (candidate === undefined) return
      this.forgetParked(candidate)
      const tab = this.host.tabs.get(candidate)
      if (tab) this.host.stage.release(tab.view)
    }
  }

  /** Remember that the agent asked for this tab to be brought to the user. */
  rememberReveal(tabId: string, threadId: string): void {
    const now = Date.now()
    for (const [id, reveal] of this.host.agentReveals) {
      if (now - reveal.at > AGENT_REVEAL_GRACE_MS) this.host.agentReveals.delete(id)
    }
    this.host.agentReveals.set(tabId, { threadKey: threadId, at: now, shown: false })
  }

  /** The revealed tab reached the user's screen, so leaving it now says
   *  something about the reveal. */
  markRevealShown(tabId: string): void {
    const reveal = this.host.agentReveals.get(tabId)
    if (reveal) reveal.shown = true
  }

  /**
   * A reveal the user saw and then left within the grace window was not welcome.
   * Two of those in a row make the agent's next opens mount offscreen silently
   * for a cooldown, so an agent cannot keep pulling the user away from what they
   * were doing. Nothing is shown in the UI about it.
   */
  noteDepartedReveal(tabId: string): void {
    const reveal = this.host.agentReveals.get(tabId)
    if (!reveal) return
    this.host.agentReveals.delete(tabId)
    const now = Date.now()
    if (now - reveal.at > AGENT_REVEAL_GRACE_MS) return
    // A reveal the user never saw was not refused: the renderer hides a tab for
    // reasons that have nothing to do with the user leaving it (a full-window
    // surface taking over, a stale-attach guard, the sidebar changing region).
    if (!reveal.shown) return
    const previous = this.host.abandonedReveals.get(reveal.threadKey)
    // Only consecutive ignores count, so an old one cannot combine with a new
    // one days later to mute a thread.
    const count = previous && now - previous.at <= RELAX_COOLDOWN_MS ? previous.count + 1 : 1
    if (count < MAX_ABANDONED_REVEALS) {
      this.host.abandonedReveals.set(reveal.threadKey, { count, at: now })
      return
    }
    this.host.abandonedReveals.delete(reveal.threadKey)
    this.host.relaxedUntil.set(reveal.threadKey, now + RELAX_COOLDOWN_MS)
  }

  isRelaxed(threadId: string): boolean {
    const until = this.host.relaxedUntil.get(threadId)
    if (until === undefined) return false
    if (Date.now() >= until) {
      this.host.relaxedUntil.delete(threadId)
      return false
    }
    return true
  }
}
