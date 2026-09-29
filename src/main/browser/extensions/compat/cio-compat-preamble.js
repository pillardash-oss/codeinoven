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
  const state = globalThis.__cioCompat || (globalThis.__cioCompat = { installed: [], namespaces: [], errors: [] })
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
      namespaces: browserObject && typeof browserObject === 'object' ? Object.keys(browserObject).sort() : [],
      hasPermissions: browserObject && typeof browserObject === 'object' ? typeof browserObject.permissions : 'no-browser',
      webRequestMemberCount:
        browserObject && browserObject.webRequest ? Object.keys(browserObject.webRequest).length : null
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
    if (candidate && typeof candidate === 'object' && !roots.includes(candidate)) roots.push(candidate)
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
  ensureNamespace('contextMenus', { create: noop, update: noop, remove: noop, removeAll: () => resolved() }, [
    'onClicked',
    'onShown',
    'onHidden'
  ])
  ensureNamespace(
    'webNavigation',
    { getFrame: noop, getAllFrames: noop },
    [
      'onBeforeNavigate',
      'onCommitted',
      'onDOMContentLoaded',
      'onCompleted',
      'onHistoryStateUpdated',
      'onReferenceFragmentUpdated',
      'onCreatedNavigationTarget',
      'onErrorOccurred',
      'onTabReplaced'
    ]
  )
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
  ensureNamespace('permissions', { contains: () => resolved(false), request: () => resolved(false), remove: () => resolved(false), getAll: () => resolved({}) }, ['onAdded', 'onRemoved'])
  ensureNamespace('history', { search: () => resolved([]), getVisits: () => resolved([]), addUrl: noop, deleteUrl: noop, deleteRange: noop, deleteAll: noop }, ['onVisited', 'onVisitRemoved'])
  ensureNamespace('bookmarks', { search: () => resolved([]), get: noop, getTree: noop, getSubTree: noop, create: noop, remove: noop }, ['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onImportBegan', 'onImportEnded'])
  ensureNamespace('downloads', { download: noop, search: () => resolved([]), pause: noop, resume: noop, cancel: noop }, ['onCreated', 'onChanged', 'onErased', 'onDeterminingFilename'])
  ensureNamespace('identity', { getAuthToken: noop, getProfileUserInfo: () => resolved({}), launchWebAuthFlow: noop, getRedirectURL: (path) => String(path || '') }, ['onSignInChanged'])
  ensureNamespace('sidePanel', { setPanelBehavior: noop, setOptions: noop, getOptions: () => resolved({}), open: noop }, ['onOpened', 'onClosed'])
  ensureNamespace('browsingData', { remove: noop, removeCache: noop, removeCookies: noop, settings: () => resolved({}) }, [])
  ensureNamespace('sessions', { getRecentlyClosed: () => resolved([]), restore: noop }, ['onChanged'])
  ensureNamespace('topSites', { get: () => resolved([]) }, ['onUpdated'])
  ensureNamespace('search', { query: noop, get: () => resolved([]) }, [])
  ensureNamespace('fontSettings', { getFontList: () => resolved({}), getDefaultFontSize: () => resolved(16), setDefaultFontSize: noop, getFont: noop, setFont: noop }, ['onFontChanged'])
  ensureNamespace('tabGroups', { query: () => resolved([]), get: noop, update: noop, TAB_GROUP_ID_NONE: -1 }, ['onCreated', 'onUpdated', 'onRemoved', 'onMoved'])
  ensureNamespace('omnibox', { setDefaultSuggestion: noop }, ['onInputStarted', 'onInputChanged', 'onInputEntered', 'onInputCancelled'])
  ensureNamespace('declarativeContent', { onPageChanged: makeEvent(), PageStateMatcher: noop, ShowAction: noop, RequestContentScript: noop }, [])

  // ── Members Electron leaves out of namespaces it does implement ──────────────
  // The popup of an extension asks for the tab it should act on, and the ad
  // blockers open their own pages. Neither exists in this runtime, and a missing
  // method throws where a missing event namespace merely does nothing.
  ensureNamespace('tabs', { create: noop, update: noop, remove: noop, getCurrent: noop, discard: noop, reload: noop }, [
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
  ])
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
  ensureNamespace('runtime', {}, ['onInstalled', 'onStartup', 'onSuspend', 'onMessage', 'onMessageExternal', 'onConnect', 'onConnectExternal'])
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
      const manifest = chromeApi.runtime && chromeApi.runtime.getManifest ? chromeApi.runtime.getManifest() : {}
      // Only the rulesets the manifest declares as enabled by default. Enabling
      // every declared ruleset would hand the user fifty filter lists they opted
      // out of, which is worse than the defect being worked around.
      const declared = (((manifest.declarative_net_request || {}).rule_resources) || []).filter(
        (resource) => resource.enabled === true
      )
      const shouldEnable = declared.map((resource) => resource.id)
      rulesApi
        .getEnabledRulesets()
        .then((enabled) => {
          const missing = shouldEnable.filter((id) => !enabled.includes(id))
          if (!missing.length) {
            state.rulesets = { shouldEnable, enabledBefore: enabled, enabledAfter: enabled, changed: false }
            return
          }
          return rulesApi.updateEnabledRulesets({ enableRulesetIds: missing }).then(() =>
            rulesApi.getEnabledRulesets().then((after) => {
              state.rulesets = { shouldEnable, enabledBefore: enabled, enabledAfter: after, changed: true }
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

  state.preambleAt = Date.now()

  // The app has no window into a worker's globals, so the preamble publishes what
  // it did into the extension's own storage, where any extension page can read it
  // back as `chrome.storage.local.get('__cioCompatReport')`.
  const publish = () => {
    try {
      const storage = chromeApi.storage && chromeApi.storage.local
      if (storage && storage.set) storage.set({ __cioCompatReport: JSON.parse(JSON.stringify(state)) })
    } catch (error) {
      state.errors.push('publish: ' + String(error))
    }
  }
  setTimeout(publish, 1500)
  setTimeout(publish, 4000)
})();
