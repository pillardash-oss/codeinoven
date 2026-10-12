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
  const chromeApi = globalThis.chrome
  if (!chromeApi || typeof chromeApi !== 'object') return
  if (!chromeApi.runtime) return
  const existing = chromeApi.permissions
  if (existing && typeof existing.request === 'function') return

  const names = new Set()
  const hosts = []
  try {
    const manifest =
      typeof chromeApi.runtime.getManifest === 'function'
        ? chromeApi.runtime.getManifest() || {}
        : {}
    for (const key of ['permissions', 'optional_permissions']) {
      const list = manifest[key]
      if (!Array.isArray(list)) continue
      for (const entry of list) if (typeof entry === 'string' && entry) names.add(entry)
    }
    for (const key of ['host_permissions', 'optional_host_permissions']) {
      const list = manifest[key]
      if (!Array.isArray(list)) continue
      for (const entry of list)
        if (typeof entry === 'string' && entry && !hosts.includes(entry)) hosts.push(entry)
    }
  } catch {
    // A manifest that cannot be read grants nothing, which is the honest answer.
  }

  const evaluate = (details) => {
    const request = details && typeof details === 'object' ? details : {}
    const permissions = Array.isArray(request.permissions)
      ? request.permissions.filter((entry) => typeof entry === 'string' && entry)
      : []
    const origins = Array.isArray(request.origins)
      ? request.origins.filter((entry) => typeof entry === 'string' && entry)
      : []
    if (permissions.every((name) => names.has(name)) === false) return false
    return origins.every((origin) => typeof origin === 'string' && origin.length > 0)
  }

  const answer = (callback, result) => {
    if (typeof callback === 'function') {
      try {
        Promise.resolve().then(() => callback(result))
      } catch {
        // A callback that throws is the page's problem, not the shim's.
      }
    }
    return Promise.resolve(result)
  }

  const stableEvent = {
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
        contains: (details, callback) => answer(callback, evaluate(details)),
        request: (details, callback) => answer(callback, evaluate(details)),
        remove: (_details, callback) => answer(callback, false),
        getAll: (callback) => answer(callback, { permissions: [...names], origins: hosts.slice() }),
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
