/**
 * The Ctrl+Tab switcher's entry list.
 *
 * The switcher is a task switcher, not a thread list, so its entries are the
 * surfaces a user actually moves between: any thread (project, chat or
 * assistant task) and any open browser tab. They share one recency order
 * (`recent-visits.svelte`), so the pure builder here only has to resolve each
 * stored key against the live data and pad the tail with the most recently
 * active threads, which is what keeps the list useful on a cold start.
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
  /** Every open browser tab. */
  tabs: readonly GlobalBrowserTab[]
  /**
   * The browser tab on screen right now, while the browser view is the surface
   * the user is looking at, otherwise null.
   *
   * The surface the user is on is the present, so it leads the list whatever the
   * recorded order says: Control release then lands on the surface they were on
   * before it, which is what makes Ctrl+Tab alternate. It is also the one entry
   * that may not drop out for want of a visit key or for want of room, so a tab
   * whose visit was never recorded, or was evicted from the recent list, is still
   * listed while the user looks at it. It has to name a tab in `tabs` all the
   * same: no row can be built from a tab the caller could not see.
   */
  currentBrowserTabId?: string | null
  limit?: number
}

/**
 * The floor on the list bound.
 *
 * One row cannot offer a choice, and a bound that small would leave the budgets
 * meaningless (a tab budget of zero lists no browser tab even while the user is
 * looking at one), so a caller's smaller or unusable bound is raised to this.
 */
const MIN_SWITCHER_ENTRIES = 2

/**
 * Resolve the recent-visit keys into live entries, then guarantee a row for every
 * open browser tab within its share of the slots, then fill the remaining slots
 * with the most recently active threads so the switcher is never empty just
 * because nothing has been visited yet.
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
  const currentKey = currentTabId ? browserTabVisitKey(currentTabId) : null
  // The surface the user is on leads the list; everything else keeps the order it
  // recorded (see `currentBrowserTabId` for what leading buys).
  const visits = currentKey
    ? [currentKey, ...source.visits.filter((visit) => visit !== currentKey)]
    : source.visits
  // The slots are budgeted across the two kinds so neither can starve the
  // other. Tabs come first because a tab left out of the list is a surface the
  // user can only find again with the mouse. Threads always keep at least one
  // slot, which is what stops a session with more open tabs than the list is
  // long from turning the switcher into a tab strip that cannot reach a thread.
  const tabBudget = Math.min(tabsById.size, Math.max(0, limit - 1))
  const threadBudget = limit - tabBudget

  for (const visit of visits) {
    if (isBrowserTabVisitKey(visit)) {
      if (usedTabs.size >= tabBudget) continue
      const tab = tabsById.get(browserTabIdFromVisitKey(visit))
      if (!tab || usedTabs.has(tab.id)) continue
      entries.push({ kind: 'browser', tab })
      usedTabs.add(tab.id)
      continue
    }
    if (usedThreads.size >= threadBudget) continue
    const thread = threadsByKey.get(visit)
    if (!thread || usedThreads.has(thread.id)) continue
    entries.push({ kind: 'thread', thread })
    usedThreads.add(thread.id)
  }

  // Every open tab within its budget is listed, whether or not the order names
  // it: a visit key can be missing for a tab restored from storage, and a tab the
  // user cannot reach from the switcher is a tab that needs the mouse. Most
  // recently used first, which is the order the switcher is about.
  for (const tab of [...source.tabs].sort((a, b) => b.lastUsedAt - a.lastUsedAt)) {
    if (entries.length >= limit || usedTabs.size >= tabBudget) break
    if (usedTabs.has(tab.id)) continue
    entries.push({ kind: 'browser', tab })
    usedTabs.add(tab.id)
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
