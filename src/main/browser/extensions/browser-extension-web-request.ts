/**
 * Electron's webRequest facts, in the shape `chrome.webRequest` hands a listener.
 *
 * Chromium's `chrome.webRequest` namespace is compiled out of this runtime, so no
 * listener an extension installs there ever fires, and the API has no shim that can
 * synthesise the events from inside the worker: the request never reaches it. The
 * one observer of the traffic is the session's own `webRequest`, which reports the
 * same five moments this app cares about.
 *
 * What it reports is not what an extension reads. Electron's details name the
 * request with a number, a resource by its internal name and the frame as a
 * webContents id, while Chrome's details carry a string id, the extension API's own
 * resource names, and a frame id of the observed frame. A listener written against
 * the real API reads those fields, so the translation is the whole point of this
 * module.
 *
 * Which fields exist is decided by the event, not by what Electron happened to
 * include: `onSendHeaders` carries request headers, `onHeadersReceived` and
 * `onResponseStarted` carry the response's, `onCompleted` adds the cache fact, and
 * `onErrorOccurred` carries the error and nothing about a response. A field the
 * event does not document is left out rather than sent as `undefined`, because an
 * extension that tests `'statusCode' in details` must be told the truth.
 *
 * This module is pure: an Electron detail object in, one Chrome-shaped object out.
 * The session, the listeners and the bridges belong to the service that owns them.
 */

/** The five `chrome.webRequest` events the app can feed. */
export type BrowserExtensionWebRequestEventName =
  'onSendHeaders' | 'onResponseStarted' | 'onHeadersReceived' | 'onCompleted' | 'onErrorOccurred'

/** Chrome's `ResourceType`, as the extension API spells it. */
export type BrowserExtensionResourceType =
  | 'main_frame'
  | 'sub_frame'
  | 'stylesheet'
  | 'script'
  | 'image'
  | 'font'
  | 'object'
  | 'xmlhttprequest'
  | 'ping'
  | 'csp_report'
  | 'media'
  | 'websocket'
  | 'other'

/** One header as Chrome reports it: a name and one value. A header Electron holds
 *  as a list becomes one entry per value, which is the shape Chrome documents. */
export interface BrowserExtensionWebRequestHeader {
  name: string
  value: string
}

/**
 * One request, in the details shape `chrome.webRequest` listeners receive.
 *
 * Only the fields the fired event documents are present, so what is absent is as
 * meaningful as what is there.
 */
export interface BrowserExtensionWebRequestDetails {
  /** Chrome's request id is a string; Electron's is a number. */
  requestId: string
  url: string
  method: string
  /** The observed frame. This app watches no subframe, so a request it reports is
   *  always the main frame's. */
  frameId: number
  /** Chrome reports -1 for a request with no parent, which is every main-frame
   *  request it can describe here. */
  parentFrameId: number
  /** The tab's own id, or -1 for a request that belongs to no tab. Electron names
   *  the webContents, and the extension runtime the app hands a tab is keyed by
   *  the same number. */
  tabId: number
  type: BrowserExtensionResourceType
  /** The page that issued the request, empty when no page did. */
  initiator: string
  /** Milliseconds since the epoch, as Chrome's `timeStamp` is. */
  timeStamp: number
  requestHeaders?: BrowserExtensionWebRequestHeader[]
  responseHeaders?: BrowserExtensionWebRequestHeader[]
  statusCode?: number
  statusLine?: string
  fromCache?: boolean
  ip?: string
  error?: string
}

/**
 * The subset of an Electron `webRequest` listener's details this mapping reads.
 *
 * Structural rather than one of Electron's five detail types: the module is handed
 * whichever event fired, and each of those types is assignable to this one. Keeping
 * the fields optional is what lets one mapper answer for all five without a cast.
 */
export interface BrowserExtensionWebRequestSource {
  id: number
  url: string
  method: string
  webContentsId?: number
  resourceType: string
  referrer: string
  timestamp: number
  /** Electron types `onSendHeaders` as a single value per header and the response
   *  events as lists; both are accepted and flattened the same way. */
  requestHeaders?: Record<string, string | string[]>
  responseHeaders?: Record<string, string | string[]>
  statusCode?: number
  fromCache?: boolean
  /** Present in Chrome's details and in no Electron one, so it is only copied when
   *  a future runtime starts supplying it. */
  ip?: string
  error?: string
}

/** Electron's resource names, translated to the ones the extension API exposes. */
const RESOURCE_TYPE_BY_ELECTRON_NAME: Record<string, BrowserExtensionResourceType> = {
  mainFrame: 'main_frame',
  subFrame: 'sub_frame',
  stylesheet: 'stylesheet',
  script: 'script',
  image: 'image',
  font: 'font',
  object: 'object',
  xhr: 'xmlhttprequest',
  ping: 'ping',
  cspReport: 'csp_report',
  media: 'media',
  webSocket: 'websocket',
  other: 'other'
}

/** Flatten the record Electron reports into Chrome's list of single-value
 *  headers. A name carrying several values keeps every one of them, in the order
 *  Electron supplied them, because dropping one would change what the extension
 *  reads about the request. */
function toHeaders(
  headers: Record<string, string | string[]> | undefined
): BrowserExtensionWebRequestHeader[] | undefined {
  if (!headers) return undefined
  const mapped: BrowserExtensionWebRequestHeader[] = []
  for (const [name, values] of Object.entries(headers)) {
    if (Array.isArray(values)) {
      for (const value of values) {
        if (typeof value === 'string') mapped.push({ name, value })
      }
    } else if (typeof values === 'string') {
      mapped.push({ name, value: values })
    }
  }
  return mapped
}

/** The status facts `onHeadersReceived`, `onResponseStarted` and `onCompleted`
 *  all report. Chrome's `statusLine` is the one line an extension prints when it
 *  logs a response, and Electron hands it as a string of its own; the line is
 *  built from the code so both readers agree with each other. */
function applyStatus(
  details: BrowserExtensionWebRequestDetails,
  source: BrowserExtensionWebRequestSource
): void {
  if (typeof source.statusCode !== 'number') return
  details.statusCode = source.statusCode
  details.statusLine = `HTTP/1.1 ${source.statusCode}`
}

/**
 * Translate one Electron `webRequest` detail object into Chrome's details shape.
 *
 * The event name decides which of the optional fields are read, so an extension
 * sees the same presence rules the real API documents even though one mapper
 * answers for all five events.
 */
export function toWebRequestDetails(
  name: BrowserExtensionWebRequestEventName,
  source: BrowserExtensionWebRequestSource
): BrowserExtensionWebRequestDetails {
  const details: BrowserExtensionWebRequestDetails = {
    requestId: String(source.id),
    url: source.url,
    method: source.method,
    frameId: 0,
    parentFrameId: -1,
    tabId: typeof source.webContentsId === 'number' ? source.webContentsId : -1,
    type: RESOURCE_TYPE_BY_ELECTRON_NAME[source.resourceType] ?? 'other',
    initiator: typeof source.referrer === 'string' ? source.referrer : '',
    timeStamp: Number.isFinite(source.timestamp) ? source.timestamp : Date.now()
  }
  switch (name) {
    case 'onSendHeaders':
      details.requestHeaders = toHeaders(source.requestHeaders) ?? []
      break
    case 'onHeadersReceived':
      details.responseHeaders = toHeaders(source.responseHeaders) ?? []
      applyStatus(details, source)
      break
    case 'onResponseStarted':
      details.responseHeaders = toHeaders(source.responseHeaders) ?? []
      applyStatus(details, source)
      if (typeof source.fromCache === 'boolean') details.fromCache = source.fromCache
      if (typeof source.ip === 'string') details.ip = source.ip
      break
    case 'onCompleted':
      details.responseHeaders = toHeaders(source.responseHeaders) ?? []
      applyStatus(details, source)
      if (typeof source.fromCache === 'boolean') details.fromCache = source.fromCache
      if (typeof source.ip === 'string') details.ip = source.ip
      break
    case 'onErrorOccurred':
      if (typeof source.fromCache === 'boolean') details.fromCache = source.fromCache
      if (typeof source.ip === 'string') details.ip = source.ip
      details.error = typeof source.error === 'string' ? source.error : ''
      break
  }
  return details
}
