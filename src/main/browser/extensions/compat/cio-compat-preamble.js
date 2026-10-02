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
   * Chrome's shimmed methods have to answer both ways: an extension may pass a
   * callback or await a promise, and the two are used interchangeably in the wild.
   * The callback is deferred a microtask rather than called in line, because a
   * listener that runs before the shimmed call returns sees a value the caller has
   * not been handed yet.
   */
  const answerWith = (callback, result) => {
    if (typeof callback === 'function') {
      try {
        Promise.resolve().then(() => callback(result))
      } catch (error) {
        state.errors.push('callback: ' + String(error))
      }
    }
    return Promise.resolve(result)
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

  /**
   * A placeholder answer for a namespace this runtime has no truth for: the API's
   * empty shape, handed back both ways. An extension may await it or pass a
   * callback, and the two are used interchangeably in the wild, so a place that
   * answers only one way hangs the other silently.
   */
  const answering =
    (value) =>
    (...args) =>
      answerWith(args[args.length - 1], value)

  // ── Namespaces Electron does not compile in at all ───────────────────────────
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
      getAll: answering([]),
      create: noop,
      remove: noop,
      update: noop,
      WINDOW_ID_NONE: -1,
      WINDOW_ID_CURRENT: -2
    },
    ['onCreated', 'onRemoved', 'onFocusChanged', 'onBoundsChanged']
  )
  ensureNamespace('commands', { getAll: answering([]), update: noop }, ['onCommand'])
  ensureNamespace(
    'notifications',
    {
      create: answering('cio-notification'),
      update: answering(true),
      clear: answering(true),
      getAll: answering({}),
      getPermissionLevel: answering('granted')
    },
    ['onClicked', 'onClosed', 'onButtonClicked', 'onPermissionLevelChanged']
  )
  ensureNamespace(
    'permissions',
    {
      contains: answering(false),
      request: answering(false),
      remove: answering(false),
      getAll: answering({})
    },
    ['onAdded', 'onRemoved']
  )
  ensureNamespace(
    'history',
    {
      search: answering([]),
      getVisits: answering([]),
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
      search: answering([]),
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
    { download: noop, search: answering([]), pause: noop, resume: noop, cancel: noop },
    ['onCreated', 'onChanged', 'onErased', 'onDeterminingFilename']
  )
  ensureNamespace(
    'identity',
    {
      getAuthToken: noop,
      getProfileUserInfo: answering({}),
      launchWebAuthFlow: noop,
      getRedirectURL: (path) => String(path || '')
    },
    ['onSignInChanged']
  )
  ensureNamespace(
    'sidePanel',
    { setPanelBehavior: noop, setOptions: noop, getOptions: answering({}), open: noop },
    ['onOpened', 'onClosed']
  )
  ensureNamespace(
    'browsingData',
    { remove: noop, removeCache: noop, removeCookies: noop, settings: answering({}) },
    []
  )
  ensureNamespace('sessions', { getRecentlyClosed: answering([]), restore: noop }, ['onChanged'])
  ensureNamespace('topSites', { get: answering([]) }, ['onUpdated'])
  ensureNamespace('search', { query: noop, get: answering([]) }, [])
  ensureNamespace(
    'fontSettings',
    {
      getFontList: answering({}),
      getDefaultFontSize: answering(16),
      setDefaultFontSize: noop,
      getFont: noop,
      setFont: noop
    },
    ['onFontChanged']
  )
  ensureNamespace(
    'tabGroups',
    { query: answering([]), get: noop, update: noop, TAB_GROUP_ID_NONE: -1 },
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

  // ── The app bridge: lifecycle in, state out ─────────────────────────────────
  // Electron delivers no tab lifecycle events to an extension (measured: zero
  // `tabs.on*` events across three navigations), and it has no API to read an
  // extension's action state back. The app supplies both through the bridge page
  // it writes into this copy beside the preamble: main drives that page with
  // `executeJavaScript`, the page `runtime.sendMessage`s into this worker, and
  // everything this worker wants the app to know is written to one storage key
  // the page reads back on demand. See `browser-extension-bridge.ts`.
  const BRIDGE_PAGE_MARKER = '/cio-bridge.html'

  const makeRealEvent = () => {
    const listeners = []
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
      __cioCount: () => listeners.length,
      __cioEmit: (args) => {
        for (const listener of listeners.slice()) {
          try {
            listener(...args)
          } catch (error) {
            state.errors.push('event: ' + String(error))
          }
        }
      }
    }
  }

  // Tab events are replaced rather than ensured: the runtime has the events but
  // never fires one, so a listener registered on the native event waits forever.
  // One dispatcher per event, shared by both roots, so a listener is called
  // whichever root the extension registered it on.
  const tabEvents = {}
  for (const name of ['onCreated', 'onUpdated', 'onRemoved', 'onActivated', 'onHighlighted']) {
    const dispatcher = makeRealEvent()
    tabEvents[name] = dispatcher
    for (const root of roots) {
      const tabsApi = root && root.tabs
      if (!tabsApi) continue
      try {
        Object.defineProperty(tabsApi, name, {
          value: dispatcher,
          configurable: true,
          writable: true
        })
      } catch (error) {
        state.errors.push(name + ': ' + String(error))
      }
    }
  }

  // The same for the two runtime events the app synthesizes.
  const runtimeEvents = {}
  for (const name of ['onStartup', 'onInstalled']) {
    const dispatcher = makeRealEvent()
    runtimeEvents[name] = dispatcher
    for (const root of roots) {
      const runtimeApi = root && root.runtime
      if (!runtimeApi) continue
      try {
        Object.defineProperty(runtimeApi, name, {
          value: dispatcher,
          configurable: true,
          writable: true
        })
      } catch (error) {
        state.errors.push(name + ': ' + String(error))
      }
    }
  }

  // The same treatment for navigation, and for the same reason: `chrome.webNavigation`
  // is compiled out entirely, so its nine events were no-op stubs that a listener
  // registered on and waited on forever. These dispatchers are what the app pushes
  // the lifecycle it already watches into.
  //
  // Main frame only. The app observes the main frame's own `did-*` events, so a
  // listener filtered to a subframe would never be called; saying so here is better
  // than quietly dropping those events, and the capability report carries the same
  // limit.
  const webNavigationEvents = {}
  for (const name of [
    'onBeforeNavigate',
    'onCommitted',
    'onDOMContentLoaded',
    'onCompleted',
    'onErrorOccurred',
    'onHistoryStateUpdated',
    'onReferenceFragmentUpdated'
  ]) {
    const dispatcher = makeRealEvent()
    webNavigationEvents[name] = dispatcher
    for (const root of roots) {
      const navigationApi = root && root.webNavigation
      if (!navigationApi) continue
      try {
        // Enumerable, like the runtime's own events: an extension that discovers
        // what it can listen to by iterating must see these.
        Object.defineProperty(navigationApi, name, {
          value: dispatcher,
          configurable: true,
          writable: true,
          enumerable: true
        })
      } catch (error) {
        state.errors.push('webNavigation.' + name + ': ' + String(error))
      }
    }
  }
  state.webNavigation = { events: Object.keys(webNavigationEvents), mainFrameOnly: true }

  // ── privacy, for real ───────────────────────────────────────────────────────
  // `chrome.privacy` is read while an extension's module graph evaluates, not on
  // demand: uBlock Origin classic touches `networkPredictionEnabled` and
  // `hyperlinkAuditingEnabled` as its own modules run, and Electron compiles the
  // whole namespace out, so there was nothing there to read and the extension died
  // before it could filter anything (measured, see `.cio/work/browser-containers/plan.md`).
  //
  // What this can honestly be is a reader. The app does not gate network
  // prediction, hyperlink auditing or WebRTC policy on an extension's say-so, so
  // these settings report `not_controllable` rather than claim a control nobody
  // wired up, and every `set` or `clear` is counted in `state.privacy.inertCalls`
  // so the install-time capability report can say the setting was read-only instead
  // of reporting the namespace as present and whole. `set` still resolves rather
  // than rejects: an extension that tries is better off carrying on with a setting
  // that does nothing than being thrown out of its own startup path.
  //
  // Values are Chromium's own defaults for a profile with no policy, which is what
  // an extension expects to read in a browser nobody has configured.
  const privacyDefaults = {
    network: {
      networkPredictionEnabled: true,
      webRTCIPHandlingPolicy: 'default_public_interface_only'
    },
    services: {
      alternateErrorPagesEnabled: true,
      autofillAddressEnabled: true,
      autofillCreditCardEnabled: true,
      passwordSavingEnabled: true,
      safeBrowsingEnabled: true,
      searchSuggestEnabled: true,
      spellingServiceEnabled: true,
      translationServiceEnabled: true
    },
    websites: {
      thirdPartyCookiesAllowed: true,
      referrersEnabled: true,
      hyperlinkAuditingEnabled: true,
      protectedContentEnabled: true
    }
  }
  const makePrivacySetting = (initial) => {
    const onChange = makeRealEvent()
    let value = initial
    const read = () => ({
      value,
      // Not a claim about the value, a claim about who can change it. The app
      // does not act on any of these, so saying otherwise would be a lie an
      // extension could plan around.
      levelOfControl: 'not_controllable',
      incognitoSpecific: false
    })
    const note = (call) => {
      state.privacy.inertCalls += 1
      state.privacy.lastCall = call
    }
    // Chrome's dual callback/promise surface, shared with the other shims.
    const answer = answerWith
    return {
      get: (details, callback) => {
        try {
          return answer(callback, read())
        } catch (error) {
          state.errors.push('privacy-get: ' + String(error))
          return Promise.resolve(read())
        }
      },
      set: (details, callback) => {
        try {
          const next = details && 'value' in details ? details.value : undefined
          // The value is kept in this life so a read after a write does not
          // contradict what the extension was just told, even though the app is
          // not acting on it.
          if (next !== undefined && next !== value) {
            value = next
            onChange.__cioEmit([{ value }])
          }
          note('set')
          return answer(callback)
        } catch (error) {
          state.errors.push('privacy-set: ' + String(error))
          return Promise.resolve()
        }
      },
      clear: (details, callback) => {
        try {
          // Back to the default this shim started from, which is what clearing a
          // setting means when nobody else has set it.
          value = initial
          note('clear')
          return answer(callback)
        } catch (error) {
          state.errors.push('privacy-clear: ' + String(error))
          return Promise.resolve()
        }
      },
      onChange
    }
  }
  // One instance per setting, shared by both roots, for the same reason the tab
  // dispatchers are shared: an extension that registered on `browser.privacy` and
  // reads `chrome.privacy` must be looking at one setting, not two.
  state.privacy = { settings: [], inertCalls: 0, areas: [] }
  const privacyAreas = {}
  for (const areaName of Object.keys(privacyDefaults)) {
    const area = {}
    for (const settingName of Object.keys(privacyDefaults[areaName])) {
      // Enumerable, because Chromium's own API objects are: an extension that
      // discovers capability by iterating sees nothing of a non-enumerable one.
      Object.defineProperty(area, settingName, {
        value: makePrivacySetting(privacyDefaults[areaName][settingName]),
        configurable: true,
        writable: true,
        enumerable: true
      })
      state.privacy.settings.push(areaName + '.' + settingName)
    }
    Object.defineProperty(privacyAreas, areaName, {
      value: area,
      configurable: true,
      writable: true,
      enumerable: true
    })
    state.privacy.areas.push(areaName)
  }
  for (const root of roots) {
    try {
      if (!root) continue
      const existing = root.privacy
      if (existing && typeof existing === 'object') {
        // Add-only, so a runtime that ever compiles part of this in is not
        // overwritten. Nothing here is enumerable-breaking: a setting that is
        // already there is left exactly as the runtime made it.
        for (const areaName of Object.keys(privacyAreas)) {
          if (!existing[areaName] || typeof existing[areaName] !== 'object') {
            Object.defineProperty(existing, areaName, {
              value: privacyAreas[areaName],
              configurable: true,
              writable: true,
              enumerable: true
            })
          }
        }
        continue
      }
      Object.defineProperty(root, 'privacy', {
        value: privacyAreas,
        configurable: true,
        writable: true,
        enumerable: true
      })
    } catch (error) {
      state.errors.push('privacy: ' + String(error))
    }
  }

  // ── notifications, for real ────────────────────────────────────────────────
  // The namespace is compiled out, so the stubs above made `create` return a
  // plausible id and raise nothing: an extension that reports a problem to the user
  // was talking to itself. The app can do better than that, because it owns the
  // desktop. A request is queued here, main reads it out of the mailbox and raises
  // it through the app's own notifier, and a click comes back over the bridge as a
  // real `onClicked`, which is the half an extension actually needs.
  //
  // The ids stay the extension's own, because an extension that stores the id it
  // was handed and clears it later must be able to. Main namespaces them per
  // extension on its side instead of rewriting them here.
  const notificationQueue = []
  let notificationSeq = 0
  let notificationAutoId = 0
  const notificationBox = new Map()
  const notificationClicked = makeRealEvent()
  const notificationClosed = makeRealEvent()
  const notificationButtonClicked = makeRealEvent()
  state.notifications = { queued: 0, live: 0 }

  const queueNotification = (kind, id, options) => {
    notificationSeq += 1
    notificationQueue.push({
      seq: notificationSeq,
      id,
      kind,
      options: options && typeof options === 'object' ? options : undefined
    })
    // Only what the app has not seen yet matters, but a life that raises a
    // thousand toasts is not worth unbounded memory either.
    if (notificationQueue.length > 60) {
      notificationQueue.splice(0, notificationQueue.length - 60)
    }
    state.notifications.queued = notificationSeq
    state.notifications.live = notificationBox.size
    scheduleMailbox()
    return id
  }
  const resolveNotificationId = (id) => {
    if (typeof id === 'string' && id.length > 0) return id
    notificationAutoId += 1
    return 'cio-notification-' + String(notificationAutoId)
  }
  const notificationApi = {
    create: (idOrOptions, optionsOrCallback, maybeCallback) => {
      try {
        let id = null
        let options = null
        let callback = null
        if (typeof idOrOptions === 'string') {
          id = idOrOptions
          options = optionsOrCallback
          callback = maybeCallback
        } else {
          options = idOrOptions
          callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : null
        }
        const resolvedId = resolveNotificationId(id)
        notificationBox.set(resolvedId, options && typeof options === 'object' ? options : {})
        queueNotification('create', resolvedId, options)
        return answerWith(callback, resolvedId)
      } catch (error) {
        state.errors.push('notifications-create: ' + String(error))
        return Promise.resolve(null)
      }
    },
    update: (id, options, callback) => {
      try {
        const key = String(id === undefined || id === null ? '' : id)
        // Chromium answers whether an update landed, and an extension that clears
        // a stale id relies on the false rather than on an exception.
        if (!notificationBox.has(key)) return answerWith(callback, false)
        notificationBox.set(key, options && typeof options === 'object' ? options : {})
        queueNotification('update', key, options)
        return answerWith(callback, true)
      } catch (error) {
        state.errors.push('notifications-update: ' + String(error))
        return Promise.resolve(false)
      }
    },
    clear: (id, callback) => {
      try {
        const key = String(id === undefined || id === null ? '' : id)
        const existed = notificationBox.delete(key)
        queueNotification('clear', key, undefined)
        return answerWith(callback, existed)
      } catch (error) {
        state.errors.push('notifications-clear: ' + String(error))
        return Promise.resolve(false)
      }
    },
    getAll: (callback) => {
      try {
        const all = {}
        for (const [key, value] of notificationBox.entries()) {
          all[key] = JSON.parse(JSON.stringify(value))
        }
        return answerWith(callback, all)
      } catch (error) {
        state.errors.push('notifications-getAll: ' + String(error))
        return Promise.resolve({})
      }
    },
    // The app shows these itself, so an extension is entitled to a yes rather than
    // the prompt Chromium would show.
    getPermissionLevel: (callback) => answerWith(callback, 'granted')
  }
  const notificationEvents = {
    onClicked: notificationClicked,
    onClosed: notificationClosed,
    onButtonClicked: notificationButtonClicked,
    onPermissionLevelChanged: makeRealEvent(),
    onShowSettings: makeRealEvent()
  }
  // Replaced, not ensured: these members are the stubs this same file installed a
  // few hundred lines up, so overwriting them replaces a placeholder rather than
  // clobbering something the runtime provided. Enumerable, like Chromium's own.
  for (const root of roots) {
    const api = root && root.notifications
    if (!api) continue
    for (const key of Object.keys(notificationApi)) {
      try {
        Object.defineProperty(api, key, {
          value: notificationApi[key],
          configurable: true,
          writable: true,
          enumerable: true
        })
      } catch (error) {
        state.errors.push('notifications.' + key + ': ' + String(error))
      }
    }
    for (const key of Object.keys(notificationEvents)) {
      try {
        Object.defineProperty(api, key, {
          value: notificationEvents[key],
          configurable: true,
          writable: true,
          enumerable: true
        })
      } catch (error) {
        state.errors.push('notifications.' + key + ': ' + String(error))
      }
    }
  }
  state.notifications.shimmed = true

  // ── sidePanel, for real ─────────────────────────────────────────────────────
  // Electron compiles the namespace out, so `setOptions` and `open` were calls that
  // returned nothing and changed nothing: an extension that offers its UI in a side
  // panel simply had no UI. The app has a rail it can host one in, so the extension's
  // intent is carried to main here and main puts the panel in that rail.
  //
  // What travels is the extension's own `path`, unchanged. The panel is the
  // extension's HTML loaded from its own origin in its own jar, not markup the app
  // re-renders, so a panel that scripts itself works the way it does in a browser.
  const sidePanelRequests = []
  let sidePanelRequestSeq = 0
  let sidePanelBehavior = null
  const sidePanelOptionRecords = []
  const sidePanelOpened = makeRealEvent()
  const sidePanelClosed = makeRealEvent()
  state.sidePanel = { requests: 0, options: 0, behavior: null }

  const sidePanelScopeKey = (options) => {
    const tabId = options && typeof options === 'object' ? options.tabId : undefined
    // Chromium keeps a per-tab override and a default; the default is the record
    // with no tab id, which is what an extension that never passes one means.
    return typeof tabId === 'number' && tabId >= 0 ? String(tabId) : ''
  }
  const queueSidePanelRequest = (kind, options) => {
    sidePanelRequestSeq += 1
    sidePanelRequests.push({
      seq: sidePanelRequestSeq,
      kind,
      tabId:
        options && typeof options.tabId === 'number' && options.tabId >= 0
          ? options.tabId
          : undefined
    })
    if (sidePanelRequests.length > 20) {
      sidePanelRequests.splice(0, sidePanelRequests.length - 20)
    }
    state.sidePanel.requests = sidePanelRequestSeq
    scheduleMailbox()
  }
  const sidePanelDetails = (command) => ({
    tabId: command && typeof command.tabId === 'number' ? command.tabId : -1,
    windowId: -1,
    path:
      command && typeof command.path === 'string'
        ? command.path
        : sidePanelOptionRecords.find((record) => record.tabId === undefined)?.path || ''
  })
  const sidePanelApi = {
    setOptions: (options, callback) => {
      try {
        const scope = sidePanelScopeKey(options)
        const record = {
          tabId: scope === '' ? undefined : Number(scope),
          path: options && typeof options.path === 'string' ? options.path : undefined,
          enabled: options && typeof options.enabled === 'boolean' ? options.enabled : undefined
        }
        const index = sidePanelOptionRecords.findIndex(
          (entry) => (entry.tabId === undefined ? '' : String(entry.tabId)) === scope
        )
        if (index === -1) sidePanelOptionRecords.push(record)
        else sidePanelOptionRecords[index] = record
        state.sidePanel.options = sidePanelOptionRecords.length
        scheduleMailbox()
        return answerWith(callback)
      } catch (error) {
        state.errors.push('sidePanel-setOptions: ' + String(error))
        return Promise.resolve()
      }
    },
    getOptions: (options, callback) => {
      try {
        const scope = sidePanelScopeKey(options)
        const found = sidePanelOptionRecords.find(
          (entry) => (entry.tabId === undefined ? '' : String(entry.tabId)) === scope
        )
        // Chromium's own answer for a panel nobody configured is `enabled: true`
        // with no path, and an extension that reads it back before setting it
        // expects that rather than an empty object.
        return answerWith(callback, found ? { ...found } : { enabled: true })
      } catch (error) {
        state.errors.push('sidePanel-getOptions: ' + String(error))
        return Promise.resolve({ enabled: true })
      }
    },
    setPanelBehavior: (behavior, callback) => {
      try {
        sidePanelBehavior = {
          openPanelOnActionClick: !!(behavior && behavior.openPanelOnActionClick)
        }
        state.sidePanel.behavior = sidePanelBehavior
        scheduleMailbox()
        return answerWith(callback)
      } catch (error) {
        state.errors.push('sidePanel-setPanelBehavior: ' + String(error))
        return Promise.resolve()
      }
    },
    open: (options, callback) => {
      try {
        queueSidePanelRequest('open', options)
        return answerWith(callback)
      } catch (error) {
        state.errors.push('sidePanel-open: ' + String(error))
        return Promise.resolve()
      }
    },
    close: (options, callback) => {
      try {
        queueSidePanelRequest('close', options)
        return answerWith(callback)
      } catch (error) {
        state.errors.push('sidePanel-close: ' + String(error))
        return Promise.resolve()
      }
    }
  }
  const sidePanelEvents = { onOpened: sidePanelOpened, onClosed: sidePanelClosed }
  // Replaced, not ensured, for the same reason as notifications: these members are
  // this file's own placeholders from the stub section above.
  for (const root of roots) {
    const api = root && root.sidePanel
    if (!api) continue
    for (const key of Object.keys(sidePanelApi)) {
      try {
        Object.defineProperty(api, key, {
          value: sidePanelApi[key],
          configurable: true,
          writable: true,
          enumerable: true
        })
      } catch (error) {
        state.errors.push('sidePanel.' + key + ': ' + String(error))
      }
    }
    for (const key of Object.keys(sidePanelEvents)) {
      try {
        Object.defineProperty(api, key, {
          value: sidePanelEvents[key],
          configurable: true,
          writable: true,
          enumerable: true
        })
      } catch (error) {
        state.errors.push('sidePanel.' + key + ': ' + String(error))
      }
    }
  }
  state.sidePanel.shimmed = true

  // ── The state the app reads back ────────────────────────────────────────────
  // A worker that goes idle is released and restarted by the next message, and
  // the new life's sequence starts over with none of the previous action state.
  // The generation is what lets the app tell a fresh life from a stale sequence
  // and reset its own mirror instead of treating the first snapshot as old.
  const makeGeneration = () => {
    try {
      if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
        return globalThis.crypto.randomUUID()
      }
    } catch {
      // No randomUUID in this worker: the timestamp fallback below is enough for
      // an identifier that only has to differ between worker lives.
    }
    return String(Date.now()) + '-' + Math.random().toString(36).slice(2)
  }
  state.generation = makeGeneration()
  const actionState = { global: {}, tabs: {} }
  const actionPopupRequests = []
  let actionPopupRequestSeq = 0
  const contextMenuItems = new Map()
  const contextMenuClicked = makeRealEvent()
  let menuSeq = 0
  const mailboxStorage = (() => {
    try {
      const storage = chromeApi.storage
      if (!storage) return null
      if (storage.session && typeof storage.session.set === 'function') return storage.session
      if (storage.local && typeof storage.local.set === 'function') return storage.local
    } catch (error) {
      state.errors.push('mailbox-area: ' + String(error))
    }
    return null
  })()
  let mailboxTimer = null
  const writeMailbox = () => {
    if (!mailboxStorage) return
    try {
      state.mailboxSeq = (state.mailboxSeq || 0) + 1
      const payload = {
        generation: state.generation,
        seq: state.mailboxSeq,
        at: Date.now(),
        actions: actionState,
        menus: Array.from(contextMenuItems.values()),
        menuSeq,
        // The notifications this life has asked the app to raise. Main acts on the
        // entries newer than the last sequence it saw, the same way it does menus.
        notifications: notificationQueue,
        // What the extension wants a side panel to be, and when it asked for one.
        sidePanel: {
          behavior: sidePanelBehavior,
          options: sidePanelOptionRecords,
          requests: sidePanelRequests
        },
        actionPopups: actionPopupRequests,
        bridgeCommands: state.bridgeCommands || 0,
        commandLog: state.commandLog || [],
        eventDispatch: state.eventDispatch || {},
        errors: state.errors.slice(-20)
      }
      const returned = mailboxStorage.set({ __cioMailbox: JSON.parse(JSON.stringify(payload)) })
      if (returned && typeof returned.catch === 'function') returned.catch(() => {})
    } catch (error) {
      state.errors.push('mailbox: ' + String(error))
    }
  }
  const scheduleMailbox = () => {
    if (mailboxTimer) return
    mailboxTimer = setTimeout(() => {
      mailboxTimer = null
      writeMailbox()
    }, 80)
  }

  // ── contextMenus, for real ──────────────────────────────────────────────────
  // A stub that drops `create` leaves an extension's own menu unrenderable, and
  // one whose `onClicked` cannot store a listener can never be clicked. The tree
  // is recorded here, read back by the app, rendered in the native context menu,
  // and the chosen item comes back as a click on the same real event.
  const normalizeContexts = (value) => {
    if (typeof value === 'string' && value) return [value]
    if (Array.isArray(value)) {
      const list = value.filter((entry) => typeof entry === 'string' && entry)
      if (list.length > 0) return list
    }
    return ['page']
  }
  const invokeMenuCallback = (callback) => {
    if (typeof callback !== 'function') return
    try {
      callback()
    } catch (error) {
      state.errors.push('menu-callback: ' + String(error))
    }
  }
  let generatedMenuId = 0
  const contextMenusApi = {
    create(properties, callback) {
      const props = properties && typeof properties === 'object' ? properties : {}
      const hasId = props.id !== undefined && props.id !== null && props.id !== ''
      const id = hasId ? String(props.id) : 'cio-menu-' + (generatedMenuId += 1)
      try {
        contextMenuItems.set(id, {
          id,
          // The value `create` answered with, so a click carries back exactly
          // what the extension compared against.
          rawId: hasId ? props.id : id,
          parentId:
            props.parentId === undefined || props.parentId === null ? null : String(props.parentId),
          title: typeof props.title === 'string' ? props.title : '',
          type:
            ['normal', 'separator', 'checkbox', 'radio'].indexOf(props.type) === -1
              ? 'normal'
              : props.type,
          contexts: normalizeContexts(props.contexts),
          enabled: props.enabled !== false,
          checked: props.checked === true,
          documentUrlPatterns: Array.isArray(props.documentUrlPatterns)
            ? props.documentUrlPatterns.map(String)
            : [],
          targetUrlPatterns: Array.isArray(props.targetUrlPatterns)
            ? props.targetUrlPatterns.map(String)
            : []
        })
        menuSeq += 1
        scheduleMailbox()
      } catch (error) {
        state.errors.push('menu-create: ' + String(error))
      }
      invokeMenuCallback(callback)
      return id
    },
    update(id, properties, callback) {
      try {
        const existing = contextMenuItems.get(String(id))
        if (existing) {
          const props = properties && typeof properties === 'object' ? properties : {}
          if (typeof props.title === 'string') existing.title = props.title
          if (props.enabled !== undefined) existing.enabled = props.enabled !== false
          if (props.checked !== undefined) existing.checked = props.checked === true
          if (props.type !== undefined) existing.type = String(props.type)
          if (props.contexts !== undefined) existing.contexts = normalizeContexts(props.contexts)
          if (props.parentId !== undefined) {
            existing.parentId = props.parentId === null ? null : String(props.parentId)
          }
          menuSeq += 1
          scheduleMailbox()
        }
      } catch (error) {
        state.errors.push('menu-update: ' + String(error))
      }
      invokeMenuCallback(callback)
    },
    remove(id, callback) {
      try {
        if (contextMenuItems.delete(String(id))) {
          menuSeq += 1
          scheduleMailbox()
        }
      } catch (error) {
        state.errors.push('menu-remove: ' + String(error))
      }
      invokeMenuCallback(callback)
    },
    removeAll(callback) {
      try {
        if (contextMenuItems.size > 0) {
          contextMenuItems.clear()
          menuSeq += 1
          scheduleMailbox()
        }
      } catch (error) {
        state.errors.push('menu-remove-all: ' + String(error))
      }
      invokeMenuCallback(callback)
    },
    onClicked: contextMenuClicked,
    onShown: makeRealEvent(),
    onHidden: makeRealEvent()
  }
  for (const root of roots) {
    try {
      Object.defineProperty(root, 'contextMenus', {
        value: contextMenusApi,
        configurable: true,
        writable: true
      })
    } catch (error) {
      state.errors.push('contextMenus: ' + String(error))
    }
  }
  state.contextMenus = 'installed'

  // ── action state, recorded ──────────────────────────────────────────────────
  const normalizeBadgeColor = (color) => {
    if (typeof color === 'string' && color) return color
    if (Array.isArray(color) && color.length >= 3) {
      const alpha = color.length > 3 && typeof color[3] === 'number' ? color[3] : 255
      return alpha >= 255
        ? 'rgb(' + color[0] + ',' + color[1] + ',' + color[2] + ')'
        : 'rgba(' + color[0] + ',' + color[1] + ',' + color[2] + ',' + alpha / 255 + ')'
    }
    return null
  }
  const resolveIconPath = (path) => {
    try {
      if (typeof path === 'string' && path) return chromeApi.runtime.getURL(path)
      if (path && typeof path === 'object') {
        const sizes = Object.keys(path)
          .map((key) => Number(key))
          .filter((size) => Number.isFinite(size))
          .sort((left, right) => left - right)
        if (sizes.length === 0) return null
        const chosen = sizes.find((size) => size >= 19) ?? sizes[sizes.length - 1]
        const file = path[chosen] ?? path[String(chosen)]
        return typeof file === 'string' && file ? chromeApi.runtime.getURL(file) : null
      }
    } catch (error) {
      state.errors.push('icon-path: ' + String(error))
    }
    return null
  }
  const recordAction = (details, patch) => {
    const target =
      !details || details.tabId === undefined || details.tabId === null || details.tabId === -1
        ? actionState.global
        : (actionState.tabs[String(details.tabId)] ??
          (actionState.tabs[String(details.tabId)] = {}))
    Object.assign(target, patch)
    scheduleMailbox()
  }
  const wrapActionMember = (api, key, build) => {
    try {
      if (!Object.prototype.hasOwnProperty.call(api, key) || typeof api[key] !== 'function') {
        Object.defineProperty(api, key, { value: noop, configurable: true, writable: true })
        state.installed.push('action.' + key)
      }
      const current = api[key]
      if (typeof current !== 'function' || current.__cioWrapped) return
      const wrapped = function () {
        const args = Array.prototype.slice.call(arguments)
        try {
          const patch = build(args[0])
          if (patch) recordAction(args[0], patch)
        } catch (error) {
          state.errors.push('action-' + key + ': ' + String(error))
        }
        return current.apply(this, args)
      }
      wrapped.__cioWrapped = true
      Object.defineProperty(api, key, { value: wrapped, configurable: true, writable: true })
    } catch (error) {
      state.errors.push('action-wrap-' + key + ': ' + String(error))
    }
  }
  const routeActionPopupRequest = () => {
    try {
      const tabId = tabActivity.activeTabId
      if (typeof tabId === 'number' && Number.isFinite(tabId) && tabId >= 0) {
        actionPopupRequests.push({ seq: ++actionPopupRequestSeq, tabId, kind: 'action' })
        if (actionPopupRequests.length > 16)
          actionPopupRequests.splice(0, actionPopupRequests.length - 16)
        scheduleMailbox()
      }
    } catch (error) {
      state.errors.push('action-open-popup: ' + String(error))
    }
    return Promise.resolve()
  }
  const wrapActionApi = (api) => {
    if (!api || typeof api !== 'object') return
    wrapActionMember(api, 'setBadgeText', (details) => ({
      badgeText: details && typeof details.text === 'string' ? details.text : ''
    }))
    wrapActionMember(api, 'setBadgeBackgroundColor', (details) => ({
      badgeColor: normalizeBadgeColor(details && details.color)
    }))
    wrapActionMember(api, 'setTitle', (details) => ({
      title: details && typeof details.title === 'string' ? details.title : null
    }))
    wrapActionMember(api, 'setIcon', (details) => ({
      iconUrl: details && details.imageData ? null : resolveIconPath(details && details.path)
    }))
    try {
      Object.defineProperty(api, 'openPopup', {
        value: routeActionPopupRequest,
        configurable: true,
        writable: true
      })
    } catch (error) {
      state.errors.push('action-open-popup-wrap: ' + String(error))
    }
  }
  /**
   * A toolbar namespace built from nothing, for the extension that gets neither
   * of the runtime's two names for one.
   */
  const synthesizeActionNamespace = (root, name) => {
    const api = {}
    for (const member of [
      'setBadgeText',
      'setBadgeBackgroundColor',
      'getBadgeText',
      'getBadgeBackgroundColor',
      'setTitle',
      'getTitle',
      'setIcon',
      'setPopup',
      'getPopup',
      'enable',
      'disable',
      'openPopup'
    ]) {
      api[member] = noop
    }
    // The event a toolbar click arrives on, so a listener has somewhere to go.
    api.onClicked = makeRealEvent()
    try {
      Object.defineProperty(root, name, {
        value: api,
        configurable: true,
        writable: true,
        enumerable: true
      })
      return api
    } catch (error) {
      state.errors.push(name + ': ' + String(error))
      return null
    }
  }
  for (const root of roots) {
    if (!root) continue
    const actionApi = root.action && typeof root.action === 'object' ? root.action : null
    // Manifest V2 reaches its toolbar through `browserAction`, and an MV2 extension
    // gets neither name here: the runtime compiles in only MV3's `action`, and
    // exposes it only to an MV3 extension. A missing namespace there is not a
    // missing badge, it is an extension that dies on its own startup path
    // (measured: uBlock Origin classic throws on
    // `chrome.browserAction.setBadgeBackgroundColor`). So one is always provided:
    // the runtime's own `action` when there is one, and otherwise a namespace built
    // from the members this file already knows how to record.
    let browserActionApi =
      root.browserAction && typeof root.browserAction === 'object' ? root.browserAction : null
    if (!browserActionApi) {
      if (actionApi) {
        browserActionApi = actionApi
        try {
          Object.defineProperty(root, 'browserAction', {
            value: actionApi,
            configurable: true,
            writable: true,
            enumerable: true
          })
        } catch (error) {
          state.errors.push('browserAction: ' + String(error))
        }
      } else {
        browserActionApi = synthesizeActionNamespace(root, 'browserAction')
      }
      state.browserActionAlias = (state.browserActionAlias || 0) + 1
    }
    if (actionApi) wrapActionApi(actionApi)
    // Only a namespace that is genuinely its own object is wrapped separately: on
    // the alias above it is the same object, and wrapping it twice would record one
    // badge call as two.
    if (browserActionApi && browserActionApi !== actionApi) {
      wrapActionApi(browserActionApi)
    }
  }
  state.actionRecorder = 'installed'

  // ── the bridge itself ───────────────────────────────────────────────────────
  const BRIDGE_PORT_NAME = '__cio:bridge'
  let bridgePort = null
  let frameRequestSeq = 0
  const frameRequests = new Map()
  const sendFrameRequest = (request) => {
    if (!bridgePort) return
    try {
      bridgePort.postMessage({ kind: 'frames-query', id: request.id, tabId: request.tabId })
    } catch {
      bridgePort = null
    }
  }
  const queryFrames = (tabId) =>
    new Promise((resolve) => {
      if (!Number.isInteger(tabId) || tabId < 0 || frameRequests.size >= 64) {
        resolve(null)
        return
      }
      const id = ++frameRequestSeq
      const timer = setTimeout(() => {
        frameRequests.delete(id)
        resolve(null)
      }, 5000)
      const request = { id, tabId, resolve, timer }
      frameRequests.set(id, request)
      sendFrameRequest(request)
    })
  // Electron exposes no native frame lookup. A no-op here leaves extensions'
  // callback-based autofill and frame-policy lookups waiting indefinitely.
  for (const root of roots) {
    const api = root && root.webNavigation
    if (!api) continue
    const getAllFrames = (details, callback) => {
      const request = details && typeof details === 'object' ? details : {}
      return queryFrames(request.tabId).then((frames) => answerWith(callback, frames))
    }
    const getFrame = (details, callback) => {
      const request = details && typeof details === 'object' ? details : {}
      return queryFrames(request.tabId).then((frames) => {
        const found = frames && frames.find((frame) => frame.frameId === request.frameId)
        return answerWith(callback, found || undefined)
      })
    }
    try {
      Object.defineProperty(api, 'getAllFrames', {
        value: getAllFrames,
        configurable: true,
        writable: true
      })
      Object.defineProperty(api, 'getFrame', {
        value: getFrame,
        configurable: true,
        writable: true
      })
    } catch (error) {
      state.errors.push('webNavigation-frames: ' + String(error))
    }
  }
  /**
   * The tab the app says is on screen, as the runtime's own tab ids.
   *
   * The app is the only one who knows this: its browser view lives in no window the
   * runtime tracks, so `chrome.tabs.query` answers from a focus that never lands on
   * the tab the user is looking at, and every tab it reports reads as inactive.
   * What it announces is the truth, and it announces it twice over: an activation
   * names the tab, and every tab it describes carries the flag as it knows it.
   */
  const tabActivity = {
    activeTabId: null,
    tabs: Object.create(null),
    replayComplete: false,
    replayWaiters: [],
    replayGate: null
  }
  const markTabReplayComplete = () => {
    if (tabActivity.replayComplete) return
    tabActivity.replayComplete = true
    for (const resolve of tabActivity.replayWaiters.splice(0)) resolve()
  }
  const waitForTabReplay = () => {
    if (tabActivity.replayComplete) return Promise.resolve()
    if (!tabActivity.replayGate) {
      tabActivity.replayGate = new Promise((resolve) => {
        tabActivity.replayWaiters.push(resolve)
        setTimeout(markTabReplayComplete, 1500)
      })
    }
    return tabActivity.replayGate
  }
  const HOSTED_POPUP_WINDOW_ID = 2147483646
  const HOSTED_POPUP_TAB_ID = 2147483645
  const hostedPopout = { url: null, focused: false }

  const isExtensionPopoutUrl = (url) => {
    if (
      typeof url !== 'string' ||
      !chromeApi.runtime ||
      typeof chromeApi.runtime.getURL !== 'function'
    ) {
      return false
    }
    try {
      const root = new URL(chromeApi.runtime.getURL(''))
      const candidate = new URL(url)
      return (
        candidate.protocol === root.protocol &&
        candidate.host === root.host &&
        candidate.searchParams.get('uilocation') === 'popout'
      )
    } catch {
      return false
    }
  }

  const routePopupWindowRequest = (kind, url) => {
    const tabId = tabActivity.activeTabId
    if (typeof tabId !== 'number' || !Number.isFinite(tabId) || tabId < 0) return false
    const request = { seq: ++actionPopupRequestSeq, tabId, kind }
    if (typeof url === 'string') request.url = url
    actionPopupRequests.push(request)
    if (actionPopupRequests.length > 16) {
      actionPopupRequests.splice(0, actionPopupRequests.length - 16)
    }
    scheduleMailbox()
    return true
  }

  const hostedWindow = (id, focused) => ({
    id,
    focused,
    type: id === HOSTED_POPUP_WINDOW_ID ? 'popup' : 'normal',
    state: 'normal',
    left: 0,
    top: 0,
    width: 1280,
    height: 800,
    alwaysOnTop: false,
    tabs:
      id === HOSTED_POPUP_WINDOW_ID && hostedPopout.url
        ? [
            {
              id: HOSTED_POPUP_TAB_ID,
              index: 0,
              windowId: HOSTED_POPUP_WINDOW_ID,
              active: false,
              highlighted: false,
              pinned: false,
              incognito: false,
              discarded: false,
              status: 'complete',
              url: hostedPopout.url,
              title: ''
            }
          ]
        : []
  })

  const wrapWindowsApi = (api) => {
    if (!api || typeof api !== 'object') return
    const originals = {
      create: typeof api.create === 'function' ? api.create : noop,
      remove: typeof api.remove === 'function' ? api.remove : noop,
      update: typeof api.update === 'function' ? api.update : noop,
      get: typeof api.get === 'function' ? api.get : noop,
      getCurrent: typeof api.getCurrent === 'function' ? api.getCurrent : noop,
      getLastFocused: typeof api.getLastFocused === 'function' ? api.getLastFocused : noop
    }
    const install = (name, wrapped) => {
      try {
        Object.defineProperty(api, name, { value: wrapped, configurable: true, writable: true })
      } catch (error) {
        state.errors.push('windows-' + name + '-wrap: ' + String(error))
      }
    }
    const originalCreate = originals.create
    if (!originalCreate.__cioHostedPopoutWrapped) {
      const wrapped = function () {
        const args = Array.prototype.slice.call(arguments)
        const data = args[0] && typeof args[0] === 'object' ? args[0] : {}
        const url = typeof data.url === 'string' ? data.url : ''
        if (isExtensionPopoutUrl(url) && routePopupWindowRequest('open-window', url)) {
          hostedPopout.url = url
          hostedPopout.focused = true
          const callback =
            typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null
          return answerWith(callback, hostedWindow(HOSTED_POPUP_WINDOW_ID, true))
        }
        return originalCreate.apply(this, args)
      }
      wrapped.__cioHostedPopoutWrapped = true
      install('create', wrapped)
    }
    const originalRemove = originals.remove
    if (!originalRemove.__cioHostedPopoutWrapped) {
      const wrapped = function () {
        const args = Array.prototype.slice.call(arguments)
        if (args[0] === HOSTED_POPUP_WINDOW_ID && hostedPopout.url) {
          hostedPopout.focused = false
          if (routePopupWindowRequest('hide-window', hostedPopout.url)) {
            const callback =
              typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null
            return answerWith(callback, undefined)
          }
        }
        return originalRemove.apply(this, args)
      }
      wrapped.__cioHostedPopoutWrapped = true
      install('remove', wrapped)
    }
    const originalUpdate = originals.update
    if (!originalUpdate.__cioHostedPopoutWrapped) {
      const wrapped = function () {
        const args = Array.prototype.slice.call(arguments)
        if (args[0] === HOSTED_POPUP_WINDOW_ID && hostedPopout.url) {
          if (routePopupWindowRequest('focus-window', hostedPopout.url)) {
            hostedPopout.focused = true
            const callback =
              typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null
            return answerWith(callback, hostedWindow(HOSTED_POPUP_WINDOW_ID, true))
          }
        }
        return originalUpdate.apply(this, args)
      }
      wrapped.__cioHostedPopoutWrapped = true
      install('update', wrapped)
    }
    const originalGet = originals.get
    if (!originalGet.__cioHostedPopoutWrapped) {
      const wrapped = function () {
        const args = Array.prototype.slice.call(arguments)
        const id = args[0]
        if (id === HOSTED_POPUP_WINDOW_ID || id === 0 || id === -1 || id === -2) {
          const callback =
            typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null
          const result =
            id === HOSTED_POPUP_WINDOW_ID
              ? hostedWindow(id, hostedPopout.focused)
              : hostedWindow(0, true)
          return answerWith(callback, result)
        }
        return originalGet.apply(this, args)
      }
      wrapped.__cioHostedPopoutWrapped = true
      install('get', wrapped)
    }
    for (const name of ['getCurrent', 'getLastFocused']) {
      const original = originals[name]
      if (original.__cioHostedPopoutWrapped) continue
      const wrapped = function () {
        const args = Array.prototype.slice.call(arguments)
        const callback = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null
        return answerWith(callback, hostedWindow(0, true))
      }
      wrapped.__cioHostedPopoutWrapped = true
      install(name, wrapped)
    }
  }

  for (const root of roots) wrapWindowsApi(root && root.windows)

  const handleBridgeCommand = (command) => {
    if (!command || typeof command !== 'object') return
    state.bridgeCommands = (state.bridgeCommands || 0) + 1
    // A short log of what actually reached this worker, for the app's own
    // diagnostics: the alternative is guessing whether an event was delivered.
    state.commandLog = state.commandLog || []
    state.commandLog.push(
      typeof command.name === 'string' ? command.kind + ':' + command.name : String(command.kind)
    )
    if (state.commandLog.length > 100) {
      state.commandLog.splice(0, state.commandLog.length - 100)
    }
    // What was delivered and how many listeners were there to receive it: an
    // event delivered before an extension registered its listener looks exactly
    // like one it never reacted to, and the two are worth telling apart when a
    // menu or a panel does not appear. Tab events and navigation events both
    // record through here, because the shim's own delivery is the first thing to
    // doubt when a real extension seems not to react.
    const emitRecorded = (name, dispatcher, args) => {
      const counters = state.eventDispatch || (state.eventDispatch = {})
      const entry = counters[name] || (counters[name] = { delivered: 0, listeners: 0, errors: 0 })
      entry.delivered += 1
      entry.listeners = typeof dispatcher.__cioCount === 'function' ? dispatcher.__cioCount() : 0
      const errorsBefore = state.errors.length
      dispatcher.__cioEmit(args)
      entry.errors += state.errors.length - errorsBefore
    }
    if (command.kind === 'tab') {
      const args = Array.isArray(command.args) ? command.args : []
      if (command.name === 'onActivated') {
        if (args[0] && typeof args[0].tabId === 'number') tabActivity.activeTabId = args[0].tabId
      } else if (command.name === 'onCreated' || command.name === 'onHighlighted') {
        if (
          args[0] &&
          typeof args[0] === 'object' &&
          args[0].active === true &&
          typeof args[0].id === 'number'
        ) {
          tabActivity.activeTabId = args[0].id
        }
      } else if (command.name === 'onUpdated') {
        const info = args[2]
        if (
          info &&
          typeof info === 'object' &&
          info.active === true &&
          typeof info.id === 'number'
        ) {
          tabActivity.activeTabId = info.id
        }
      } else if (command.name === 'onRemoved') {
        if (args[0] === tabActivity.activeTabId) tabActivity.activeTabId = null
      }
      if (command.name === 'onCreated') {
        const tab = args[0]
        if (tab && typeof tab === 'object' && typeof tab.id === 'number' && tab.id >= 0) {
          tabActivity.tabs[String(tab.id)] = Object.assign(
            {
              discarded: false,
              highlighted: tab.active === true,
              windowType: 'normal',
              autoDiscardable: false,
              mutedInfo: { muted: false }
            },
            tab
          )
        }
      } else if (command.name === 'onUpdated') {
        const tab = args[2]
        if (tab && typeof tab === 'object' && typeof tab.id === 'number' && tab.id >= 0) {
          const key = String(tab.id)
          tabActivity.tabs[key] = Object.assign(
            {
              discarded: false,
              highlighted: tab.active === true,
              windowType: 'normal',
              autoDiscardable: false,
              mutedInfo: { muted: false }
            },
            tabActivity.tabs[key] || {},
            tab
          )
        }
      } else if (command.name === 'onRemoved' && typeof args[0] === 'number') {
        delete tabActivity.tabs[String(args[0])]
      }
      if (typeof tabActivity.activeTabId === 'number') {
        for (const key of Object.keys(tabActivity.tabs)) {
          const active = Number(key) === tabActivity.activeTabId
          tabActivity.tabs[key].active = active
          tabActivity.tabs[key].highlighted = active
        }
      }
      const dispatcher = tabEvents[command.name]
      if (dispatcher) {
        emitRecorded(command.name, dispatcher, args)
        // A closed tab's action state goes with the event, so a long session
        // does not accumulate entries for tabs nobody has.
        if (command.name === 'onRemoved' && command.args && command.args[0] !== undefined) {
          delete actionState.tabs[String(command.args[0])]
        }
      }
    } else if (command.kind === 'tab-replay-complete') {
      markTabReplayComplete()
    } else if (command.kind === 'web-navigation') {
      // The details object is built on the app's side in `chrome.webNavigation`'s
      // own shape, so a listener written against the real API runs unmodified.
      const dispatcher = webNavigationEvents[command.name]
      if (dispatcher) {
        emitRecorded(
          command.name,
          dispatcher,
          Array.isArray(command.args) ? command.args : [command.details || {}]
        )
      }
    } else if (command.kind === 'side-panel-opened') {
      sidePanelOpened.__cioEmit([sidePanelDetails(command)])
    } else if (command.kind === 'side-panel-closed') {
      sidePanelClosed.__cioEmit([sidePanelDetails(command)])
    } else if (command.kind === 'notification-click') {
      const id = String(command.id || '')
      // A button click is not a body click: Chromium reports them on different
      // events, and an extension that offers buttons only listens for the former.
      if (typeof command.buttonIndex === 'number') {
        notificationButtonClicked.__cioEmit([id, command.buttonIndex])
      } else {
        notificationClicked.__cioEmit([id])
      }
    } else if (command.kind === 'notification-close') {
      notificationClosed.__cioEmit([String(command.id || ''), command.byUser === true])
    } else if (command.kind === 'startup') {
      state.startupAt = Date.now()
      runtimeEvents.onStartup.__cioEmit([])
    } else if (command.kind === 'installed') {
      const rawDetails = command.details
      const details =
        rawDetails && typeof rawDetails === 'object' && !Array.isArray(rawDetails) ? rawDetails : {}
      const installed = {
        reason: details.reason === 'update' ? 'update' : 'install',
        ...(typeof details.previousVersion === 'string'
          ? { previousVersion: details.previousVersion }
          : {})
      }
      emitRecorded('onInstalled', runtimeEvents.onInstalled, [installed])
    } else if (command.kind === 'menu-click') {
      if (command.tab && typeof command.tab.id === 'number' && command.tab.id >= 0) {
        tabActivity.activeTabId = command.tab.id
      }
      contextMenuClicked.__cioEmit([command.info || {}, command.tab || null])
    }
    scheduleMailbox()
  }
  // A port, not a message: `runtime.sendMessage` is delivered to every one of
  // the extension's own `onMessage` listeners, and a real extension's listener
  // can throw on a shape it does not know (uBlock Origin Lite's does, measured:
  // `request.what.includes(':')` on a message with no `what`). A port's traffic
  // reaches its other end and nothing else, and the connect itself is the one
  // event the extension could still see.
  try {
    const runtime = chromeApi.runtime
    if (runtime && runtime.onConnect && typeof runtime.onConnect.addListener === 'function') {
      runtime.onConnect.addListener((port) => {
        try {
          if (!port || port.name !== BRIDGE_PORT_NAME) return
          bridgePort = port
          for (const request of frameRequests.values()) sendFrameRequest(request)
          port.onDisconnect.addListener(() => {
            if (bridgePort === port) bridgePort = null
          })
          port.onMessage.addListener((command) => {
            try {
              if (command && command.kind === 'frames-result') {
                const request = frameRequests.get(command.id)
                if (request) {
                  frameRequests.delete(command.id)
                  clearTimeout(request.timer)
                  request.resolve(Array.isArray(command.frames) ? command.frames : null)
                }
                return
              }
              handleBridgeCommand(command)
            } catch (error) {
              state.errors.push('bridge: ' + String(error))
            }
          })
          state.bridgeListener = 'installed'
        } catch (error) {
          state.errors.push('bridge-port: ' + String(error))
        }
      })
    }
  } catch (error) {
    state.errors.push('bridge-listener: ' + String(error))
  }

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
        // The app's own bridge page is not part of the extension's UI, and
        // reporting it as a context would make an extension believe one of its
        // own pages is open.
        if (url.indexOf(BRIDGE_PAGE_MARKER) !== -1) return null
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

  // ── the app's browser tabs, as chrome.tabs.query answers them ───────────────
  //
  // The app's pages are WebContentsViews, not tabs in a Chromium window. Electron's
  // partial tabs API therefore cannot be the whole answer: extensions which query
  // all tabs (Dark Reader does this when first installed) would otherwise never
  // inject into a page that was already open. The bridge replays and forwards the
  // app's tab events, and those snapshots are merged with any tabs Electron knows.
  try {
    if (state.tabsActivityRepair !== 'installed') {
      const hostedPopoutTab = () =>
        hostedPopout.url
          ? {
              id: HOSTED_POPUP_TAB_ID,
              index: 0,
              windowId: HOSTED_POPUP_WINDOW_ID,
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
      const matchesUrlFilter = (url, filter) => {
        if (!filter) return true
        const patterns = Array.isArray(filter) ? filter : [filter]
        return patterns.some((pattern) => {
          if (typeof pattern !== 'string') return false
          try {
            const source = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^]*')
            return new RegExp('^' + source + '$').test(url)
          } catch {
            return false
          }
        })
      }
      const hostedPopoutMatchesQuery = (tab, query) => {
        if (!tab) return false
        if (query && query.windowType && query.windowType !== 'popup') return false
        if (
          query &&
          typeof query.windowId === 'number' &&
          query.windowId !== HOSTED_POPUP_WINDOW_ID
        ) {
          return false
        }
        if (query && typeof query.active === 'boolean' && query.active !== tab.active) return false
        if (query && typeof query.status === 'string' && query.status !== tab.status) return false
        if (query && query.url && !matchesUrlFilter(tab.url, query.url)) return false
        if (query && query.title && tab.title !== query.title) return false
        return true
      }
      const matchesQuery = (tab, query) => {
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
        if (
          typeof query.highlighted === 'boolean' &&
          (tab.highlighted === true) !== query.highlighted
        ) {
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
      const withActivity = (tabs) => {
        const byId = new Map()
        for (const tab of Array.isArray(tabs) ? tabs : []) {
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
          const tab = tabActivity.tabs[id]
          if (!tab || typeof tab !== 'object' || typeof tab.id !== 'number') continue
          byId.set(tab.id, Object.assign({}, byId.get(tab.id) || {}, tab))
        }
        return [...byId.values()]
      }
      const readNativeTabs = (nativeQuery, query) =>
        new Promise((resolve) => {
          let settled = false
          let timeout = null
          const finish = (tabs) => {
            if (settled) return
            settled = true
            if (timeout !== null) clearTimeout(timeout)
            resolve(Array.isArray(tabs) ? tabs : [])
          }
          timeout = setTimeout(() => finish([]), 1500)
          try {
            const returned = nativeQuery(query, finish)
            if (returned && typeof returned.then === 'function') {
              returned.then(finish, (error) => {
                state.errors.push('tabs-query: ' + String(error))
                finish([])
              })
            }
          } catch (error) {
            state.errors.push('tabs-query: ' + String(error))
            try {
              const returned = nativeQuery(query)
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
      const readNativeTab = (nativeGet, id) =>
        new Promise((resolve) => {
          let settled = false
          let timeout = null
          const finish = (tab) => {
            if (settled) return
            settled = true
            if (timeout !== null) clearTimeout(timeout)
            resolve(tab && typeof tab === 'object' ? tab : null)
          }
          timeout = setTimeout(() => finish(null), 1500)
          try {
            const returned = nativeGet(id, finish)
            if (returned && typeof returned.then === 'function') {
              returned.then(finish, (error) => {
                state.errors.push('tabs-active: ' + String(error))
                finish(null)
              })
            }
          } catch (error) {
            state.errors.push('tabs-active: ' + String(error))
            try {
              const returned = nativeGet(id)
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
      let repairedOn = 0
      for (const root of roots) {
        const tabsApi = root && root.tabs
        if (!tabsApi || typeof tabsApi !== 'object') continue
        const nativeQuery = typeof tabsApi.query === 'function' ? tabsApi.query.bind(tabsApi) : null
        if (!nativeQuery) continue
        const nativeGet = typeof tabsApi.get === 'function' ? tabsApi.get.bind(tabsApi) : null
        try {
          const answerQuery = (list, query, callback) => {
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
          const queryRepaired = (...args) => {
            const callback =
              typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null
            const callArgs = callback ? args.slice(0, -1) : args
            const query = callArgs[0] && typeof callArgs[0] === 'object' ? callArgs[0] : {}
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
            const getRepaired = (id, callback) => {
              const answered = typeof callback === 'function' ? callback : null
              const tab = tabActivity.tabs[String(id)]
              const result = tab ? Promise.resolve(tab) : readNativeTab(nativeGet, id)
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

  // ── userScripts, for real ───────────────────────────────────────────────────
  // The runtime has no `chrome.userScripts`, and its `scripting` API refuses the
  // `USER_SCRIPT` execution world outright ("Value must be one of ISOLATED, MAIN",
  // measured with the permission declared), which is the CSP-exempt world the API
  // exists for. What remains is the pipeline Chromium itself uses for content
  // scripts: `register` writes each script's code into a file the app materializes
  // inside the extension's own copy, then registers that file. `world: 'MAIN'` maps
  // exactly, and `USER_SCRIPT` maps to the extension's isolated world.
  //
  // For the code extensions actually register this is faithful: uBlock Origin
  // Lite's generated user scripts are `eval`-free, use no `chrome.*` API and are
  // isolated from the page in either world (its own `js/offscreen/
  // scriptlet.template.js`), so the one loss is that a script which wanted `eval`
  // would meet the extension's MV3 CSP instead of the user-script world's
  // exemption. Registering a file, rather than code, is likewise what
  // `scripting.registerContentScripts` accepts: its `js` is a list of paths.
  try {
    const userScriptIdPrefix = 'cio-us-'
    const userScriptDirName = 'cio-user-scripts'
    const userScriptRegistryKey = '__cioUserScripts'
    const userScriptWorldsKey = '__cioUserScriptWorlds'
    const userScriptRequestsKey = '__cioFileRequests'
    const userScriptReadyKey = '__cioFileReady'
    const userScriptMaxCode = 512 * 1024

    const shortHash = (text) => {
      let hash = 0x811c9dc5
      for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index)
        hash = Math.imul(hash, 0x01000193) >>> 0
      }
      return hash.toString(36).padStart(7, '0').slice(0, 8)
    }

    const localArea = () => {
      const storage = chromeApi.storage
      return storage && storage.local ? storage.local : null
    }
    const sessionArea = () => {
      const storage = chromeApi.storage
      if (!storage) return null
      return storage.session || storage.local || null
    }
    const readKey = async (area, key) => {
      if (!area) return null
      try {
        const bag = await area.get(key)
        return bag ? bag[key] : null
      } catch (error) {
        state.errors.push('userScripts-read: ' + String(error))
        return null
      }
    }
    const writeKey = async (area, key, value) => {
      if (!area) return
      try {
        await area.set({ [key]: value })
      } catch (error) {
        state.errors.push('userScripts-write: ' + String(error))
      }
    }

    /** The world Chromium is asked for, as the extension stated it. */
    const requestedWorld = (world) => (world === 'MAIN' ? 'MAIN' : 'USER_SCRIPT')
    /** The world this runtime has. `USER_SCRIPT` has no equivalent, and the
     *  extension's isolated world is the same isolation from the page. */
    const runtimeWorld = (world) => (world === 'MAIN' ? 'MAIN' : 'ISOLATED')

    const codeOf = (sources) => {
      if (!Array.isArray(sources)) return ''
      const parts = []
      for (const source of sources) {
        if (!source || typeof source !== 'object') continue
        if (typeof source.code === 'string') {
          parts.push(source.code)
          continue
        }
        // A file the extension shipped itself cannot be read back here, so the
        // app is asked to copy it in beside the registered code instead.
        if (typeof source.file === 'string' && source.file)
          parts.push(`/* cio:file:${source.file} */`)
      }
      return parts.join('\n;\n')
    }

    const registryEntry = (script) => {
      const id = typeof script.id === 'string' && script.id ? script.id : 'cio-anonymous'
      const world = requestedWorld(script.world)
      const code = codeOf(script.js)
      const registrationId = `${userScriptIdPrefix}${shortHash(`${id}|${world}`)}`
      return {
        id,
        world,
        runtimeWorld: runtimeWorld(world),
        registrationId,
        file: `${userScriptDirName}/${registrationId}.js`,
        code,
        matches: Array.isArray(script.matches) ? script.matches : [],
        excludeMatches: Array.isArray(script.excludeMatches) ? script.excludeMatches : [],
        allFrames: script.allFrames === true,
        runAt: typeof script.runAt === 'string' ? script.runAt : 'document_start'
      }
    }

    /**
     * Ask the app to write the registered code into the extension's own copy and
     * wait for it to answer. The bridge page polls this key, and the answer is
     * written back into the same storage the worker can read, because a worker has
     * no other way to be answered (it cannot be called, only read).
     */
    let userScriptRequestSeq = 0
    const materialize = async (entries) => {
      const area = sessionArea()
      if (!area) throw new Error('no storage area for user script files')
      const oversized = entries.find((entry) => entry.code.length > userScriptMaxCode)
      if (oversized) {
        throw new Error(`the code for user script "${oversized.id}" is too large to register`)
      }
      const request = ++userScriptRequestSeq
      const files = entries
        .filter((entry) => entry.code.length !== 0)
        .map((entry) => ({ path: entry.file, code: entry.code }))
      const keep = entries.map((entry) => entry.file)
      await writeKey(area, userScriptRequestsKey, { request, files, keep, at: Date.now() })
      const deadline = Date.now() + 10000
      while (Date.now() < deadline) {
        const answer = await readKey(area, userScriptReadyKey)
        if (answer && typeof answer === 'object' && answer.request === request) {
          if (answer.error) throw new Error(String(answer.error))
          return Array.isArray(answer.paths) ? answer.paths : []
        }
        await new Promise((resolve) => setTimeout(resolve, 60))
      }
      throw new Error('the app did not write the user script files in time')
    }

    const readRegistry = async () => {
      const stored = await readKey(localArea(), userScriptRegistryKey)
      if (!Array.isArray(stored)) return []
      return stored.filter((entry) => entry && typeof entry === 'object' && entry.registrationId)
    }
    const writeRegistry = async (entries) => {
      await writeKey(localArea(), userScriptRegistryKey, entries)
      return entries
    }

    const registerScripts = async (scripts) => {
      const scripting = chromeApi.scripting
      if (!scripting || typeof scripting.registerContentScripts !== 'function') {
        throw new Error('scripting.registerContentScripts is unavailable')
      }
      if (!Array.isArray(scripts) || scripts.length === 0) return
      const incoming = scripts.map(registryEntry)
      const previous = await readRegistry()
      const merged = previous
        .filter(
          (entry) => incoming.some((next) => next.registrationId === entry.registrationId) === false
        )
        .concat(incoming)
      await materialize(merged)
      // Registering the same id twice is an error, and a registration can outlive
      // the worker that made it, so the ids about to be used are freed first.
      const ids = incoming.map((entry) => entry.registrationId)
      await scripting.unregisterContentScripts({ ids }).catch(() => undefined)
      await scripting.registerContentScripts(
        incoming.map((entry) => ({
          id: entry.registrationId,
          world: entry.runtimeWorld,
          matches: entry.matches.length !== 0 ? entry.matches : ['<all_urls>'],
          ...(entry.excludeMatches.length !== 0 ? { excludeMatches: entry.excludeMatches } : {}),
          ...(entry.allFrames ? { allFrames: true } : {}),
          runAt: entry.runAt,
          js: [entry.file]
        }))
      )
      // The code lives in the file from here on, so the registry keeps only what
      // `getScripts` and the restore path need: a large scriptlet must not sit in
      // the extension's storage a second time.
      await writeRegistry(
        merged.map((entry) => {
          const stored = Object.assign({}, entry)
          delete stored.code
          return stored
        })
      )
      state.userScripts = {
        registered: merged.length,
        worlds: merged.map((entry) => entry.world),
        at: Date.now()
      }
    }

    const unregisterScripts = async (filter) => {
      const scripting = chromeApi.scripting
      if (!scripting || typeof scripting.unregisterContentScripts !== 'function') {
        throw new Error('scripting.unregisterContentScripts is unavailable')
      }
      const previous = await readRegistry()
      const ids = filter && Array.isArray(filter.ids) ? new Set(filter.ids) : null
      const keep = []
      const drop = []
      for (const entry of previous) {
        if (ids === null || ids.has(entry.id)) drop.push(entry.registrationId)
        else keep.push(entry)
      }
      if (drop.length !== 0) {
        await scripting.unregisterContentScripts({ ids: drop }).catch(() => undefined)
      }
      await writeRegistry(keep)
      state.userScripts = { registered: keep.length, at: Date.now() }
    }

    const listScripts = async () => {
      const entries = await readRegistry()
      return entries.map((entry) => ({
        id: entry.id,
        world: entry.world,
        matches: entry.matches.length !== 0 ? entry.matches : ['<all_urls>'],
        ...(entry.excludeMatches.length !== 0 ? { excludeMatches: entry.excludeMatches } : {}),
        ...(entry.allFrames ? { allFrames: true } : {}),
        runAt: entry.runAt,
        // The runtime holds this script as a file, and saying so is honest about
        // what `register` did with the code.
        js: [{ file: entry.file }]
      }))
    }

    const userScriptsApi = {
      getScripts: () => listScripts(),
      register: (scripts) => registerScripts(scripts).then(() => undefined),
      unregister: (filter) => unregisterScripts(filter),
      update: async (scripts) => {
        const entries = await readRegistry()
        const known = new Set(entries.map((entry) => entry.id))
        for (const script of Array.isArray(scripts) ? scripts : []) {
          const id = script && typeof script.id === 'string' ? script.id : ''
          if (!id || known.has(id) === false) {
            throw new Error(`no user script with id "${id}" is registered`)
          }
        }
        await unregisterScripts({ ids: (scripts || []).map((script) => script.id) })
        await registerScripts(scripts)
      },
      execute: async (injection) => {
        const scripting = chromeApi.scripting
        if (!scripting || typeof scripting.executeScript !== 'function') {
          throw new Error('scripting.executeScript is unavailable')
        }
        const entry = registryEntry({
          id: 'cio-execute',
          world: injection && injection.world,
          js: injection && injection.js,
          matches: ['<all_urls>']
        })
        await materialize([entry])
        return scripting.executeScript({
          world: entry.runtimeWorld,
          target: (injection && injection.target) || { tabId: injection && injection.tabId },
          ...(injection && injection.allFrames === true ? { allFrames: true } : {}),
          ...(injection && injection.injectImmediately === true ? { injectImmediately: true } : {}),
          files: [entry.file]
        })
      },
      configureWorld: async (config) => {
        const worlds = (await readKey(localArea(), userScriptWorldsKey)) || {}
        const worldId =
          config && typeof config.worldId === 'string' && config.worldId
            ? config.worldId
            : `${userScriptIdPrefix}${shortHash(String((config && config.messaging) === true))}`
        const stored = Object.assign({}, worlds, {
          [worldId]: {
            worldId,
            messaging: Boolean(config && config.messaging === true),
            ...(config && typeof config.csp === 'string' ? { csp: config.csp } : {})
          }
        })
        await writeKey(localArea(), userScriptWorldsKey, stored)
        return worldId
      },
      getWorldConfigurations: async () => {
        const worlds = (await readKey(localArea(), userScriptWorldsKey)) || {}
        return Object.keys(worlds).map((key) => worlds[key])
      },
      resetWorldConfiguration: async (worldId) => {
        const worlds = (await readKey(localArea(), userScriptWorldsKey)) || {}
        if (typeof worldId !== 'string' || !worldId) {
          await writeKey(localArea(), userScriptWorldsKey, {})
          return
        }
        const next = Object.assign({}, worlds)
        delete next[worldId]
        await writeKey(localArea(), userScriptWorldsKey, next)
      }
    }

    for (const root of roots) {
      const existing = root && root.userScripts
      if (existing && typeof existing.getScripts === 'function') continue
      ensureNamespaceOnRoot(root, 'userScripts', userScriptsApi, [])
    }
    state.userScripts = { installed: true }

    // A registration can outlive the worker that made it, so anything this app
    // registered for an earlier life is read back into the registry on startup:
    // `getScripts` then answers with what the runtime really holds, and a fresh
    // `register` with the same ids does not collide with the old ones.
    ;(async () => {
      try {
        const scripting = chromeApi.scripting
        if (!scripting || typeof scripting.getRegisteredContentScripts !== 'function') return
        const registered = await scripting.getRegisteredContentScripts()
        const ours = registered.filter(
          (entry) =>
            entry && typeof entry.id === 'string' && entry.id.startsWith(userScriptIdPrefix)
        )
        const registry = await readRegistry()
        const known = new Set(registry.map((entry) => entry.registrationId))
        const orphans = ours.filter((entry) => known.has(entry.id) === false)
        if (orphans.length !== 0) {
          await scripting.unregisterContentScripts({ ids: orphans.map((entry) => entry.id) })
        }
        state.userScripts = {
          installed: true,
          registered: registry.length,
          orphansRemoved: orphans.length
        }
      } catch (error) {
        state.errors.push('userScripts-sweep: ' + String(error))
      }
    })()
  } catch (error) {
    state.errors.push('userScripts: ' + String(error))
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
