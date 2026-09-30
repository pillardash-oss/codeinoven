/**
 * CIO compatibility preamble for a browser box extension.
 *
 * WHY THIS EXISTS
 * Electron compiles out a set of `chrome.*` namespaces even when the extension
 * declares the permission, and an MV3 service worker has no other injection point:
 * `ses.registerPreloadScript({ type: 'service-worker' })` does not reach an
 * extension's worker (measured, see `.cio/tmp/sw-preload-probe`). The only way to
 * reach the worker is the file it executes, so at install time the app unzips the
 * extension into its own store and prepends this file to the extension's declared
 * `background.service_worker` entry.
 *
 * RULES FOR THIS FILE
 *   1. It must never throw. A preamble that throws is worse than no preamble,
 *      because the extension's own code then never runs at all.
 *   2. It must never overwrite something that already exists. `ensure` is
 *      add-only.
 *   3. It records everything it did on `globalThis.__cioCompat`, so the app can
 *      read back what it had to fake and report it as capability loss rather than
 *      pretending the extension is whole.
 *   4. It must be valid both as a classic script and as an ES module body, because
 *      uBlock Origin Lite and 1Password declare `"background": { "service_worker":
 *      "...", "type": "module" }`. `import` declarations are hoisted, so a
 *      preamble in front of a module body is legal.
 */

;(() => {
  const state =
    globalThis.__cioCompat ||
    (globalThis.__cioCompat = { installed: [], namespaces: [], errors: [] })
  const chromeApi = globalThis.chrome

  if (!chromeApi) {
    state.errors.push('no chrome object in scope')
    return
  }

  // The runtime's real surface, captured from inside the worker before anything is
  // patched. This is the evidence the install-time capability report is built from,
  // because a worker's globals are otherwise unreachable from app main.
  try {
    const surface = {}
    for (const name of Object.keys(chromeApi)) {
      const value = chromeApi[name]
      if (value && typeof value === 'object') surface[name] = Object.keys(value).sort()
    }
    state.surface = surface
    state.userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : null
    const browserObject = globalThis.browser
    state.browserObject = {
      present: typeof browserObject !== 'undefined',
      sameObjectAsChrome: browserObject === chromeApi,
      namespaces:
        browserObject && typeof browserObject === 'object' ? Object.keys(browserObject).sort() : [],
      hasPermissions:
        browserObject && typeof browserObject === 'object'
          ? typeof browserObject.permissions
          : 'no-browser',
      webRequestMemberCount:
        browserObject && browserObject.webRequest
          ? Object.keys(browserObject.webRequest).length
          : null
    }
  } catch (error) {
    state.errors.push('surface: ' + String(error))
  }

  const noop = function () {}
  const makeEvent = () => ({
    addListener: noop,
    removeListener: noop,
    hasListener: () => false,
    hasListeners: () => false
  })

  const ensureMember = (target, key, value) => {
    if (!target) return
    try {
      if (key in target && target[key] !== undefined && target[key] !== null) return
      Object.defineProperty(target, key, { value, configurable: true, writable: true })
      state.installed.push(key)
    } catch (error) {
      state.errors.push(key + ': ' + String(error))
    }
  }

  /**
   * The runtime exposes `chrome` and a distinct `browser` object, and the two do
   * not carry the same surface. An extension that reaches for `browser.*` (uBlock
   * Origin Lite, AdGuard, 1Password all do) has to be patched on both roots, or it
   * throws on a namespace that exists on the other one.
   */
  const roots = []
  for (const candidate of [chromeApi, globalThis.browser]) {
    if (candidate && typeof candidate === 'object' && !roots.includes(candidate))
      roots.push(candidate)
  }
  state.roots = roots.length

  const ensureNamespaceOnRoot = (root, name, members, events) => {
    try {
      let namespace = root[name]
      const created = !namespace
      if (!namespace) namespace = {}
      for (const key of Object.keys(members || {})) ensureMember(namespace, key, members[key])
      for (const key of events || []) ensureMember(namespace, key, makeEvent())
      if (created) {
        Object.defineProperty(root, name, { value: namespace, configurable: true, writable: true })
        state.namespaces.push(name)
      }
    } catch (error) {
      state.errors.push(name + ': ' + String(error))
    }
  }

  /**
   * @param {string} name namespace name
   * @param {Record<string, unknown>} members methods and constants to guarantee
   * @param {string[]} events event members to guarantee
   */
  const ensureNamespace = (name, members, events) => {
    for (const root of roots) ensureNamespaceOnRoot(root, name, members, events)
  }

  const resolved = () => Promise.resolve(undefined)

  // ── Namespaces Electron does not compile in at all ───────────────────────────
  ensureNamespace(
    'contextMenus',
    { create: noop, update: noop, remove: noop, removeAll: () => resolved() },
    ['onClicked', 'onShown', 'onHidden']
  )
  ensureNamespace('webNavigation', { getFrame: noop, getAllFrames: noop }, [
    'onBeforeNavigate',
    'onCommitted',
    'onDOMContentLoaded',
    'onCompleted',
    'onHistoryStateUpdated',
    'onReferenceFragmentUpdated',
    'onCreatedNavigationTarget',
    'onErrorOccurred',
    'onTabReplaced'
  ])
  ensureNamespace(
    'windows',
    {
      get: noop,
      getCurrent: noop,
      getLastFocused: noop,
      getAll: () => resolved([]),
      create: noop,
      remove: noop,
      update: noop,
      WINDOW_ID_NONE: -1,
      WINDOW_ID_CURRENT: -2
    },
    ['onCreated', 'onRemoved', 'onFocusChanged', 'onBoundsChanged']
  )
  ensureNamespace('commands', { getAll: () => resolved([]), update: noop }, ['onCommand'])
  ensureNamespace(
    'notifications',
    {
      create: () => resolved('cio-notification'),
      update: () => resolved(true),
      clear: () => resolved(true),
      getAll: () => resolved({}),
      getPermissionLevel: () => resolved('granted')
    },
    ['onClicked', 'onClosed', 'onButtonClicked', 'onPermissionLevelChanged']
  )
  ensureNamespace(
    'permissions',
    {
      contains: () => resolved(false),
      request: () => resolved(false),
      remove: () => resolved(false),
      getAll: () => resolved({})
    },
    ['onAdded', 'onRemoved']
  )
  ensureNamespace(
    'history',
    {
      search: () => resolved([]),
      getVisits: () => resolved([]),
      addUrl: noop,
      deleteUrl: noop,
      deleteRange: noop,
      deleteAll: noop
    },
    ['onVisited', 'onVisitRemoved']
  )
  ensureNamespace(
    'bookmarks',
    {
      search: () => resolved([]),
      get: noop,
      getTree: noop,
      getSubTree: noop,
      create: noop,
      remove: noop
    },
    ['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onImportBegan', 'onImportEnded']
  )
  ensureNamespace(
    'downloads',
    { download: noop, search: () => resolved([]), pause: noop, resume: noop, cancel: noop },
    ['onCreated', 'onChanged', 'onErased', 'onDeterminingFilename']
  )
  ensureNamespace(
    'identity',
    {
      getAuthToken: noop,
      getProfileUserInfo: () => resolved({}),
      launchWebAuthFlow: noop,
      getRedirectURL: (path) => String(path || '')
    },
    ['onSignInChanged']
  )
  ensureNamespace(
    'sidePanel',
    { setPanelBehavior: noop, setOptions: noop, getOptions: () => resolved({}), open: noop },
    ['onOpened', 'onClosed']
  )
  ensureNamespace(
    'browsingData',
    { remove: noop, removeCache: noop, removeCookies: noop, settings: () => resolved({}) },
    []
  )
  ensureNamespace('sessions', { getRecentlyClosed: () => resolved([]), restore: noop }, [
    'onChanged'
  ])
  ensureNamespace('topSites', { get: () => resolved([]) }, ['onUpdated'])
  ensureNamespace('search', { query: noop, get: () => resolved([]) }, [])
  ensureNamespace(
    'fontSettings',
    {
      getFontList: () => resolved({}),
      getDefaultFontSize: () => resolved(16),
      setDefaultFontSize: noop,
      getFont: noop,
      setFont: noop
    },
    ['onFontChanged']
  )
  ensureNamespace(
    'tabGroups',
    { query: () => resolved([]), get: noop, update: noop, TAB_GROUP_ID_NONE: -1 },
    ['onCreated', 'onUpdated', 'onRemoved', 'onMoved']
  )
  ensureNamespace('omnibox', { setDefaultSuggestion: noop }, [
    'onInputStarted',
    'onInputChanged',
    'onInputEntered',
    'onInputCancelled'
  ])
  ensureNamespace(
    'declarativeContent',
    {
      onPageChanged: makeEvent(),
      PageStateMatcher: noop,
      ShowAction: noop,
      RequestContentScript: noop
    },
    []
  )

  // ── Members Electron leaves out of namespaces it does implement ──────────────
  // The popup of an extension asks for the tab it should act on, and the ad
  // blockers open their own pages. Neither exists in this runtime, and a missing
  // method throws where a missing event namespace merely does nothing.
  ensureNamespace(
    'tabs',
    { create: noop, update: noop, remove: noop, getCurrent: noop, discard: noop, reload: noop },
    [
      'onCreated',
      'onUpdated',
      'onRemoved',
      'onActivated',
      'onHighlighted',
      'onDetached',
      'onAttached',
      'onMoved',
      'onReplaced',
      'onZoomChange'
    ]
  )
  ensureNamespace('scripting', {}, [])
  ensureNamespace('action', {}, ['onClicked', 'onUserSettingsChanged'])
  ensureNamespace('alarms', {}, ['onAlarm'])
  ensureNamespace('idle', {}, ['onStateChanged'])
  ensureNamespace('management', {}, ['onInstalled', 'onUninstalled', 'onEnabled', 'onDisabled'])
  // AdGuard's engine refused to start on a missing webRequest.onErrorOccurred: the
  // namespace exists but not every event does, and a missing member of a present
  // namespace throws where a missing namespace merely does nothing.
  ensureNamespace('webRequest', { handlerBehaviorChanged: noop }, [
    'onBeforeRequest',
    'onBeforeSendHeaders',
    'onSendHeaders',
    'onHeadersReceived',
    'onBeforeRedirect',
    'onResponseStarted',
    'onCompleted',
    'onErrorOccurred',
    'onAuthRequired'
  ])
  ensureNamespace('storage', {}, ['onChanged'])
  ensureNamespace('runtime', {}, [
    'onInstalled',
    'onStartup',
    'onSuspend',
    'onMessage',
    'onMessageExternal',
    'onConnect',
    'onConnectExternal'
  ])
  ensureNamespace('declarativeNetRequest', {}, [
    'onRuleMatchedDebug',
    'onRuleMatchedDebug2',
    'onRuleMatchedDebug3',
    'onRuleMatchedDebug4'
  ])

  // ── The ruleset defect ──────────────────────────────────────────────────────
  // Electron ignores `declarative_net_request.rule_resources[].enabled`, so an
  // ad blocker that ships its lists enabled loads with none of them on. Only the
  // extension itself may enable them, which is why this runs here and not in main.
  const rulesApi = chromeApi.declarativeNetRequest
  if (rulesApi && rulesApi.getEnabledRulesets && rulesApi.updateEnabledRulesets) {
    try {
      const manifest =
        chromeApi.runtime && chromeApi.runtime.getManifest ? chromeApi.runtime.getManifest() : {}
      // Only the rulesets the manifest declares as enabled by default. Enabling
      // every declared ruleset would hand the user fifty filter lists they opted
      // out of, which is worse than the defect being worked around.
      const declared = ((manifest.declarative_net_request || {}).rule_resources || []).filter(
        (resource) => resource.enabled === true
      )
      const shouldEnable = declared.map((resource) => resource.id)
      rulesApi
        .getEnabledRulesets()
        .then((enabled) => {
          const missing = shouldEnable.filter((id) => !enabled.includes(id))
          if (!missing.length) {
            state.rulesets = {
              shouldEnable,
              enabledBefore: enabled,
              enabledAfter: enabled,
              changed: false
            }
            return
          }
          return rulesApi.updateEnabledRulesets({ enableRulesetIds: missing }).then(() =>
            rulesApi.getEnabledRulesets().then((after) => {
              state.rulesets = {
                shouldEnable,
                enabledBefore: enabled,
                enabledAfter: after,
                changed: true
              }
            })
          )
        })
        .catch((error) => {
          state.errors.push('rulesets: ' + String(error))
        })
    } catch (error) {
      state.errors.push('rulesets: ' + String(error))
    }
  }

  // ── runtime.getContexts repair ──────────────────────────────────────────────
  // Electron never calls `extensions::SetViewType` anywhere in its shell
  // (measured on v44.4.5: zero call sites), so every WebContents it hosts reports
  // `mojom::ViewType::kInvalid` (0). Chromium's
  // `RuntimeGetContextsFunction::GetFrameContexts` treats that value as a bug
  // ("NOTREACHED hit. Unexpected view type found: 0"), skips the frame and answers
  // `[]`, which means an extension polling this API never sees the popup this app
  // hosts for it, and the app's log fills with that line on every poll. Bitwarden
  // polls it for `isPopupOpen` and `isAnyViewFocused`.
  //
  // The worker can see what the browser process will not report: Electron's own
  // tabs implementation enumerates every WebContents of the session, and a
  // long-lived port carries its sender's real document URL and ids. Both are
  // folded into an answer shaped like the API's, and the filter argument is
  // honoured the way Chromium honours it.
  try {
    const runtime = chromeApi.runtime
    if (
      runtime &&
      typeof runtime.getContexts === 'function' &&
      typeof runtime.getURL === 'function'
    ) {
      const origin = runtime.getURL('')
      const ownManifest =
        typeof runtime.getManifest === 'function' ? runtime.getManifest() || {} : {}
      const declaredPopup = (ownManifest.action || ownManifest.browser_action || {}).default_popup
      const popupHref =
        typeof declaredPopup === 'string' && declaredPopup
          ? new URL(declaredPopup, origin).href
          : null
      const isOwnPage = (url) => typeof url === 'string' && url.startsWith(origin)
      const withoutFragment = (url) => String(url || '').split('#')[0]

      // Ports first: they carry real document and frame ids, and unlike the tab
      // URL they need no permission to read.
      const connectedViews = new Map()
      try {
        const onConnect = runtime.onConnect
        if (onConnect && typeof onConnect.addListener === 'function') {
          onConnect.addListener((port) => {
            try {
              const sender = port && port.sender ? port.sender : {}
              const url = withoutFragment(sender.url)
              if (!isOwnPage(url)) return
              connectedViews.set(url, {
                documentId: typeof sender.documentId === 'string' ? sender.documentId : null,
                frameId: typeof sender.frameId === 'number' ? sender.frameId : 0,
                tabId: sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : -1
              })
              if (
                port &&
                port.onDisconnect &&
                typeof port.onDisconnect.addListener === 'function'
              ) {
                port.onDisconnect.addListener(() => connectedViews.delete(url))
              }
            } catch (error) {
              state.errors.push('contexts-port: ' + String(error))
            }
          })
        }
      } catch (error) {
        state.errors.push('contexts-onConnect: ' + String(error))
      }

      // A hosted popup loads the declared popup address itself; a popout is the
      // same document reached through an address that carries its own parameters.
      // Comparing the whole address keeps the two apart, which is what the
      // extension's own TAB-versus-POPUP checks depend on.
      const contextTypeOf = (url) => {
        if (!isOwnPage(url)) return null
        return popupHref && url === popupHref ? 'POPUP' : 'TAB'
      }

      const contextOf = (url, ids) => {
        const contextType = contextTypeOf(url)
        if (!contextType) return null
        return {
          contextType,
          // Chromium answers with document UUIDs and a context UUID. Nothing in
          // this runtime hands those out for a hosted view, so the address is
          // used as a stable stand-in rather than a fresh random value per call.
          contextId: ids.documentId || url,
          documentId: ids.documentId || url,
          documentUrl: url,
          documentOrigin: origin,
          frameId: ids.frameId,
          tabId: ids.tabId,
          windowId: -1,
          incognito: false
        }
      }

      // Callback form, because it is the one shape that works whether or not the
      // runtime also returns a promise. A tab list that never arrives must not
      // leave the extension's `await` hanging, so it is time-boxed.
      const queryTabs = () =>
        new Promise((resolve) => {
          const tabsApi = chromeApi.tabs
          let settled = false
          const settle = (tabs) => {
            if (settled) return
            settled = true
            resolve(Array.isArray(tabs) ? tabs : [])
          }
          if (!tabsApi || typeof tabsApi.query !== 'function') {
            settle([])
            return
          }
          try {
            const returned = tabsApi.query({}, settle)
            if (returned && typeof returned.then === 'function')
              returned.then(settle, () => settle([]))
          } catch (error) {
            state.errors.push('contexts-tabs: ' + String(error))
            settle([])
          }
          setTimeout(() => settle([]), 2000)
        })

      const matchesFilter = (context, filter) => {
        const wanted = filter || {}
        const admits = (value, list) =>
          !Array.isArray(list) || list.length === 0 || list.includes(value)
        if (!admits(context.contextType, wanted.contextTypes)) return false
        if (!admits(context.contextId, wanted.contextIds)) return false
        if (!admits(context.tabId, wanted.tabIds)) return false
        if (!admits(context.windowId, wanted.windowIds)) return false
        if (!admits(context.documentId, wanted.documentIds)) return false
        if (!admits(context.frameId, wanted.frameIds)) return false
        if (!admits(context.documentUrl, wanted.documentUrls)) return false
        if (!admits(context.documentOrigin, wanted.documentOrigins)) return false
        if (typeof wanted.incognito === 'boolean' && wanted.incognito !== context.incognito)
          return false
        return true
      }

      const repaired = (filter) =>
        queryTabs()
          .then((tabs) => {
            const contexts = [
              {
                contextType: 'BACKGROUND',
                contextId: 'cio-background',
                documentId: 'cio-background',
                frameId: 0,
                tabId: -1,
                windowId: -1,
                incognito: false
              }
            ]
            const claimed = new Set()
            for (const entry of connectedViews) {
              const context = contextOf(entry[0], entry[1])
              if (!context) continue
              contexts.push(context)
              claimed.add(entry[0])
            }
            for (const tab of tabs) {
              const url = withoutFragment(tab && tab.url)
              if (!url || claimed.has(url)) continue
              const context = contextOf(url, {
                documentId: null,
                frameId: 0,
                tabId: typeof tab.id === 'number' ? tab.id : -1
              })
              if (context) contexts.push(context)
            }
            state.runtimeContexts = {
              answered: true,
              popupHref,
              count: contexts.length,
              types: contexts.map((context) => context.contextType)
            }
            return filter ? contexts.filter((context) => matchesFilter(context, filter)) : contexts
          })
          .catch((error) => {
            state.errors.push('contexts-answer: ' + String(error))
            return []
          })

      let repairedOn = 0
      for (const root of roots) {
        const target = root && root.runtime
        if (!target || typeof target.getContexts !== 'function') continue
        try {
          Object.defineProperty(target, 'getContexts', {
            value: repaired,
            configurable: true,
            writable: true
          })
          repairedOn += 1
        } catch (error) {
          state.errors.push('contexts-define: ' + String(error))
        }
      }
      state.getContextsRepair = repairedOn > 0 ? 'installed' : 'not-installed'
    }
  } catch (error) {
    state.errors.push('contexts: ' + String(error))
  }

  state.preambleAt = Date.now()

  // The app has no window into a worker's globals, so the preamble publishes what
  // it did into the extension's own storage, where any extension page can read it
  // back as `chrome.storage.local.get('__cioCompatReport')`.
  const publish = () => {
    try {
      const storage = chromeApi.storage && chromeApi.storage.local
      if (storage && storage.set)
        storage.set({ __cioCompatReport: JSON.parse(JSON.stringify(state)) })
    } catch (error) {
      state.errors.push('publish: ' + String(error))
    }
  }
  setTimeout(publish, 1500)
  setTimeout(publish, 4000)
})()
// The line below is this block's own end marker. The app rewrites a stale preamble
// in an already installed copy by splitting the file at that marker, so it has to
// stay the last line here.
// ── CIO compatibility preamble ends here ─────────────────────────────────────
