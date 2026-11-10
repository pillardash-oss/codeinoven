/**
 * ── runtime.getContexts repair ──────────────────────────────────────────────
 * Electron never calls `extensions::SetViewType` anywhere in its shell (measured
 * on v44.7.0; the v44.7.0 to v44.7.2 and v44.7.2 to v44.8.0 shell diffs each add
 * no call site), so every
 * WebContents it hosts reports
 * `mojom::ViewType::kInvalid` (0). Chromium's
 * `RuntimeGetContextsFunction::GetFrameContexts` treats that value as a bug
 * ("NOTREACHED hit. Unexpected view type found: 0"), skips the frame and answers
 * `[]`, which means an extension polling this API never sees the popup this app
 * hosts for it, and the app's log fills with that line on every poll. Bitwarden
 * polls it for `isPopupOpen` and `isAnyViewFocused`.
 *
 * The worker can see what the browser process will not report: Electron's own
 * tabs implementation enumerates every WebContents of the session, and a
 * long-lived port carries its sender's real document URL and ids. Both are
 * folded into an answer shaped like the API's, and the filter argument is
 * honoured the way Chromium honours it.
 *
 * WHAT IT HOLDS
 * The connected views the port listener collected (by document address, so a
 * popup and a tab are told apart exactly the way the extension's own checks tell
 * them apart), the two pure readers the answer is built from, and the one side
 * effect, `installContextsRepair`, which replaces `getContexts` on every root
 * that carries it. The views live at module scope because they are the answer's
 * only memory: the listener that fills them is registered here and nothing else
 * writes them.
 */
import { chromeApi, roots, state } from './context.ts'
import type { ChromeNamespace, PreambleEvent } from './context.ts'
import { BRIDGE_PAGE_MARKER } from './events.ts'

/** The view types `getContexts` answers with. */
export type ContextType = 'BACKGROUND' | 'TAB' | 'POPUP'

/** One context, in the shape `chrome.runtime.getContexts` answers with. */
export interface RuntimeContext {
  contextType: ContextType
  contextId: string
  documentId: string
  documentUrl?: string
  documentOrigin?: string
  frameId: number
  tabId: number
  windowId: number
  incognito: boolean
}

/**
 * The filter argument the API accepts. Every list is read the way Chromium reads
 * it, so the members stay untyped here: an extension may hand any of them.
 */
export interface ContextFilter {
  contextTypes?: unknown
  contextIds?: unknown
  tabIds?: unknown
  windowIds?: unknown
  documentIds?: unknown
  frameIds?: unknown
  documentUrls?: unknown
  documentOrigins?: unknown
  incognito?: unknown
}

/** The ids one connected port carries, which are the ones Chromium would report. */
export interface ConnectedView {
  documentId: string | null
  frameId: number
  tabId: number
}

/** The sender fields of one connected port, in the members this repair reads. */
export interface ConnectedSender {
  url?: unknown
  documentId?: unknown
  frameId?: unknown
  tab?: { id?: unknown }
}

/** One `runtime.onConnect` port, in the members this repair reads. */
export interface ConnectedPort {
  sender?: ConnectedSender
  onDisconnect?: PreambleEvent
}

/** One tab `chrome.tabs.query` answered with, as far as this repair reads it. */
export type ContextTab = Record<string, unknown>

/** Whatever a `tabs.query` call returns when it answers with a promise. */
interface Thenable {
  then(onFulfilled: (value: unknown) => void, onRejected: (error: unknown) => void): unknown
}

/** `chrome.runtime`, viewed with the members this repair reads and replaces. */
interface ContextsRuntime extends ChromeNamespace {
  getContexts?: (
    filter?: ContextFilter | null,
    callback?: unknown
  ) => Promise<RuntimeContext[]> | void
  getURL: (path: string) => string
  getManifest?: () => Record<string, unknown> | undefined
  onConnect?: PreambleEvent
}

/** `chrome.tabs`, viewed with the one call the context answer needs. */
interface ContextsTabs extends ChromeNamespace {
  query: (
    query: Record<string, unknown>,
    callback: (tabs: unknown) => void
  ) => Thenable | null | undefined
}

// The views this app has connected to, by document address. Ports carry real
// document and frame ids, and unlike the tab URL they need no permission to read.
export const connectedViews = new Map<string, ConnectedView>()

/** An address without its fragment: the two halves of a page are one document. */
export const withoutFragment = (url: unknown): string => String(url || '').split('#')[0]

/**
 * Whether one context passes the filter the way Chromium applies it: a list that is
 * absent or empty admits everything, and a non-list value is not a filter at all.
 */
export function matchesFilter(context: RuntimeContext, filter?: ContextFilter | null): boolean {
  const wanted = filter || {}
  const admits = (value: unknown, list: unknown): boolean =>
    !Array.isArray(list) || list.length === 0 || list.includes(value)
  if (!admits(context.contextType, wanted.contextTypes)) return false
  if (!admits(context.contextId, wanted.contextIds)) return false
  if (!admits(context.tabId, wanted.tabIds)) return false
  if (!admits(context.windowId, wanted.windowIds)) return false
  if (!admits(context.documentId, wanted.documentIds)) return false
  if (!admits(context.frameId, wanted.frameIds)) return false
  if (!admits(context.documentUrl, wanted.documentUrls)) return false
  if (!admits(context.documentOrigin, wanted.documentOrigins)) return false
  if (typeof wanted.incognito === 'boolean' && wanted.incognito !== context.incognito) return false
  return true
}

/**
 * Answer `getContexts` from what this app can see, on every root that carries it.
 *
 * Nothing here throws: a runtime without the member is left as it is, and a root
 * that refuses the property is recorded on `state.errors` rather than raised,
 * because a worker with no shims at all is worse than one wrong answer.
 */
export function installContextsRepair(): void {
  try {
    const runtime = chromeApi.runtime as ContextsRuntime | undefined
    if (
      runtime &&
      typeof runtime.getContexts === 'function' &&
      typeof runtime.getURL === 'function'
    ) {
      const origin = runtime.getURL('')
      const ownManifest =
        typeof runtime.getManifest === 'function' ? runtime.getManifest() || {} : {}
      const declaredPopup = (
        (ownManifest.action || ownManifest.browser_action || {}) as Record<string, unknown>
      ).default_popup
      const popupHref =
        typeof declaredPopup === 'string' && declaredPopup
          ? new URL(declaredPopup, origin).href
          : null
      const isOwnPage = (url: unknown): boolean => typeof url === 'string' && url.startsWith(origin)

      // Ports first: they carry real document and frame ids, and unlike the tab
      // URL they need no permission to read.
      try {
        const onConnect = runtime.onConnect
        if (onConnect && typeof onConnect.addListener === 'function') {
          onConnect.addListener((port) => {
            try {
              const opened = (port || {}) as ConnectedPort
              const sender: ConnectedSender = opened.sender || {}
              const url = withoutFragment(sender.url)
              if (!isOwnPage(url)) return
              connectedViews.set(url, {
                documentId: typeof sender.documentId === 'string' ? sender.documentId : null,
                frameId: typeof sender.frameId === 'number' ? sender.frameId : 0,
                tabId: sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : -1
              })
              if (opened.onDisconnect && typeof opened.onDisconnect.addListener === 'function') {
                opened.onDisconnect.addListener(() => connectedViews.delete(url))
              }
            } catch (error) {
              state.errors.push('contexts-port: ' + String(error))
            }
          })
        }
      } catch (error) {
        state.errors.push('contexts-onConnect: ' + String(error))
      }

      // A hosted popup loads the declared popup address itself; a popout is the
      // same document reached through an address that carries its own parameters.
      // Comparing the whole address keeps the two apart, which is what the
      // extension's own TAB-versus-POPUP checks depend on.
      const contextTypeOf = (url: string): ContextType | null => {
        if (!isOwnPage(url)) return null
        // The app's own bridge page is not part of the extension's UI, and
        // reporting it as a context would make an extension believe one of its
        // own pages is open.
        if (url.indexOf(BRIDGE_PAGE_MARKER) !== -1) return null
        return popupHref && url === popupHref ? 'POPUP' : 'TAB'
      }

      const contextOf = (url: string, ids: ConnectedView): RuntimeContext | null => {
        const contextType = contextTypeOf(url)
        if (!contextType) return null
        return {
          contextType,
          // Chromium answers with document UUIDs and a context UUID. Nothing in
          // this runtime hands those out for a hosted view, so the address is
          // used as a stable stand-in rather than a fresh random value per call.
          contextId: ids.documentId || url,
          documentId: ids.documentId || url,
          documentUrl: url,
          documentOrigin: origin,
          frameId: ids.frameId,
          tabId: ids.tabId,
          windowId: -1,
          incognito: false
        }
      }

      // Callback form, because it is the one shape that works whether or not the
      // runtime also returns a promise. A tab list that never arrives must not
      // leave the extension's `await` hanging, so it is time-boxed.
      const queryTabs = (): Promise<ContextTab[]> =>
        new Promise<ContextTab[]>((resolve) => {
          const tabsApi = chromeApi.tabs as ContextsTabs | undefined
          let settled = false
          const settle = (tabs: unknown): void => {
            if (settled) return
            settled = true
            resolve(Array.isArray(tabs) ? (tabs as ContextTab[]) : [])
          }
          if (!tabsApi || typeof tabsApi.query !== 'function') {
            settle([])
            return
          }
          try {
            const returned = tabsApi.query({}, settle)
            if (returned && typeof returned.then === 'function')
              returned.then(settle, () => settle([]))
          } catch (error) {
            state.errors.push('contexts-tabs: ' + String(error))
            settle([])
          }
          setTimeout(() => settle([]), 2000)
        })

      const repaired = (filter?: ContextFilter | null): Promise<RuntimeContext[]> =>
        queryTabs()
          .then((tabs) => {
            const contexts: RuntimeContext[] = [
              {
                contextType: 'BACKGROUND',
                contextId: 'cio-background',
                documentId: 'cio-background',
                frameId: 0,
                tabId: -1,
                windowId: -1,
                incognito: false
              }
            ]
            const claimed = new Set<string>()
            for (const entry of connectedViews) {
              const context = contextOf(entry[0], entry[1])
              if (!context) continue
              contexts.push(context)
              claimed.add(entry[0])
            }
            for (const tab of tabs) {
              const url = withoutFragment(tab.url)
              if (!url || claimed.has(url)) continue
              const context = contextOf(url, {
                documentId: null,
                frameId: 0,
                tabId: typeof tab.id === 'number' ? tab.id : -1
              })
              if (context) contexts.push(context)
            }
            state.runtimeContexts = {
              answered: true,
              popupHref,
              count: contexts.length,
              types: contexts.map((context) => context.contextType)
            }
            return filter ? contexts.filter((context) => matchesFilter(context, filter)) : contexts
          })
          .catch((error) => {
            state.errors.push('contexts-answer: ' + String(error))
            return []
          })

      let repairedOn = 0
      for (const root of roots) {
        const target = root.runtime as ContextsRuntime | undefined
        if (!target || typeof target.getContexts !== 'function') continue
        try {
          Object.defineProperty(target, 'getContexts', {
            value: repaired,
            configurable: true,
            writable: true
          })
          repairedOn += 1
        } catch (error) {
          state.errors.push('contexts-define: ' + String(error))
        }
      }
      state.getContextsRepair = repairedOn > 0 ? 'installed' : 'not-installed'
    }
  } catch (error) {
    state.errors.push('contexts: ' + String(error))
  }
}
