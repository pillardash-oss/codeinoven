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
  bridgeCommands: number
}

export interface BrowserExtensionBridgeDeps {
  session: Session
  extensionId: string
  /** The bridge page's absolute `chrome-extension://` address. */
  pageUrl: string
  /** One snapshot, every time it changes, and once more when the worker
   *  restarted (so main can drop what the dead life left behind). */
  onMailbox: (mail: BrowserExtensionMailbox, restarted: boolean) => void
  /** The bridge page could not be brought up, so nothing can be delivered. */
  onUnavailable: (reason: string) => void
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

export class BrowserExtensionBridge {
  private view: WebContentsView | null = null
  private poll: ReturnType<typeof setInterval> | null = null
  private draining = false
  private disposed = false
  /** The worker life the last snapshot came from. */
  private generation = ''
  /** The last sequence number seen in that life. */
  private lastSeq = 0

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
        this.poll = setInterval(() => void this.drain(), MAILBOX_POLL_INTERVAL_MS)
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
        bridgeCommands: typeof parsed['bridgeCommands'] === 'number' ? parsed['bridgeCommands'] : 0
      }
      this.generation = generation
      this.lastSeq = seq
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
