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
 */

;(() => {
  /** Where main leaves the tab this page acts on, read fresh on every call. */
  const SNAPSHOT_KEY = '__cioPageTabsSnapshot'

  const ownTab = () => {
    const snapshot = globalThis[SNAPSHOT_KEY]
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
  const isHostedExtensionSurface = (url) =>
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
  const escapeLiteral = (text) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')

  /** One `*`-wildcarded literal, as the body of an expression. */
  const wildcardBody = (text) => escapeLiteral(text).replace(/\*/g, '[^]*')

  const safeExpression = (source) => {
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
  const urlExpression = (pattern) => {
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
  const globExpression = (pattern) => {
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

  const matches = (expression, patterns, value) => {
    const list = Array.isArray(patterns) ? patterns : [patterns]
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
  const mayRead = (url) => {
    try {
      for (const root of roots) {
        const runtime = root && root.runtime
        if (!runtime || typeof runtime.getManifest !== 'function') continue
        const manifest = runtime.getManifest() || {}
        const declared = [].concat(manifest.permissions || [], manifest.host_permissions || [])
        if (declared.indexOf('tabs') !== -1) return true
        if (matches(urlExpression, declared, url)) return true
      }
      return false
    } catch {
      return false
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
  const tabEntry = (page) => {
    const active = page.active === true
    const entry = {
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
  const matchesQuery = (page, entry, queryInfo) => {
    const query = queryInfo && typeof queryInfo === 'object' ? queryInfo : {}
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
  const answer = (tabs, queryInfo) => {
    const listed = []
    for (const tab of tabs) {
      if (!tab || typeof tab !== 'object') continue
      if (isHostedExtensionSurface(tab.url)) continue
      listed.push(tab)
    }
    const page = ownTab()
    if (!page) return listed
    const entry = tabEntry(page)
    const others = listed.filter((tab) => tab.id !== entry.id)
    return matchesQuery(page, entry, queryInfo) ? [entry].concat(others) : others
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
  const askOriginal = (original, queryInfo) =>
    new Promise((resolve, reject) => {
      let settled = false
      const settle = (tabs) => {
        if (settled) return
        settled = true
        resolve(Array.isArray(tabs) ? tabs : [])
      }
      const fail = (error) => {
        if (settled) return
        settled = true
        reject(error instanceof Error ? error : new Error(String(error)))
      }
      let returned
      try {
        returned = original(queryInfo)
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
        const answered = original(queryInfo, settle)
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
  const getCurrent = (callback) => {
    if (typeof callback === 'function') {
      queueMicrotask(() => callback(undefined))
      return undefined
    }
    return Promise.resolve(undefined)
  }

  /** Define one member, however the runtime made the namespace's properties. */
  const define = (target, key, value) => {
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

  // Both roots, because they are two objects with the same namespaces in this
  // runtime and an extension may reach for either. They are deduplicated: a page
  // where `browser` is `chrome` is one namespace, not two.
  const roots = []
  for (const root of [globalThis.chrome, globalThis.browser]) {
    if (!root || roots.indexOf(root) !== -1) continue
    roots.push(root)
  }

  for (const root of roots) {
    const tabsApi = root.tabs
    if (!tabsApi) continue
    const original = typeof tabsApi.query === 'function' ? tabsApi.query : null
    // One marker on the wrapper itself, so a push into a page that already has them
    // rewrites the snapshot and installs nothing a second time.
    if (original && original.__cioPageTabs !== true) {
      const wrapped = function (queryInfo, callback) {
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
  }
})()
