/**
 * The app's recent-visit list: one MRU across every surface the Ctrl+Tab
 * switcher can jump to.
 *
 * A thread visit is stored as `<projectId>:<threadId>` (the key the workspace
 * has persisted since the switcher existed), and a browser tab visit as
 * `browser-tab:<tabId>`. Both kinds live in one ordered list with one bound, so a
 * project thread, a chat, an assistant task and a browser tab compete for the
 * same slots: whatever was used most recently is first, and a newer visit pushes
 * an older one off the end whatever kind it is. That is the point of the gesture,
 * quick task switching across views that share no other list.
 *
 * It is persisted in localStorage on purpose: navigation history is optional,
 * so losing it costs a less helpful switcher order and must never block a
 * switch.
 */

import { APP_SLUG } from '$shared/brand'
import type { Thread } from '$shared/types'

const RECENT_VISITS_KEY = `${APP_SLUG}.recent-thread-visits.v1`
/**
 * How many visits the list keeps, one bound for every kind.
 *
 * A separate budget per kind was a real defect: it meant an older browser tab
 * could never be evicted by newer thread visits, so the list kept naming tabs the
 * user had long since stopped using. One bound is what makes the list a single
 * recency order rather than two lists interleaved.
 */
const RECENT_VISIT_LIMIT = 50
/** Marks one entry as a browser tab. Project ids are UUIDs, so a thread key can
 *  never start with this. */
const BROWSER_TAB_VISIT_PREFIX = 'browser-tab:'

function loadRecentVisits(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const parsed = JSON.parse(window.localStorage.getItem(RECENT_VISITS_KEY) ?? '[]')
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : []
  } catch {
    return []
  }
}

function persistRecentVisits(visits: readonly string[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(RECENT_VISITS_KEY, JSON.stringify(visits))
  } catch {
    // Recent navigation history is optional and must never block task switching.
  }
}

/** The stable identity of a thread in the recent list and the switcher. */
export function threadVisitKey(thread: Pick<Thread, 'projectId' | 'id'>): string {
  return `${thread.projectId}:${thread.id}`
}

/** The recent-list key for one browser tab. */
export function browserTabVisitKey(tabId: string): string {
  return `${BROWSER_TAB_VISIT_PREFIX}${tabId}`
}

/** Whether a recent-visit key belongs to a browser tab rather than a thread. */
export function isBrowserTabVisitKey(key: string): boolean {
  return key.startsWith(BROWSER_TAB_VISIT_PREFIX)
}

/** The tab id behind a browser tab visit key. Call only when
 *  {@link isBrowserTabVisitKey} is true. */
export function browserTabIdFromVisitKey(key: string): string {
  return key.slice(BROWSER_TAB_VISIT_PREFIX.length)
}

/**
 * Bound the visit list with one limit for every kind.
 *
 * The newest `RECENT_VISIT_LIMIT` visits are kept, in order, whether they are a
 * thread or a browser tab. See the constant for why the bound is not per kind.
 */
export function capRecentVisits(entries: readonly string[]): string[] {
  return entries.slice(0, RECENT_VISIT_LIMIT)
}

class RecentVisitsState {
  /** Every visit, newest first, threads and browser tabs interleaved. */
  private entries: string[] = $state(loadRecentVisits())

  /** The unified MRU, newest first. */
  get all(): readonly string[] {
    return this.entries
  }

  /** Only the thread keys, in visit order. Every thread-facing consumer reads
   *  this rather than the mixed list, so a browser tab visit never leaks into a
   *  surface that resolves threads. */
  get threadKeys(): readonly string[] {
    return this.entries.filter((key) => !isBrowserTabVisitKey(key))
  }

  /** Count a thread as visited, moving it to the front. */
  recordThread(thread: Pick<Thread, 'projectId' | 'id'>): void {
    this.record(threadVisitKey(thread))
  }

  /** Count a browser tab as visited, moving it to the front. */
  recordBrowserTab(tabId: string): void {
    this.record(browserTabVisitKey(tabId))
  }

  /**
   * Drop a browser tab's visit, which is what closing the tab does.
   *
   * A closed tab can never be switched to again, so its key would only take a
   * slot from a surface the user can still reach.
   */
  forgetBrowserTab(tabId: string): void {
    const key = browserTabVisitKey(tabId)
    if (!this.entries.includes(key)) return
    this.entries = this.entries.filter((candidate) => candidate !== key)
    persistRecentVisits(this.entries)
  }

  private record(key: string): void {
    this.entries = capRecentVisits([key, ...this.entries.filter((candidate) => candidate !== key)])
    persistRecentVisits(this.entries)
  }
}

export const recentVisits = new RecentVisitsState()
