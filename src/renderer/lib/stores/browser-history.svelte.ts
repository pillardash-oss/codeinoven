/**
 * The app's browsing history.
 *
 * One MRU of the pages the browser has been to, newest first, shared by every tab
 * the app shows   the global browser's and a project's alike   because a person's
 * history is theirs, not a project's. It survives a restart, and it is capped:
 * older visits evict for newer ones once the configured limit is reached, so the
 * list stays a useful memory instead of growing without end.
 *
 * A visit is derived from main's own page state (`browser:state`), which is
 * published for every tab whichever surface is showing it. That also makes the
 * recording honest: one record per committed address, so a page reporting its
 * title, its icon or its loading state after it committed is the same visit rather
 * than a new one.
 *
 * The list is durable app state owned by the main process (see
 * `browser:loadHistory` / `browser:saveHistory`), the same contract the tab list
 * follows, because renderer `localStorage` silently empties whenever another app
 * instance holds the profile.
 */

import { invoke, subscribe } from '$lib/ipc.svelte'
import type { BrowserPageState } from '$shared/ipc-contract'
import {
  BROWSER_LIBRARY_SAVE_COALESCE_MS,
  MAX_BROWSER_HISTORY_RECORDS,
  browserHistorySuggestions,
  normalizeBrowserLibraryUrl,
  parseBrowserHistorySnapshot,
  type BrowserHistoryEntry,
  type BrowserHistorySnapshot
} from '$shared/browser/browser-library'
import { appConfigState } from './app-config.svelte'
import { reportError } from './app-errors.svelte'

/** An empty list, shared so a panel's derived value does not churn on every read. */
const EMPTY_ENTRIES: BrowserHistoryEntry[] = []

export class BrowserHistoryState {
  /** Every visit, newest first. */
  entries: BrowserHistoryEntry[] = $state(EMPTY_ENTRIES)

  /**
   * True once the stored list has been read. Nothing is written before then, so a
   * store that has not seen the stored list can never overwrite it with the one
   * visit it happens to have recorded.
   */
  hydrated = $state(false)

  /** The last address recorded for each tab, so one committed page is one visit
   *  however many state reports it produces. Plain, not reactive: nothing renders
   *  it. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  private readonly lastRecordedUrl = new Map<string, string>()
  private saveTimer: number | null = null
  /** Whether this session changed the list while the stored list was still
   *  arriving. A visit the user made is theirs, so it is merged rather than
   *  replaced by what was read. */
  private mutatedSinceBoot = false
  /** Whether {@link start} has wired the runtime. The store is only reachable
   *  through the browser's own chunk, but it stays inert until the runtime seam
   *  asks for it, exactly like every other browser store. */
  private started = false

  get count(): number {
    return this.entries.length
  }

  /** Wire the runtime and read the stored list. Idempotent. */
  start(): void {
    if (this.started) return
    this.started = true
    subscribe('browser:state', (state) => this.record(state))
    // The coalesced write is the last chance the list has to carry what the user
    // just visited; the shutdown pipeline keeps the renderer alive for it.
    subscribe('window:beforeQuit', () => this.flush())
    void this.hydrate()
  }

  /** Release the pending write. The store lives for the renderer's lifetime, so
   *  this exists for tests and a deliberate teardown. */
  dispose(): void {
    this.started = false
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer)
    this.saveTimer = null
  }

  /**
   * The pages to offer for a query, best first.
   *
   * The ranking lives in the shared module, so the address spotlight and the
   * history panel answer the same question the same way.
   */
  suggestions(query: string, limit: number): BrowserHistoryEntry[] {
    return browserHistorySuggestions(this.entries, query, limit)
  }

  /**
   * Forget one page, which is the only way to take back a single visit without
   * clearing everything.
   */
  forget(url: string): void {
    if (!this.entries.some((entry) => entry.url === url)) return
    this.entries = this.entries.filter((entry) => entry.url !== url)
    this.persist()
  }

  /**
   * Forget everything.
   *
   * The clear is applied in the main process, and the pending write is dropped
   * with it: a coalesced save still in flight would otherwise put back the very
   * list the user just cleared.
   */
  async clear(): Promise<void> {
    this.cancelPendingSave()
    this.entries = EMPTY_ENTRIES
    this.lastRecordedUrl.clear()
    try {
      await invoke('browser:clearHistory')
    } catch (error) {
      reportError(error, 'The browsing history could not be cleared.')
    }
  }

  /** Re-apply the configured cap after the user changed it, evicting the oldest
   *  visits the smaller limit can no longer hold. */
  applyLimit(): void {
    if (this.trimToLimit()) this.persist()
  }

  // ─── Recording ────────────────────────────────────────────────────────────

  /**
   * Take one page-state report into the history.
   *
   * A report is a visit only when it names a page the tab was not already on: a
   * title, icon or loading update for the document already there is the same
   * visit. A report that names nothing to record   a fresh tab, an `about:blank`
   * popup, or an app-generated design or video preview on a loopback port that
   * changes every run   ends the tab's current visit instead, so returning to it
   * later counts again.
   */
  private record(state: BrowserPageState): void {
    const url = state.design || state.composition ? null : normalizeBrowserLibraryUrl(state.url)
    if (url === null) {
      this.lastRecordedUrl.delete(state.tabId)
      return
    }
    const previous = this.lastRecordedUrl.get(state.tabId)
    if (previous === url) {
      this.updateTitle(url, state.title)
      return
    }
    this.lastRecordedUrl.set(state.tabId, url)
    this.recordVisit(url, state.title)
  }

  /** Fold a later report's title onto the visit it belongs to. A page often
   *  commits before it reports its title, and the strip's own label falls back to
   *  the host, so this is what upgrades that placeholder to the real one. */
  private updateTitle(url: string, title: string): void {
    const trimmed = title.trim()
    if (trimmed === '') return
    const entry = this.entries.find((candidate) => candidate.url === url)
    if (!entry || entry.title === trimmed) return
    entry.title = trimmed
    this.persist()
  }

  /** Move an address to the front of the list, counting the visit. */
  private recordVisit(url: string, title: string): void {
    this.mutatedSinceBoot = true
    const trimmed = title.trim()
    const existing = this.entries.find((entry) => entry.url === url)
    if (existing) {
      existing.visitCount += 1
      existing.visitedAt = Date.now()
      if (trimmed !== '') existing.title = trimmed
      this.entries = [existing, ...this.entries.filter((entry) => entry.url !== url)]
    } else {
      this.entries = [
        {
          url,
          title: trimmed === '' ? url : trimmed,
          visitedAt: Date.now(),
          visitCount: 1
        },
        ...this.entries
      ]
    }
    this.trimToLimit()
    this.persist()
  }

  /**
   * The configured cap, clamped to the bounds the main process validates with, so
   * a hand-edited config can never make the renderer trim to something main would
   * have refused.
   */
  private get limit(): number {
    const configured = appConfigState.browserHistoryLimit
    return Math.min(
      MAX_BROWSER_HISTORY_RECORDS,
      Math.max(1, Number.isSafeInteger(configured) ? configured : MAX_BROWSER_HISTORY_RECORDS)
    )
  }

  /** Evict the oldest visits past the cap. Reports whether anything went. */
  private trimToLimit(): boolean {
    const limit = this.limit
    if (this.entries.length <= limit) return false
    const kept = this.entries.slice(0, limit)
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const keptUrls = new Set(kept.map((entry) => entry.url))
    for (const [tabId, url] of this.lastRecordedUrl) {
      // A tab still sitting on an evicted address must start a new visit if it
      // comes back to it, instead of being silently dropped from the list.
      if (!keptUrls.has(url)) this.lastRecordedUrl.delete(tabId)
    }
    this.entries = kept
    return true
  }

  // ─── Storage ──────────────────────────────────────────────────────────────

  /**
   * Read the stored list and put it on screen.
   *
   * A profile that stored a corrupt or absent file simply starts empty, and a
   * visit made while the read was in flight is merged with what arrived rather
   * than replaced by it.
   */
  private async hydrate(): Promise<void> {
    let stored: BrowserHistorySnapshot | null = null
    try {
      stored = await invoke('browser:loadHistory')
    } catch (error) {
      reportError(error, 'The saved browsing history could not be read.')
    }
    const entries = parseBrowserHistorySnapshot(stored).entries
    if (entries.length > 0) {
      this.entries = this.mutatedSinceBoot ? this.merge(entries) : entries
    }
    this.trimToLimit()
    this.hydrated = true
    if (this.mutatedSinceBoot) this.persist()
  }

  /** The stored list folded under the visits this session already made, one
   *  record per address. */
  private merge(stored: readonly BrowserHistoryEntry[]): BrowserHistoryEntry[] {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const known = new Set(this.entries.map((entry) => entry.url))
    const merged = [...this.entries]
    for (const entry of stored) {
      if (known.has(entry.url)) continue
      known.add(entry.url)
      merged.push(entry)
    }
    merged.sort((a, b) => b.visitedAt - a.visitedAt)
    return merged
  }

  /** Write the list soon, so a burst of visits (a redirect chain, an agent
   *  clicking through a flow) becomes one write instead of one per page. */
  private persist(): void {
    // Never write before the stored list has landed: an unread list is not an
    // empty one, and writing here would replace what the user had with nothing.
    if (!this.started || !this.hydrated) return
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer)
    this.saveTimer = window.setTimeout(() => this.flush(), BROWSER_LIBRARY_SAVE_COALESCE_MS)
  }

  /** Write the pending list now, which is what a quit and a clear both need. */
  private flush(): void {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (!this.hydrated) return
    const snapshot: BrowserHistorySnapshot = { entries: $state.snapshot(this.entries) }
    void invoke('browser:saveHistory', snapshot).catch((error: unknown) => {
      reportError(error, 'The browsing history could not be saved.')
    })
  }

  private cancelPendingSave(): void {
    if (this.saveTimer === null) return
    window.clearTimeout(this.saveTimer)
    this.saveTimer = null
  }
}

export const browserHistory = new BrowserHistoryState()
