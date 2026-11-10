/**
 * `chrome.runtime.openOptionsPage` and the `chrome.webNavigation` events.
 *
 * WHY THESE TWO TOGETHER
 * Both are the same defect: this runtime compiles the member out, so an extension
 * calls a method that is not there, or registers a listener on an event that never
 * fires. `openOptionsPage` is not part of this runtime at all, so AB Download
 * Manager Browser Integration's "More settings" item did nothing; the page it means
 * to show is the extension's own, and only the app can open a window for one, so the
 * intent goes over the bridge. The call answers at once, the way a fire-and-forget
 * method in Chrome does: nobody waits on a page appearing, and an `await` that never
 * settled would stall the click handler.
 *
 * The webNavigation dispatchers are what the app pushes the lifecycle it already
 * watches into. Main frame only: the app observes the main frame's own `did-*`
 * events, so a listener filtered to a subframe would never be called. Saying so here
 * is better than quietly dropping those events, and the capability report carries
 * the same limit.
 */
import { answerWith, roots, state } from './context.ts'
import type { ChromeNamespace } from './context.ts'
import { currentBridgePort, setBridgePort } from './bridge.ts'
import { makeRealEvent } from './events.ts'
import type { RealEvent } from './events.ts'

/** The runtime namespace this file adds `openOptionsPage` to. */
interface RuntimeApi extends ChromeNamespace {
  openOptionsPage?: (callback?: unknown) => Promise<unknown>
}

/** What the capability report says about the options-page repair. */
interface ExtensionPageReport {
  requested: number
  failed: number
  lastError: unknown
  installed?: number
}

let extensionPageSeq = 0

/**
 * The navigation dispatchers, exported because the app's own push fires them.
 *
 * One object shared by both roots, the same reason the tab dispatchers are shared:
 * an extension that registered on `browser.webNavigation` must be called when the
 * app pushes into `chrome.webNavigation`.
 */
export const webNavigationEvents: Record<string, RealEvent> = {}

/** The report this module keeps on `state`, typed. */
function extensionPages(): ExtensionPageReport {
  const report = (state['extensionPages'] ?? {
    requested: 0,
    failed: 0,
    lastError: null
  }) as ExtensionPageReport
  state['extensionPages'] = report
  return report
}

/** Ask the app to open one of this extension's own pages, over the bridge. */
export function requestExtensionPage(page: unknown): boolean {
  const report = extensionPages()
  extensionPageSeq += 1
  report.requested = extensionPageSeq
  const port = currentBridgePort()
  if (!port) {
    report.failed += 1
    report.lastError = 'the bridge page is not connected'
    return false
  }
  try {
    port.postMessage({
      kind: 'extension-page-request',
      requestId: extensionPageSeq,
      page
    })
    return true
  } catch (error) {
    state.errors.push('extension-page-bridge: ' + String(error))
    setBridgePort(null)
    report.failed += 1
    report.lastError = String(error)
    return false
  }
}

/** `chrome.runtime.openOptionsPage`: ask, then answer the way Chrome does. */
export function openOptionsPage(callback?: unknown): Promise<unknown> {
  requestExtensionPage('options')
  return answerWith(typeof callback === 'function' ? callback : null, undefined)
}

/** Install the options-page member and the navigation dispatchers. */
export function installExtensionPage(): void {
  extensionPages()
  let openOptionsPageInstalled = 0
  for (const root of roots) {
    const runtime = root && (root['runtime'] as RuntimeApi | undefined)
    if (!runtime) continue
    // Only where the runtime has none: a future Electron that implements this
    // itself is better than this shim and must not be shadowed by it.
    if (typeof runtime.openOptionsPage === 'function') continue
    try {
      Object.defineProperty(runtime, 'openOptionsPage', {
        value: openOptionsPage,
        configurable: true,
        writable: true
      })
      openOptionsPageInstalled += 1
    } catch (error) {
      state.errors.push('openOptionsPage: ' + String(error))
    }
  }
  extensionPages().installed = openOptionsPageInstalled

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
      const navigationApi = root && (root['webNavigation'] as ChromeNamespace | undefined)
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
  state['webNavigation'] = { events: Object.keys(webNavigationEvents), mainFrameOnly: true }
}
