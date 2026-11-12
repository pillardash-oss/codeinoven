/**
 * ── the app's browser tabs, as chrome.tabs.query answers them ───────────────
 *
 * The app's pages are WebContentsViews, not tabs in a Chromium window. Electron's
 * partial tabs API therefore cannot be the whole answer: extensions which query
 * all tabs (Dark Reader does this when first installed) would otherwise never
 * inject into a page that was already open. The bridge replays and forwards the
 * app's tab events, and those snapshots are merged with any tabs Electron knows.
 *
 * WHY THIS MODULE EXISTS
 * `chrome.tabs.query` is the one call an extension makes before it acts on a page,
 * so the answer decides whether a content script ever reaches a document. The
 * runtime's own answer omits the tab the app hosts for the extension and marks
 * every tab of the app's own browser inactive, because the focus that would make
 * one active never lands in a window Chromium tracks. Both are corrected here.
 *
 * WHAT IT HOLDS
 * The hosted window's tab as this repair answers it, the filter matcher Chromium's
 * own query would have applied, the snapshot merge with what the app announced, and
 * the two time-boxed readers for a runtime that answers by callback, by promise or
 * not at all. The one side effect is `installTabsQueryRepair`, which wraps `query`
 * and `get` once per tabs object, however many roots alias it.
 */
import { answerWith, roots, state } from './context.ts'
import type { ChromeNamespace } from './context.ts'
import {
  HOSTED_POPUP_TAB_ID,
  HOSTED_POPUP_WINDOW_ID,
  hostedPopout,
  tabActivity,
  waitForTabReplay
} from './bridge.ts'
import type { TabSnapshot } from './bridge.ts'

/** One tab this repair answers with, in `chrome.tabs`' own shape. */
export interface QueryTab {
  id?: unknown
  index?: unknown
  windowId?: unknown
  windowType?: unknown
  active?: unknown
  highlighted?: unknown
  pinned?: unknown
  incognito?: unknown
  discarded?: unknown
  autoDiscardable?: unknown
  audible?: unknown
  status?: unknown
  url?: unknown
  title?: unknown
  mutedInfo?: { muted?: unknown } | null
  [field: string]: unknown
}

/** The query an extension hands `chrome.tabs.query`, read member by member. */
export type QueryInfo = Record<string, unknown>

/** Whatever a `tabs.query` call returns when it answers with a promise. */
interface Thenable {
  then(onFulfilled: (value: unknown) => void, onRejected: (error: unknown) => void): unknown
}

/** The runtime's own `tabs.query`, bound to its namespace. */
type NativeQuery = (query: QueryInfo, callback?: (tabs: unknown) => void) => unknown

/** The runtime's own `tabs.get`, bound to its namespace. */
type NativeGet = (id: number, callback?: (tab: unknown) => void) => unknown

/** `chrome.tabs`, viewed with the members this repair wraps. */
interface TabsApi extends ChromeNamespace {
  query?: (...args: unknown[]) => unknown
  get?: (...args: unknown[]) => unknown
  /** The mark that keeps this repair to one wrap per tabs object. */
  __cioTabsQueryRepaired?: boolean
}

// The tab the app hosts for the extension, in the answer's own shape: the same two
// ids the app reports a window ending under, and the focus it announced.
export const hostedPopoutTab = (): QueryTab | null =>
  hostedPopout.url
    ? {
        id: HOSTED_POPUP_TAB_ID,
        index: 0,
        windowId: HOSTED_POPUP_WINDOW_ID,
        windowType: 'popup',
        active: hostedPopout.focused,
        highlighted: hostedPopout.focused,
        pinned: false,
        incognito: false,
        discarded: false,
        autoDiscardable: false,
        status: 'complete',
        url: hostedPopout.url,
        title: ''
      }
    : null

/**
 * Whether an address passes one `url` / `title` filter entry.
 *
 * Chromium's filter is a match pattern, and this is its two wildcard forms: `*` is
 * any run of characters, everything else is literal. A pattern that will not
 * compile matches nothing rather than throwing into the extension's call.
 */
export const matchesUrlFilter = (url: unknown, filter: unknown): boolean => {
  if (!filter) return true
  const patterns = Array.isArray(filter) ? filter : [filter]
  return patterns.some((pattern) => {
    if (typeof pattern !== 'string') return false
    try {
      const source = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^]*')
      return new RegExp('^' + source + '$').test(String(url))
    } catch {
      return false
    }
  })
}

/** Whether the hosted window's tab passes the parts of a query that name a window. */
export const hostedPopoutMatchesQuery = (
  tab: QueryTab | null,
  query: QueryInfo
): tab is QueryTab => {
  if (!tab) return false
  if (query && query.windowType && query.windowType !== 'popup') return false
  if (query && typeof query.windowId === 'number' && query.windowId !== HOSTED_POPUP_WINDOW_ID) {
    return false
  }
  if (query && typeof query.active === 'boolean' && query.active !== tab.active) return false
  if (query && typeof query.status === 'string' && query.status !== tab.status) return false
  if (query && query.url && !matchesUrlFilter(tab.url, query.url)) return false
  if (query && query.title && tab.title !== query.title) return false
  return true
}

/** Whether one tab passes every member of a query that this repair can answer. */
export const matchesQuery = (tab: QueryTab | null | undefined, query: QueryInfo): boolean => {
  if (!tab || typeof tab !== 'object') return false
  if (typeof query.active === 'boolean' && tab.active !== query.active) return false
  if (typeof query.audible === 'boolean' && (tab.audible === true) !== query.audible) {
    return false
  }
  if (
    typeof query.autoDiscardable === 'boolean' &&
    (tab.autoDiscardable === true) !== query.autoDiscardable
  ) {
    return false
  }
  if (typeof query.discarded === 'boolean' && (tab.discarded === true) !== query.discarded) {
    return false
  }
  if (typeof query.highlighted === 'boolean' && (tab.highlighted === true) !== query.highlighted) {
    return false
  }
  if (typeof query.index === 'number' && tab.index !== query.index) return false
  if (typeof query.muted === 'boolean') {
    const muted = tab.mutedInfo && tab.mutedInfo.muted === true
    if (muted !== query.muted) return false
  }
  if (typeof query.pinned === 'boolean' && (tab.pinned === true) !== query.pinned) {
    return false
  }
  if (typeof query.status === 'string' && tab.status !== query.status) return false
  if (query.title && !matchesUrlFilter(tab.title || '', query.title)) return false
  if (query.url && !matchesUrlFilter(tab.url || '', query.url)) return false
  if (typeof query.windowId === 'number' && tab.windowId !== query.windowId) return false
  if (query.windowType && tab.windowType !== query.windowType) return false
  if (
    (query.currentWindow === true || query.lastFocusedWindow === true) &&
    tab.windowId !== 0 &&
    tab.windowId !== HOSTED_POPUP_WINDOW_ID
  ) {
    return false
  }
  return true
}

/**
 * Merge what the runtime knows with what the app announced.
 *
 * The app's snapshots carry the truth about which tab is on screen, and the
 * runtime's carry ids the snapshots do not. A tab both sides name is one tab, with
 * the announcement winning the fields it holds.
 */
export const withActivity = (tabs: unknown): QueryTab[] => {
  const byId = new Map<number, QueryTab>()
  for (const tab of Array.isArray(tabs) ? (tabs as QueryTab[]) : []) {
    if (
      !tab ||
      typeof tab !== 'object' ||
      Array.isArray(tab) ||
      typeof tab.id !== 'number' ||
      !Number.isFinite(tab.id)
    ) {
      continue
    }
    const active = tab.id === tabActivity.activeTabId
    byId.set(tab.id, Object.assign({}, tab, { active }))
  }
  for (const id of Object.keys(tabActivity.tabs)) {
    const tab: TabSnapshot | undefined = tabActivity.tabs[id]
    if (!tab || typeof tab !== 'object' || typeof tab.id !== 'number') continue
    byId.set(tab.id, Object.assign({}, byId.get(tab.id) || {}, tab))
  }
  return [...byId.values()]
}

/**
 * The runtime's tab list, time-boxed.
 *
 * A runtime that answers by callback, by promise or not at all must not leave the
 * extension's own call hanging, so the answer is a promise either way and a list
 * that never arrives settles empty.
 */
export const readNativeTabs = (nativeQuery: NativeQuery, query: QueryInfo): Promise<unknown[]> =>
  new Promise<unknown[]>((resolve) => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    const finish = (tabs: unknown): void => {
      if (settled) return
      settled = true
      if (timeout !== null) clearTimeout(timeout)
      resolve(Array.isArray(tabs) ? tabs : [])
    }
    timeout = setTimeout(() => finish([]), 1500)
    try {
      const returned = nativeQuery(query, finish) as Thenable | null | undefined
      if (returned && typeof returned.then === 'function') {
        returned.then(finish, (error) => {
          state.errors.push('tabs-query: ' + String(error))
          finish([])
        })
      }
    } catch (error) {
      state.errors.push('tabs-query: ' + String(error))
      try {
        const returned = nativeQuery(query) as Thenable | null | undefined
        if (returned && typeof returned.then === 'function') {
          returned.then(finish, () => finish([]))
        } else {
          finish([])
        }
      } catch (fallbackError) {
        state.errors.push('tabs-query: ' + String(fallbackError))
        finish([])
      }
    }
  })

/** One tab of the runtime's, time-boxed, for the active-tab lookup below. */
export const readNativeTab = (nativeGet: NativeGet, id: number): Promise<QueryTab | null> =>
  new Promise<QueryTab | null>((resolve) => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    const finish = (tab: unknown): void => {
      if (settled) return
      settled = true
      if (timeout !== null) clearTimeout(timeout)
      resolve(tab && typeof tab === 'object' ? (tab as QueryTab) : null)
    }
    timeout = setTimeout(() => finish(null), 1500)
    try {
      const returned = nativeGet(id, finish) as Thenable | null | undefined
      if (returned && typeof returned.then === 'function') {
        returned.then(finish, (error) => {
          state.errors.push('tabs-active: ' + String(error))
          finish(null)
        })
      }
    } catch (error) {
      state.errors.push('tabs-active: ' + String(error))
      try {
        const returned = nativeGet(id) as Thenable | null | undefined
        if (returned && typeof returned.then === 'function') {
          returned.then(finish, () => finish(null))
        } else {
          finish(null)
        }
      } catch (fallbackError) {
        state.errors.push('tabs-active: ' + String(fallbackError))
        finish(null)
      }
    }
  })

/**
 * Wrap `chrome.tabs.query` and `chrome.tabs.get` on every root that carries them.
 *
 * Every answer is the app's tab list merged with the runtime's, filtered the way
 * the query asks, with the hosted window's tab added where it belongs. An active
 * query is answered from the app's own notion of the active tab, because the
 * runtime's list cannot hold it.
 */
export function installTabsQueryRepair(): void {
  try {
    if (state.tabsActivityRepair !== 'installed') {
      let repairedOn = 0
      for (const root of roots) {
        const tabsApi = root && (root.tabs as TabsApi | undefined)
        if (!tabsApi || typeof tabsApi !== 'object') continue
        // `chrome.tabs` and `browser.tabs` are the same object in this runtime, so
        // this loop meets it twice and a second wrap would answer every query
        // twice, stacking a second copy of the hosted window's tab. A mark on the
        // object keeps the repair to one wrap, however many roots alias it.
        if (tabsApi.__cioTabsQueryRepaired) continue
        const nativeQuery: NativeQuery | null =
          typeof tabsApi.query === 'function' ? tabsApi.query.bind(tabsApi) : null
        if (!nativeQuery) continue
        tabsApi.__cioTabsQueryRepaired = true
        const nativeGet: NativeGet | null =
          typeof tabsApi.get === 'function' ? tabsApi.get.bind(tabsApi) : null
        try {
          const answerQuery = (
            list: QueryTab[],
            query: QueryInfo,
            callback: unknown
          ): Promise<unknown> => {
            const hostedTab = hostedPopoutTab()
            const combined = list.filter((tab) => matchesQuery(tab, query))
            if (hostedPopoutMatchesQuery(hostedTab, query) && matchesQuery(hostedTab, query)) {
              combined.push(hostedTab)
            }
            if (!query || query.active !== true) return answerWith(callback, combined)
            const active = combined.filter((tab) => tab && tab.active === true)
            if (active.length > 0 || tabActivity.activeTabId === null || !nativeGet) {
              return answerWith(callback, active)
            }
            return readNativeTab(nativeGet, tabActivity.activeTabId).then((tab) =>
              answerWith(
                callback,
                tab ? withActivity([tab]).filter((entry) => matchesQuery(entry, query)) : active
              )
            )
          }
          const queryRepaired = (...args: unknown[]): Promise<unknown> => {
            const callback =
              typeof args[args.length - 1] === 'function'
                ? (args[args.length - 1] as (value: unknown) => void)
                : null
            const callArgs = callback ? args.slice(0, -1) : args
            const query: QueryInfo =
              callArgs[0] && typeof callArgs[0] === 'object' ? (callArgs[0] as QueryInfo) : {}
            return waitForTabReplay()
              .then(() => readNativeTabs(nativeQuery, query))
              .then((tabs) => answerQuery(withActivity(tabs), query, callback))
              .catch((error) => {
                state.errors.push('tabs-query: ' + String(error))
                return answerWith(callback, [])
              })
          }
          Object.defineProperty(tabsApi, 'query', {
            value: queryRepaired,
            configurable: true,
            writable: true
          })
          if (nativeGet) {
            const getRepaired = (id: number, callback?: unknown): Promise<unknown> => {
              const answered = typeof callback === 'function' ? callback : null
              const tab: TabSnapshot | undefined = tabActivity.tabs[String(id)]
              const result: Promise<QueryTab | null> = tab
                ? Promise.resolve<QueryTab>(tab)
                : readNativeTab(nativeGet, id)
              return result.then((found) =>
                answerWith(answered, found ? withActivity([found])[0] : undefined)
              )
            }
            Object.defineProperty(tabsApi, 'get', {
              value: getRepaired,
              configurable: true,
              writable: true
            })
          }
          repairedOn += 1
        } catch (error) {
          state.errors.push('tabs-activity: ' + String(error))
        }
      }
      state.tabsActivityRepair = repairedOn > 0 ? 'installed' : 'not-installed'
    }
  } catch (error) {
    state.errors.push('tabs-activity-outer: ' + String(error))
  }
}
