/**
 * The app's browsing history, one list per browser surface or shared box.
 *
 * Unboxed visits belong to the browser surface that made them. Boxed visits
 * belong to the selected profile box and are shared wherever that box is used.
 * The scope key is resolved in {@link BrowserHistoryState.scopeFor}; local
 * project threads that share one browser strip also share their unboxed history.
 *
 * The global profile and named box lists are durable through the main process
 * (`browser:loadHistory` / `browser:saveHistory`), because renderer `localStorage`
 * is scoped to the renderer origin and silently empties whenever another app
 * instance holds the profile. An unboxed conversation list lives in this renderer
 * for the session and dies with its browser's last tab.
 *
 * A visit is derived from main's own page state (`browser:state`), which is
 * published for every tab whichever surface is showing it and carries the tab's
 * ownership for exactly this reason. That also makes the recording honest: one
 * record per committed address, so a page reporting its title, its icon or its
 * loading state after it committed is the same visit rather than a new one.
 */

import { invoke, subscribe } from '$lib/ipc.svelte'
import { GLOBAL_BROWSER_PROJECT_ID, type BrowserPageState } from '$shared/ipc-contract'
import { conversationScopeId } from '$shared/types'
import {
  BROWSER_LIBRARY_SAVE_COALESCE_MS,
  MAX_BROWSER_HISTORY_RECORDS,
  browserHistorySuggestions,
  normalizeBrowserLibraryUrl,
  parseBrowserHistorySnapshot,
  type BrowserHistoryEntry,
  type BrowserHistorySnapshot
} from '$shared/browser/browser-library'
import { DEFAULT_BOX_ID, MAX_GLOBAL_BROWSER_BOXES } from '$shared/browser/global-browser-tabs'
import { appConfigState } from './app-config.svelte'
import { reportError } from './app-errors.svelte'

/**
 * The scope key of the global browser's own history.
 *
 * The global browser's project id is the identity every other durable browser
 * record uses for it, so the history uses it too: one string no conversation can
 * collide with, because a conversation's scope is its project, its thread or its
 * routine.
 */
export const BROWSER_HISTORY_GLOBAL_SCOPE = GLOBAL_BROWSER_PROJECT_ID
const BROWSER_HISTORY_BOX_SCOPE_PREFIX = 'browser-box:'

/** How a browser surface is turned into the key its visits live under. */
export type BrowserHistoryScopeResolver = (projectId: string, threadId: string) => string

/** Every surface's visits, keyed by scope. */
type BrowserHistoryLists = Record<string, BrowserHistoryEntry[]>

/** An empty list, shared so a panel's derived value does not churn on every read. */
const EMPTY_ENTRIES: BrowserHistoryEntry[] = []

/** Where a tab was last recorded, and in which browser: what makes a repeat report
 *  the same visit rather than a second one. */
interface RecordedVisit {
  scope: string
  url: string
}

export class BrowserHistoryState {
  /**
   * Every surface's visits, newest first, keyed by scope.
   *
   * One `$state` record rather than a reactive map, so the whole store is the same
   * kind of value the single list used to be: a panel's derived slice reads it,
   * and the write-time snapshot copies it, with no second reactivity model in
   * between.
   */
  private lists = $state<BrowserHistoryLists>({})

  /**
   * True once the stored list has been read. Nothing is written before then, so a
   * store that has not seen the stored list can never overwrite it with the one
   * visit it happens to have recorded.
   */
  hydrated = $state(false)

  /**
   * Resolves a conversation to the browser surface its tabs belong to.
   *
   * Injected by the runtime seam, because the answer for an assistant routine's
   * threads needs the thread rows the sidebar deliberately does not hold. Until it
   * is installed, {@link scopeFor} falls back to the same
   * `conversationScopeId` the tab strip does.
   */
  private scopeResolver: BrowserHistoryScopeResolver | null = null
  /**
   * Whether a browser surface currently holds at least one tab.
   *
   * Injected by the runtime seam from the tab list that owns the surface, and null
   * until then: with no answer available no scope can be proven dead, and dropping
   * one would throw away a history the user is still reading.
   */
  private isLiveThreadScope: ((scope: string) => boolean) | null = null

  /** The last visit recorded for each tab. Plain, not reactive: nothing renders
   *  it. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  private readonly lastVisit = new Map<string, RecordedVisit>()
  private saveTimer: number | null = null
  /** Whether this session changed a durable list while stored history was still
   *  arriving. A visit the user made is theirs, so it is merged rather than
   *  replaced by what was read. */
  private mutatedSinceBoot = false
  /** Whether the user cleared the history before the stored list had landed. The
   *  read was already in flight when the clear was applied, so its answer describes
   *  a list the user has since said is gone, and restoring it would undo the clear
   *  until the next visit wrote it back. */
  private clearedSinceBoot = false
  /** Whether {@link start} has wired the runtime. The store is only reachable
   *  through the browser's own chunk, but it stays inert until the runtime seam
   *  asks for it, exactly like every other browser store. */
  private started = false

  /** How many durable pages the browser remembers across its own profile and boxes. */
  get count(): number {
    return Object.entries(this.lists).reduce(
      (total, [scope, entries]) => total + (this.isPersistentScope(scope) ? entries.length : 0),
      0
    )
  }

  /** Take the surface resolver. Called once by the runtime seam, before
   *  {@link start}, so even the first visit is filed under the right scope. */
  setScopeResolver(resolver: BrowserHistoryScopeResolver): void {
    this.scopeResolver = resolver
  }

  /** Take the live-surface predicate. Called once by the runtime seam. */
  setLiveThreadScope(predicate: (scope: string) => boolean): void {
    this.isLiveThreadScope = predicate
  }

  /**
   * The key the visits of one browser surface live under.
   *
   * The global browser is always its own surface, whichever conversation happened
   * to open the tab. A conversation resolves through the injected resolver, which
   * widens an assistant routine's threads to the routine, the same way the tab
   * strip does, so a browser's history always covers exactly the tabs the user can
   * see.
   */
  scopeFor(projectId: string, threadId: string, boxId: string | null = null): string {
    if (projectId === GLOBAL_BROWSER_PROJECT_ID) {
      return boxId && boxId !== DEFAULT_BOX_ID ? this.boxScope(boxId) : BROWSER_HISTORY_GLOBAL_SCOPE
    }
    if (boxId !== null) {
      return boxId === DEFAULT_BOX_ID ? BROWSER_HISTORY_GLOBAL_SCOPE : this.boxScope(boxId)
    }
    return (
      this.scopeResolver?.(projectId, threadId) ?? conversationScopeId(projectId, threadId, null)
    )
  }

  private boxScope(boxId: string): string {
    return `${BROWSER_HISTORY_BOX_SCOPE_PREFIX}${boxId}`
  }

  isDurableScope(scope: string): boolean {
    return (
      scope === BROWSER_HISTORY_GLOBAL_SCOPE || scope.startsWith(BROWSER_HISTORY_BOX_SCOPE_PREFIX)
    )
  }

  private isPersistentScope(scope: string): boolean {
    return this.isDurableScope(scope)
  }

  /** One surface's visits, newest first. */
  entriesFor(scope: string): BrowserHistoryEntry[] {
    return this.lists[scope] ?? EMPTY_ENTRIES
  }

  /**
   * The pages to offer for a query in one surface, best first.
   *
   * The ranking lives in the shared module, so the address palette, the address
   * drawer and the history panel answer the same question the same way.
   */
  suggestionsFor(scope: string, query: string, limit: number): BrowserHistoryEntry[] {
    return browserHistorySuggestions(this.entriesFor(scope), query, limit)
  }

  /** Wire the runtime and read the stored list. Idempotent. */
  start(): void {
    if (this.started) return
    this.started = true
    subscribe('browser:state', (state) => this.record(state))
    // The coalesced write is the last chance the global list has to carry what the
    // user just visited; the shutdown pipeline keeps the renderer alive for it.
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
   * Forget one page of one surface, which is the only way to take back a single
   * visit without clearing everything.
   *
   * The tab's own last-visit record is left alone, so a page the user forgets
   * while reading it stays forgotten until the tab actually goes somewhere else.
   */
  forget(scope: string, url: string): void {
    const entries = this.entriesFor(scope)
    if (!entries.some((entry) => entry.url === url)) return
    this.lists[scope] = entries.filter((entry) => entry.url !== url)
    if (this.isPersistentScope(scope)) this.persist()
  }

  /**
   * Forget everything, in every surface.
   *
   * The durable half is cleared in the main process, and the pending write is
   * dropped with it: a coalesced save still in flight would otherwise put back the
   * very list the user just cleared. The session-only lists go with it, because
   * "clear browsing history" is a statement about the browser, not about one
   * surface of it.
   */
  async clear(): Promise<void> {
    this.cancelPendingSave()
    this.lists = {}
    this.lastVisit.clear()
    this.mutatedSinceBoot = false
    this.clearedSinceBoot = true
    try {
      await invoke('browser:clearHistory')
    } catch (error) {
      reportError(error, 'The browsing history could not be cleared.')
    }
  }

  /** Re-apply the configured cap after the user changed it, evicting the oldest
   *  visits of every surface the smaller limit can no longer hold. */
  applyLimit(): void {
    let globalTrimmed = false
    for (const scope of Object.keys(this.lists)) {
      const trimmed = this.trimToLimit(scope)
      if (trimmed && scope === BROWSER_HISTORY_GLOBAL_SCOPE) globalTrimmed = true
    }
    if (globalTrimmed) this.persist()
  }

  /**
   * Drop the history of every thread browser that no longer exists.
   *
   * Called when a browser's tab list changes, which is the moment a surface can
   * lose its last tab, and again from {@link record}. The second call is the one
   * that closes a race: a `browser:state` sent just before the destroy of a tab can
   * land just after the close, and it must not put back the history that close has
   * already discarded.
   */
  pruneThreadScopes(): void {
    if (!this.isLiveThreadScope) return
    let changed = false
    for (const scope of Object.keys(this.lists)) {
      if (this.isPersistentScope(scope) || this.isLive(scope)) continue
      delete this.lists[scope]
      changed = true
    }
    if (!changed) return
    // A tab of a dropped surface must start a fresh visit rather than be treated as
    // already recorded into a list that no longer exists.
    for (const [tabId, visit] of this.lastVisit) {
      if (this.isLive(visit.scope)) continue
      this.lastVisit.delete(tabId)
    }
  }

  // ─── Recording ────────────────────────────────────────────────────────────

  /**
   * Take one page-state report into its surface's history.
   *
   * A report is a visit only when it names a page the tab was not already on: a
   * title, icon or loading update for the document already there is the same
   * visit. A report that names nothing to record   a fresh tab, an `about:blank`
   * popup, or an app-generated design or video preview on a loopback port that
   * changes every run   ends the tab's current visit instead, so returning to it
   * later counts again.
   */
  private record(state: BrowserPageState): void {
    const scope = this.scopeFor(state.projectId, state.threadId, state.boxId)
    // A thread browser is only as long-lived as its tabs, so reconcile the lists
    // against the surfaces that still exist before filing this report. Doing it
    // here as well as on every tab-list change closes the one race a tab-list
    // change cannot: a `browser:state` sent just before a tab was destroyed can
    // land just after the close, and it must not bring the history back.
    const threadScope = !this.isPersistentScope(scope)
    if (threadScope) this.pruneThreadScopes()
    const url = state.design || state.composition ? null : normalizeBrowserLibraryUrl(state.url)
    if (url === null || (threadScope && !this.isLive(scope))) {
      this.lastVisit.delete(state.tabId)
      return
    }
    const previous = this.lastVisit.get(state.tabId)
    if (previous && previous.url === url && previous.scope === scope) {
      this.updateTitle(scope, url, state.title)
      return
    }
    this.lastVisit.set(state.tabId, { scope, url })
    this.recordVisit(scope, url, state.title)
  }

  /** Whether a surface still exists to record a visit against. The global browser
   *  always does; a thread browser is asked of the tab list that owns it, and
   *  before that answer is available nothing is treated as gone. */
  private isLive(scope: string): boolean {
    if (scope === BROWSER_HISTORY_GLOBAL_SCOPE) return true
    return this.isLiveThreadScope?.(scope) ?? true
  }

  /** Fold a later report's title onto the visit it belongs to. A page often
   *  commits before it reports its title, and the strip's own label falls back to
   *  the host, so this is what upgrades that placeholder to the real one. */
  private updateTitle(scope: string, url: string, title: string): void {
    const trimmed = title.trim()
    if (trimmed === '') return
    const entry = this.entriesFor(scope).find((candidate) => candidate.url === url)
    if (!entry || entry.title === trimmed) return
    entry.title = trimmed
    if (this.isPersistentScope(scope)) this.persist()
  }

  /** Move an address to the front of one surface's list, counting the visit. */
  private recordVisit(scope: string, url: string, title: string): void {
    const trimmed = title.trim()
    const entries = this.entriesFor(scope)
    const existing = entries.find((entry) => entry.url === url)
    if (existing) {
      this.lists[scope] = [
        {
          url: existing.url,
          title: trimmed === '' ? existing.title : trimmed,
          visitedAt: Date.now(),
          visitCount: existing.visitCount + 1
        },
        ...entries.filter((entry) => entry.url !== url)
      ]
    } else {
      this.lists[scope] = [
        {
          url,
          title: trimmed === '' ? url : trimmed,
          visitedAt: Date.now(),
          visitCount: 1
        },
        ...entries
      ]
    }
    this.trimToLimit(scope)
    if (this.isPersistentScope(scope)) {
      this.mutatedSinceBoot = true
      this.persist()
    }
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

  /**
   * Evict the oldest visits of one surface past the cap.
   *
   * The cap is applied per surface rather than to a total: a surface only gains
   * visits while its browser has tabs, and dies with the last of them, so the
   * number of lists that can exist is already bounded by the browsers the user has
   * open. One limit, the one the user set, is worth more than a second one nobody
   * can explain.
   *
   * Reports whether anything went.
   */
  private trimToLimit(scope: string): boolean {
    const entries = this.entriesFor(scope)
    const limit = this.limit
    if (entries.length <= limit) return false
    const kept = entries.slice(0, limit)
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const keptUrls = new Set(kept.map((entry) => entry.url))
    for (const [tabId, visit] of this.lastVisit) {
      // A tab still sitting on an evicted address must start a new visit if it
      // comes back to it, instead of being silently dropped from the list.
      if (visit.scope === scope && !keptUrls.has(visit.url)) this.lastVisit.delete(tabId)
    }
    this.lists[scope] = kept
    return true
  }

  // ─── Storage ──────────────────────────────────────────────────────────────

  /**
   * Read the stored list into the global browser's scope.
   *
   * A profile that stored a corrupt or absent file simply starts empty, and a
   * visit made while the read was in flight is merged with what arrived rather
   * than replaced by it. No other scope is read, because no other scope was ever
   * written.
   */
  private async hydrate(): Promise<void> {
    let stored: BrowserHistorySnapshot | null = null
    try {
      stored = await invoke('browser:loadHistory')
    } catch (error) {
      reportError(error, 'The saved browsing history could not be read.')
    }
    const snapshot = this.clearedSinceBoot ? { entries: [] } : parseBrowserHistorySnapshot(stored)
    const storedLists: [string, BrowserHistoryEntry[]][] = [
      [BROWSER_HISTORY_GLOBAL_SCOPE, snapshot.entries]
    ]
    for (const [boxId, entries] of Object.entries(snapshot.boxEntries ?? {})) {
      storedLists.push([this.boxScope(boxId), entries])
    }
    for (const [scope, entries] of storedLists) {
      if (entries.length === 0) continue
      this.lists[scope] = this.mutatedSinceBoot ? this.merge(scope, entries) : entries
      this.trimToLimit(scope)
    }
    this.hydrated = true
    if (this.mutatedSinceBoot) this.persist()
  }

  /** The stored list folded under the visits this session already made, one record
   *  per address. */
  private merge(scope: string, stored: readonly BrowserHistoryEntry[]): BrowserHistoryEntry[] {
    const current = this.entriesFor(scope)
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const known = new Set(current.map((entry) => entry.url))
    const merged = [...current]
    for (const entry of stored) {
      if (known.has(entry.url)) continue
      known.add(entry.url)
      merged.push(entry)
    }
    merged.sort((a, b) => b.visitedAt - a.visitedAt)
    return merged
  }

  /** Write shared profile lists soon, so a burst of visits (a redirect chain, an agent
   *  clicking through a flow) becomes one write instead of one per page. */
  private persist(): void {
    // Never write before the stored list has landed: an unread list is not an
    // empty one, and writing here would replace what the user had with nothing.
    if (!this.started || !this.hydrated) return
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer)
    this.saveTimer = window.setTimeout(() => this.flush(), BROWSER_LIBRARY_SAVE_COALESCE_MS)
  }

  /** Write the pending shared profile lists now, which is what a quit needs. */
  private flush(): void {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (!this.hydrated) return
    const boxEntries: Record<string, BrowserHistoryEntry[]> = {}
    const recentBoxes = Object.entries(this.lists)
      .filter(([scope]) => scope.startsWith(BROWSER_HISTORY_BOX_SCOPE_PREFIX))
      .sort(([, a], [, b]) => (b[0]?.visitedAt ?? 0) - (a[0]?.visitedAt ?? 0))
      .slice(0, MAX_GLOBAL_BROWSER_BOXES)
    for (const [scope, entries] of recentBoxes) {
      const boxId = scope.slice(BROWSER_HISTORY_BOX_SCOPE_PREFIX.length)
      boxEntries[boxId] = $state.snapshot(entries)
    }
    const snapshot: BrowserHistorySnapshot = {
      entries: $state.snapshot(this.entriesFor(BROWSER_HISTORY_GLOBAL_SCOPE)),
      boxEntries
    }
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
