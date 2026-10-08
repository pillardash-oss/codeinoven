/**
 * The Ctrl+Tab switcher's entry list.
 *
 * The switcher is a task switcher, not a thread list. A project thread, a chat,
 * an assistant task and a browser tab are all views, and every one of them
 * competes for the same slots in one recency order (`recent-visits.svelte`): the
 * surface the user used most recently is first, the one used before that is
 * next, and a newer visit pushes an older one off the end whatever kind it is.
 * The pure builder here resolves those stored keys against live data. It never
 * invents a row for a surface the order does not name, with one deliberate
 * exception: the browser tab on screen leads the list (see `currentBrowserTabId`).
 * A browser tab the user never opened therefore cannot appear.
 */

import type { Thread } from '$shared/types'
import type { GlobalBrowserTab } from '$lib/stores/global-browser-types'
import {
  browserTabIdFromVisitKey,
  browserTabVisitKey,
  isBrowserTabVisitKey,
  threadVisitKey
} from '$lib/stores/recent-visits.svelte'

/** One row the switcher can land on. */
export type ThreadSwitcherEntry =
  { kind: 'thread'; thread: Thread } | { kind: 'browser'; tab: GlobalBrowserTab }

/** How many entries the switcher shows, matching the thread list it grew from. */
export const THREAD_SWITCHER_ENTRY_LIMIT = 10

/**
 * How many browser tabs the switcher shows at most.
 *
 * The list is one recency order, so an older tab still yields to a newer thread.
 * This cap handles the other direction: a strip with many tabs visited over a
 * session would otherwise fill most of the ten slots with pages, burying the
 * threads the gesture is for. Three keeps a couple of recent pages in reach
 * without letting them flood the list.
 */
export const MAX_BROWSER_SWITCHER_ENTRIES = 3

/** The stable identity of an entry, used to mark the highlighted one. It is the
 *  same key form the recent list stores, so a browser entry and the active tab
 *  id compare equal. */
export function threadSwitcherEntryKey(entry: ThreadSwitcherEntry): string {
  return entry.kind === 'thread' ? threadVisitKey(entry.thread) : browserTabVisitKey(entry.tab.id)
}

export interface ThreadSwitcherEntrySource {
  /** The unified recent-visit keys, newest first. */
  visits: readonly string[]
  /** Every thread the switcher may show (already filtered of archived ones). */
  threads: readonly Thread[]
  /** Every open browser tab, used only to resolve a visit key into a row. A tab
   *  the visit order never names is never listed. */
  tabs: readonly GlobalBrowserTab[]
  /**
   * The browser tab on screen right now, while the browser view is the surface
   * the user is looking at, otherwise null.
   *
   * The surface the user is on is the present, so it leads the list whatever the
   * recorded order says: Control release then lands on the surface they were on
   * before it, which is what makes Ctrl+Tab alternate. It is also the one entry
   * that may not drop out for want of a visit key, so a tab whose visit was never
   * recorded is still listed while the user looks at it. It has to name a tab in
   * `tabs` all the same: no row can be built from a tab the caller could not see.
   */
  currentBrowserTabId?: string | null
  limit?: number
}

/**
 * The floor on the list bound.
 *
 * One row cannot offer a choice, so a caller's smaller or unusable bound is
 * raised to this.
 */
const MIN_SWITCHER_ENTRIES = 2

/**
 * Resolve the recent-visit keys into live entries in one recency order.
 *
 * Every kind competes on the same terms: the walk takes whatever the order names
 * next, thread or browser tab, until the limit is reached. Nothing is reserved or
 * force-added, so the list is exactly the surfaces the user has used, newest
 * first, with one guard: at most three browser tabs are listed. The guard stops
 * a tab-heavy session from filling the list with pages while still letting a
 * newer tab outrank an older thread. When the order names fewer surfaces than
 * the list can hold, the tail is filled with the most recently active threads.
 * That keeps the switcher useful on a cold start, and it is the only padding the
 * builder does: padding with browser tabs is what used to fill the list with
 * pages the user had never opened.
 */
export function buildThreadSwitcherEntries(
  source: ThreadSwitcherEntrySource
): ThreadSwitcherEntry[] {
  const requested = source.limit ?? THREAD_SWITCHER_ENTRY_LIMIT
  const limit =
    Number.isFinite(requested) && requested > MIN_SWITCHER_ENTRIES
      ? Math.trunc(requested)
      : MIN_SWITCHER_ENTRIES
  const threadsByKey = new Map(source.threads.map((thread) => [threadVisitKey(thread), thread]))
  const tabsById = new Map(source.tabs.map((tab) => [tab.id, tab]))
  const entries: ThreadSwitcherEntry[] = []
  const usedThreads = new Set<string>()
  const usedTabs = new Set<string>()
  const currentTabId = source.currentBrowserTabId ?? null
  const currentTab = currentTabId ? (tabsById.get(currentTabId) ?? null) : null
  const currentKey = currentTab ? browserTabVisitKey(currentTab.id) : null
  // The surface the user is on leads the list; everything else keeps the one
  // recency order (see `currentBrowserTabId` for what leading buys).
  const visits = currentKey
    ? [currentKey, ...source.visits.filter((visit) => visit !== currentKey)]
    : source.visits

  for (const visit of visits) {
    if (entries.length >= limit) break
    if (isBrowserTabVisitKey(visit)) {
      const tab = tabsById.get(browserTabIdFromVisitKey(visit))
      if (!tab || usedTabs.has(tab.id)) continue
      if (usedTabs.size >= MAX_BROWSER_SWITCHER_ENTRIES) continue
      entries.push({ kind: 'browser', tab })
      usedTabs.add(tab.id)
      continue
    }
    const thread = threadsByKey.get(visit)
    if (!thread || usedThreads.has(thread.id)) continue
    entries.push({ kind: 'thread', thread })
    usedThreads.add(thread.id)
  }

  if (entries.length < limit) {
    const rest = source.threads
      .filter((thread) => !usedThreads.has(thread.id))
      .sort((a, b) => b.lastActivity - a.lastActivity)
    for (const thread of rest) {
      if (entries.length >= limit) break
      entries.push({ kind: 'thread', thread })
    }
  }

  return entries
}
