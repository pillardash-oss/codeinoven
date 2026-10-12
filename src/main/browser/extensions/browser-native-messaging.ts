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
import {
  resolveNativeHostManifest,
  type NativeHostLookupOptions
} from './browser-native-host-manifest'
import { NativeHostProcess } from './browser-native-host-process'

/** How many native ports one extension may hold open at once. The flows that use
 *  this (a password manager's desktop bridge) hold one or two; the cap is only
 *  there to bound a worker that opens connections in a loop. */
const MAX_PORTS_PER_EXTENSION = 8

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
}

interface OpenPort {
  process: NativeHostProcess
}

export class BrowserExtensionNativeMessaging {
  private readonly ports = new Map<string, OpenPort>()
  private disposed = false

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
      onMessage: (message) => this.deliver({ kind: 'message', portId, message }),
      onExit: (error) => this.closePort(portId, error)
    })
    // Hosts have to be tracked before they can speak: a very fast host can answer
    // before `start()` returns, and its message must find the port already there.
    this.ports.set(portId, { process: host })
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
    if (port.process.send(message) === false) {
      this.closePort(portId, 'the native messaging host could not be written to')
    }
  }

  /** Close one port because the extension asked to, which is not an error. */
  disconnect(portId: string): void {
    const port = this.ports.get(portId)
    if (!port) return
    this.ports.delete(portId)
    port.process.kill()
  }

  /** Close every port this extension holds and stop delivering. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const [portId, port] of [...this.ports]) {
      this.ports.delete(portId)
      port.process.kill()
    }
  }

  private closePort(portId: string, error: string | null): void {
    const port = this.ports.get(portId)
    if (!port) return
    this.ports.delete(portId)
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
