/**
 * WebSocket peer transport over the local network.
 *
 * Connects to a discovered LAN peer at `ws://<peer-host>:<LAN_PORT>` and runs a
 * device proof-of-possession handshake. On success a data channel is open;
 * handshake rejection and disconnection are reported as transport events.
 *
 * The socket is created through an injectable factory so the module is
 * unit-testable without a real network.
 */

import type { PeerRef } from './routes'
import { remoteLog } from './logger'
import { decryptPayload, encryptPayload } from './session-security'
import { handshakeTranscript, signTranscript } from './device-identity'

export type TransportEvent =
  | { kind: 'connecting'; peer: PeerRef }
  | { kind: 'handshaking'; peer: PeerRef }
  | { kind: 'handshake:ok'; peer: PeerRef }
  | { kind: 'handshake:rejected'; peer: PeerRef; reason: string }
  | { kind: 'disconnected'; peer: PeerRef; reason: string }
  | { kind: 'message'; data: string }

export interface TransportSocket {
  send(data: string): void
  close(): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: string }) => void) | null
  onclose: ((event: { code?: number; reason?: string }) => void) | null
  onerror: ((event: unknown) => void) | null
}

export type SocketFactory = (url: string) => TransportSocket

/**
 * Proof-of-possession credentials for a phone device.
 */
export interface LanDeviceCredentials {
  deviceId: string | null
  deviceName: string
  authVersion: number
  signingKey: CryptoKey
  signingPublicJwk: JsonWebKey
  agreementPublicJwk: JsonWebKey
}

export interface LanTransportOptions {
  peer: PeerRef
  authSecret: string | null
  /** Wire scheme: the PWA connects over `wss`, the desktop renderer over `ws`. */
  scheme?: 'ws' | 'wss'
  socketFactory?: SocketFactory
  handshakeTimeoutMs?: number
  onEvent: (event: TransportEvent) => void
  /** Proof-of-possession device keys (PWA phones). */
  device?: LanDeviceCredentials
  /** Single-use pairing bootstrap from the QR code for first enrollment. */
  pairingBootstrap?: string | null
  /** Called with the desktop-assigned device id returned by `remote:hello:ok`. */
  onAssignedDevice?: (deviceId: string) => void
  /** Called with the current credential version returned by `remote:hello:ok`. */
  onAssignedAuthVersion?: (authVersion: number) => void
}

export interface LanTransport {
  connect(): Promise<TransportConnectResult>
  send(data: string): Promise<void>
  close(): void
}

export type TransportConnectResult = 'open' | 'rejected' | 'failed'

interface HelloMessage {
  type: 'remote:hello'
  version: number
  nonce: string
  signature?: string
  transcript?: string
  bootstrap?: string
  signingPublicJwk?: JsonWebKey
  agreementPublicJwk?: JsonWebKey
  authVersion?: number
  deviceId?: string
  deviceName?: string
}

interface ReplyMessage {
  type: 'remote:challenge' | 'remote:hello:ok' | 'remote:error'
  reason?: string
  nonce?: string
  device?: { id?: string; authVersion?: number }
}

interface DataEnvelope {
  type: 'remote:data'
  payload: string
}

function parseReply(data: string): ReplyMessage | null {
  try {
    const parsed: unknown = JSON.parse(data)
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    if (
      record.type !== 'remote:challenge' &&
      record.type !== 'remote:hello:ok' &&
      record.type !== 'remote:error'
    )
      return null
    const deviceRecord = record.device
    return {
      type: record.type,
      reason: typeof record.reason === 'string' ? record.reason : undefined,
      nonce: typeof record.nonce === 'string' ? record.nonce : undefined,
      device:
        typeof deviceRecord === 'object' && deviceRecord !== null
          ? {
              id:
                typeof (deviceRecord as Record<string, unknown>)['id'] === 'string'
                  ? ((deviceRecord as Record<string, unknown>)['id'] as string)
                  : undefined,
              authVersion:
                typeof (deviceRecord as Record<string, unknown>)['authVersion'] === 'number'
                  ? ((deviceRecord as Record<string, unknown>)['authVersion'] as number)
                  : undefined
            }
          : undefined
    }
  } catch {
    return null
  }
}

function parseDataEnvelope(data: string): DataEnvelope | null {
  try {
    const parsed: unknown = JSON.parse(data)
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    if (record.type !== 'remote:data') return null
    return {
      type: 'remote:data',
      payload: typeof record.payload === 'string' ? record.payload : ''
    }
  } catch {
    return null
  }
}

export function createLanTransport(options: LanTransportOptions): LanTransport {
  const peer = options.peer
  const url = `${options.scheme ?? 'ws'}://${peer.host}:${peer.port}`
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000
  const socketFactory =
    options.socketFactory ??
    ((target: string): TransportSocket => {
      return new WebSocket(target) as unknown as TransportSocket
    })

  let socket: TransportSocket
  let settled = false
  let open = false
  let handshakeTimer: number | null = null

  function finish(result: TransportConnectResult, event: TransportEvent): void {
    if (settled) return
    settled = true
    if (handshakeTimer !== null) {
      clearTimeout(handshakeTimer)
      handshakeTimer = null
    }
    options.onEvent(event)
    resolve(result)
  }

  let resolve: (result: TransportConnectResult) => void = () => undefined

  return {
    connect(): Promise<TransportConnectResult> {
      options.onEvent({ kind: 'connecting', peer })
      socket = socketFactory(url)

      socket.onopen = () => {
        if (settled) return
        options.onEvent({ kind: 'handshaking', peer })
        handshakeTimer = setTimeout(() => {
          remoteLog.error(`LAN handshake timed out for ${url}`)
          finish('failed', { kind: 'disconnected', peer, reason: 'handshake-timeout' })
          socket.close()
        }, handshakeTimeoutMs) as unknown as number
      }

      socket.onmessage = (event) => {
        const reply = parseReply(event.data)
        if (reply) {
          if (reply.type === 'remote:challenge' && reply.nonce) {
            void buildHello(reply.nonce)
              .then((hello) => {
                if (settled) return
                socket.send(JSON.stringify(hello))
              })
              .catch(() => {
                finish('rejected', {
                  kind: 'handshake:rejected',
                  peer,
                  reason: 'device-credentials-required'
                })
                socket.close()
              })
            return
          }
          if (reply.type === 'remote:hello:ok') {
            open = true
            const assigned = reply.device?.id
            if (assigned) options.onAssignedDevice?.(assigned)
            if (typeof reply.device?.authVersion === 'number') {
              options.onAssignedAuthVersion?.(reply.device.authVersion)
            }
            remoteLog.dev(`LAN handshake accepted for ${url}`)
            finish('open', { kind: 'handshake:ok', peer })
            return
          }
          remoteLog.error(`LAN handshake rejected for ${url}: ${reply.reason ?? 'unknown'}`)
          finish('rejected', {
            kind: 'handshake:rejected',
            peer,
            reason: reply.reason ?? 'auth-failed'
          })
          socket.close()
          return
        }

        const envelope = parseDataEnvelope(event.data)
        if (envelope) {
          void decryptPayload(options.authSecret ?? '', envelope.payload)
            .then((plaintext) => options.onEvent({ kind: 'message', data: plaintext }))
            .catch(() => {
              remoteLog.error(`LAN payload decryption failed for ${url}`)
              finish('failed', { kind: 'disconnected', peer, reason: 'decrypt-failed' })
              socket.close()
            })
          return
        }

        options.onEvent({ kind: 'message', data: event.data })
      }

      socket.onclose = () => {
        if (!settled) {
          finish('failed', { kind: 'disconnected', peer, reason: 'socket-closed' })
          return
        }
        if (open) {
          open = false
          options.onEvent({ kind: 'disconnected', peer, reason: 'socket-closed' })
        }
      }

      socket.onerror = () => {
        remoteLog.error(`LAN transport error for ${url}`)
      }

      return new Promise<TransportConnectResult>((innerResolve) => {
        resolve = innerResolve
      })
    },

    async send(data: string): Promise<void> {
      if (!open || !socket) {
        remoteLog.error('LAN transport send attempted before the channel was open')
        return
      }
      const payload = await encryptPayload(options.authSecret ?? '', data)
      socket.send(JSON.stringify({ type: 'remote:data', payload } satisfies DataEnvelope))
    },

    close(): void {
      if (!socket) return
      socket.close()
    }
  }

  /** Build the proof-of-possession handshake hello. */
  async function buildHello(nonce: string): Promise<HelloMessage> {
    const device = options.device
    if (!device) throw new Error('device-credentials-required')
    const transcript = handshakeTranscript({
      nonce,
      deviceId: device.deviceId,
      authVersion: device.authVersion,
      bootstrap: options.pairingBootstrap
    })
    const signature = await signTranscript(device.signingKey, transcript)
    if (!device.deviceId) {
      return {
        type: 'remote:hello',
        version: 3,
        nonce,
        signature,
        transcript,
        bootstrap: options.pairingBootstrap ?? undefined,
        signingPublicJwk: device.signingPublicJwk,
        agreementPublicJwk: device.agreementPublicJwk,
        deviceName: device.deviceName
      }
    }
    return {
      type: 'remote:hello',
      version: 3,
      nonce,
      signature,
      transcript,
      authVersion: device.authVersion,
      deviceId: device.deviceId,
      deviceName: device.deviceName
    }
  }
}
