/**
 * The app's recent-visit list: one MRU across every surface the Ctrl+Tab
 * switcher can jump to.
 *
 * A thread visit is stored as `<projectId>:<threadId>` (the key the workspace
 * has persisted since the switcher existed), a browser tab visit as
 * `browser-tab:<tabId>`, and a panel tab visit (a terminal, file or
 * thread-browser tab) as `panel-tab:<sidebarTabId>`. All kinds live in one
 * ordered list with one bound, so a project thread, a chat, an assistant task, a
 * global browser tab and a panel tab compete for the same slots: whatever was
 * used most recently is first, and a newer visit pushes an older one off the end
 * whatever kind it is. That is the point of the gesture, quick task switching
 * across views that share no other list.
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
/**
 * Marks one entry as a panel tab (a terminal, file or thread-browser tab).
 *
 * The key is the sidebar tab id it names, which is unique across the three
 * kinds (`terminal:…`, `files:…`, `browser:…`), so one prefix separates every
 * panel tab from a thread key and from a global browser tab.
 */
const PANEL_TAB_VISIT_PREFIX = 'panel-tab:'

/** Every non-thread visit prefix. A thread key is `<projectId>:<threadId>`,
 *  where the project id is a UUID, so it can start with none of these. */
const NON_THREAD_VISIT_PREFIXES = [BROWSER_TAB_VISIT_PREFIX, PANEL_TAB_VISIT_PREFIX]

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

/** The recent-list key for one panel tab (a terminal, file or thread-browser
 *  tab), keyed by the sidebar tab id it names. */
export function panelTabVisitKey(tabId: string): string {
  return `${PANEL_TAB_VISIT_PREFIX}${tabId}`
}

/** Whether a recent-visit key belongs to a panel tab rather than a thread. */
export function isPanelTabVisitKey(key: string): boolean {
  return key.startsWith(PANEL_TAB_VISIT_PREFIX)
}

/** The tab id behind a panel-tab visit key. Call only when
 *  {@link isPanelTabVisitKey} is true. */
export function panelTabIdFromVisitKey(key: string): string {
  return key.slice(PANEL_TAB_VISIT_PREFIX.length)
}

/** Whether a recent-visit key names a thread (rather than a global browser tab
 *  or a panel tab). */
export function isThreadVisitKey(key: string): boolean {
  return !NON_THREAD_VISIT_PREFIXES.some((prefix) => key.startsWith(prefix))
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
   *  this rather than the mixed list, so a browser or panel tab visit never leaks
   *  into a surface that resolves threads. */
  get threadKeys(): readonly string[] {
    return this.entries.filter(isThreadVisitKey)
  }

  /** Count a thread as visited, moving it to the front. */
  recordThread(thread: Pick<Thread, 'projectId' | 'id'>): void {
    this.record(threadVisitKey(thread))
  }

  /** Count a browser tab as visited, moving it to the front. */
  recordBrowserTab(tabId: string): void {
    this.record(browserTabVisitKey(tabId))
  }

  /** Count a panel tab (a terminal, file or thread-browser tab) as visited,
   *  moving it to the front. */
  recordPanelTab(tabId: string): void {
    this.record(panelTabVisitKey(tabId))
  }

  /**
   * Drop a browser tab's visit, which is what closing the tab does.
   *
   * A closed tab can never be switched to again, so its key would only take a
   * slot from a surface the user can still reach.
   */
  forgetBrowserTab(tabId: string): void {
    this.forget(browserTabVisitKey(tabId))
  }

  /** Drop a panel tab's visit, which is what closing the tab does. A closed tab
   *  can never be switched to again, so its key would only take a slot from a
   *  surface the user can still reach. */
  forgetPanelTab(tabId: string): void {
    this.forget(panelTabVisitKey(tabId))
  }

  private forget(key: string): void {
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
