/**
 * `chrome.windows` and `chrome.tabs.create`, answered by the app that owns the tabs.
 *
 * This runtime has no second window to put a page in: a browser window here is the
 * app's own. A popup on the extension's own page is the popout this shim has always
 * hosted in the rail; any other window, and every tab an extension asks for, becomes
 * a tab of the browser the extension is acting in. A password manager's "launch" row
 * is exactly that call, and the runtime's stub answered it with nothing, so the click
 * opened no page at all.
 *
 * Only an absolute `http(s)` address is routed; anything else keeps the runtime's own
 * answer, and a request that cannot be routed falls through to it as well.
 */
import { answerWith, noop, roots, state } from './context.ts'
import {
  HOSTED_POPUP_WINDOW_ID,
  hostedPopout,
  hostedWindow,
  ownExtensionPageUrl,
  routePopupWindowRequest,
  routeRequestWhenTabKnown,
  webWindowUrl
} from './bridge.ts'

/** A `chrome.windows` namespace, as far as this file reads and rewrites it. */
interface WindowsApi {
  [member: string]: unknown
  create?: (...args: unknown[]) => unknown
  remove?: (...args: unknown[]) => unknown
  update?: (...args: unknown[]) => unknown
  get?: (...args: unknown[]) => unknown
  getCurrent?: (...args: unknown[]) => unknown
  getLastFocused?: (...args: unknown[]) => unknown
}

/** A `chrome.tabs` namespace, as far as this file rewrites it. */
interface TabsApi {
  [member: string]: unknown
  create?: (...args: unknown[]) => unknown
}

/** One window the runtime or this shim answers with, plus the marker it stamps. */
type WrappedMember = ((...args: unknown[]) => unknown) & {
  __cioHostedPopoutWrapped?: boolean
  __cioOpenTabWrapped?: boolean
}

/** The callback an extension handed as the last argument, if it handed one. */
function trailingCallback(args: unknown[]): ((value?: unknown) => void) | null {
  const candidate = args[args.length - 1]
  return typeof candidate === 'function' ? (candidate as (value?: unknown) => void) : null
}

/** The first argument of a `create` call, as the record it is documented to be. */
function createProperties(args: unknown[]): Record<string, unknown> {
  const first = args[0]
  return first && typeof first === 'object' ? (first as Record<string, unknown>) : {}
}

/** The one address a `create` call asked for, whichever shape it used. */
function requestedUrl(data: Record<string, unknown>): unknown {
  return Array.isArray(data['url']) ? data['url'][0] : data['url']
}

/**
 * Answer `chrome.windows` from the app's own windows.
 *
 * Each member is wrapped once and marked, so a second call in the same worker does
 * not wrap a wrapper.
 */
export function wrapWindowsApi(api: WindowsApi | undefined): void {
  if (!api || typeof api !== 'object') return
  const originals = {
    create: (typeof api.create === 'function' ? api.create : noop) as WrappedMember,
    remove: (typeof api.remove === 'function' ? api.remove : noop) as WrappedMember,
    update: (typeof api.update === 'function' ? api.update : noop) as WrappedMember,
    get: (typeof api.get === 'function' ? api.get : noop) as WrappedMember,
    getCurrent: (typeof api.getCurrent === 'function' ? api.getCurrent : noop) as WrappedMember,
    getLastFocused: (typeof api.getLastFocused === 'function'
      ? api.getLastFocused
      : noop) as WrappedMember
  }
  const install = (name: string, wrapped: unknown): void => {
    try {
      Object.defineProperty(api, name, { value: wrapped, configurable: true, writable: true })
    } catch (error) {
      state.errors.push('windows-' + name + '-wrap: ' + String(error))
    }
  }

  const originalCreate = originals.create
  if (!originalCreate.__cioHostedPopoutWrapped) {
    const wrapped: WrappedMember = function (this: unknown, ...args: unknown[]) {
      const data = createProperties(args)
      const ownUrl = ownExtensionPageUrl(requestedUrl(data))
      // A popup window on the extension's own page is the popout this shim has
      // always hosted in the rail. Any other window   a normal window, or a
      // window on the web   has no second window to open in, because the
      // browser window here is the app's own, so it becomes a tab of the
      // browser that asked.
      if (ownUrl && data['type'] === 'popup') {
        const callback = trailingCallback(args)
        return routeRequestWhenTabKnown('open-window', ownUrl).then(
          (routed) => {
            if (!routed) return originalCreate.apply(this, args)
            hostedPopout.url = ownUrl
            hostedPopout.focused = true
            return answerWith(callback, hostedWindow(HOSTED_POPUP_WINDOW_ID, true))
          },
          (error: unknown) => {
            // This file must never throw, so a wait that failed is a window the
            // runtime is asked for instead of a promise the caller cannot settle.
            state.errors.push('windows-create-route: ' + String(error))
            return originalCreate.apply(this, args)
          }
        )
      }
      const tabUrl = ownUrl || webWindowUrl(requestedUrl(data))
      if (tabUrl) {
        const callback = trailingCallback(args)
        return routeRequestWhenTabKnown('open-tab', tabUrl).then(
          (routed) => {
            if (!routed) return originalCreate.apply(this, args)
            // The answer is the browser window, without tabs, which is what
            // Chromium returns for a `windows.create` that did not ask to be
            // populated; the new tab announces itself as `onCreated`.
            return answerWith(callback, hostedWindow(0, true))
          },
          (error: unknown) => {
            state.errors.push('windows-create-tab-route: ' + String(error))
            return originalCreate.apply(this, args)
          }
        )
      }
      return originalCreate.apply(this, args)
    }
    wrapped.__cioHostedPopoutWrapped = true
    install('create', wrapped)
  }

  const originalRemove = originals.remove
  if (!originalRemove.__cioHostedPopoutWrapped) {
    const wrapped: WrappedMember = function (this: unknown, ...args: unknown[]) {
      if (args[0] === HOSTED_POPUP_WINDOW_ID && hostedPopout.url) {
        hostedPopout.focused = false
        if (routePopupWindowRequest('hide-window', hostedPopout.url)) {
          const callback = trailingCallback(args)
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
    const wrapped: WrappedMember = function (this: unknown, ...args: unknown[]) {
      const update =
        args[1] && typeof args[1] === 'object' ? (args[1] as Record<string, unknown>) : {}
      // Browser tabs belong to the app's window 0. Bitwarden awaits this
      // callback in its passkey request's finally block before returning the
      // assertion to the site. Electron has no windows.update implementation,
      // so falling through to its placeholder leaves the response pending.
      if ((args[0] === 0 || args[0] === -2) && typeof update['focused'] === 'boolean') {
        if (update['focused'] === true) routePopupWindowRequest('focus-browser')
        const callback = trailingCallback(args)
        return answerWith(callback, hostedWindow(0, update['focused'] === true))
      }
      if (args[0] === HOSTED_POPUP_WINDOW_ID && hostedPopout.url) {
        if (routePopupWindowRequest('focus-window', hostedPopout.url)) {
          hostedPopout.focused = true
          const callback = trailingCallback(args)
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
    const wrapped: WrappedMember = function (this: unknown, ...args: unknown[]) {
      const id = args[0]
      if (id === HOSTED_POPUP_WINDOW_ID || id === 0 || id === -1 || id === -2) {
        const callback = trailingCallback(args)
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
    const original = name === 'getCurrent' ? originals.getCurrent : originals.getLastFocused
    if (original.__cioHostedPopoutWrapped) continue
    const wrapped: WrappedMember = function (...args: unknown[]) {
      const callback = trailingCallback(args)
      return answerWith(callback, hostedWindow(0, true))
    }
    wrapped.__cioHostedPopoutWrapped = true
    install(name, wrapped)
  }
}

/**
 * `chrome.tabs.create`, which this runtime cannot honour from a worker either.
 *
 * A page an extension opens is the same rule as a window on the web: there is no
 * second window here, because a browser window is the app's own, so the address
 * becomes a tab of the browser the extension is acting in. A password manager's
 * "launch" from a notification or an overlay is exactly this call, and the stub
 * answered it with nothing, so the click opened no page at all.
 *
 * Only an absolute `http(s)` address is routed; anything else   a page of the
 * extension's own, which is a window rather than a tab   keeps the runtime's own
 * answer. A request that cannot be routed falls through to it as well.
 */
export function wrapTabsApi(api: TabsApi | undefined): void {
  if (!api || typeof api !== 'object') return
  const create = (typeof api.create === 'function' ? api.create : noop) as WrappedMember
  if (create.__cioOpenTabWrapped) return
  const wrapped: WrappedMember = function (this: unknown, ...args: unknown[]) {
    const url = webWindowUrl(requestedUrl(createProperties(args)))
    if (!url) return create.apply(this, args)
    const callback = trailingCallback(args)
    return routeRequestWhenTabKnown('open-tab', url).then(
      (routed) => {
        if (!routed) return create.apply(this, args)
        // The tab is the app's to create, so the caller is answered without an
        // id it could not be given: what it asked for was that the page opens.
        return answerWith(callback, undefined)
      },
      (error: unknown) => {
        state.errors.push('tabs-create-route: ' + String(error))
        return create.apply(this, args)
      }
    )
  }
  wrapped.__cioOpenTabWrapped = true
  try {
    Object.defineProperty(api, 'create', { value: wrapped, configurable: true, writable: true })
  } catch (error) {
    state.errors.push('tabs-create-wrap: ' + String(error))
  }
}

/** Wrap every root's window and tab namespace with the app's answers. */
export function installWindowsTabs(): void {
  for (const root of roots) wrapWindowsApi((root['windows'] as WindowsApi | undefined) ?? undefined)
  for (const root of roots) wrapTabsApi((root['tabs'] as TabsApi | undefined) ?? undefined)
}
