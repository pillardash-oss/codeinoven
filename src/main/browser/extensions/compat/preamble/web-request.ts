/**
 * ── webRequest, for real ────────────────────────────────────────────────────
 * The stub block above installs the whole namespace as events that never fire,
 * which is why AB Download Manager Browser Integration silently captured
 * nothing: it decides whether a request is one to take over from what
 * `chrome.webRequest` told it, and an event that never fires is
 * indistinguishable from a browser that made no request at all. The app already
 * watches its own session's network activity, so these five are dispatchers with
 * the app's observations behind them, each called with the API's own details
 * shape.
 *
 * Only these five. Redirects, auth challenges and the request bodies are not
 * things the app reports, so those events stay the stubs they were rather than
 * adding to what this file claims.
 *
 * The dispatchers are exported because the app fires them long after install: the
 * bridge command hub looks one up by name in {@link webRequestEvents}.
 */
import { roots, state } from './context.ts'
import type { ChromeNamespace } from './context.ts'
import { makeRealEvent } from './events.ts'
import type { RealEvent } from './events.ts'

/** The five events the app has observations for, in the API's own names. */
export const webRequestEventNames: string[] = [
  'onSendHeaders',
  'onResponseStarted',
  'onHeadersReceived',
  'onCompleted',
  'onErrorOccurred'
]

/** The dispatchers the app fires, by the API's own names. */
export const webRequestEvents: Record<string, RealEvent> = {}

/**
 * Replace the stub events of this namespace with the app's dispatchers, on every
 * root that carries it.
 *
 * Replaced, not ensured: these members are the placeholders `installNamespaces`
 * installed, so overwriting them replaces a stub rather than clobbering something
 * the runtime provided.
 */
export function installWebRequest(): void {
  for (const name of webRequestEventNames) {
    const dispatcher = makeRealEvent()
    webRequestEvents[name] = dispatcher
    for (const root of roots) {
      const api = root && (root['webRequest'] as ChromeNamespace | undefined)
      if (!api) continue
      try {
        // Enumerable, like the runtime's own events: an extension that discovers
        // what it can listen to by iterating must see these.
        Object.defineProperty(api, name, {
          value: dispatcher,
          configurable: true,
          writable: true,
          enumerable: true
        })
      } catch (error) {
        state.errors.push('webRequest.' + name + ': ' + String(error))
      }
    }
  }
  state.webRequest = { events: webRequestEventNames.slice(), real: true }
}
