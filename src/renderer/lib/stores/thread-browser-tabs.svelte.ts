/**
 * The thread browser's tab recency, and which tab the full screen browser is
 * showing.
 *
 * The app's Ctrl+Tab gesture is the thread switcher: a jump between threads and
 * the surfaces that hold them. Inside the full screen thread browser that gesture
 * is a browser's own, and it must step through the tabs of the browser on screen
 * instead. This store holds the two facts that let the browser take the gesture
 * over without any other surface changing:
 *
 *   - which tab the full screen browser is showing, so the thread switcher can
 *     stand down while that overlay is up;
 *   - the recency order of the thread browser's tabs, so a cycle walks from the
 *     tab in use to the one used before it, exactly like a browser's own
 *     recently-used order.
 *
 * Order is recorded wherever a tab becomes the one in use
 * (`SidebarBrowserTabs.focus`, and the full screen browser following its own
 * tab), and dropped wherever a tab goes away, so the list describes the tabs
 * that exist rather than every tab the session ever opened. It is deliberately
 * not persisted: recency is a property of this session, like a browser's own
 * gesture history.
 */

/** One in-flight cycle: the recency order frozen for the gesture, and where the
 *  highlight sits in it. Repeated presses walk `index`; the Control release
 *  reorders the live list to the tab the cycle landed on. */
interface CycleSession {
  order: string[]
  index: number
}

class ThreadBrowserTabsState {
  /** The tab the full screen thread browser is showing, or null while it is not
   *  on screen. */
  fullscreenTabId: string | null = $state(null)

  /** The thread browser's tabs, most recently used first. */
  private recent: string[] = []

  /** The live cycle, or null when no Ctrl+Tab gesture is in progress. */
  private session: CycleSession | null = null

  /** Whether the full screen thread browser owns the window, which is what makes
   *  the Ctrl+Tab gesture its own. */
  get fullscreenActive(): boolean {
    return this.fullscreenTabId !== null
  }

  /** Publish the tab the full screen browser shows, or null when it closes. */
  setFullscreen(tabId: string | null): void {
    this.fullscreenTabId = tabId
  }

  /**
   * Count a tab as used, moving it to the front of the recency order.
   *
   * Ignored while a cycle is in flight: the cycle writes one provisional tab
   * after another as it is pressed through, and only the tab it settles on is a
   * real visit (`commit`).
   */
  record(tabId: string): void {
    if (this.session) return
    this.recent = [tabId, ...this.recent.filter((id) => id !== tabId)]
  }

  /** Drop a tab that no longer exists, from the recency order and from any
   *  cycle that is still being pressed through. */
  forget(tabId: string): void {
    this.recent = this.recent.filter((id) => id !== tabId)
    if (this.session) this.session.order = this.session.order.filter((id) => id !== tabId)
  }

  /**
   * Step the recency order one place and name the tab to show.
   *
   * The first press of a gesture freezes the order: the tab in use leads, the
   * tabs that exist follow in recency order, and any tab the order has not seen
   * yet trails in strip order. Every further press moves within that frozen
   * order, so a held Control walks the same list the user saw when the gesture
   * started. `direction` is 1 for the next tab and -1 for the one before it,
   * wrapping at both ends. Returns null when there is nothing to switch to.
   */
  cycle(direction: 1 | -1, liveIds: readonly string[], currentId: string | null): string | null {
    if (liveIds.length === 0) return null
    const live = new Set(liveIds)
    if (!this.session) {
      const order: string[] = []
      if (currentId && live.has(currentId)) order.push(currentId)
      for (const id of this.recent) {
        if (live.has(id) && !order.includes(id)) order.push(id)
      }
      for (const id of liveIds) {
        if (!order.includes(id)) order.push(id)
      }
      this.session = { order, index: 0 }
    } else {
      const previous = this.session.order[this.session.index]
      this.session.order = this.session.order.filter((id) => live.has(id))
      if (this.session.order.length === 0) {
        this.session = null
        return null
      }
      const at = previous ? this.session.order.indexOf(previous) : -1
      this.session.index = at >= 0 ? at : 0
    }
    const { order } = this.session
    this.session.index = (this.session.index + direction + order.length) % order.length
    return order[this.session.index]
  }

  /**
   * Settle a cycle on the tab it landed on, which is the visit the order keeps.
   *
   * Also the idle path for a gesture that never cycled, so a Control release or
   * a window blur can call it unconditionally.
   */
  commit(): void {
    if (!this.session) return
    const current = this.session.order[this.session.index]
    this.session = null
    if (current) this.recent = [current, ...this.recent.filter((id) => id !== current)]
  }
}

export const threadBrowserTabs = new ThreadBrowserTabsState()
