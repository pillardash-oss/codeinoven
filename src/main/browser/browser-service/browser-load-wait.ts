/**
 * Waiting for a page to stop loading, with one listener pair per page.
 *
 * A capture that runs while a page is still arriving shows a half-painted frame,
 * so every caller that wants a settled page waits on the same three facts: the
 * page stopped loading, a navigation failed, or its own deadline passed. The
 * naive form of that   a listener pair registered and removed by each caller   is
 * what this module exists to avoid: Electron's `WebContents` is an
 * `EventEmitter`, Node warns above ten listeners on one emitter, and a design
 * sweep, a video capture and a board refresh can easily have a dozen waits in
 * flight on one thread's tab at once. The listeners were never leaked, but the
 * warning was real and every extra pair was work the page's own event dispatch
 * paid for.
 *
 * So the listeners belong to the page, not to the caller: the first waiter
 * registers the pair, every later waiter joins the same group, and the pair is
 * removed when the last one settles. Each caller keeps its own deadline and its
 * own promise, because a caller's bound is its own   a board refresh and a frame
 * capture may legitimately ask for different ones.
 *
 * A page that has nothing in flight, or one that is already gone, is answered
 * without a listener at all: the same answer a stop event would have given.
 */

/** The three events a wait ends on. */
type LoadWaitEvent = 'did-stop-loading' | 'did-fail-load' | 'destroyed'

/**
 * The part of a page this module uses, so the rule can be exercised without a
 * browser (the same structural surface `browser-permission-memory` describes for
 * the storage it writes to). A `WebContents` satisfies it as it stands.
 */
export interface LoadWaitPage {
  isLoading(): boolean
  isDestroyed(): boolean
  on(event: LoadWaitEvent, listener: () => void): unknown
  removeListener(event: LoadWaitEvent, listener: () => void): unknown
}

/** One waiting caller's deadline, and the answer it is holding. */
type LoadWaitSettler = () => void

interface LoadWaitGroup {
  /** The page the listeners belong to, so a group can be found and removed. */
  page: LoadWaitPage
  /** Each waiting caller, against the timer that ends its wait. */
  waiters: Map<LoadWaitSettler, ReturnType<typeof setTimeout>>
  /** Take the group's listeners off the page. */
  detach: () => void
}

export class BrowserLoadWaits {
  private readonly groups = new Map<LoadWaitPage, LoadWaitGroup>()

  /**
   * Wait until one page stops loading, bounded by this caller's own deadline.
   *
   * Never rejects: a page that fails to load is as settled as one that finished,
   * and a caller that must tell the difference reads the page's error state after
   * this resolves, exactly as it would have with a listener of its own.
   */
  wait(page: LoadWaitPage, timeoutMs: number): Promise<void> {
    if (page.isDestroyed() || !page.isLoading()) return Promise.resolve()
    const group = this.groupFor(page)
    return new Promise<void>((resolve) => {
      // A waiter settles once: whichever of its deadline and the page's own
      // events arrives first wins, and the other must find nothing to do.
      let settled = false
      const settle: LoadWaitSettler = () => {
        if (settled) return
        settled = true
        const timer = group.waiters.get(settle)
        if (timer !== undefined) {
          clearTimeout(timer)
          group.waiters.delete(settle)
        }
        // The page's listeners are only worth holding while somebody is waiting
        // on them, so the last waiter to settle is the one that takes them off.
        if (group.waiters.size === 0) this.finish(group)
        resolve()
      }
      group.waiters.set(settle, setTimeout(settle, Math.max(0, timeoutMs)))
    })
  }

  /** How many pages are holding listeners right now, for a caller that wants to
   *  assert the pair is gone (a probe, or a teardown check). */
  get trackedPages(): number {
    return this.groups.size
  }

  /** How many callers are waiting on one page, for the same reason. */
  waitingOn(page: LoadWaitPage): number {
    return this.groups.get(page)?.waiters.size ?? 0
  }

  private groupFor(page: LoadWaitPage): LoadWaitGroup {
    const existing = this.groups.get(page)
    if (existing) return existing
    const group: LoadWaitGroup = { page, waiters: new Map(), detach: () => {} }
    const stop = (): void => this.finish(group)
    page.on('did-stop-loading', stop)
    page.on('did-fail-load', stop)
    // A page that is destroyed while something waits on it (a tab the user
    // closed, a hurry the app gave up on) will never report a load ending, so
    // the wait ends here instead of at the caller's deadline.
    page.on('destroyed', stop)
    group.detach = () => {
      page.removeListener('did-stop-loading', stop)
      page.removeListener('did-fail-load', stop)
      page.removeListener('destroyed', stop)
    }
    this.groups.set(page, group)
    return group
  }

  /** Settle every waiter of one page and put the page's listeners away. */
  private finish(group: LoadWaitGroup): void {
    this.groups.delete(group.page)
    group.detach()
    // Every waiter's own settle clears its timer and drops it from the group, so
    // the map is read as a snapshot: settling the last one re-enters `finish`,
    // which finds nothing left to do.
    for (const settle of [...group.waiters.keys()]) settle()
  }
}
