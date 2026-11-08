/**
 * The native messaging ports one extension holds, and the rules about them.
 *
 * Electron refuses every `chrome.runtime.connectNative` call (measured, see
 * `.cio/tmp/nm-probe`), so the compatibility preamble in the extension's worker
 * asks app main to open the port instead and this class is the app's half: it turns
 * one worker request into one host process, keeps the ports apart, and turns the
 * host's own messages back into deliveries the preamble can hand to the
 * extension's listeners.
 *
 * Everything the worker sends is untrusted. A name is validated before it is looked
 * up, a port id is minted here rather than accepted from the worker, a post to an
 * unknown port is dropped, and the number of live ports one extension may hold is
 * capped so a worker cannot start hosts without bound.
 *
 * The class owns only the processes; the lookup is
 * `browser-native-host-manifest.ts` and the wire format is
 * `browser-native-host-process.ts`.
 */

import { randomUUID } from 'node:crypto'
import { Logger } from '../../system/logger'
import {
  resolveNativeHostManifest,
  type NativeHostLookupOptions
} from './browser-native-host-manifest'
import { NativeHostProcess } from './browser-native-host-process'

/** How many native ports one extension may hold open at once. The flows that use
 *  this (a password manager's desktop bridge) hold one or two; the cap is only
 *  there to bound a worker that opens connections in a loop. */
const MAX_PORTS_PER_EXTENSION = 8

/**
 * How long a host may leave one of the extension's messages unanswered before the
 * app says the host stopped working.
 *
 * Native messaging is request/response, so a request with no reply is the only
 * evidence there is that the program on the other end is stuck, and an extension
 * that asked for an answer waits on it for as long as its own code allows: a
 * password manager's encrypted-channel handshake has no timeout at all, so its
 * popup spins until the app is told, or forever. The window is generous enough
 * for a host that has to start a second process or prompt the user, and short
 * enough that the notice arrives while the user is still looking at the spinner. */
export const NATIVE_ANSWER_TIMEOUT_MS = 10_000

/** What the app tells the worker about a native port. */
export type NativeMessagingDelivery =
  | { kind: 'connect-result'; requestId: number; portId: string | null; error: string | null }
  | { kind: 'message'; portId: string; message: unknown }
  | { kind: 'disconnect'; portId: string; error: string | null }

export interface BrowserExtensionNativeMessagingDeps {
  /** The extension's own origin, `chrome-extension://<id>/`, which a host manifest
   *  must admit in its `allowed_origins`. */
  origin: string
  lookupOptions: NativeHostLookupOptions
  deliver: (delivery: NativeMessagingDelivery) => void
  /**
   * One message this extension wrote that its host never answered.
   *
   * Called at most once per silent stretch of one port, because the point is to
   * tell the user once that the program on the other end has stopped responding,
   * not to report every message that joins the queue behind it.
   */
  reportSilentHost?: (application: string, waitedMs: number) => void
}

interface OpenPort {
  process: NativeHostProcess
  /** The host name the extension asked for, kept for the trace below. */
  application: string
}

export class BrowserExtensionNativeMessaging {
  private readonly ports = new Map<string, OpenPort>()
  private disposed = false
  /** The host name of a message still waiting for an answer, null when the last
   *  message this extension wrote has been answered. */
  private awaitingAnswer: string | null = null
  /** The one timer that notices that answer never arriving. Armed by a write,
   *  disarmed by the host's own words, so an idle extension costs nothing. */
  private answerTimer: ReturnType<typeof setTimeout> | null = null
  /** Whether this silent stretch has already been reported, so a host that stops
   *  answering tells the user once instead of once per queued message. */
  private reportedSilence = false

  constructor(private readonly deps: BrowserExtensionNativeMessagingDeps) {}

  /**
   * Open a port to `application` for the worker request `requestId`.
   *
   * The answer is always delivered, including a failure, because the worker's
   * `connectNative` has already handed the extension a port object and can only
   * finish it with a `disconnect` event. A failure here is that disconnect, with
   * the reason in `error`.
   */
  async connect(requestId: number, application: string): Promise<void> {
    if (this.disposed) {
      this.deliverConnectFailure(requestId, 'the extension was unloaded')
      return
    }
    if (this.ports.size >= MAX_PORTS_PER_EXTENSION) {
      this.deliverConnectFailure(
        requestId,
        'too many native messaging connections are already open'
      )
      return
    }
    const lookup = await resolveNativeHostManifest(
      application,
      this.deps.origin,
      this.deps.lookupOptions
    )
    if (lookup.found === false) {
      this.deliverConnectFailure(requestId, describeLookupFailure(application, lookup.reason))
      return
    }
    if (this.disposed) {
      this.deliverConnectFailure(requestId, 'the extension was unloaded')
      return
    }
    const portId = randomUUID()
    const host = new NativeHostProcess(lookup.host.path, {
      onMessage: (message) => {
        // The host spoke, so nothing it was asked is unanswered any more.
        this.clearAnswerWatch()
        traceNativeMessage('host-to-extension', application, message)
        this.deliver({ kind: 'message', portId, message })
      },
      onExit: (error) => this.closePort(portId, error)
    })
    // Hosts have to be tracked before they can speak: a very fast host can answer
    // before `start()` returns, and its message must find the port already there.
    this.ports.set(portId, { process: host, application })
    if (host.start() === false) {
      this.ports.delete(portId)
      this.deliverConnectFailure(
        requestId,
        `the native messaging host could not be started (${application})`
      )
      return
    }
    this.deliver({ kind: 'connect-result', requestId, portId, error: null })
  }

  /** Write one message to an open port. An unknown port is dropped: the worker's
   *  own port object already saw its disconnect. */
  post(portId: string, message: unknown): void {
    const port = this.ports.get(portId)
    if (!port) return
    traceNativeMessage('extension-to-host', port.application, message)
    if (port.process.send(message) === false) {
      this.closePort(portId, 'the native messaging host could not be written to')
      return
    }
    this.watchForAnswer(port.application)
  }

  /** Close one port because the extension asked to, which is not an error. */
  disconnect(portId: string): void {
    const port = this.ports.get(portId)
    if (!port) return
    this.ports.delete(portId)
    if (this.ports.size === 0) this.clearAnswerWatch()
    port.process.kill()
  }

  /** Close every port this extension holds and stop delivering. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearAnswerWatch()
    for (const [portId, port] of [...this.ports]) {
      this.ports.delete(portId)
      port.process.kill()
    }
  }

  /**
   * Start noticing whether the host answers the message just written.
   *
   * The timer only exists while a message is outstanding: it is armed by the
   * write, cleared by the first thing the host says, and never re-armed for a
   * stretch that has already been reported, so an extension that holds a port
   * open for hours costs one timer per exchange rather than a standing one.
   */
  private watchForAnswer(application: string): void {
    this.awaitingAnswer = application
    if (this.disposed || this.reportedSilence || this.answerTimer !== null) return
    const timer = setTimeout(() => {
      this.answerTimer = null
      const pending = this.awaitingAnswer
      if (pending === null || this.disposed) return
      this.reportedSilence = true
      // Dev level, and only the routing fields: the extension's own log carries
      // the same moment, and a host's payloads can carry key material.
      Logger.dev('Native messaging host left a message unanswered:', {
        application: pending,
        waitedMs: NATIVE_ANSWER_TIMEOUT_MS
      })
      this.deps.reportSilentHost?.(pending, NATIVE_ANSWER_TIMEOUT_MS)
    }, NATIVE_ANSWER_TIMEOUT_MS)
    // A stalled host must never be a reason for this process to stay alive.
    timer.unref?.()
    this.answerTimer = timer
  }

  /** Forget the outstanding message: the host answered, or there is no port left. */
  private clearAnswerWatch(): void {
    if (this.answerTimer !== null) {
      clearTimeout(this.answerTimer)
      this.answerTimer = null
    }
    this.awaitingAnswer = null
    this.reportedSilence = false
  }

  private closePort(portId: string, error: string | null): void {
    const port = this.ports.get(portId)
    if (!port) return
    this.ports.delete(portId)
    // A host that went away is not left holding an unanswered message: the
    // extension already has its disconnect, so there is nothing to report later.
    if (this.ports.size === 0) this.clearAnswerWatch()
    if (this.disposed) return
    this.deliver({ kind: 'disconnect', portId, error })
  }

  private deliverConnectFailure(requestId: number, error: string): void {
    if (this.disposed) return
    this.deliver({ kind: 'connect-result', requestId, portId: null, error })
  }

  private deliver(delivery: NativeMessagingDelivery): void {
    if (this.disposed) return
    this.deps.deliver(delivery)
  }
}

/**
 * One dev-level line about a native port's traffic.
 *
 * A password manager's biometric unlock is decided entirely by this exchange: the
 * extension asks the desktop app over the port and shows the option only when it
 * gets an answer, so "the extension offers no Touch ID" is invisible without it.
 * Only the routing fields and scalar answers are recorded: a host's own payloads
 * can carry key material (Bitwarden returns the user's key over this port) and
 * never belong in a log file.
 */
const TRACE_FIELDS = ['command', 'type', 'topic', 'response', 'status', 'error'] as const

function traceNativeMessage(direction: string, application: string, message: unknown): void {
  if (typeof message !== 'object' || message === null) {
    Logger.dev('Extension native message:', { direction, application, message: typeof message })
    return
  }
  const record = message as Record<string, unknown>
  const fields: Record<string, unknown> = {}
  for (const field of TRACE_FIELDS) {
    const value = record[field]
    if (typeof value === 'number' || typeof value === 'boolean') fields[field] = value
    else if (typeof value === 'string') fields[field] = value.slice(0, 120)
  }
  Logger.dev('Extension native message:', { direction, application, ...fields })
}

/** The reason a lookup failed, phrased the way the extension's own users read it. */
function describeLookupFailure(application: string, reason: string): string {
  switch (reason) {
    case 'invalid-name':
      return `"${application}" is not a valid native messaging host name`
    case 'not-found':
      return `the native messaging host "${application}" is not installed`
    case 'invalid-manifest':
      return `the native messaging host "${application}" has an invalid manifest`
    case 'type-unsupported':
      return `the native messaging host "${application}" is not a stdio host`
    case 'origin-not-allowed':
      return `the native messaging host "${application}" does not allow this extension`
    default:
      return `the native messaging host "${application}" could not be reached`
  }
}
