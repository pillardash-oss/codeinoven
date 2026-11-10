/**
 * The tab an extension's own page is acting on, told to the page itself.
 *
 * An extension's action popup is not a tab in any browser, but this app hosts it in
 * a `WebContentsView` among the pages, and the runtime answers `chrome.tabs.query`
 * by enumerating every `WebContents` of the session and calling whichever one holds
 * the keyboard `active`. The popup takes the keyboard when it is shown, because a
 * popup nobody can type into is not a popup, so from the moment it opens an
 * extension that resolves "the tab I am acting on" from focus is handed its own
 * document: Bitwarden reads the host of that address, finds it is not the login's
 * site, and shows "Site doesn't match" with `CURRENT WEBSITE
 * nngceckbapebfimnlniiiahkandclblb`   its own id.
 *
 * Main therefore pushes the tab it knows this page acts on into
 * `globalThis.__cioPageTabsSnapshot` and runs this file, and the wrappers below
 * answer `chrome.tabs` from that snapshot: the app's own extension surfaces are not
 * tabs and are not listed, and the page behind the popup is the active tab, which is
 * what Chromium would have answered had the popup not been a view of its own. The
 * snapshot is read at call time, so a fresh push is a re-run of this file and never a
 * reinstall, and a page that navigates is told again by the run that follows its new
 * document.
 *
 * Two answers are deliberate and worth stating, because an extension can read them:
 *
 *   - `tabs.getCurrent` answers `undefined`. Chromium answers that in a popup, since
 *     no tab holds the document, and callers are written for it: Bitwarden's own
 *     sites fall back to `tabs.query({ active: true, currentWindow: true })`, which
 *     is the query this file exists to answer. The missing function is a `TypeError`
 *     at the call site, which no caller branches on.
 *   - `url` and `title` ride along only when the extension may read them   the `tabs`
 *     permission, or a host permission matching the page   which is the rule the
 *     runtime applies to the tabs it reports itself.
 *
 * The page also opens tabs, and that is the same repair in the other direction: a
 * password manager's "launch" row is a `chrome.tabs.create` for the address the
 * entry holds, this runtime has no second window to put a page in, and the call
 * reaches a stub, so the click opens nothing at all. The app owns the tab strip, so
 * the page asks it over the message channel `chrome.runtime.openOptionsPage` already
 * uses and the preload forwards, and the answer is the new tab's id   its
 * `WebContents` id, which is the id this runtime's own tab API answers with, so a
 * caller that watches the tab it opened finds it again.
 */

;(() => {
  /**
   * The page main pushes into the snapshot, as `chrome.tabs` describes a tab.
   *
   * Only the fields this file reads are named: `id` is the one it always has, every
   * other field is there because a query filter or a published tab entry reads it.
   */
  interface PageSnapshot {
    id: number
    url?: string
    title?: string
    active?: boolean
    audible?: boolean
    muted?: boolean
    loading?: boolean
  }

  /** One tab of the runtime's own `tabs.query` answer, as far as this file reads it. */
  interface ListedTab {
    id?: number
    url?: unknown
  }

  /** The tab this file reports, in the shape `chrome.tabs` describes a tab. */
  interface TabEntry {
    id: number
    index: number
    windowId: number
    active: boolean
    highlighted: boolean
    pinned: boolean
    incognito: boolean
    audible: boolean
    mutedInfo: { muted: boolean; reason: string }
    discarded: boolean
    autoDiscardable: boolean
    groupId: number
    status: string
    url?: string
    title?: string
  }

  /**
   * The filters a `tabs.query` caller may set, as this file reads them.
   *
   * The values are the types the query documents: an extension that passes something
   * else is answered by the `typeof` tests in `matchesQuery`, never by these types.
   */
  interface TabsQueryInfo {
    active?: boolean
    audible?: boolean
    muted?: boolean
    pinned?: boolean
    status?: string
    url?: string | string[]
    title?: string | string[]
  }

  /** The `tabs.create` properties this file reads. */
  interface TabCreateProperties {
    url?: string | string[]
    active?: boolean
  }

  /** A `tabs.query` call: a promise or a callback, whichever shape the build answers. */
  interface TabsQuery {
    (queryInfo: unknown, callback?: (tabs: unknown) => void): unknown
    /** The marker that makes a second run of this file a rewrite and not a reinstall. */
    __cioPageTabs?: boolean
  }

  /** A `tabs.create` call, answered with the tab the app opened. */
  interface TabsCreate {
    (createProperties: unknown, callback?: (tab: unknown) => void): unknown
    /** The marker that makes a second run of this file a rewrite and not a reinstall. */
    __cioPageTabs?: boolean
  }

  /** `tabs.getCurrent`, which this file answers itself. */
  type TabsGetCurrent = (callback?: (tab: unknown) => void) => Promise<undefined> | undefined

  /** One tab event as this page's own code registers on it. */
  interface TabsEvent {
    addListener?: (listener: (...args: unknown[]) => void) => void
    removeListener?: (listener: (...args: unknown[]) => void) => void
    hasListener?: (listener: (...args: unknown[]) => void) => boolean
    hasListeners?: () => boolean
  }

  /**
   * A tab event this file owns, so the app can fire it at the page's own listeners.
   *
   * The runtime ships these events and never fires one, exactly as it does in a
   * worker (see the compatibility preamble), so a password manager's side panel that
   * tracks "which tab am I on" with `tabs.onActivated` never heard about a tab
   * switch and kept answering for the page the user left.
   */
  interface TabsEventEmitter extends TabsEvent {
    /** Fire at every listener held, one failure isolated per listener. */
    __cioEmit?: (args: unknown[]) => void
  }

  /**
   * The `chrome.tabs` namespace this file wraps.
   *
   * A type alias rather than an interface, so it can be handed to `define` as a
   * `Record` of members: an interface has no implicit index signature.
   */
  type TabsApi = {
    query?: TabsQuery
    getCurrent?: TabsGetCurrent
    create?: TabsCreate
    onCreated?: TabsEvent
    onUpdated?: TabsEvent
    onRemoved?: TabsEvent
    onActivated?: TabsEvent
    onHighlighted?: TabsEvent
  }

  /** The `chrome.runtime` surface `mayRead` asks for the extension's manifest. */
  interface ChromeRuntimeApi {
    getManifest?: () => ChromeManifest | undefined
  }

  /** The manifest fields `mayRead` reads. */
  interface ChromeManifest {
    permissions?: string[]
    host_permissions?: string[]
  }

  /** One root of the compat surface, which `chrome` and `browser` both are. */
  interface ChromeRoot {
    tabs?: TabsApi
    runtime?: ChromeRuntimeApi
  }

  /** Whatever a `tabs.query` call returns when it answers with a promise. */
  interface Thenable {
    then(onFulfilled: (value: unknown) => void, onRejected: (error: unknown) => void): unknown
  }

  /** One `tabs.create` ask still waiting for the app's answer. */
  interface OpenRequest {
    resolve: (tabId: number | null) => void
    timer: ReturnType<typeof setTimeout>
  }

  /** The app's answer to one `tabs.create` ask, as the message carries it. */
  interface OpenedTabAnswer {
    requestId: number
    tabId: number | null
  }

  /** The message the app posts back for one `tabs.create` ask. */
  interface OpenedTabMessage {
    __cioPageOpenedTab?: OpenedTabAnswer
  }

  /**
   * The global this file is injected into.
   *
   * The injected script is not a module, so these declarations stay inside it and
   * nothing here is published to the page's own world.
   */
  type CompatGlobal = typeof globalThis & {
    chrome?: ChromeRoot
    browser?: ChromeRoot
    __cioPageTabsSnapshot?: PageSnapshot
    /** Fire one tab event the app observed at this page's own listeners. */
    __cioPageTabsEmit?: (name: string, args: unknown[]) => void
  }

  /** The one typed view of the global, read through instead of `globalThis` itself. */
  const surface = globalThis as CompatGlobal

  /** Where main leaves the tab this page acts on, read fresh on every call. */
  const SNAPSHOT_KEY = '__cioPageTabsSnapshot'

  const ownTab = (): PageSnapshot | null => {
    const snapshot = surface[SNAPSHOT_KEY]
    return snapshot && typeof snapshot.id === 'number' ? snapshot : null
  }

  /**
   * Whether an address is one of the extension surfaces this app hosts   a popup it
   * drew for an extension, or the app's own bridge page   rather than a page.
   *
   * A browser holds no tab for any of these: a popup hangs off its window's toolbar
   * and the bridge page belongs to the app. Reporting one as a tab is what made an
   * extension act on itself, so none of them is ever listed, which is also what the
   * app's worker-side repairs already assume.
   */
  const isHostedExtensionSurface = (url: unknown) =>
    typeof url === 'string' && url.indexOf('chrome-extension://') === 0

  // ── Matching a query, for the entry this file adds ──────────────────────────
  // The runtime applies `active`, `audible`, `muted`, `title` and `url` to the tabs
  // it answers with, and ignores `windowId`, `currentWindow`, `lastFocusedWindow`,
  // `index`, `groupId`, `highlighted`, `discarded` and `autoDiscardable`: this
  // browser has one window, one strip, no pinning and no discard history of its own,
  // so there is nothing behind those filters to disagree with. The one entry added
  // here is held to the same set of filters, because a query that asked for another
  // site, or for a tab that is not active, must not be answered with this page.

  /** One literal with `*` wildcards left in place, so they can become wildcards. */
  const escapeLiteral = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')

  /** One `*`-wildcarded literal, as the body of an expression. */
  const wildcardBody = (text: string) => escapeLiteral(text).replace(/\*/g, '[^]*')

  const safeExpression = (source: string): RegExp | null => {
    try {
      return new RegExp(source)
    } catch {
      return null
    }
  }

  /**
   * One pattern from `tabs.query({ url })`, as an expression.
   *
   * `<scheme>://<host><path>` is the syntax that query documents, plus the `/regex/`
   * short form and `<all_urls>`. A pattern that names no port matches every port,
   * which is Chrome's own rule for match patterns and the one this browser needs:
   * a local development page is served from whatever port it was started on.
   */
  const urlExpression = (pattern: unknown): RegExp | null => {
    if (typeof pattern !== 'string' || pattern.length === 0) return null
    if (
      pattern.length > 1 &&
      pattern.charAt(0) === '/' &&
      pattern.charAt(pattern.length - 1) === '/'
    ) {
      return safeExpression(pattern.slice(1, -1))
    }
    if (pattern === '<all_urls>') return /^[^]*$/
    const separator = pattern.indexOf('://')
    if (separator === -1) return safeExpression('^' + wildcardBody(pattern) + '$')
    const scheme = pattern.slice(0, separator)
    const rest = pattern.slice(separator + 3)
    const slash = rest.indexOf('/')
    const host = slash === -1 ? rest : rest.slice(0, slash)
    const path = slash === -1 ? '' : rest.slice(slash)
    const port = host.indexOf(':') === -1 ? '(?::[0-9]+)?' : ''
    return safeExpression(
      '^' + wildcardBody(scheme) + '://' + wildcardBody(host) + port + wildcardBody(path) + '$'
    )
  }

  /**
   * One pattern from `tabs.query({ title })` or a host permission, as an expression:
   * a glob over a literal, and the `/regex/` short form.
   */
  const globExpression = (pattern: unknown): RegExp | null => {
    if (typeof pattern !== 'string' || pattern.length === 0) return null
    if (
      pattern.length > 1 &&
      pattern.charAt(0) === '/' &&
      pattern.charAt(pattern.length - 1) === '/'
    ) {
      return safeExpression(pattern.slice(1, -1))
    }
    return safeExpression('^' + wildcardBody(pattern) + '$')
  }

  const matches = (
    expression: (pattern: unknown) => RegExp | null,
    patterns: unknown,
    value: string
  ) => {
    const list: unknown[] = Array.isArray(patterns) ? patterns : [patterns]
    for (const pattern of list) {
      const built = expression(pattern)
      if (built && built.test(value)) return true
    }
    return false
  }

  /**
   * Whether this extension may read the address and title of the page it is hosted
   * over: the `tabs` permission, or a host permission matching that page. It is the
   * same rule the runtime applies to the fields of the tabs it reports, and the
   * declared names that are not host patterns (`storage`, `scripting`) simply match
   * no address.
   */
  const mayRead = (url: string) => {
    try {
      for (const root of roots) {
        const runtime = root && root.runtime
        if (!runtime || typeof runtime.getManifest !== 'function') continue
        const manifest: ChromeManifest = runtime.getManifest() || {}
        const declared = ([] as string[]).concat(
          manifest.permissions || [],
          manifest.host_permissions || []
        )
        if (declared.indexOf('tabs') !== -1) return true
        if (matches(urlExpression, declared, url)) return true
      }
      return false
    } catch {
      return false
    }
  }

  // ── Tab events, which this runtime never fires in a page ──────────────────
  // A popup or a side panel is a document of the extension, so it registers its
  // own `tabs.on*` listeners the way Chromium expects and keeps its idea of the
  // current tab from them. The runtime delivers none of those, which left a side
  // panel showing the site the user had already left. One emitter per event, on
  // both roots, and the app fires the same facts it hands the worker.
  const tabEventEmitters: Record<string, TabsEventEmitter> = {}

  const makeTabEvent = (): TabsEventEmitter => {
    const listeners: ((...args: unknown[]) => void)[] = []
    return {
      addListener: (listener) => {
        if (typeof listener === 'function' && listeners.indexOf(listener) === -1) {
          listeners.push(listener)
        }
      },
      removeListener: (listener) => {
        const index = listeners.indexOf(listener)
        if (index !== -1) listeners.splice(index, 1)
      },
      hasListener: (listener) => listeners.indexOf(listener) !== -1,
      hasListeners: () => listeners.length > 0,
      __cioEmit: (args) => {
        for (const listener of listeners.slice()) {
          try {
            listener(...args)
          } catch {
            // One listener that throws does not deny the fact to the others.
          }
        }
      }
    }
  }

  /**
   * The page as `chrome.tabs` describes a tab.
   *
   * `index`, `windowId`, `pinned`, `discarded`, `autoDiscardable` and `status` are
   * this browser's constants, and they are the values the runtime's own answers carry:
   * one strip, one window, no pinning, a live page, never discarded. `highlighted` and
   * `groupId` are Chrome's own values rather than the runtime's unset defaults, because
   * this is what an extension written against Chromium reads and the app's own
   * `chrome.tabGroups` stub already answers `TAB_GROUP_ID_NONE: -1`.
   */
  const tabEntry = (page: PageSnapshot): TabEntry => {
    const active = page.active === true
    const entry: TabEntry = {
      id: page.id,
      index: 0,
      windowId: 0,
      active,
      highlighted: active,
      pinned: false,
      incognito: false,
      audible: page.audible === true,
      mutedInfo: { muted: page.muted === true, reason: 'user' },
      discarded: false,
      autoDiscardable: false,
      groupId: -1,
      status: page.loading === true ? 'loading' : 'complete'
    }
    // The filters are answered from the page's real address even when the extension
    // may not read it: the runtime filters a query on the committed URL and only
    // hides the field, so a query whose pattern matches must still find this tab.
    if (mayRead(page.url || '')) {
      entry.url = page.url || ''
      entry.title = page.title || ''
    }
    return entry
  }

  /** Whether the tab this file reports answers one query. */
  const matchesQuery = (page: PageSnapshot, entry: TabEntry, queryInfo: unknown) => {
    const query = (queryInfo && typeof queryInfo === 'object' ? queryInfo : {}) as TabsQueryInfo
    if (typeof query.active === 'boolean' && query.active !== entry.active) return false
    if (typeof query.audible === 'boolean' && query.audible !== entry.audible) return false
    if (typeof query.muted === 'boolean' && query.muted !== entry.mutedInfo.muted) return false
    if (typeof query.pinned === 'boolean' && query.pinned !== entry.pinned) return false
    if (typeof query.status === 'string' && query.status !== entry.status) return false
    if (query.url && !matches(urlExpression, query.url, page.url || '')) return false
    if (query.title && !matches(globExpression, query.title, page.title || '')) return false
    return true
  }

  /**
   * One query, answered the way Chromium would have answered it.
   *
   * The runtime's own answer is the starting point, because it is the one that can
   * see every `WebContents` of the session, and then the two corrections this file
   * exists for: the extension surfaces this app hosts are not tabs, and the page
   * behind this one is the active tab, whatever currently holds the keyboard.
   */
  const answer = (tabs: ListedTab[], queryInfo: unknown): ListedTab[] => {
    const listed: ListedTab[] = []
    for (const tab of tabs) {
      if (!tab || typeof tab !== 'object') continue
      if (isHostedExtensionSurface(tab.url)) continue
      listed.push(tab)
    }
    const page = ownTab()
    if (!page) return listed
    const entry = tabEntry(page)
    const others = listed.filter((tab) => tab.id !== entry.id)
    return matchesQuery(page, entry, queryInfo) ? ([entry] as ListedTab[]).concat(others) : others
  }

  /** How long a runtime that never answers may keep an extension waiting. */
  const ANSWER_TIMEOUT_MS = 2000

  /**
   * The runtime's own answer, in whichever shape this build answers in.
   *
   * `tabs.query` is declared with `returns_async`, so asking it without a callback
   * gets a promise; a build that answers only through a callback is asked again in
   * that shape rather than left hanging, and a refusal from the promise is passed on
   * as a refusal. A runtime that answers in neither shape   a view taken away
   * mid-call   resolves empty, because a query that never settles is worse for the
   * page than one that answers "nothing".
   */
  const askOriginal = (original: TabsQuery, queryInfo: unknown) =>
    new Promise<ListedTab[]>((resolve, reject) => {
      let settled = false
      const settle = (tabs: unknown) => {
        if (settled) return
        settled = true
        resolve(Array.isArray(tabs) ? (tabs as ListedTab[]) : [])
      }
      const fail = (error: unknown) => {
        if (settled) return
        settled = true
        reject(error instanceof Error ? error : new Error(String(error)))
      }
      let returned: Thenable | null
      try {
        returned = original(queryInfo) as Thenable | null
      } catch {
        // Either a build that wants a callback, or a refusal: both are settled by
        // the attempt below, so nothing is reported from here.
        returned = null
      }
      if (returned && typeof returned.then === 'function') {
        returned.then(settle, fail)
        return
      }
      try {
        const answered = original(queryInfo, settle) as Thenable | null
        if (answered && typeof answered.then === 'function') answered.then(settle, fail)
      } catch (error) {
        fail(error)
        return
      }
      setTimeout(() => settle([]), ANSWER_TIMEOUT_MS)
    })

  /**
   * `tabs.getCurrent`, which this runtime does not have at all.
   *
   * Chromium answers `undefined` for a document that is not a tab   a popup, a
   * panel, a background page   and callers are written for that answer, because it
   * is the one a popup gets in Chrome too.
   */
  const getCurrent = (callback?: (tab: unknown) => void): Promise<undefined> | undefined => {
    if (typeof callback === 'function') {
      queueMicrotask(() => callback(undefined))
      return undefined
    }
    return Promise.resolve(undefined)
  }

  /** Define one member, however the runtime made the namespace's properties. */
  const define = (target: Record<string, unknown>, key: string, value: unknown) => {
    try {
      Object.defineProperty(target, key, { value, configurable: true, writable: true })
      return
    } catch {
      try {
        target[key] = value
      } catch {
        // A namespace that accepts neither: nothing this file can do about it, and
        // the extension keeps the answer the runtime gives.
      }
    }
  }

  /** The tab events this file owns, so the app can fire the facts it observed. */
  const TAB_EVENT_NAMES: (keyof TabsApi)[] = [
    'onCreated',
    'onUpdated',
    'onRemoved',
    'onActivated',
    'onHighlighted'
  ]

  /**
   * Install the tab events once per document, and remember them for the app.
   *
   * Once, not on every push: a second install would replace the event object and
   * drop the listeners the extension had already registered on it. The preload is
   * what runs this before the extension's own bundle, so a page that has it needs
   * nothing more than the push that rewrites the snapshot.
   */
  const installTabEvents = (tabsApi: TabsApi) => {
    for (const name of TAB_EVENT_NAMES) {
      const existing = tabEventEmitters[name]
      if (existing) {
        if (tabsApi[name] !== existing) define(tabsApi, name, existing)
        continue
      }
      const emitter = makeTabEvent()
      tabEventEmitters[name] = emitter
      define(tabsApi, name, emitter)
    }
  }

  surface.__cioPageTabsEmit = (name, args) => {
    const emitter = tabEventEmitters[name]
    if (emitter && typeof emitter.__cioEmit === 'function') emitter.__cioEmit(args)
  }

  // ── Opening a tab, which this runtime cannot do from a page ─────────────────

  /** How long a page waits for the app to say it opened the tab. */
  const OPEN_TAB_TIMEOUT_MS = 3000

  /** The asks still waiting for the app's answer, keyed by their request number. */
  const openRequests = new Map<number, OpenRequest>()
  let openRequestSequence = 0

  /**
   * Whether an address is a web page a tab can be opened on.
   *
   * The app validates it again before anything loads, and it is the same rule a
   * link click is held to. An extension asking for one of its own pages is not a
   * tab of the browser, so it is not this channel's to open.
   */
  const isWebAddress = (url: string) => {
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
      return parsed.username === '' && parsed.password === ''
    } catch {
      return false
    }
  }

  /**
   * The page as `chrome.tabs.create` answers with the tab it just opened.
   *
   * The app opens the page in the strip it owns, so the index, the window and the
   * status are this browser's constants, and the address is the one the extension
   * asked for   it already knows it, which is why Chromium reports it here too.
   */
  const openedTabEntry = (id: number, url: string, active: boolean): TabEntry => ({
    id,
    index: 0,
    windowId: 0,
    active,
    highlighted: active,
    pinned: false,
    incognito: false,
    audible: false,
    mutedInfo: { muted: false, reason: 'user' },
    discarded: false,
    autoDiscardable: false,
    groupId: -1,
    status: 'loading',
    url,
    title: ''
  })

  // The app's answer to each ask arrives on the same channel the page asks on,
  // labelled so the wrappers here can tell it from a request of their own.
  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    const data = (event ? event.data : null) as OpenedTabMessage | null
    if (!data || typeof data !== 'object') return
    const answer = data.__cioPageOpenedTab
    if (!answer || typeof answer !== 'object') return
    const request = openRequests.get(answer.requestId)
    if (!request) return
    openRequests.delete(answer.requestId)
    clearTimeout(request.timer)
    request.resolve(typeof answer.tabId === 'number' ? answer.tabId : null)
  })

  /**
   * `chrome.tabs.create`, answered by the app that owns the tabs.
   *
   * A request the page cannot complete still settles: an address that is not a web
   * page, or an app that never answers, resolves with no tab instead of a promise
   * that hangs, because a button that waits forever is worse than one that failed.
   */
  const createTab = (
    createProperties: unknown,
    callback?: (tab: unknown) => void
  ): Promise<TabEntry | undefined> | undefined => {
    const properties = (
      createProperties && typeof createProperties === 'object' ? createProperties : {}
    ) as TabCreateProperties
    const requested = Array.isArray(properties.url) ? properties.url[0] : properties.url
    const url = typeof requested === 'string' ? requested : ''
    const active = typeof properties.active === 'boolean' ? properties.active : true
    const opened = new Promise<number | null>((resolve) => {
      if (!url || !isWebAddress(url)) {
        resolve(null)
        return
      }
      const requestId = ++openRequestSequence
      const timer = setTimeout(() => {
        openRequests.delete(requestId)
        resolve(null)
      }, OPEN_TAB_TIMEOUT_MS)
      openRequests.set(requestId, { resolve, timer })
      try {
        window.postMessage({ __cioPageCommand: 'open-tab', requestId, url, active }, '*')
      } catch {
        openRequests.delete(requestId)
        clearTimeout(timer)
        resolve(null)
      }
    }).then((tabId) => (tabId === null ? undefined : openedTabEntry(tabId, url, active)))
    if (typeof callback === 'function') {
      opened.then(
        (tab) => callback(tab),
        () => callback(undefined)
      )
      return undefined
    }
    return opened
  }

  // Both roots, because they are two objects with the same namespaces in this
  // runtime and an extension may reach for either. They are deduplicated: a page
  // where `browser` is `chrome` is one namespace, not two.
  const roots: ChromeRoot[] = []
  for (const root of [surface.chrome, surface.browser]) {
    if (!root || roots.indexOf(root) !== -1) continue
    roots.push(root)
  }

  for (const root of roots) {
    const tabsApi = root.tabs
    if (!tabsApi) continue
    installTabEvents(tabsApi)
    const original = typeof tabsApi.query === 'function' ? tabsApi.query : null
    // One marker on the wrapper itself, so a push into a page that already has them
    // rewrites the snapshot and installs nothing a second time.
    if (original && original.__cioPageTabs !== true) {
      const wrapped: TabsQuery = function (queryInfo: unknown, callback?: (tabs: unknown) => void) {
        const asked = askOriginal(original, queryInfo)
        if (typeof callback === 'function') {
          asked.then(
            (tabs) => callback(answer(tabs, queryInfo)),
            // A refused query reaches a callback caller as an empty list: this
            // runtime sets `runtime.lastError` for the extension's own callback
            // invocation, and a page cannot set it for a callback it calls itself.
            () => callback([])
          )
          return undefined
        }
        return asked.then((tabs) => answer(tabs, queryInfo))
      }
      wrapped.__cioPageTabs = true
      define(tabsApi, 'query', wrapped)
    }
    if (typeof tabsApi.getCurrent !== 'function') define(tabsApi, 'getCurrent', getCurrent)
    // Replaced rather than ensured, and on both roots: the runtime either omits
    // this member or answers it with a stub, and a launch button bound to a call
    // that opens nothing is indistinguishable from a broken one.
    const installedCreate = typeof tabsApi.create === 'function' ? tabsApi.create : null
    if (!installedCreate || installedCreate.__cioPageTabs !== true) {
      const wrappedCreate: TabsCreate = function (
        createProperties: unknown,
        callback?: (tab: unknown) => void
      ) {
        return createTab(createProperties, callback)
      }
      wrappedCreate.__cioPageTabs = true
      define(tabsApi, 'create', wrappedCreate)
    }
  }
})()
