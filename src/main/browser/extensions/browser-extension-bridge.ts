/**
 * The app's channel into one extension's service worker.
 *
 * An extension's worker can only be reached through a page of its own origin:
 * `ses.registerPreloadScript({ type: 'service-worker' })` registers and is listed
 * but the worker never sees the script (measured), and the runtime has no API to
 * hand a worker an event or read its state. So the install path writes a bridge
 * page into the extension's copy beside the preamble, and this class drives it:
 *
 *   - **Commands in.** `executeJavaScript` calls the page's receive function,
 *     which posts the command over a long-lived port named `__cio:bridge` into
 *     the worker. That direction was measured to reach the preamble's listener,
 *     and to start a worker Chromium has already released: a push after the idle
 *     window came back handled, from a fresh worker life. A port rather than
 *     `runtime.sendMessage`, because a message is delivered to every `onMessage`
 *     listener the extension has and a real extension's listener can throw on a
 *     shape it does not know (uBlock Origin Lite's did, measured).
 *   - **State out.** The preamble records action state and the context menu tree
 *     and writes one mailbox into the extension's session storage; the page reads
 *     it fresh on every poll, and this class hands each new snapshot over exactly
 *     once.
 *
 * A worker restart is a new life: it holds none of the previous in-memory state
 * and its sequence starts over, so every mailbox carries a generation and a new
 * one is reported as a restart. Main's own mirror is reset from that signal
 * rather than merging a fresh life's first snapshot into a dead one's leftovers.
 *
 * The class owns nothing else: no session, no window, no renderer plumbing. It
 * starts a view, pushes, drains, and goes away with the load it belongs to.
 */

import { WebContentsView, type Session } from 'electron'
import type { BrowserExtensionMenuRecord } from '../../../lib/ipc/browser'
import { Logger } from '../../system/logger'
import {
  parseUserScriptFileRequest,
  type UserScriptFileRequest,
  type UserScriptFileResult
} from './browser-extension-user-scripts'

/**
 * How often the mailbox is read.
 *
 * A badge an ad blocker updates as requests are aborted should land while the
 * user is still looking at the page, so this is well under the 1500 ms the
 * tooltip system itself considers immediate, and the read is one storage get in
 * a page that does nothing else. Nothing is sent to the renderer when the
 * snapshot has not changed.
 */
const MAILBOX_POLL_INTERVAL_MS = 500

/** A bridge page that never loads is not worth retrying, and a view that loaded
 *  is waited on only until it has. */
const BRIDGE_LOAD_TIMEOUT_MS = 15_000

/** One mailbox snapshot: everything the worker wants the app to know. */
export interface BrowserExtensionMailbox {
  /** Unique per worker life; a new value means the worker restarted and holds
   *  no memory of anything the previous life recorded. */
  generation: string
  seq: number
  at: number
  actions: {
    global: Record<string, unknown>
    tabs: Record<string, Record<string, unknown>>
  }
  menus: BrowserExtensionMenuRecord[]
  menuSeq: number
  /** The OS notifications the worker asked the app to raise, oldest first. Main
   *  acts only on the entries newer than the last sequence it saw, and a
   *  restarted worker starts its own sequence over with no memory. */
  notifications: BrowserExtensionNotificationRecord[]
  /** What the extension wants a side panel to be, and when it asked for one.
   *  Main acts only on the requests newer than the last sequence it saw, and a
   *  restarted worker starts its own sequence over with no memory. */
  sidePanel: BrowserExtensionSidePanelMailbox
  /** Action popups the worker asked the app to open, oldest first. */
  actionPopups: BrowserExtensionActionPopupRequest[]
  bridgeCommands: number
}

/** One `chrome.action.openPopup()` request from the extension worker. */
export interface BrowserExtensionActionPopupRequest {
  seq: number
  tabId: number
}

/** The kinds of OS-notification request an extension can make through
 *  `chrome.notifications`, carried in one mailbox entry. */
export type BrowserExtensionNotificationKind = 'create' | 'update' | 'clear' | 'clearAll'

/** The fields of a notification an extension asked the app to raise, only the
 *  ones it actually set. */
export interface BrowserExtensionNotificationOptions {
  title?: string
  message?: string
  iconUrl?: string
  silent?: boolean
  buttons?: { title?: string }[]
}

/** One `chrome.notifications` request, normalised so a malformed field cannot
 *  reach the app's notifier as `undefined`. `seq` increases per request within
 *  one worker life, exactly as the recorded menu sequence does. */
export interface BrowserExtensionNotificationRecord {
  seq: number
  id: string
  kind: BrowserExtensionNotificationKind
  options?: BrowserExtensionNotificationOptions
}

/** How an extension wants its action click to behave, when it set a behavior
 *  through `chrome.sidePanel.setPanelBehavior`. */
export interface BrowserExtensionSidePanelBehavior {
  openPanelOnActionClick: boolean
}

/** One `chrome.sidePanel.setOptions` record, normalised so a malformed field
 *  cannot reach the view layer. A record with no `tabId` is the extension-wide
 *  default; one with a `tabId` overrides it for that tab. */
export interface BrowserExtensionSidePanelOption {
  tabId?: number
  path?: string
  enabled?: boolean
}

/** One `chrome.sidePanel.open` or `chrome.sidePanel.close` request, normalised so
 *  a malformed field cannot reach the view layer. `seq` increases per request
 *  within one worker life, exactly as the notification sequence does. */
export interface BrowserExtensionSidePanelRequest {
  seq: number
  kind: 'open' | 'close'
  tabId?: number
}

/** Everything one worker life recorded about its side panel: the behavior it
 *  asked for, the options it set per scope, and the requests it queued. */
export interface BrowserExtensionSidePanelMailbox {
  behavior: BrowserExtensionSidePanelBehavior | null
  options: BrowserExtensionSidePanelOption[]
  requests: BrowserExtensionSidePanelRequest[]
}

export interface BrowserExtensionBridgeDeps {
  session: Session
  extensionId: string
  /** The bridge page's absolute `chrome-extension://` address. */
  pageUrl: string
  /** One snapshot, every time it changes, and once more when the worker
   *  restarted (so main can drop what the dead life left behind). */
  onMailbox: (mail: BrowserExtensionMailbox, restarted: boolean) => void
  /**
   * The tab events that describe the extension's own jar right now.
   *
   * Asked for once when the channel opens and again after every worker restart,
   * because a worker that has just started its life knows of no tab that was
   * already open and the runtime gives it no way to ask.
   */
  tabReplay?: () => { name: string; args: unknown[] }[]
  /** The bridge page could not be brought up, so nothing can be delivered. */
  onUnavailable: (reason: string) => void
  /**
   * Write the files one `chrome.userScripts.register` asked for into the
   * extension's own copy. A worker cannot write a file and
   * `scripting.registerContentScripts` takes paths rather than code, so the
   * compatibility preamble asks for the write here and waits for the answer.
   */
  materializeUserScripts?: (request: UserScriptFileRequest) => Promise<UserScriptFileResult>
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}

/** Whether an unknown value from the wire is a usable menu record, normalised
 *  so a malformed field cannot reach the native menu as `undefined`. */
function toMenuRecord(value: unknown): BrowserExtensionMenuRecord | null {
  const record = asRecord(value)
  const id = record['id']
  if (typeof id !== 'string' || id.length === 0) return null
  const rawId = record['rawId']
  const type = record['type']
  return {
    id,
    rawId: typeof rawId === 'string' || typeof rawId === 'number' ? rawId : id,
    parentId: typeof record['parentId'] === 'string' ? record['parentId'] : null,
    title: typeof record['title'] === 'string' ? record['title'] : '',
    type: typeof type === 'string' ? type : 'normal',
    contexts: asStringArray(record['contexts']),
    enabled: record['enabled'] !== false,
    checked: record['checked'] === true,
    documentUrlPatterns: asStringArray(record['documentUrlPatterns']),
    targetUrlPatterns: asStringArray(record['targetUrlPatterns'])
  }
}

/** Whether an unknown value from the wire is a usable notification request,
 *  normalised so a malformed field cannot reach the app's notifier. */
function toNotificationRecord(value: unknown): BrowserExtensionNotificationRecord | null {
  const record = asRecord(value)
  const seq = record['seq']
  if (typeof seq !== 'number' || !Number.isFinite(seq) || seq <= 0) return null
  const kind = record['kind']
  if (kind !== 'create' && kind !== 'update' && kind !== 'clear' && kind !== 'clearAll') {
    return null
  }
  const options = asRecord(record['options'])
  const normalisedOptions: BrowserExtensionNotificationOptions = {}
  if (typeof options['title'] === 'string') normalisedOptions.title = options['title']
  if (typeof options['message'] === 'string') normalisedOptions.message = options['message']
  if (typeof options['iconUrl'] === 'string') normalisedOptions.iconUrl = options['iconUrl']
  if (typeof options['silent'] === 'boolean') normalisedOptions.silent = options['silent']
  if (Array.isArray(options['buttons'])) {
    normalisedOptions.buttons = options['buttons'].map((button) => {
      const item = asRecord(button)
      return { title: typeof item['title'] === 'string' ? item['title'] : '' }
    })
  }
  const id = record['id']
  return {
    seq,
    id: typeof id === 'string' ? id : '',
    kind,
    ...(Object.keys(normalisedOptions).length > 0 ? { options: normalisedOptions } : {})
  }
}

/** Whether an unknown value from the wire is a usable side-panel behavior.
 *  Null is the extension never having set one, which the app reads as the
 *  default behavior. */
function toSidePanelBehavior(value: unknown): BrowserExtensionSidePanelBehavior | null {
  if (typeof value !== 'object' || value === null) return null
  const record = asRecord(value)
  return { openPanelOnActionClick: record['openPanelOnActionClick'] === true }
}

/** Whether an unknown value from the wire is a usable side-panel option record.
 *  A record that carries neither a path nor an enabled flag says nothing the app
 *  can act on, so it is dropped rather than stored as an empty override. */
function toSidePanelOption(value: unknown): BrowserExtensionSidePanelOption | null {
  const record = asRecord(value)
  const option: BrowserExtensionSidePanelOption = {}
  const tabId = record['tabId']
  if (typeof tabId === 'number' && Number.isFinite(tabId) && tabId >= 0) option.tabId = tabId
  const path = record['path']
  if (typeof path === 'string') option.path = path
  const enabled = record['enabled']
  if (typeof enabled === 'boolean') option.enabled = enabled
  if (option.path === undefined && option.enabled === undefined) return null
  return option
}

/** Whether an unknown value from the wire is a usable side-panel request,
 *  normalised so a malformed field cannot reach the view layer. */
function toSidePanelRequest(value: unknown): BrowserExtensionSidePanelRequest | null {
  const record = asRecord(value)
  const seq = record['seq']
  if (typeof seq !== 'number' || !Number.isFinite(seq) || seq <= 0) return null
  const kind = record['kind']
  if (kind !== 'open' && kind !== 'close') return null
  const request: BrowserExtensionSidePanelRequest = { seq, kind }
  const tabId = record['tabId']
  if (typeof tabId === 'number' && Number.isFinite(tabId) && tabId >= 0) request.tabId = tabId
  return request
}

/** One side-panel mailbox field, always carrying usable arrays so a malformed
 *  payload cannot arrive at the view layer as `undefined`. */
function toSidePanelMailbox(value: unknown): BrowserExtensionSidePanelMailbox {
  const record = asRecord(value)
  return {
    behavior: toSidePanelBehavior(record['behavior']),
    options: Array.isArray(record['options'])
      ? record['options']
          .map(toSidePanelOption)
          .filter((item): item is BrowserExtensionSidePanelOption => item !== null)
      : [],
    requests: Array.isArray(record['requests'])
      ? record['requests']
          .map(toSidePanelRequest)
          .filter((item): item is BrowserExtensionSidePanelRequest => item !== null)
      : []
  }
}

/** A popup request from the mailbox, with only the fields the host needs. */
function toActionPopupRequest(value: unknown): BrowserExtensionActionPopupRequest | null {
  const record = asRecord(value)
  const seq = record['seq']
  const tabId = record['tabId']
  if (
    typeof seq !== 'number' ||
    !Number.isFinite(seq) ||
    seq <= 0 ||
    typeof tabId !== 'number' ||
    !Number.isFinite(tabId) ||
    tabId < 0
  ) {
    return null
  }
  return { seq, tabId }
}

export class BrowserExtensionBridge {
  private view: WebContentsView | null = null
  private poll: ReturnType<typeof setInterval> | null = null
  private draining = false
  private disposed = false
  /** The worker life the last snapshot came from. */
  private generation = ''
  /** The last sequence number seen in that life. */
  private lastSeq = 0
  /** The last user-script file request answered, so one is never written twice. */
  private lastUserScriptRequest = 0

  constructor(private readonly deps: BrowserExtensionBridgeDeps) {}

  /** Bring the bridge page up; it is the only door into the worker. */
  start(): void {
    if (this.disposed || this.view) return
    const view = new WebContentsView({
      webPreferences: {
        session: this.deps.session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        devTools: true
      }
    })
    this.view = view
    const contents = view.webContents
    contents.once('destroyed', () => this.stop())
    const loaded = contents.loadURL(this.deps.pageUrl)
    const timer = setTimeout(() => {
      if (this.poll) return
      this.deps.onUnavailable('the bridge page did not finish loading')
      this.stop()
    }, BRIDGE_LOAD_TIMEOUT_MS)
    loaded
      .then(() => {
        clearTimeout(timer)
        if (this.disposed || this.view !== view) return
        // A worker that has just been loaded has no notion of a session start;
        // this is the one event that says the jar it runs in is awake.
        this.push({ kind: 'startup' })
        this.replayTabs()
        this.poll = setInterval(() => {
          void this.drain()
          void this.writeUserScriptFiles()
          void this.reassertUserScripts()
        }, MAILBOX_POLL_INTERVAL_MS)
      })
      .catch((error: unknown) => {
        clearTimeout(timer)
        this.deps.onUnavailable(error instanceof Error ? error.message : String(error))
        this.stop()
      })
  }

  /** Send one command into the worker. Fire and forget: a worker that is asleep
   *  is started by the message itself, and a push into a dying view is dropped
   *  rather than queued, because a tab event that arrives late is worse than one
   *  that does not arrive. */
  push(command: unknown): void {
    const view = this.view
    if (!view || this.disposed) return
    const contents: Electron.WebContents | undefined = view.webContents
    if (!contents || contents.isDestroyed()) return
    const script = `globalThis.__cioBridgeReceive && globalThis.__cioBridgeReceive(${JSON.stringify(command)})`
    void contents.executeJavaScript(script, true).catch(() => undefined)
  }

  /**
   * Hand the worker the tab state it cannot ask for itself.
   *
   * No-ops when there is nothing to say, which is the common case for a jar whose
   * tabs are all hibernated: an empty replay would only wake a worker to tell it
   * nothing.
   */
  private replayTabs(): void {
    const events = this.deps.tabReplay?.() ?? []
    for (const event of events) {
      this.push({ kind: 'tab', name: event.name, args: event.args })
    }
  }

  private async drain(): Promise<void> {
    const view = this.view
    if (!view || this.disposed || this.draining) return
    const contents: Electron.WebContents | undefined = view.webContents
    if (!contents || contents.isDestroyed()) return
    this.draining = true
    try {
      const raw = await contents.executeJavaScript(
        'globalThis.__cioBridgeDrain ? globalThis.__cioBridgeDrain() : null',
        true
      )
      if (typeof raw !== 'string' || raw === 'null' || raw.length === 0) return
      const parsed = asRecord(JSON.parse(raw))
      const generation = typeof parsed['generation'] === 'string' ? parsed['generation'] : ''
      const seq = typeof parsed['seq'] === 'number' ? parsed['seq'] : 0
      if (!generation || seq === 0) return
      const restarted = generation !== this.generation
      if (!restarted && seq <= this.lastSeq) return
      const actions = asRecord(parsed['actions'])
      const tables = asRecord(actions['tabs'])
      const mail: BrowserExtensionMailbox = {
        generation,
        seq,
        at: typeof parsed['at'] === 'number' ? parsed['at'] : Date.now(),
        actions: {
          global: asRecord(actions['global']),
          tabs: Object.fromEntries(
            Object.entries(tables).map(([tabId, patch]) => [tabId, asRecord(patch)])
          )
        },
        menus: Array.isArray(parsed['menus'])
          ? parsed['menus']
              .map(toMenuRecord)
              .filter((item): item is BrowserExtensionMenuRecord => item !== null)
          : [],
        menuSeq: typeof parsed['menuSeq'] === 'number' ? parsed['menuSeq'] : 0,
        notifications: Array.isArray(parsed['notifications'])
          ? parsed['notifications']
              .map(toNotificationRecord)
              .filter((item): item is BrowserExtensionNotificationRecord => item !== null)
          : [],
        sidePanel: toSidePanelMailbox(parsed['sidePanel']),
        actionPopups: Array.isArray(parsed['actionPopups'])
          ? parsed['actionPopups']
              .slice(-16)
              .map(toActionPopupRequest)
              .filter((item): item is BrowserExtensionActionPopupRequest => item !== null)
          : [],
        bridgeCommands: typeof parsed['bridgeCommands'] === 'number' ? parsed['bridgeCommands'] : 0
      }
      this.generation = generation
      this.lastSeq = seq
      // A restarted worker is a fresh life: it holds no memory of the tabs the
      // dead one was told about, so the jar's tab state is handed over again
      // before anything it recorded is published as its new state.
      if (restarted) this.replayTabs()
      this.deps.onMailbox(mail, restarted)
    } catch (error) {
      // A read that failed or a snapshot that could not be parsed is skipped; the
      // next poll tries again and the worker is untouched either way.
      Logger.dev('Extension bridge mailbox could not be read:', {
        extensionId: this.deps.extensionId,
        error
      })
    } finally {
      this.draining = false
    }
  }

  /**
   * Answer one `chrome.userScripts` file request.
   *
   * The worker cannot be called, so the answer goes back into the same storage
   * the worker reads, and only a request the app has not already answered is
   * written: the poll sees the same request until the worker asks for another one.
   */
  private async writeUserScriptFiles(): Promise<void> {
    const materialize = this.deps.materializeUserScripts
    if (!materialize) return
    const view = this.view
    if (!view || this.disposed) return
    const contents: Electron.WebContents | undefined = view.webContents
    if (!contents || contents.isDestroyed()) return
    try {
      const raw = await contents.executeJavaScript(
        'globalThis.__cioBridgeDrainWrites ? globalThis.__cioBridgeDrainWrites() : null',
        true
      )
      if (typeof raw !== 'string' || raw === 'null' || raw.length === 0) return
      const request = parseUserScriptFileRequest(JSON.parse(raw))
      if (!request || request.request <= this.lastUserScriptRequest) return
      this.lastUserScriptRequest = request.request
      const result = await materialize(request)
      if (result.error) {
        Logger.dev('Extension user script files could not be written:', {
          extensionId: this.deps.extensionId,
          error: result.error
        })
      }
      await contents.executeJavaScript(
        `globalThis.__cioBridgeWrite && globalThis.__cioBridgeWrite('__cioFileReady', ${JSON.stringify(result)})`,
        true
      )
    } catch (error) {
      Logger.dev('Extension user script request could not be handled:', {
        extensionId: this.deps.extensionId,
        error
      })
    }
  }

  /**
   * Put back any user script something else removed.
   *
   * The compatibility preamble rebuilds `chrome.userScripts` on the scripting
   * registry, and an extension that clears its own content scripts clears that
   * whole registry, so its user scripts go with them. The registry the preamble
   * keeps is the truth and the bridge page replays what is missing; this is the
   * call that makes it happen while the app is running.
   */
  private async reassertUserScripts(): Promise<void> {
    const view = this.view
    if (!view || this.disposed) return
    const contents: Electron.WebContents | undefined = view.webContents
    if (!contents || contents.isDestroyed()) return
    try {
      const outcome = await contents.executeJavaScript(
        'globalThis.__cioBridgeReassert ? globalThis.__cioBridgeReassert() : "unavailable"',
        true
      )
      if (typeof outcome === 'string' && outcome.startsWith('restored:')) {
        Logger.dev('Extension user scripts were restored:', {
          extensionId: this.deps.extensionId,
          outcome
        })
      }
    } catch (error) {
      Logger.dev('Extension user scripts could not be checked:', {
        extensionId: this.deps.extensionId,
        error
      })
    }
  }

  /** Whether the bridge is up and its poll running. */
  get running(): boolean {
    return this.poll !== null && !this.disposed
  }

  private stop(): void {
    if (this.poll) {
      clearInterval(this.poll)
      this.poll = null
    }
    const view = this.view
    this.view = null
    if (!view) return
    const contents: Electron.WebContents | undefined = view.webContents
    if (contents && !contents.isDestroyed()) contents.close()
  }

  dispose(): void {
    this.disposed = true
    this.stop()
  }
}
