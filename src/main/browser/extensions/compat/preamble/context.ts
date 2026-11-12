/**
 * The floor every preamble concern module stands on.
 *
 * WHY THIS MODULE EXISTS
 * The preamble was one 3,622 line closure. A closure shares everything by accident:
 * any section could read any other section's variable, so nothing could be moved or
 * checked on its own, and the file was past the repository's line ceiling. The split
 * keeps the injected copy a single IIFE (see `index.ts`, which the app bundles), and
 * this module holds the handful of things every concern needs: the runtime's own
 * objects, the add-only `ensure` helpers, and the state the app reads back.
 *
 * THE ONE RULE THAT SURVIVED EVERYTHING
 * A preamble that throws is worse than no preamble, because the extension's own code
 * then never runs at all. `ensure` is add-only, every installed member is recorded on
 * `state`, and a failure is recorded rather than raised.
 */

/** What the app reads back as `chrome.storage.local.get('__cioCompatReport')`. */
export interface PreambleState {
  installed: string[]
  namespaces: string[]
  errors: string[]
  /** Written by `installSurfaceCapture`; the runtime's own pre-patch surface. */
  surface?: Record<string, string[]>
  userAgent?: string | null
  browserObject?: {
    present: boolean
    sameObjectAsChrome: boolean
    namespaces: string[]
    hasPermissions: string
    webRequestMemberCount: number | null
  }
  roots?: number
  [key: string]: unknown
}

/** A `chrome` namespace object, read and written through its member names. */
export interface ChromeNamespace {
  [member: string]: unknown
}

/** One `chrome` root: `chrome` itself, and the `browser` object beside it. */
export interface ChromeRoot {
  [namespace: string]: unknown
}

/** One `addListener` object, the shape every `chrome` event has. */
export interface PreambleEvent {
  addListener: (listener: (...args: unknown[]) => void) => void
  removeListener: (listener: (...args: unknown[]) => void) => void
  hasListener: (listener: unknown) => boolean
  hasListeners: () => boolean
}

declare global {
  var __cioCompat: PreambleState | undefined
  var chrome: ChromeRoot | undefined
  var browser: ChromeRoot | undefined
}

export const state: PreambleState =
  globalThis.__cioCompat || (globalThis.__cioCompat = { installed: [], namespaces: [], errors: [] })

/**
 * The runtime's chrome object.
 *
 * Read as present: the app installs this preamble only where a `chrome` object
 * exists, `index.ts` checks `hasChromeApi` before calling any concern, and a concern
 * module does nothing but declare functions, so nothing here runs unguarded.
 */
export const chromeApi = globalThis.chrome as ChromeRoot

/** The distinct `browser` object this runtime also exposes, where it exposes one. */
export const browserApi = globalThis.browser

/** Whether there is a runtime to patch at all; the entry checks this first. */
export const hasChromeApi = Boolean(globalThis.chrome)

/** One namespace of one root, or `undefined` when the root does not carry it. */
export function namespaceOf(
  root: ChromeRoot | undefined,
  name: string
): ChromeNamespace | undefined {
  if (!root) return undefined
  const value = root[name]
  return value && typeof value === 'object' ? (value as ChromeNamespace) : undefined
}

/**
 * The runtime exposes `chrome` and a distinct `browser` object, and the two do not
 * carry the same surface. An extension that reaches for `browser.*` (uBlock Origin
 * Lite, AdGuard, 1Password all do) has to be patched on both roots, or it throws on a
 * namespace that exists on the other one.
 */
export const roots: ChromeRoot[] = []
for (const candidate of [chromeApi, browserApi]) {
  if (candidate && typeof candidate === 'object' && !roots.includes(candidate))
    roots.push(candidate)
}

export const noop = function (): void {}

export const makeEvent = (): PreambleEvent => ({
  addListener: noop,
  removeListener: noop,
  hasListener: () => false,
  hasListeners: () => false
})

/**
 * Add one member to a namespace, never replacing something the runtime already has.
 *
 * The `installed` list this appends to is the record the capability report is built
 * from, so a member that was already present is not claimed here.
 */
export function ensureMember(
  target: ChromeNamespace | undefined,
  key: string,
  value: unknown
): void {
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
 * Chrome's shimmed methods have to answer both ways: an extension may pass a callback
 * or await a promise, and the two are used interchangeably in the wild. The callback
 * is deferred a microtask rather than called in line, because a listener that runs
 * before the shimmed call returns sees a value the caller has not been handed yet.
 */
export function answerWith(callback: unknown, result: unknown): Promise<unknown> {
  if (typeof callback === 'function') {
    try {
      Promise.resolve().then(() => (callback as (value: unknown) => void)(result))
    } catch (error) {
      state.errors.push('callback: ' + String(error))
    }
  }
  return Promise.resolve(result)
}

/**
 * A placeholder answer for a namespace this runtime has no truth for: the API's empty
 * shape, handed back both ways. A place that answers only one way hangs the other
 * silently.
 */
export const answering =
  (value: unknown) =>
  (...args: unknown[]): Promise<unknown> =>
    answerWith(args[args.length - 1], value)

/** One member of one namespace of one root, for the concern modules that patch. */
export function installNamespaceOnRoot(
  root: ChromeRoot,
  name: string,
  members: ChromeNamespace,
  events: string[]
): void {
  try {
    let namespace = namespaceOf(root, name)
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

/** Guarantee one namespace on every root this runtime exposes. */
export function ensureNamespace(name: string, members: ChromeNamespace, events: string[]): void {
  for (const root of roots) installNamespaceOnRoot(root, name, members, events)
}

/**
 * Record the runtime's real surface before anything is patched.
 *
 * This is the evidence the install-time capability report is built from, because a
 * worker's globals are otherwise unreachable from app main.
 */
export function installSurfaceCapture(): void {
  try {
    const surface: Record<string, string[]> = {}
    for (const name of Object.keys(chromeApi)) {
      const value = chromeApi[name]
      if (value && typeof value === 'object') {
        surface[name] = Object.keys(value as ChromeNamespace).sort()
      }
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
  state.roots = roots.length
}
