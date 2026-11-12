/**
 * The toolbar state an extension sets, recorded for the app, and the namespace every
 * extension is guaranteed to reach it through.
 *
 * WHY THIS MODULE EXISTS
 * This runtime compiles out `browserAction` entirely and exposes `action` only to an
 * MV3 extension, and a missing toolbar namespace is not a missing badge: it is an
 * extension that dies on its own startup path (measured: uBlock Origin classic throws
 * on `chrome.browserAction.setBadgeBackgroundColor`). So this module records what a
 * toolbar call set into the state the app mirrors, and hands an MV2 extension a
 * namespace to call at all.
 *
 * The recording half is deliberately thin. Nothing here decides anything: every
 * value is whatever the extension handed over, written into `actionState` from
 * `mailbox.ts`, which is the record the app reads back. A popup request is not
 * recorded here either; it is routed by `bridge.ts`, which knows the tab.
 */
import { routeRequestWhenTabKnown } from './bridge.ts'
import { chromeApi, noop, roots, state } from './context.ts'
import type { ChromeNamespace, ChromeRoot } from './context.ts'
import { makeRealEvent } from './events.ts'
import { actionState, scheduleMailbox } from './mailbox.ts'

// ── action state, recorded ──────────────────────────────────────────────────

/**
 * The first argument of a toolbar call: the tab it applies to, and the value that
 * particular member carries. Every field is `unknown` where the member reads it,
 * because the extension's own JavaScript supplies it.
 */
export interface ActionDetails {
  tabId?: number | null
  text?: unknown
  color?: unknown
  title?: unknown
  imageData?: unknown
  path?: unknown
}

/** What one wrapped member records for the app from its call's first argument. */
type ActionPatchBuilder = (details: ActionDetails) => Record<string, unknown> | null

/** One action member, in the shape this module wraps and marks as already wrapped. */
interface WrapableActionMember {
  (this: unknown, ...args: unknown[]): unknown
  __cioWrapped?: boolean
}

/** The one member of `chrome.runtime` this module needs typed. */
interface IconUrlRuntime extends ChromeNamespace {
  getURL: (path: string) => string
}

export function normalizeBadgeColor(color: unknown): string | null {
  if (typeof color === 'string' && color) return color
  if (Array.isArray(color) && color.length >= 3) {
    const alpha = color.length > 3 && typeof color[3] === 'number' ? color[3] : 255
    return alpha >= 255
      ? 'rgb(' + color[0] + ',' + color[1] + ',' + color[2] + ')'
      : 'rgba(' + color[0] + ',' + color[1] + ',' + color[2] + ',' + alpha / 255 + ')'
  }
  return null
}

export function resolveIconPath(path: unknown): string | null {
  try {
    if (typeof path === 'string' && path) return (chromeApi.runtime as IconUrlRuntime).getURL(path)
    if (path && typeof path === 'object') {
      const images = path as Record<string, unknown>
      const sizes = Object.keys(images)
        .map((key) => Number(key))
        .filter((size) => Number.isFinite(size))
        .sort((left, right) => left - right)
      if (sizes.length === 0) return null
      const chosen = sizes.find((size) => size >= 19) ?? sizes[sizes.length - 1]
      const file = images[chosen] ?? images[String(chosen)]
      return typeof file === 'string' && file
        ? (chromeApi.runtime as IconUrlRuntime).getURL(file)
        : null
    }
  } catch (error) {
    state.errors.push('icon-path: ' + String(error))
  }
  return null
}

/**
 * Write one call's patch into the record the app mirrors, then ask for a mailbox write.
 *
 * A patch with no tab id is global; one with a tab id is that tab's, so a badge the
 * extension set for one page is not shown on every page. Tab `-1` means the same as
 * no tab, which is how Chromium documents it.
 */
export function recordAction(
  details: ActionDetails | null | undefined,
  patch: Record<string, unknown>
): void {
  const target = (
    !details || details.tabId === undefined || details.tabId === null || details.tabId === -1
      ? actionState.global
      : (actionState.tabs[String(details.tabId)] ?? (actionState.tabs[String(details.tabId)] = {}))
  ) as Record<string, unknown>
  Object.assign(target, patch)
  scheduleMailbox()
}

/**
 * Replace one member of a toolbar namespace with a recorder.
 *
 * The runtime's own member still runs, and its answer is still what the extension
 * gets; the wrapper only reads the arguments on the way past. A member the namespace
 * does not have at all is given a no-op first, because a missing method throws where a
 * missing value merely does nothing, and the value it records is what the extension
 * asked for rather than what the runtime did.
 */
export function wrapActionMember(
  api: ChromeNamespace,
  key: string,
  build: ActionPatchBuilder
): void {
  try {
    if (!Object.prototype.hasOwnProperty.call(api, key) || typeof api[key] !== 'function') {
      Object.defineProperty(api, key, { value: noop, configurable: true, writable: true })
      state.installed.push('action.' + key)
    }
    const current = api[key] as WrapableActionMember
    if (typeof current !== 'function' || current.__cioWrapped) return
    // The arguments are a rest array rather than `arguments`, which is the same copy
    // the original closure made before the call ran.
    const wrapped: WrapableActionMember = function (this: unknown, ...args: unknown[]) {
      try {
        const patch = build(args[0] as ActionDetails)
        if (patch) recordAction(args[0] as ActionDetails, patch)
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

export const routeActionPopupRequest = async (): Promise<void> => {
  try {
    // The worker may not know a tab yet: a request from a worker that has just
    // started is one this app must still answer. See
    // `routeRequestWhenTabKnown`.
    await routeRequestWhenTabKnown('action')
  } catch (error) {
    state.errors.push('action-open-popup: ' + String(error))
  }
}

export function wrapActionApi(api: ChromeNamespace | null): void {
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
export function synthesizeActionNamespace(root: ChromeRoot, name: string): ChromeNamespace | null {
  const api: ChromeNamespace = {}
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

/** Install the recorder, and make sure every root has both toolbar names. */
export function installAction(): void {
  for (const root of roots) {
    if (!root) continue
    const actionApi =
      root.action && typeof root.action === 'object' ? (root.action as ChromeNamespace) : null
    // Manifest V2 reaches its toolbar through `browserAction`, and an MV2 extension
    // gets neither name here: the runtime compiles in only MV3's `action`, and
    // exposes it only to an MV3 extension. A missing namespace there is not a
    // missing badge, it is an extension that dies on its own startup path
    // (measured: uBlock Origin classic throws on
    // `chrome.browserAction.setBadgeBackgroundColor`). So one is always provided:
    // the runtime's own `action` when there is one, and otherwise a namespace built
    // from the members this file already knows how to record.
    let browserActionApi =
      root.browserAction && typeof root.browserAction === 'object'
        ? (root.browserAction as ChromeNamespace)
        : null
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
      state.browserActionAlias = (Number(state.browserActionAlias) || 0) + 1
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
}
