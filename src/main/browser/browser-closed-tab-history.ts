/**
 * The session's stack of closed browser tabs' navigation history.
 *
 * Closing a tab normally discards its Back/Forward stack: the stack belongs to
 * the tab it was made in, and a tab that is gone has none. Reopening a closed
 * tab is the one case where the stack has to outlive the tab, so this holds it
 * between the close and the reopen, keyed by the tab id it will be restored into.
 *
 * This is deliberately memory-only. The reopen stack is a convenience for the
 * run it happened in, exactly as a browser's own "Reopen closed tab" is: quitting
 * the app empties it, so a relaunch never resurrects tabs the user closed in a
 * session they have since left. Nothing here is ever written to disk, and it has
 * no flush point of its own; the durable stacks live in `BrowserTabHistoryStore`.
 */

import type { BrowserTabHistoryRecord } from '../../lib/browser/browser-tab-history'

/**
 * How many closed tabs' stacks are kept.
 *
 * A stack is a bounded, few-hundred-byte record, so the cap is about how far
 * back a person can reasonably reopen rather than about memory. It matches the
 * depth the renderer's own closed-tab list keeps, so the two cannot disagree
 * about which tab is still reopenable.
 */
export const MAX_CLOSED_BROWSER_TABS = 20

export class BrowserClosedTabHistory {
  /** Most recently closed last, so the oldest is evicted first. */
  private readonly records = new Map<string, BrowserTabHistoryRecord>()

  /**
   * Remember a closed tab's stack.
   *
   * Re-stashing an id moves it to the newest position, because a tab closed,
   * reopened and closed again is the most recently closed one. The cap is
   * enforced here, which is the only place the set grows.
   */
  stash(tabId: string, record: BrowserTabHistoryRecord): void {
    this.records.delete(tabId)
    this.records.set(tabId, record)
    while (this.records.size > MAX_CLOSED_BROWSER_TABS) {
      const oldest = this.records.keys().next().value
      if (oldest === undefined) break
      this.records.delete(oldest)
    }
  }

  /** The stack stored for a tab, without consuming it. */
  peek(tabId: string): BrowserTabHistoryRecord | null {
    return this.records.get(tabId) ?? null
  }

  /** Take a tab's stack, so a reopen cannot restore it twice. */
  take(tabId: string): BrowserTabHistoryRecord | null {
    const record = this.records.get(tabId)
    if (!record) return null
    this.records.delete(tabId)
    return record
  }

  /** Forget one tab's stack, called when it is captured as a live tab again. */
  forget(tabId: string): void {
    this.records.delete(tabId)
  }

  /** Drop every stack owned by one project, or one thread of it. */
  forgetScopes(predicate: (record: BrowserTabHistoryRecord) => boolean): void {
    for (const [tabId, record] of [...this.records]) {
      if (predicate(record)) this.records.delete(tabId)
    }
  }
}
