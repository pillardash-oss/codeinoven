/**
 * The port the app talks to this worker through, and the few things only the app can
 * answer: which tab is on screen, which frames a tab holds, and the window it hands
 * an extension.
 *
 * WHY THIS MODULE EXISTS
 * Electron delivers no tab lifecycle to a worker and no frame lookup at all, so
 * `chrome.webNavigation.getAllFrames` is a namespace whose every method is missing,
 * and an extension's callback-based autofill or frame-policy lookup waits on it
 * forever. The app knows the real answers, so the worker asks it over one long-lived
 * port and the app answers from its own `WebContentsView`s. Nothing here decides
 * anything alone: every fact below is either what the app announced or null.
 *
 * The port itself is connected elsewhere, by the `runtime.onConnect` listener the
 * worker installs, because the connect is the extension-visible half of the bridge.
 * It assigns through {@link setBridgePort} so the binding stays in this module and no
 * other file writes it.
 */
import { answerWith, chromeApi, roots, state } from './context.ts'
import type { ChromeNamespace, PreambleEvent } from './context.ts'
import { actionPopupRequests, scheduleMailbox } from './mailbox.ts'

// ── the bridge itself ───────────────────────────────────────────────────────
export const BRIDGE_PORT_NAME = '__cio:bridge'

/** One end of the app's port, in the members this shim uses of it. */
export interface BridgePort {
  name: string
  postMessage: (message: unknown) => void
  onDisconnect: PreambleEvent
  onMessage: PreambleEvent
}

let bridgePort: BridgePort | null = null

/** The connected port, or null while the app is not listening. */
export function currentBridgePort(): BridgePort | null {
  return bridgePort
}

/** Record the port the connect listener was handed, or that it went away. */
export function setBridgePort(value: BridgePort | null): void {
  bridgePort = value
}

let frameRequestSeq = 0

/** One outstanding frame query, held until the app answers or 5s passes. */
export interface FrameRequest {
  id: number
  tabId: number
  resolve: (frames: Frame[] | null) => void
  timer: ReturnType<typeof setTimeout>
}

/** The outstanding frame queries, by request id, so an answer can settle its own. */
export const frameRequests = new Map<number, FrameRequest>()

export function sendFrameRequest(request: FrameRequest): void {
  if (!bridgePort) return
  try {
    bridgePort.postMessage({ kind: 'frames-query', id: request.id, tabId: request.tabId })
  } catch {
    bridgePort = null
  }
}

/** One frame of one tab, in `chrome.webNavigation`'s own shape. */
export interface Frame {
  frameId: number
  parentFrameId?: number
  processId?: number
  url?: string
  errorOccurred?: boolean
  documentLifecycle?: string
}

export function queryFrames(tabId: number): Promise<Frame[] | null> {
  return new Promise<Frame[] | null>((resolve) => {
    if (!Number.isInteger(tabId) || tabId < 0 || frameRequests.size >= 64) {
      resolve(null)
      return
    }
    const id = ++frameRequestSeq
    const timer = setTimeout(() => {
      frameRequests.delete(id)
      resolve(null)
    }, 5000)
    const request = { id, tabId, resolve, timer }
    frameRequests.set(id, request)
    sendFrameRequest(request)
  })
}

/**
 * The tab the app says is on screen, as the runtime's own tab ids.
 *
 * The app is the only one who knows this: its browser view lives in no window the
 * runtime tracks, so `chrome.tabs.query` answers from a focus that never lands on
 * the tab the user is looking at, and every tab it reports reads as inactive.
 * What it announces is the truth, and it announces it twice over: an activation
 * names the tab, and every tab it describes carries the flag as it knows it.
 */
export interface TabActivity {
  activeTabId: number | null
  tabs: Record<string, TabSnapshot>
  replayComplete: boolean
  replayWaiters: Array<() => void>
  replayGate: Promise<void> | null
}

/** One tab the app described, as far as this shim reads and writes it. */
export interface TabSnapshot {
  id: number
  url?: string | null
  active?: boolean
  highlighted?: boolean
  windowId?: number
  index?: number
  windowType?: string
  discarded?: boolean
  autoDiscardable?: boolean
  pinned?: boolean
  incognito?: boolean
  status?: string
  title?: string
  mutedInfo?: { muted: boolean }
  [field: string]: unknown
}

export const tabActivity: TabActivity = {
  activeTabId: null,
  tabs: Object.create(null) as Record<string, TabSnapshot>,
  replayComplete: false,
  replayWaiters: [],
  replayGate: null
}

export function markTabReplayComplete(): void {
  if (tabActivity.replayComplete) return
  tabActivity.replayComplete = true
  for (const resolve of tabActivity.replayWaiters.splice(0)) resolve()
}

export function waitForTabReplay(): Promise<void> {
  if (tabActivity.replayComplete) return Promise.resolve()
  if (!tabActivity.replayGate) {
    tabActivity.replayGate = new Promise<void>((resolve) => {
      tabActivity.replayWaiters.push(resolve)
      setTimeout(markTabReplayComplete, 1500)
    })
  }
  return tabActivity.replayGate
}

// The ids this app lends an extension: the same two numbers the app reports a
// window ending under, and the same pair `src/lib/browser/browser-extension-window.ts`
// documents. They are a contract, not a preference: a different number here is a
// window the extension never hears is gone.
export const HOSTED_POPUP_WINDOW_ID = 2147483646
export const HOSTED_POPUP_TAB_ID = 2147483645

/** The window this app hosts for the extension, and whether it is focused. */
export interface HostedPopout {
  url: string | null
  focused: boolean
}

export const hostedPopout: HostedPopout = { url: null, focused: false }

/** The one member of `chrome.runtime` this module needs typed. */
interface ExtensionUrlRuntime extends ChromeNamespace {
  getURL: (path: string) => string
}

/**
 * One of this extension's own pages, as an absolute URL, or null.
 *
 * `chrome.windows.create` takes a page of the calling extension and the runtime
 * resolves a relative one against the extension root, so a plain
 * `/matched-rules.html?tab=1` and a fully-qualified
 * `chrome-extension://<id>/popup.html` both name the same sort of window. Only
 * the extension's own origin is admitted: a web URL is not this shim's to host,
 * and the app refuses it on the same rule.
 */
export function ownExtensionPageUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url.length === 0) return null
  const runtime = chromeApi.runtime as ExtensionUrlRuntime | undefined
  if (!runtime || typeof runtime.getURL !== 'function') return null
  try {
    const root = new URL(runtime.getURL(''))
    const candidate = new URL(url, root)
    if (candidate.protocol !== root.protocol || candidate.host !== root.host) return null
    return candidate.toString()
  } catch {
    return null
  }
}

/**
 * A web address an extension asked to open in a window, or null.
 *
 * `chrome.windows.create` with an `http(s)` URL opens a window on the web, and
 * the app has no second window to put one in: a browser window here is the
 * app's own, so the page belongs in a new tab of the browser that asked, which
 * is what the app opens it as. Only an absolute `http(s)` address with no
 * credentials is a candidate; the app validates it again before any tab loads.
 */
export function webWindowUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url.length === 0) return null
  try {
    const candidate = new URL(url)
    if (candidate.protocol !== 'http:' && candidate.protocol !== 'https:') return null
    if (candidate.username !== '' || candidate.password !== '') return null
    return candidate.toString()
  } catch {
    return null
  }
}

// The tab id a request carries when the app, not the worker, is the side that
// knows which page it belongs to. A worker shared by a whole jar has one notion
// of "the tab I act for", and a jar whose page is not the one on screen leaves it
// with none at all: the app answers with the page the user is on.
export const UNNAMED_TAB_ID = -1

/** One window request in the mailbox the app reads. */
export interface ActionPopupRequest {
  seq: number
  tabId: number
  kind: string
  url?: string
  [field: string]: unknown
}

// The sequence and the request list are written here and read by the app through the
// mailbox, so the counter belongs to the only code that increments it.
let actionPopupRequestSeq = 0

export function routePopupWindowRequest(
  kind: string,
  url?: unknown,
  tabId: number | null = tabActivity.activeTabId
): boolean {
  if (typeof tabId !== 'number' || !Number.isFinite(tabId)) return false
  if (tabId < 0 && tabId !== UNNAMED_TAB_ID) return false
  const request: ActionPopupRequest = { seq: ++actionPopupRequestSeq, tabId, kind }
  if (typeof url === 'string') request.url = url
  actionPopupRequests.push(request)
  if (actionPopupRequests.length > 16) {
    actionPopupRequests.splice(0, actionPopupRequests.length - 16)
  }
  scheduleMailbox()
  return true
}

/**
 * Route a request the worker makes about the window it is acting for, waiting
 * out a worker that does not know a tab yet.
 *
 * A worker that has just been started has been handed no tab events, and a
 * password manager's passkey save is issued by exactly such a worker: the click
 * that begins the ceremony is what wakes it. Routing straight away finds no tab,
 * and every caller then falls through to a runtime that implements no window at
 * all, so the request is dropped with nothing to show for it and the page waits
 * on a promise that never settles. That is indistinguishable, from the user's
 * side, from a browser with no passkey support. The tab replay the app always
 * sends on a worker's first snapshot is what is waited for, and the wait is
 * bounded, so a worker that never learns a tab is still answered rather than
 * held forever.
 */
export async function routeRequestWhenTabKnown(kind: string, url?: unknown): Promise<boolean> {
  if (routePopupWindowRequest(kind, url)) return true
  await waitForTabReplay()
  if (routePopupWindowRequest(kind, url)) return true
  // The fallback matters more than the exact tab: an extension window that is
  // never asked for is a prompt the page waits on forever, and the app can place
  // it beside the page the user is actually on. It only reaches a runtime with no
  // windows at all if this is skipped.
  return routePopupWindowRequest(kind, url, UNNAMED_TAB_ID)
}

/** One tab of a window this shim answers with, in `chrome.windows`' own shape. */
export interface HostedWindowTab {
  id: number
  index: number
  windowId: number
  windowType: string
  active: boolean
  highlighted: boolean
  pinned: boolean
  incognito: boolean
  discarded: boolean
  status: string
  url: string
  title: string
}

/** A window this shim answers `chrome.windows` with, in that API's own shape. */
export interface HostedWindow {
  id: number
  focused: boolean
  type: string
  state: string
  left: number
  top: number
  width: number
  height: number
  alwaysOnTop: boolean
  tabs: HostedWindowTab[]
}

export function hostedWindow(id: number, focused: boolean): HostedWindow {
  return {
    id,
    focused,
    type: id === HOSTED_POPUP_WINDOW_ID ? 'popup' : 'normal',
    state: 'normal',
    left: 0,
    top: 0,
    width: 1280,
    height: 800,
    alwaysOnTop: false,
    tabs:
      id === HOSTED_POPUP_WINDOW_ID && hostedPopout.url
        ? [
            {
              id: HOSTED_POPUP_TAB_ID,
              index: 0,
              windowId: HOSTED_POPUP_WINDOW_ID,
              windowType: 'popup',
              active: false,
              highlighted: false,
              pinned: false,
              incognito: false,
              discarded: false,
              status: 'complete',
              url: hostedPopout.url,
              title: ''
            }
          ]
        : []
  }
}

/** The frame lookup the runtime leaves out, answered by the app through the port. */
interface FrameQueryDetails {
  tabId: number
  frameId: number
}

/**
 * Install the frame lookup on every root that carries `webNavigation`.
 *
 * Nothing else in this module has to run for the port to be usable: the constants and
 * helpers above are declarations, and this is the one side effect.
 */
export function installBridge(): void {
  // Electron exposes no native frame lookup. A no-op here leaves extensions'
  // callback-based autofill and frame-policy lookups waiting indefinitely.
  for (const root of roots) {
    const api = root && (root.webNavigation as ChromeNamespace | undefined)
    if (!api) continue
    const getAllFrames = (details: unknown, callback: unknown) => {
      const request = (details && typeof details === 'object' ? details : {}) as FrameQueryDetails
      return queryFrames(request.tabId).then((frames) => answerWith(callback, frames))
    }
    const getFrame = (details: unknown, callback: unknown) => {
      const request = (details && typeof details === 'object' ? details : {}) as FrameQueryDetails
      return queryFrames(request.tabId).then((frames) => {
        const found = frames && frames.find((frame) => frame.frameId === request.frameId)
        return answerWith(callback, found || undefined)
      })
    }
    try {
      Object.defineProperty(api, 'getAllFrames', {
        value: getAllFrames,
        configurable: true,
        writable: true
      })
      Object.defineProperty(api, 'getFrame', {
        value: getFrame,
        configurable: true,
        writable: true
      })
    } catch (error) {
      state.errors.push('webNavigation-frames: ' + String(error))
    }
  }
}
