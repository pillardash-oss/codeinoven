/**
 * Cloud relay client.
 *
 * Connects to the relay endpoint configured via `RELAY_URL` plus `RELAY_TOKEN`
 * and, when MQTT signaling is configured (`MQTT_URL`, `MQTT_USERNAME`,
 * `MQTT_PASSWORD`), uses MQTT for signaling before the relay data channel.
 * Peer credentials are exchanged for the session handshake through
 * `PEER_SECRET_AUTH` (nonce + HMAC token; the raw secret never leaves the
 * device). All relay values come from public environment variables.
 *
 * The socket is created through an injectable factory so the module is
 * unit-testable without a production relay — tests use the localhost dev
 * fallback.
 */

import type { RelayRef } from './routes'
import { remoteLog } from './logger'
import type { SocketFactory, TransportSocket } from './transport'
import {
  createHandshakeToken,
  decryptPayload,
  encryptPayload,
  generateNonce
} from './session-security'

export type RelayEvent =
  | { kind: 'signaling:mqtt-failed'; reason: string }
  | { kind: 'handshake:ok'; relay: RelayRef }
  | { kind: 'handshake:rejected'; relay: RelayRef; reason: string }
  | { kind: 'disconnected'; relay: RelayRef; reason: string }
  | { kind: 'message'; data: string }

export interface RelayClientOptions {
  url: string
  token: string | null
  authSecret: string | null
  mqtt: {
    url: string | null
    username: string | null
    password: string | null
  }
  socketFactory?: SocketFactory
  handshakeTimeoutMs?: number
  mqttSignalingTimeoutMs?: number
  onEvent: (event: RelayEvent) => void
}

export interface RelayClient {
  connect(): Promise<RelayConnectResult>
  send(data: string): Promise<void>
  close(): void
}

export type RelayConnectResult = 'open' | 'rejected' | 'failed'

interface RelayHello {
  type: 'relay:hello'
  version: number
  nonce: string
  token: string | null
  auth: string
}

interface RelayReply {
  type: 'relay:hello:ok' | 'relay:error'
  reason?: string
}

interface DataEnvelope {
  type: 'remote:data'
  payload: string
}

function parseReply(data: string): RelayReply | null {
  try {
    const parsed: unknown = JSON.parse(data)
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    if (record.type !== 'relay:hello:ok' && record.type !== 'relay:error') return null
    return {
      type: record.type,
      reason: typeof record.reason === 'string' ? record.reason : undefined
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

/**
 * Attempt optional MQTT signaling. Failures are non-fatal — the relay data
 * channel can still signal directly — and are reported as a relay event.
 */
function attemptMqttSignaling(
  options: RelayClientOptions,
  socketFactory: SocketFactory,
  timeoutMs: number
): Promise<boolean> {
  const mqttUrl = options.mqtt.url
  if (!mqttUrl) return Promise.resolve(false)

  let socket: TransportSocket
  try {
    socket = socketFactory(mqttUrl)
  } catch {
    options.onEvent({ kind: 'signaling:mqtt-failed', reason: 'socket-creation-failed' })
    return Promise.resolve(false)
  }

  return new Promise<boolean>((resolvePromise) => {
    let settled = false
    const finish = (ok: boolean, reason?: string): void => {
      if (settled) return
      settled = true
      if (!ok) {
        options.onEvent({ kind: 'signaling:mqtt-failed', reason: reason ?? 'signaling-failed' })
      }
      resolvePromise(ok)
    }
    const timer = setTimeout(
      () => finish(false, 'signaling-timeout'),
      timeoutMs
    ) as unknown as number

    socket.onopen = () => {
      clearTimeout(timer)
      socket.send(
        JSON.stringify({
          type: 'relay:signal',
          username: options.mqtt.username ?? 'desktop'
        })
      )
      finish(true)
    }
    socket.onerror = () => finish(false, 'socket-error')
    socket.onclose = () => finish(false, 'socket-closed')
  })
}

export function createRelayClient(options: RelayClientOptions): RelayClient {
  const relay: RelayRef = { url: options.url }
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000
  const mqttSignalingTimeoutMs = options.mqttSignalingTimeoutMs ?? 5_000
  const socketFactory =
    options.socketFactory ??
    ((target: string): TransportSocket => new WebSocket(target) as unknown as TransportSocket)

  let socket: TransportSocket
  let settled = false
  let open = false
  let handshakeTimer: number | null = null
  let resolve: (result: RelayConnectResult) => void = () => undefined

  function finish(result: RelayConnectResult, event: RelayEvent): void {
    if (settled) return
    settled = true
    if (handshakeTimer !== null) {
      clearTimeout(handshakeTimer)
      handshakeTimer = null
    }
    options.onEvent(event)
    resolve(result)
  }

  return {
    connect(): Promise<RelayConnectResult> {
      // MQTT signaling is optional and non-fatal when it fails.
      void attemptMqttSignaling(options, socketFactory, mqttSignalingTimeoutMs)

      socket = socketFactory(options.url)
      socket.onopen = () => {
        if (settled) return
        remoteLog.dev(`Relay handshaking with ${options.url}`)
        const nonce = generateNonce()
        void createHandshakeToken(options.authSecret ?? '', nonce).then((auth) => {
          if (settled) return
          const hello: RelayHello = {
            type: 'relay:hello',
            version: 1,
            nonce,
            token: options.token,
            auth
          }
          socket.send(JSON.stringify(hello))
        })
        handshakeTimer = setTimeout(() => {
          remoteLog.error(`Relay handshake timed out for ${options.url}`)
          finish('failed', { kind: 'disconnected', relay, reason: 'handshake-timeout' })
          socket.close()
        }, handshakeTimeoutMs) as unknown as number
      }

      socket.onmessage = (event) => {
        const reply = parseReply(event.data)
        if (reply) {
          if (reply.type === 'relay:hello:ok') {
            open = true
            remoteLog.dev(`Relay handshake accepted for ${options.url}`)
            finish('open', { kind: 'handshake:ok', relay })
            return
          }
          remoteLog.error(
            `Relay handshake rejected for ${options.url}: ${reply.reason ?? 'unknown'}`
          )
          finish('rejected', {
            kind: 'handshake:rejected',
            relay,
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
              remoteLog.error(`Relay payload decryption failed for ${options.url}`)
              finish('failed', { kind: 'disconnected', relay, reason: 'decrypt-failed' })
              socket.close()
            })
          return
        }

        options.onEvent({ kind: 'message', data: event.data })
      }

      socket.onclose = () => {
        if (!settled) {
          finish('failed', { kind: 'disconnected', relay, reason: 'socket-closed' })
          return
        }
        if (open) {
          open = false
          options.onEvent({ kind: 'disconnected', relay, reason: 'socket-closed' })
        }
      }

      socket.onerror = () => {
        remoteLog.error(`Relay transport error for ${options.url}`)
      }

      return new Promise<RelayConnectResult>((innerResolve) => {
        resolve = innerResolve
      })
    },

    async send(data: string): Promise<void> {
      if (!open || !socket) {
        remoteLog.error('Relay send attempted before the channel was open')
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
}
