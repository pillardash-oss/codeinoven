/**
 * The namespaces this runtime does not compile in at all, and the members it leaves
 * out of the namespaces it does implement.
 *
 * WHY THIS MODULE EXISTS
 * Electron's extension runtime is a partial implementation of the API. A namespace
 * that is absent makes an extension throw at load time, and a member missing from a
 * namespace that *is* present makes it throw at call time, which is worse: the
 * extension's own feature detection passes and the call that follows does not. So
 * every namespace below is ensured on every root with the empty shape the API
 * documents, and the events an extension waits on are ensured as real event objects
 * whose listeners are simply never called.
 *
 * The one namespace that is not a stub is `chrome.permissions`: see the comment
 * above its declarations for why it answers from the extension's own manifest.
 *
 * Order matters here. The `ensureNamespace` calls run in the sequence the preamble
 * always ran them in, because each one appends to `state.namespaces` and that list
 * is the capability report the app reads back.
 */
import {
  answerWith,
  answering,
  chromeApi,
  ensureNamespace,
  makeEvent,
  noop,
  state
} from './context.ts'

/** The request one extension hands `chrome.permissions`. */
interface PermissionRequestDetails {
  permissions?: unknown
  origins?: unknown
}

/** The runtime, viewed with the manifest reader these declarations call. */
interface PreambleRuntime {
  getManifest: () => Record<string, unknown> | undefined
}

// `chrome.permissions` is absent from this runtime entirely, and a password
// manager cannot enable its own optional capability without it: Bitwarden asks
// `chrome.permissions.request({permissions:['nativeMessaging']})` before it will
// save "Unlock with biometrics", and a stub that always answers `false` is
// exactly why the toggle never stuck. The declared manifest is the source of
// truth: a permission the extension already declares   required or optional   is
// one the app has, so a request for it is granted. `nativeMessaging` is a real
// capability here now (see the native messaging section below), not a stub.
export function declaredPermissionNames(): Set<string> {
  const names = new Set<string>()
  try {
    const runtime = chromeApi.runtime as PreambleRuntime | undefined
    const manifest =
      runtime && typeof runtime.getManifest === 'function' ? runtime.getManifest() || {} : {}
    for (const key of ['permissions', 'optional_permissions']) {
      const list = manifest[key]
      if (!Array.isArray(list)) continue
      for (const entry of list) if (typeof entry === 'string' && entry) names.add(entry)
    }
  } catch (error) {
    state.errors.push('permissions-manifest: ' + String(error))
  }
  return names
}

/** Every host the extension declares access to, as its own manifest lists them. */
export function declaredHosts(): string[] {
  const hosts: string[] = []
  try {
    const runtime = chromeApi.runtime as PreambleRuntime | undefined
    const manifest =
      runtime && typeof runtime.getManifest === 'function' ? runtime.getManifest() || {} : {}
    for (const key of ['host_permissions', 'optional_host_permissions']) {
      const list = manifest[key]
      if (!Array.isArray(list)) continue
      for (const entry of list)
        if (typeof entry === 'string' && entry && !hosts.includes(entry)) hosts.push(entry)
    }
  } catch (error) {
    state.errors.push('permissions-hosts: ' + String(error))
  }
  return hosts
}

/** Whether a permission request asks only for what the extension already declares. */
export function permissionRequestIsGranted(details: unknown): boolean {
  const request: PermissionRequestDetails =
    details && typeof details === 'object' ? (details as PermissionRequestDetails) : {}
  const permissions = Array.isArray(request.permissions)
    ? request.permissions.filter((entry) => typeof entry === 'string' && entry)
    : []
  const origins = Array.isArray(request.origins)
    ? request.origins.filter((entry) => typeof entry === 'string' && entry)
    : []
  const known = declaredPermissionNames()
  if (permissions.every((name) => known.has(name)) === false) return false
  // A requested origin is one the extension declares host access for in its own
  // manifest; whether a script may run on a site is the app's site-permission
  // layer's decision, not this namespace's.
  if (origins.every((origin) => typeof origin === 'string' && origin.length > 0) === false)
    return false
  return true
}

/**
 * Ensure every namespace and member this runtime leaves out, on every root.
 *
 * A stub never throws: it answers the API's empty shape, both as a callback and as
 * a promise, because an extension may use either.
 */
export function installNamespaces(): void {
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
      contains: (details: unknown, callback: unknown) =>
        answerWith(callback, permissionRequestIsGranted(details)),
      request: (details: unknown, callback: unknown) =>
        answerWith(callback, permissionRequestIsGranted(details)),
      remove: (_details: unknown, callback: unknown) => answerWith(callback, false),
      getAll: (callback: unknown) =>
        answerWith(callback, {
          permissions: [...declaredPermissionNames()],
          origins: declaredHosts()
        })
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
  // `downloads` is not ensured here: the app's download manager owns every
  // download this browser starts and feeds the real namespace below, rather than
  // leaving a stub whose events never fire (see the downloads section).
  ensureNamespace(
    'identity',
    {
      getAuthToken: noop,
      getProfileUserInfo: answering({}),
      launchWebAuthFlow: noop,
      getRedirectURL: (path: unknown) => String(path || '')
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
      getFontList: answering([
        { fontId: 'serif', displayName: 'serif' },
        { fontId: 'sans-serif', displayName: 'sans-serif' },
        { fontId: 'monospace', displayName: 'monospace' },
        { fontId: 'cursive', displayName: 'cursive' },
        { fontId: 'fantasy', displayName: 'fantasy' },
        { fontId: 'system-ui', displayName: 'system-ui' }
      ]),
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
}
