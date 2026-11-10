/**
 * `chrome.permissions` for an extension's own page.
 *
 * The runtime has no `permissions` namespace at all, and an extension page   a
 * Bitwarden popup, for instance   calls `chrome.permissions.request` directly while
 * it decides whether to offer an optional capability. Undefined there is a thrown
 * `TypeError`, which is worse than a refusal: the extension's own error path may
 * swallow it and simply leave the toggle off, which is exactly how "Unlock with
 * biometrics" failed to save.
 *
 * This file is injected into the page's own world by the extension page preload
 * (see `browser-extension-page-tabs.ts`), beside the tab snapshot, so it runs before
 * the page's own scripts. The manifest is the source of truth: a permission the
 * extension already declares, required or optional, is one the app has, and a
 * request for it is granted. The service worker's own half of the same rule lives
 * in `cio-compat-preamble.js`.
 *
 * Rule: it must never throw. A page that gets no `permissions` is no worse off than
 * before, but a page whose preload threw is a page whose other wrappers did not run.
 */

;(() => {
  /** The four manifest permission lists this shim reads. */
  interface ExtensionManifest {
    permissions?: string[]
    optional_permissions?: string[]
    host_permissions?: string[]
    optional_host_permissions?: string[]
  }

  /** What a page hands `permissions.request`, `contains` or `remove`. */
  interface PermissionRequestDetails {
    permissions?: string[]
    origins?: string[]
  }

  /** What `permissions.getAll` answers with. */
  interface PermissionsSnapshot {
    permissions: string[]
    origins: string[]
  }

  /** The listener list an extension page expects on `onAdded` and `onRemoved`. */
  interface PermissionsEvent {
    addListener(): void
    removeListener(): void
    hasListener(): boolean
    hasListeners(): boolean
  }

  /** The namespace this shim puts on the page, as the page calls it. */
  interface ChromePermissionsNamespace {
    contains?(
      details: PermissionRequestDetails,
      callback?: (granted: boolean) => void
    ): Promise<boolean>
    request?(
      details: PermissionRequestDetails,
      callback?: (granted: boolean) => void
    ): Promise<boolean>
    remove?(
      details: PermissionRequestDetails,
      callback?: (granted: boolean) => void
    ): Promise<boolean>
    getAll?(callback?: (snapshot: PermissionsSnapshot) => void): Promise<PermissionsSnapshot>
    onAdded?: PermissionsEvent
    onRemoved?: PermissionsEvent
  }

  interface ChromeRoot {
    runtime?: { getManifest?(): ExtensionManifest }
    permissions?: ChromePermissionsNamespace
  }

  type CompatGlobal = typeof globalThis & {
    chrome?: ChromeRoot
  }

  const globals = globalThis as CompatGlobal
  const chromeApi = globals.chrome
  if (!chromeApi || typeof chromeApi !== 'object') return
  if (!chromeApi.runtime) return
  const existing = chromeApi.permissions
  if (existing && typeof existing.request === 'function') return

  const names = new Set<string>()
  const hosts: string[] = []
  try {
    const manifest: ExtensionManifest =
      typeof chromeApi.runtime.getManifest === 'function'
        ? chromeApi.runtime.getManifest() || {}
        : {}
    for (const key of ['permissions', 'optional_permissions'] as const) {
      const list = manifest[key]
      if (!Array.isArray(list)) continue
      for (const entry of list) if (typeof entry === 'string' && entry) names.add(entry)
    }
    for (const key of ['host_permissions', 'optional_host_permissions'] as const) {
      const list = manifest[key]
      if (!Array.isArray(list)) continue
      for (const entry of list)
        if (typeof entry === 'string' && entry && !hosts.includes(entry)) hosts.push(entry)
    }
  } catch {
    // A manifest that cannot be read grants nothing, which is the honest answer.
  }

  const evaluate = (details: PermissionRequestDetails): boolean => {
    const request = details && typeof details === 'object' ? details : {}
    const permissions = Array.isArray(request.permissions)
      ? request.permissions.filter((entry: string) => typeof entry === 'string' && entry)
      : []
    const origins = Array.isArray(request.origins)
      ? request.origins.filter((entry: string) => typeof entry === 'string' && entry)
      : []
    if (permissions.every((name) => names.has(name)) === false) return false
    return origins.every((origin) => typeof origin === 'string' && origin.length > 0)
  }

  const answer = <T>(callback: ((value: T) => void) | undefined, result: T): Promise<T> => {
    if (typeof callback === 'function') {
      try {
        Promise.resolve().then(() => callback(result))
      } catch {
        // A callback that throws is the page's problem, not the shim's.
      }
    }
    return Promise.resolve(result)
  }

  const stableEvent: PermissionsEvent = {
    addListener() {},
    removeListener() {},
    hasListener() {
      return false
    },
    hasListeners() {
      return false
    }
  }

  try {
    Object.defineProperty(chromeApi, 'permissions', {
      value: {
        contains: (details: PermissionRequestDetails, callback?: (granted: boolean) => void) =>
          answer(callback, evaluate(details)),
        request: (details: PermissionRequestDetails, callback?: (granted: boolean) => void) =>
          answer(callback, evaluate(details)),
        remove: (_details: PermissionRequestDetails, callback?: (granted: boolean) => void) =>
          answer(callback, false),
        getAll: (callback?: (snapshot: PermissionsSnapshot) => void) =>
          answer(callback, { permissions: [...names], origins: hosts.slice() }),
        onAdded: stableEvent,
        onRemoved: stableEvent
      },
      configurable: true,
      writable: true
    })
  } catch {
    // A runtime that refuses the property leaves the page with no permissions API.
  }
})()
