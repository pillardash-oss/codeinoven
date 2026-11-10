/**
 * The event objects the app fires itself, and the tab, window and runtime events it
 * replaces so that a listener registered on the runtime's own event is the listener
 * that gets called.
 *
 * WHY THIS MODULE EXISTS
 * The runtime ships these events and never fires one, so a listener registered on the
 * native object waits forever: Electron delivers no tab lifecycle events to an
 * extension (measured: zero `tabs.on*` events across three navigations), no window
 * events for a window it did not open, and no runtime startup for a worker the app
 * restarted. This module owns the dispatchers that take their place. One dispatcher
 * per event, defined on both roots, so a listener is called whichever root the
 * extension registered it on.
 *
 * `makeRealEvent` is exported because the other concerns need the same object: the
 * download, cookie, webRequest, notification, side-panel, context-menu and action
 * events are all fired by the app through the bridge, and each of them needs a real
 * listener-backed event to fire at, not the quiet placeholder `makeEvent` returns.
 */
import { roots, state } from './context.ts'
import type { ChromeNamespace, PreambleEvent } from './context.ts'

// ── The app bridge: lifecycle in, state out ─────────────────────────────────
// Electron delivers no tab lifecycle events to an extension (measured: zero
// `tabs.on*` events across three navigations), and it has no API to read an
// extension's action state back. The app supplies both through the bridge page
// it writes into this copy beside the preamble: main drives that page with
// `executeJavaScript`, the page `runtime.sendMessage`s into this worker, and
// everything this worker wants the app to know is written to one storage key
// the page reads back on demand. See `browser-extension-bridge.ts`.
export const BRIDGE_PAGE_MARKER = '/cio-bridge.html'

/** One listener, in the shape every `chrome` event is handed them. */
export type RealListener = (...args: unknown[]) => void

/** An event that holds real listeners and can be fired at them. */
export interface RealEvent extends PreambleEvent {
  /** How many listeners this event holds. */
  __cioCount: () => number
  /** Fire this event at every listener it holds, one failure isolated per listener. */
  __cioEmit: (args: unknown[]) => void
}

export const makeRealEvent = (): RealEvent => {
  const listeners: RealListener[] = []
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
    hasListener: (listener) => listeners.indexOf(listener as RealListener) !== -1,
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
export const tabEvents: Record<string, RealEvent> = {}

// The same for the two window events this app is the author of, for the reason
// the window itself exists: Electron has no extension window, so the app hands
// the extension one (`chrome.windows.create` answers with it from below) and the
// app is the only side that can report it gone. A password manager waits on
// `onRemoved` to abandon the passkey prompt that window was showing, so a window
// that closes without this event leaves the page's ceremony pending forever.
export const windowEvents: Record<string, RealEvent> = {}

// The same for the two runtime events the app synthesizes.
export const runtimeEvents: Record<string, RealEvent> = {}

/**
 * Replace this runtime's tab, window and runtime events with the app's dispatchers.
 *
 * Each event is defined on every root that carries its namespace, and a failure to
 * define one is recorded rather than raised: an extension that never hears a tab
 * close is a bug the report names, and a preamble that throws is a worker with no
 * shims at all.
 */
export function installEvents(): void {
  for (const name of ['onCreated', 'onUpdated', 'onRemoved', 'onActivated', 'onHighlighted']) {
    const dispatcher = makeRealEvent()
    tabEvents[name] = dispatcher
    for (const root of roots) {
      const tabsApi = root && (root.tabs as ChromeNamespace | undefined)
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

  for (const name of ['onCreated', 'onRemoved', 'onFocusChanged', 'onBoundsChanged']) {
    const dispatcher = makeRealEvent()
    windowEvents[name] = dispatcher
    for (const root of roots) {
      const windowsApi = root && (root.windows as ChromeNamespace | undefined)
      if (!windowsApi) continue
      try {
        Object.defineProperty(windowsApi, name, {
          value: dispatcher,
          configurable: true,
          writable: true
        })
      } catch (error) {
        state.errors.push('windows-' + name + ': ' + String(error))
      }
    }
  }

  for (const name of ['onStartup', 'onInstalled']) {
    const dispatcher = makeRealEvent()
    runtimeEvents[name] = dispatcher
    for (const root of roots) {
      const runtimeApi = root && (root.runtime as ChromeNamespace | undefined)
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
}
