/**
 * Every tab's navigation history, owned by the main process.
 *
 * The stack a tab can walk back through lives in its `WebContentsView` and dies
 * with it: hibernation closes the view, quitting closes every view, and parking
 * one only re-parents it, so a stack that was never written down is gone at the
 * first of those. This is where it is written down.
 *
 * The main process owns the file for the reason every other durable browser record
 * is main-owned: the renderer's `localStorage` is scoped to the renderer origin and
 * silently empties whenever another app instance holds the profile, which is how
 * durable browser state used to disappear between launches. Unlike those records,
 * nothing is sent here by the renderer: this process is the only one that can read
 * a stack off a view, so it is both the reader and the writer.
 *
 * Writes are batched. A capture marks the set dirty and schedules one write; the
 * commit points (parking a view, destroying a tab, quitting) all funnel through
 * that, so a browsing session is not one disk write per page and a hibernation
 * sweep of twenty tabs is one write, not twenty.
 */

import { dirname, join } from 'node:path'
import {
  BROWSER_TAB_HISTORY_STATE_RELATIVE_PATH,
  MAX_BROWSER_TAB_HISTORY_RECORDS,
  browserTabHistorySnapshotPayload,
  parseBrowserTabHistorySnapshot,
  type BrowserTabHistoryRecord
} from '../../lib/browser/browser-tab-history'
import { ensureDir, getConfigRoot, isUnpackagedElectronLaunch, readJson, writeJson } from '../../lib/utils'
import { Logger } from '../system/logger'

/**
 * How long a change to the history waits for a second one.
 *
 * The commit points arrive in bursts (a hibernation sweep, a handful of parks as
 * the user moves around), and one write per burst is what keeps a durable stack
 * from costing more than it is worth. Quitting flushes outright, so the delay can
 * never lose a stack.
 */
export const BROWSER_TAB_HISTORY_SAVE_COALESCE_MS = 500

/**
 * Where this launch reads and writes per-tab navigation stacks. Follows the
 * tab list split: dev uses a `-dev` variant so restoring a dev tab never
 * picks up a prod tab's back-stack. Prod keeps the established file.
 */
export function resolveBrowserTabHistoryStateRelativePath(): string {
  if (isUnpackagedElectronLaunch()) {
    return BROWSER_TAB_HISTORY_STATE_RELATIVE_PATH.replace(/\.json$/, '-dev.json')
  }
  return BROWSER_TAB_HISTORY_STATE_RELATIVE_PATH
}

export class BrowserTabHistoryStore {
  private readonly records = new Map<string, BrowserTabHistoryRecord>()
  /**
   * Whether the file has been read yet. Nothing is written before then: an unread
   * file is not an empty one, and a flush that ran first would replace every
   * stored stack with the handful this session happens to hold.
   */
  private loaded = false
  /** Whether the in-memory set differs from what is on disk. */
  private dirty = false
  /**
   * The write currently running, if any.
   *
   * A flush that arrives while one is in flight waits for it rather than reading a
   * dirty flag the other write has already claimed. That is what lets a teardown
   * find out whether the records it just captured actually landed: a write that
   * failed restores the flag, so the waiting flush becomes the retry instead of
   * returning against a set that looks clean because someone else is writing it.
   */
  private inFlight: Promise<void> | null = null
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  private get filePath(): string {
    return join(getConfigRoot(), resolveBrowserTabHistoryStateRelativePath())
  }

  /** Read the stored stacks once. A corrupt file reads as none rather than
   *  failing the launch: the tabs then simply have no history to restore. */
  async load(): Promise<void> {
    let stored: unknown
    try {
      stored = await readJson<unknown>(this.filePath)
    } catch (error) {
      Logger.error('Browser tab history could not be read', error)
      stored = null
    }
    if (stored !== null) {
      for (const [tabId, record] of Object.entries(parseBrowserTabHistorySnapshot(stored).records)) {
        this.records.set(tabId, record)
      }
    }
    this.loaded = true
  }

  /** The stack stored for a tab, or null when it has none. */
  recordFor(tabId: string): BrowserTabHistoryRecord | null {
    return this.records.get(tabId) ?? null
  }

  /** Remember a tab's stack, and hand the write to the coalescing clock. */
  store(tabId: string, record: BrowserTabHistoryRecord): void {
    this.records.set(tabId, record)
    this.enforceRecordCap()
    this.schedule()
  }

  /** Drop one tab's stack. Called when the tab is closed and its row is gone, so
   *  the history dies with the tab it belonged to. */
  forget(tabId: string): void {
    if (!this.records.delete(tabId)) return
    this.schedule()
  }

  /** Drop every stack owned by one project, or one thread of it. A thread deleted
   *  or a project removed destroys its tabs, and a hibernated tab of that scope has
   *  no live tab left to be found by the destroy loop, so the sweep is by owner. */
  forgetScopes(predicate: (record: BrowserTabHistoryRecord) => boolean): void {
    let changed = false
    for (const [tabId, record] of [...this.records]) {
      if (!predicate(record)) continue
      this.records.delete(tabId)
      changed = true
    }
    if (changed) this.schedule()
  }

  /**
   * Write the pending change, waiting out the coalescing clock first.
   *
   * Awaited by the shutdown pipeline before the views are closed, which is the one
   * place the write has to be finished rather than merely started, and by the
   * window teardown, which is the one place the process may not stay alive long
   * enough for a retry.
   */
  async flush(): Promise<void> {
    this.cancelPendingFlush()
    if (!this.loaded) return
    // Wait out a write that is already running before deciding: it owns the pending
    // change, and if it failed the flag is true again and this call is the retry.
    if (this.inFlight) await this.inFlight
    if (!this.dirty) return
    this.dirty = false
    const snapshot = { records: Object.fromEntries(this.records) }
    const path = this.filePath
    const write = (async (): Promise<void> => {
      try {
        await ensureDir(dirname(path))
        await writeJson(path, browserTabHistorySnapshotPayload(snapshot))
      } catch (error) {
        // A write that failed leaves the set dirty, so the next flush tries again
        // instead of the loss being silent.
        this.dirty = true
        Logger.error('Browser tab history could not be written', error)
      }
    })()
    this.inFlight = write
    await write
    if (this.inFlight === write) this.inFlight = null
  }

  /** Stop the coalescing clock, so a quit is not held open by a pending timer. */
  cancelPendingFlush(): void {
    if (this.flushTimer === null) return
    clearTimeout(this.flushTimer)
    this.flushTimer = null
  }

  /**
   * Keep the set inside its ceiling, evicting the least recently captured record
   * first. Reached only by a session that outlives the tab caps, which is why it
   * is a safety net rather than the rule: the rule is that closing a tab drops its
   * record.
   */
  private enforceRecordCap(): void {
    if (this.records.size <= MAX_BROWSER_TAB_HISTORY_RECORDS) return
    const ordered = [...this.records].sort((a, b) => a[1].updatedAt - b[1].updatedAt)
    for (const [tabId] of ordered) {
      if (this.records.size <= MAX_BROWSER_TAB_HISTORY_RECORDS) break
      this.records.delete(tabId)
    }
  }

  private schedule(): void {
    this.dirty = true
    if (this.flushTimer !== null) return
    const timer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, BROWSER_TAB_HISTORY_SAVE_COALESCE_MS)
    // A pending flush must never hold the process open on its own.
    if (typeof timer.unref === 'function') timer.unref()
    this.flushTimer = timer
  }
}
