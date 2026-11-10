/**
 * The `chrome` surface an extension sees inside this runtime, as a fixture.
 *
 * The compatibility preamble's whole job is repairing this surface, so both the
 * equivalence harness that compared the split against the single-closure file it
 * replaced and `tests/main/browser/compat-preamble.test.ts` need the same one. The
 * numbers those tests pin (254 installed members, the created namespaces, the answers
 * to the calls an extension makes) were recorded against this fixture, so changing a
 * member here changes evidence rather than a test convenience.
 */

export type AnyRecord = Record<string, unknown>

export const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop'

function event(name: string): AnyRecord {
  const listeners: unknown[] = []
  return {
    name,
    addListener: (listener: unknown) => listeners.push(listener),
    removeListener: (listener: unknown) => {
      const index = listeners.indexOf(listener)
      if (index !== -1) listeners.splice(index, 1)
    },
    hasListener: (listener: unknown) => listeners.includes(listener),
    hasListeners: () => listeners.length > 0,
    __listeners: listeners
  }
}

function storageArea(store: Map<string, unknown>): AnyRecord {
  return {
    get: async (keys: unknown) => {
      if (keys === null || keys === undefined) return Object.fromEntries(store)
      if (typeof keys === 'string') return { [keys]: store.get(keys) }
      if (Array.isArray(keys)) {
        return Object.fromEntries(
          keys.filter((key) => store.has(String(key))).map((key) => [key, store.get(String(key))])
        )
      }
      if (typeof keys === 'object') {
        const out: AnyRecord = {}
        for (const [key, fallback] of Object.entries(keys as AnyRecord)) {
          out[key] = store.has(key) ? store.get(key) : fallback
        }
        return out
      }
      return {}
    },
    set: async (values: AnyRecord) => {
      for (const [key, value] of Object.entries(values)) store.set(key, value)
    },
    remove: async (keys: unknown) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(String(key))
    },
    clear: async () => store.clear(),
    QUOTA_BYTES: 10485760
  }
}

const manifest = {
  manifest_version: 3,
  name: 'Mock Extension',
  version: '1.0.0',
  permissions: ['storage', 'tabs', 'scripting', 'webRequest', 'declarativeNetRequest'],
  optional_permissions: ['nativeMessaging'],
  host_permissions: ['https://*/*'],
  background: { service_worker: 'background.js' },
  content_scripts: [{ matches: ['https://*/*'], js: ['content.js'] }]
}

/** Build one fresh runtime object graph plus the storage the app reads back. */
export function createMockSurface(): {
  chrome: AnyRecord
  storage: Map<string, unknown>
  session: Map<string, unknown>
} {
  const storage = new Map<string, unknown>()
  const session = new Map<string, unknown>()
  const port = () => ({
    name: '',
    postMessage: () => undefined,
    disconnect: () => undefined,
    onMessage: event('onMessage'),
    onDisconnect: event('onDisconnect')
  })

  const runtime: AnyRecord = {
    id: EXTENSION_ID,
    lastError: null,
    getURL: (path: string) =>
      `chrome-extension://${EXTENSION_ID}/${String(path).replace(/^\//u, '')}`,
    getManifest: () => manifest,
    getPlatformInfo: async () => ({ os: 'mac', arch: 'arm64' }),
    connect: port,
    connectNative: () => port(),
    sendMessage: async () => undefined,
    onMessage: event('onMessage'),
    onMessageExternal: event('onMessageExternal'),
    onConnect: event('onConnect'),
    onConnectExternal: event('onConnectExternal'),
    onSuspend: event('onSuspend'),
    onUpdateAvailable: event('onUpdateAvailable')
  }

  const chrome: AnyRecord = {
    runtime,
    storage: {
      local: storageArea(storage),
      session: storageArea(session),
      sync: storageArea(new Map()),
      onChanged: event('onChanged')
    },
    scripting: {
      executeScript: async () => [],
      insertCSS: async () => undefined,
      removeCSS: async () => undefined,
      getRegisteredContentScripts: async () => [],
      registerContentScripts: async () => undefined,
      unregisterContentScripts: async () => undefined,
      updateContentScripts: async () => undefined
    },
    tabs: {
      query: async () => [],
      get: async (id: number) => ({ id, url: 'https://example.com/', title: 'Example' }),
      sendMessage: async () => undefined,
      update: async () => ({}),
      onCreated: event('onCreated'),
      onUpdated: event('onUpdated'),
      onRemoved: event('onRemoved'),
      onActivated: event('onActivated'),
      onHighlighted: event('onHighlighted')
    },
    action: {
      setIcon: async () => undefined,
      setTitle: async () => undefined,
      setPopup: async () => undefined,
      getPopup: async () => '',
      setBadgeText: async () => undefined,
      getBadgeText: async () => '',
      setBadgeBackgroundColor: async () => undefined,
      getBadgeBackgroundColor: async () => ({ color: [0, 0, 0, 0] }),
      setBadgeTextColor: async () => undefined,
      getBadgeTextColor: async () => ({ color: [0, 0, 0, 0] }),
      onClicked: event('onClicked')
    },
    browserAction: {
      setIcon: async () => undefined,
      setTitle: async () => undefined,
      setPopup: async () => undefined,
      setBadgeText: async () => undefined,
      getBadgeText: async () => '',
      onClicked: event('onClicked')
    },
    pageAction: {
      show: async () => undefined,
      hide: async () => undefined,
      onClicked: event('onClicked')
    },
    contextMenus: {
      create: (properties: AnyRecord, callback?: () => void) => {
        callback?.()
        return properties.id
      },
      update: async () => undefined,
      remove: async () => undefined,
      removeAll: async () => undefined,
      onClicked: event('onClicked')
    },
    declarativeNetRequest: {
      getDynamicRules: async () => [],
      updateDynamicRules: async () => undefined,
      getSessionRules: async () => [],
      updateSessionRules: async () => undefined,
      getEnabledRulesets: async () => [],
      updateEnabledRulesets: async () => undefined,
      isRegexSupported: async () => ({ isSupported: true }),
      MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES: 5000,
      RuleActionType: { BLOCK: 'block', REDIRECT: 'redirect' },
      RuleCondition: {},
      RequestMethod: { GET: 'get' }
    },
    declarativeContent: {
      PageStateMatcher: class {},
      ShowAction: class {},
      RequestContentScript: class {}
    },
    privacy: {
      network: {
        networkPredictionEnabled: {
          get: async () => ({ value: true, levelOfControl: 'controllable_by_this_extension' }),
          set: async () => undefined,
          clear: async () => undefined
        },
        webRTCIPHandlingPolicy: {
          get: async () => ({ value: 'default', levelOfControl: 'controllable_by_this_extension' }),
          set: async () => undefined,
          clear: async () => undefined
        }
      },
      services: {
        allowSigninPrompt: {
          get: async () => ({ value: false, levelOfControl: 'controllable_by_this_extension' }),
          set: async () => undefined,
          clear: async () => undefined
        }
      },
      websites: {
        hyperlinkAuditingEnabled: {
          get: async () => ({ value: true, levelOfControl: 'controllable_by_this_extension' }),
          set: async () => undefined,
          clear: async () => undefined
        }
      }
    },
    webRequest: {
      onBeforeRequest: event('onBeforeRequest'),
      onBeforeSendHeaders: event('onBeforeSendHeaders'),
      onSendHeaders: event('onSendHeaders'),
      onHeadersReceived: event('onHeadersReceived'),
      onAuthRequired: event('onAuthRequired'),
      onResponseStarted: event('onResponseStarted'),
      onBeforeRedirect: event('onBeforeRedirect'),
      onCompleted: event('onCompleted'),
      onErrorOccurred: event('onErrorOccurred'),
      handlerBehaviorChanged: async () => undefined,
      MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES: 20
    },
    offscreen: {
      createDocument: async () => undefined,
      closeDocument: async () => undefined,
      hasDocument: async () => false
    },
    i18n: {
      getMessage: (messageName: string) => messageName,
      getUILanguage: () => 'en-US',
      getAcceptLanguages: async () => ['en-US']
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      get: async (id: number) => ({ id }),
      getAll: async () => [],
      query: async () => [],
      update: async () => ({}),
      onCreated: event('onCreated'),
      onUpdated: event('onUpdated'),
      onRemoved: event('onRemoved')
    }
  }

  return { chrome, storage, session }
}

/** Every timer the preamble schedules, captured so a run can be finished on demand. */
export interface TimerRecorder {
  pending: Array<{ run: () => void; ms: number }>
  setTimeout: (run: () => void, ms?: number) => number
  clearTimeout: (id: number) => void
  flush: () => void
}

export function createTimerRecorder(): TimerRecorder {
  let next = 1
  const handles = new Map<number, { run: () => void; ms: number }>()
  const pending: Array<{ run: () => void; ms: number }> = []
  return {
    pending,
    setTimeout: (run: () => void, ms = 0) => {
      const id = next++
      const record = { run, ms }
      handles.set(id, record)
      pending.push(record)
      return id
    },
    clearTimeout: (id: number) => {
      const record = handles.get(id)
      handles.delete(id)
      if (record) pending.splice(pending.indexOf(record), 1)
    },
    flush: () => {
      for (let round = 0; round < 5; round += 1) {
        const batch = pending.splice(0)
        if (batch.length === 0) return
        for (const record of batch) {
          try {
            record.run()
          } catch {
            // A timer that throws during a flush is reported by the run itself.
          }
        }
      }
    }
  }
}
