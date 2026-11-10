/**
 * The extension's end of a native messaging host, and the bridge port itself.
 *
 * WHY THIS MODULE EXISTS
 * Electron accepts `chrome.runtime.connectNative` and `sendNativeMessage` and then
 * refuses every one of them, so a password manager's desktop bridge — the whole of
 * its biometric unlock — cannot connect at all. The app opens the host process
 * itself in main, and this module is the extension's side of that: a `Port` that
 * behaves the way `chrome.runtime` documents one, carried over the same bridge port
 * the frame queries use. Nothing here talks to a process; every command is written
 * to the port and the app answers, which is why a call made before the port exists
 * is queued rather than dropped.
 *
 * WHAT IT ALSO OWNS
 * The `runtime.onConnect` listener that receives that port. The port is where every
 * command the app sends a worker arrives (startup, installed, menu clicks, cookies,
 * native host answers), so the listener belongs with the queue it flushes and with
 * the native state those answers settle.
 */
import { answerWith, chromeApi, roots, state } from './context.ts'
import {
  BRIDGE_PORT_NAME,
  currentBridgePort,
  frameRequests,
  sendFrameRequest,
  setBridgePort
} from './bridge.ts'
import type { BridgePort, Frame } from './bridge.ts'
import type { RealEvent } from './events.ts'
import { makeRealEvent } from './events.ts'
import { handleBridgeCommand } from './bridge-commands.ts'

// ── native messaging ────────────────────────────────────────────────────────
// Electron implements `chrome.runtime.connectNative` and `sendNativeMessage` but
// refuses every call, an installed host and a bogus host name alike, with "Access
// to the native messaging host was disabled by the system administrator"
// (measured). A password manager's desktop bridge   the whole of its biometric
// unlock   therefore cannot connect at all, so the app opens the host itself in
// main and this section is the extension's end of that: a Port that behaves the
// way `chrome.runtime` documents one, carried over the same bridge port the frame
// queries use. There is no `nativeMessaging` permission to check here; main owns
// the manifest's `allowed_origins` gate.

/** The Port `runtime.connectNative` hands back, in the members extensions read. */
export interface NativePort {
  name: string
  sender: undefined
  onMessage: RealEvent
  onDisconnect: RealEvent
  postMessage: (message: unknown) => void
  disconnect: () => void
}

/** One native host request, held from `connect` until the port is closed. */
export interface NativePortRecord {
  requestId: number
  application: string
  portId: string | null
  connected: boolean
  closed: boolean
  queue: unknown[]
  onMessage: RealEvent
  onDisconnect: RealEvent
  port: NativePort | null
}

/** One command this worker sends the app about a native host request. */
export type NativeCommand =
  | { kind: 'native-request'; requestId: number; op: 'connect'; application: string }
  | { kind: 'native-request'; requestId: number; op: 'post'; portId: string; message: unknown }
  | { kind: 'native-request'; requestId: number; op: 'disconnect'; portId: string }

/** One answer the app sends back about a native host request. */
export type NativeInboundCommand =
  | {
      kind: 'native-connect-result'
      requestId: number
      portId?: string | null
      error?: string | null
    }
  | { kind: 'native-message'; portId: string; message: unknown }
  | { kind: 'native-disconnect'; portId: string; error?: string | null }

/** The runtime namespace, viewed through the members this module replaces. */
interface NativeRuntime {
  connectNative?: (application: string) => NativePort
  sendNativeMessage?: (
    application: string,
    message: unknown,
    callback?: unknown
  ) => Promise<unknown>
}

/** `runtime.onConnect`, whose listener is handed the port the app connected. */
interface ConnectEvent {
  addListener: (listener: (port: BridgePort) => void) => void
}

/** The runtime namespace, viewed through the one member the port listener reads. */
interface BridgeRuntime {
  onConnect?: ConnectEvent
}

/**
 * One command the app posts over the bridge port.
 *
 * The only members this listener reads are the frame answer's own, so only those
 * are named; `handleBridgeCommand` reads the rest of the envelope.
 */
interface BridgeCommandEnvelope {
  kind: string
  id: number
  frames?: Frame[]
  [member: string]: unknown
}

/** The requests the app has not answered yet, by this worker's request number. */
export const nativePortsByRequest = new Map<number, NativePortRecord>()

/** The requests the app holds a live host process for, by the app's port id. */
export const nativePortsById = new Map<string, NativePortRecord>()

/** Commands written before the bridge page connected, flushed when it does. */
export const pendingNativeCommands: NativeCommand[] = []

export let nativeSequence = 0

export function nativeRequestId(): number {
  nativeSequence += 1
  return nativeSequence
}

export function sendNativeCommand(command: NativeCommand): void {
  const port = currentBridgePort()
  if (port) {
    try {
      port.postMessage(command)
      return
    } catch (error) {
      state.errors.push('native-bridge: ' + String(error))
      setBridgePort(null)
    }
  }
  // A worker can call `connectNative` before the bridge page has connected. The
  // command is held and flushed the moment it does, rather than dropped.
  if (pendingNativeCommands.length < 64) pendingNativeCommands.push(command)
}

export function setRuntimeLastError(message: string | null): void {
  try {
    Object.defineProperty(chromeApi.runtime, 'lastError', {
      value: message ? { message } : undefined,
      configurable: true,
      writable: true
    })
  } catch {
    // A runtime that refuses the property simply has no lastError to read.
  }
}

export function closeNativePort(
  record: NativePortRecord,
  error: string | null,
  notify: boolean
): void {
  if (record.closed) return
  record.closed = true
  nativePortsByRequest.delete(record.requestId)
  if (record.portId) nativePortsById.delete(record.portId)
  if (!notify) return
  setRuntimeLastError(error)
  try {
    record.onDisconnect.__cioEmit([record.port])
  } catch (dispatchError) {
    state.errors.push('native-disconnect: ' + String(dispatchError))
  }
  setRuntimeLastError(null)
}

export function handleNativeCommand(command: NativeInboundCommand): void {
  if (command.kind === 'native-connect-result') {
    const record = nativePortsByRequest.get(command.requestId)
    if (!record) return
    if (!command.portId || command.error) {
      closeNativePort(
        record,
        command.error || 'the native messaging host could not be started',
        true
      )
      return
    }
    record.portId = command.portId
    record.connected = true
    nativePortsById.set(command.portId, record)
    for (const message of record.queue.splice(0)) {
      sendNativeCommand({
        kind: 'native-request',
        requestId: nativeRequestId(),
        op: 'post',
        portId: record.portId,
        message
      })
    }
    return
  }
  if (command.kind === 'native-message') {
    const record = nativePortsById.get(command.portId)
    if (!record || record.closed) return
    try {
      record.onMessage.__cioEmit([command.message, record.port])
    } catch (dispatchError) {
      state.errors.push('native-message: ' + String(dispatchError))
    }
    return
  }
  if (command.kind === 'native-disconnect') {
    const record = nativePortsById.get(command.portId)
    if (!record) return
    closeNativePort(record, command.error || null, true)
  }
}

export function createNativePort(application: string): NativePort {
  const onMessage = makeRealEvent()
  const onDisconnect = makeRealEvent()
  const record: NativePortRecord = {
    requestId: nativeRequestId(),
    application,
    portId: null,
    connected: false,
    closed: false,
    queue: [],
    onMessage,
    onDisconnect,
    port: null
  }
  const port: NativePort = {
    name: application,
    sender: undefined,
    onMessage,
    onDisconnect,
    postMessage(message) {
      if (record.closed) return
      // A message written before the host is up waits, which is what Chrome does
      // with a port whose connection is still being established.
      if (!record.connected || !record.portId) {
        if (record.queue.length < 256) record.queue.push(message)
        return
      }
      sendNativeCommand({
        kind: 'native-request',
        requestId: nativeRequestId(),
        op: 'post',
        portId: record.portId,
        message
      })
    },
    disconnect() {
      if (record.closed) return
      if (record.portId) {
        sendNativeCommand({
          kind: 'native-request',
          requestId: nativeRequestId(),
          op: 'disconnect',
          portId: record.portId
        })
      }
      // Chrome fires `onDisconnect` on the other end of a disconnect, not on the
      // caller's own listeners, so nothing is emitted here.
      closeNativePort(record, null, false)
    }
  }
  record.port = port
  nativePortsByRequest.set(record.requestId, record)
  sendNativeCommand({
    kind: 'native-request',
    requestId: record.requestId,
    op: 'connect',
    application
  })
  return port
}

/**
 * Replace `connectNative` and `sendNativeMessage` on every root, then take the
 * bridge port the app connects to.
 *
 * Both halves are one install because the listener is what flushes the queue the
 * native commands wait in: without the port there is no host, and without the port
 * listener there is no port.
 */
export function installNativeMessaging(): void {
  for (const root of roots) {
    const runtime = root && (root.runtime as NativeRuntime | undefined)
    if (!runtime) continue
    try {
      Object.defineProperty(runtime, 'connectNative', {
        value: (application: unknown) => {
          if (typeof application !== 'string' || application.length === 0) {
            throw new Error('Invalid native messaging host name')
          }
          return createNativePort(application)
        },
        configurable: true,
        writable: true
      })
      Object.defineProperty(runtime, 'sendNativeMessage', {
        value: (application: unknown, message: unknown, callback?: unknown) => {
          if (typeof application !== 'string' || application.length === 0) {
            return answerWith(callback, undefined)
          }
          return new Promise<unknown>((resolve) => {
            const port = createNativePort(application)
            let settled = false
            const finish = (response: unknown) => {
              if (settled) return
              settled = true
              try {
                port.disconnect()
              } catch {
                // Already closed.
              }
              answerWith(callback, response)
              resolve(response)
            }
            port.onMessage.addListener((incoming) => finish(incoming))
            port.onDisconnect.addListener(() => finish(undefined))
            port.postMessage(message)
          })
        },
        configurable: true,
        writable: true
      })
    } catch (error) {
      state.errors.push('native-messaging: ' + String(error))
    }
  }

  // A port, not a message: `runtime.sendMessage` is delivered to every one of
  // the extension's own `onMessage` listeners, and a real extension's listener
  // can throw on a shape it does not know (uBlock Origin Lite's does, measured:
  // `request.what.includes(':')` on a message with no `what`). A port's traffic
  // reaches its other end and nothing else, and the connect itself is the one
  // event the extension could still see.
  try {
    const runtime = chromeApi.runtime as BridgeRuntime | undefined
    if (runtime && runtime.onConnect && typeof runtime.onConnect.addListener === 'function') {
      runtime.onConnect.addListener((port) => {
        try {
          if (!port || port.name !== BRIDGE_PORT_NAME) return
          setBridgePort(port)
          for (const request of frameRequests.values()) sendFrameRequest(request)
          for (const command of pendingNativeCommands.splice(0)) {
            try {
              port.postMessage(command)
            } catch (error) {
              state.errors.push('native-bridge: ' + String(error))
            }
          }
          port.onDisconnect.addListener(() => {
            if (currentBridgePort() === port) setBridgePort(null)
          })
          port.onMessage.addListener((incoming) => {
            try {
              const command = incoming as BridgeCommandEnvelope
              if (command && command.kind === 'frames-result') {
                const request = frameRequests.get(command.id)
                if (request) {
                  frameRequests.delete(command.id)
                  clearTimeout(request.timer)
                  request.resolve(Array.isArray(command.frames) ? command.frames : null)
                }
                return
              }
              handleBridgeCommand(command)
            } catch (error) {
              state.errors.push('bridge: ' + String(error))
            }
          })
          state.bridgeListener = 'installed'
        } catch (error) {
          state.errors.push('bridge-port: ' + String(error))
        }
      })
    }
  } catch (error) {
    state.errors.push('bridge-listener: ' + String(error))
  }
}
