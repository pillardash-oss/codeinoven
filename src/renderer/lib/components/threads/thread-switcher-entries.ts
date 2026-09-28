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
  limit?: number
}

/**
 * Resolve the recent-visit keys into live entries, then fill the remaining slots
 * with the most recently active threads so the switcher is never empty just
 * because nothing has been visited yet.
 */
export function buildThreadSwitcherEntries(
  source: ThreadSwitcherEntrySource
): ThreadSwitcherEntry[] {
  const limit = source.limit ?? THREAD_SWITCHER_ENTRY_LIMIT
  const threadsByKey = new Map(source.threads.map((thread) => [threadVisitKey(thread), thread]))
  const tabsById = new Map(source.tabs.map((tab) => [tab.id, tab]))
  const entries: ThreadSwitcherEntry[] = []
  const usedThreads = new Set<string>()
  const usedTabs = new Set<string>()

  for (const visit of source.visits) {
    if (entries.length >= limit) break
    if (isBrowserTabVisitKey(visit)) {
      const tab = tabsById.get(browserTabIdFromVisitKey(visit))
      if (!tab || usedTabs.has(tab.id)) continue
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
