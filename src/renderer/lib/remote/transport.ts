/**
 * WebSocket peer transport over the local network.
 *
 * Connects to a discovered LAN peer at `ws://<peer-host>:<LAN_PORT>` and runs a
 * `PEER_SECRET_AUTH` handshake: the client sends a nonce plus an HMAC-SHA256
 * token derived from the shared secret — the raw secret never leaves the
 * device. On success a data channel is open; handshake rejection and
 * disconnection are reported as transport events.
 *
 * The socket is created through an injectable factory so the module is
 * unit-testable without a real network.
 */

import type { PeerRef } from './routes'
import { remoteLog } from './logger'

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

export interface LanTransportOptions {
  peer: PeerRef
  authSecret: string | null
  socketFactory?: SocketFactory
  handshakeTimeoutMs?: number
  onEvent: (event: TransportEvent) => void
}

export interface LanTransport {
  connect(): Promise<TransportConnectResult>
  send(data: string): void
  close(): void
}

export type TransportConnectResult = 'open' | 'rejected' | 'failed'

interface HelloMessage {
  type: 'remote:hello'
  version: number
  nonce: string
  token: string
}

interface ReplyMessage {
  type: 'remote:hello:ok' | 'remote:error'
  reason?: string
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** HMAC-SHA256 token over the nonce, keyed by the shared auth secret. */
export async function createAuthToken(secret: string, nonce: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(nonce))
  return toBase64(new Uint8Array(signature))
}

export function createNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return toBase64(bytes)
}

function parseReply(data: string): ReplyMessage | null {
  try {
    const parsed: unknown = JSON.parse(data)
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    if (record.type !== 'remote:hello:ok' && record.type !== 'remote:error') return null
    return {
      type: record.type,
      reason: typeof record.reason === 'string' ? record.reason : undefined
    }
  } catch {
    return null
  }
}

export function createLanTransport(options: LanTransportOptions): LanTransport {
  const peer = options.peer
  const url = `ws://${peer.host}:${peer.port}`
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
        const nonce = createNonce()
        const secret = options.authSecret ?? ''
        void createAuthToken(secret, nonce).then((token) => {
          if (settled) return
          const hello: HelloMessage = { type: 'remote:hello', version: 1, nonce, token }
          socket.send(JSON.stringify(hello))
        })
        handshakeTimer = setTimeout(() => {
          remoteLog.error(`LAN handshake timed out for ${url}`)
          finish('failed', { kind: 'disconnected', peer, reason: 'handshake-timeout' })
          socket.close()
        }, handshakeTimeoutMs) as unknown as number
      }

      socket.onmessage = (event) => {
        const reply = parseReply(event.data)
        if (!reply) {
          options.onEvent({ kind: 'message', data: event.data })
          return
        }
        if (reply.type === 'remote:hello:ok') {
          open = true
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

    send(data: string): void {
      if (!open || !socket) {
        remoteLog.error('LAN transport send attempted before the channel was open')
        return
      }
      socket.send(data)
    },

    close(): void {
      if (!socket) return
      socket.close()
    }
  }
}
