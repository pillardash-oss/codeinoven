/**
 * ── cookies, for real ───────────────────────────────────────────────────────
 * `chrome.cookies` is compiled out of this runtime entirely, and the download
 * manager extension this browser has to work with (AB Download Manager Browser
 * Integration) forwards the browser's cookies to its own app before it takes a
 * download over: with no namespace to read, every download it captured asked the
 * user to sign in again. The jar belongs to main, so a read is a question: it is
 * numbered here, posted over the bridge, and answered with the cookies in
 * `chrome.cookies`' own shape.
 *
 * Read-only, and saying so is the honest half: the app does not let an extension
 * rewrite its user's cookies, so `set`, `remove` and `removeAll` answer `false`
 * and leave that refusal in `runtime.lastError`, which is where Chromium puts one
 * and therefore where an extension already checks.
 *
 * Every top-level name here is exported because the read outlives install: the
 * bridge command hub settles an answer into {@link cookieRequests} through
 * {@link settleCookieRequest}, and the refusal path needs the same `lastError`
 * member the native messaging module sets.
 */
import { answerWith, ensureNamespace, state } from './context.ts'
import { currentBridgePort, setBridgePort } from './bridge.ts'
import { makeRealEvent } from './events.ts'
import { setRuntimeLastError } from './native-messaging.ts'

/** One cookie, in `chrome.cookies`' own shape: main builds it out of the session jar. */
export type CookieRecord = Record<string, unknown>

/** The filter `get` and `getAll` take, reduced to the members main matches on. */
export type CookieFilter = Record<string, unknown>

/** One read this worker is waiting on, and the timer that gives up on it. */
export interface PendingCookieRequest {
  resolve: (cookies: CookieRecord[]) => void
  timer: ReturnType<typeof setTimeout>
}

/** What this module records on `state.cookies`, which the app reads back. */
export interface CookieStats {
  requests: number
  answered: number
  timedOut: number
  refused: number
  lastError: string | null
  installed?: boolean
}

/**
 * The answer the app posts back for one read.
 *
 * Read as `unknown` member by member: it arrives from outside this module, and a
 * command that carried the wrong shape must fall out of the pending list as an
 * empty answer rather than throw inside the worker's message listener.
 */
export interface CookieResultCommand {
  requestId?: unknown
  error?: unknown
  cookies?: unknown
}

export const cookieMaxPending = 64
export const cookieTimeoutMs = 10000
export const cookieRequests = new Map<number, PendingCookieRequest>()
export let cookieRequestSeq = 0

/**
 * The object `state.cookies` points at.
 *
 * It is held here as well as on `state` because `PreambleState` carries an index
 * signature, so `state.cookies.requests` reads as `unknown`; the two names are the
 * same object, and `installCookies` puts this one on `state`.
 */
export const cookieStats: CookieStats = {
  requests: 0,
  answered: 0,
  timedOut: 0,
  refused: 0,
  lastError: null
}

export const cookieFilterTypes: Record<string, string> = {
  url: 'string',
  name: 'string',
  domain: 'string',
  path: 'string',
  secure: 'boolean',
  session: 'boolean'
}

/**
 * The filter members `get` and `getAll` define, kept only where the caller gave
 * the type the API documents. Main matches on these, and a stray value from an
 * object an extension built loosely would either match nothing or match
 * everything, and both answer a cookie list that is a lie about the jar.
 */
export function sanitizeCookieFilter(filter: unknown): CookieFilter {
  const source: CookieFilter = filter && typeof filter === 'object' ? (filter as CookieFilter) : {}
  const clean: CookieFilter = {}
  for (const key of Object.keys(cookieFilterTypes)) {
    if (typeof source[key] === cookieFilterTypes[key]) clean[key] = source[key]
  }
  return clean
}

/**
 * Ask main for cookies. Never rejects and never hangs: a worker whose read is
 * never answered still has work to do, and ten seconds is longer than any read
 * this app has to do, because main answers out of the session's own jar.
 */
export function requestCookies(filter: unknown): Promise<CookieRecord[]> {
  return new Promise<CookieRecord[]>((resolve) => {
    const bridgePort = currentBridgePort()
    if (!bridgePort || cookieRequests.size >= cookieMaxPending) {
      resolve([])
      return
    }
    const requestId = ++cookieRequestSeq
    const timer = setTimeout(() => {
      cookieRequests.delete(requestId)
      cookieStats.timedOut += 1
      resolve([])
    }, cookieTimeoutMs)
    cookieRequests.set(requestId, { resolve, timer })
    cookieStats.requests += 1
    try {
      bridgePort.postMessage({
        kind: 'cookies-request',
        requestId,
        filter: sanitizeCookieFilter(filter)
      })
    } catch (error) {
      state.errors.push('cookies-bridge: ' + String(error))
      setBridgePort(null)
      cookieRequests.delete(requestId)
      clearTimeout(timer)
      resolve([])
    }
  })
}

/**
 * Main's answer, or the fact that it could not read the jar.
 *
 * An error reads as the empty answer rather than a rejection, because the API's
 * own way of saying "no such cookie" is a value and not an exception, and an
 * extension thrown out of `get` loses the whole download rather than its
 * authentication. It is still recorded, so the capability report can name it.
 */
export function settleCookieRequest(command: CookieResultCommand): void {
  // A command whose request id is not the number this worker handed out matches no
  // pending read, which is what the lookup below answers for it anyway.
  if (typeof command.requestId !== 'number') return
  const pending = cookieRequests.get(command.requestId)
  if (!pending) return
  cookieRequests.delete(command.requestId)
  clearTimeout(pending.timer)
  if (command.error) {
    cookieStats.lastError = String(command.error)
    state.errors.push('cookies: ' + String(command.error))
    pending.resolve([])
    return
  }
  cookieStats.answered += 1
  pending.resolve(Array.isArray(command.cookies) ? (command.cookies as CookieRecord[]) : [])
}

export function refuseCookieWrite(callback: unknown): Promise<unknown> {
  cookieStats.refused += 1
  cookieStats.lastError = 'this app does not let an extension change its cookies'
  setRuntimeLastError(cookieStats.lastError)
  // Chromium's refusal is a `false` plus a `lastError`, and the error is cleared
  // once the caller's turn ends. The callback here runs on a microtask, so this
  // clear is queued behind the answer rather than before it.
  return answerWith(callback, false).then((value) => {
    setRuntimeLastError(null)
    return value
  })
}

export const cookiesApi = {
  get: (details: unknown, callback: unknown): Promise<unknown> =>
    requestCookies(details).then((cookies) =>
      answerWith(callback, cookies.length > 0 ? cookies[0] : null)
    ),
  getAll: (details: unknown, callback: unknown): Promise<unknown> =>
    requestCookies(details).then((cookies) => answerWith(callback, cookies)),
  // One jar in this runtime and no incognito windows, which is the shape the API
  // answers for a browser that has never partitioned its cookies.
  getAllCookieStores: (callback: unknown): Promise<unknown> =>
    answerWith(callback, [{ id: '0', tabIds: [] }]),
  set: (_details: unknown, callback: unknown): Promise<unknown> => refuseCookieWrite(callback),
  remove: (_details: unknown, callback: unknown): Promise<unknown> => refuseCookieWrite(callback),
  removeAll: (_details: unknown, callback: unknown): Promise<unknown> =>
    refuseCookieWrite(callback),
  // A change cannot be observed because a change cannot be made. The event is
  // real rather than absent so an extension that registers on it while its own
  // modules evaluate does not throw on a namespace that has the rest.
  onChanged: makeRealEvent()
}

/** Install the read-only namespace on every root this runtime exposes. */
export function installCookies(): void {
  state.cookies = cookieStats
  ensureNamespace('cookies', cookiesApi, [])
  cookieStats.installed = state.namespaces.indexOf('cookies') !== -1
}
