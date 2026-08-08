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
 *
 * Delivery guarantees: connect deadlines, a bounded outbound queue with
 * monotonic message IDs and acknowledgement handling, inbound duplicate
 * suppression, and opt-in full-jitter reconnection with bounded retries.
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
import { BoundedSet, createEpochMessageIdAllocator, fullJitterDelay } from './relay-protocol'

export { fullJitterDelay } from './relay-protocol'

export type RelayEvent =
  | { kind: 'signaling:mqtt-failed'; reason: string }
  | { kind: 'handshake:ok'; relay: RelayRef }
  | { kind: 'handshake:rejected'; relay: RelayRef; reason: string }
  | { kind: 'disconnected'; relay: RelayRef; reason: string }
  | { kind: 'message'; data: string }

export interface RelayReconnectOptions {
  maxAttempts?: number
  initialDelayMs?: number
  maxDelayMs?: number
  /** Deterministic random source for the full-jitter backoff (tests). */
  random?: () => number
}

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
  /** Deadline for the socket to open; when exceeded the attempt fails. */
  connectTimeoutMs?: number
  /** Bounded outbound queue; the oldest message is dropped when full. */
  queueLimit?: number
  /** When provided, the client reconnects with full-jitter backoff. */
  reconnect?: RelayReconnectOptions
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
  id?: string
  payload: string
}

interface AckEnvelope {
  type: 'remote:ack' | 'relay:ack'
  id: string
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000
const DEFAULT_QUEUE_LIMIT = 1_000
const DEFAULT_RECONNECT_MAX_ATTEMPTS = 8
const DEFAULT_RECONNECT_INITIAL_DELAY_MS = 500
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000

function parseDataEnvelope(data: string): DataEnvelope | null {
  try {
    const parsed: unknown = JSON.parse(data)
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    if (record.type !== 'remote:data') return null
    return {
      type: 'remote:data',
      id: typeof record.id === 'string' ? record.id : undefined,
      payload: typeof record.payload === 'string' ? record.payload : ''
    }
  } catch {
    return null
  }
}

function parseAck(data: string): AckEnvelope | null {
  try {
    const parsed: unknown = JSON.parse(data)
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    if (record.type !== 'remote:ack' && record.type !== 'relay:ack') return null
    return { type: record.type, id: typeof record.id === 'string' ? record.id : '' }
  } catch {
    return null
  }
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
    const timer = setTimeout(() => {
      socket.close()
      finish(false, 'signaling-timeout')
    }, timeoutMs) as unknown as number

    socket.onopen = () => {
      clearTimeout(timer)
      socket.send(
        JSON.stringify({
          type: 'relay:signal',
          username: options.mqtt.username ?? 'desktop'
        })
      )
      socket.close()
      finish(true)
    }
    socket.onerror = () => {
      clearTimeout(timer)
      socket.close()
      finish(false, 'socket-error')
    }
    socket.onclose = () => {
      if (!settled) finish(false, 'socket-closed')
    }
  })
}

export function createRelayClient(options: RelayClientOptions): RelayClient {
  const relay: RelayRef = { url: options.url }
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000
  const mqttSignalingTimeoutMs = options.mqttSignalingTimeoutMs ?? 5_000
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  const queueLimit = options.queueLimit ?? DEFAULT_QUEUE_LIMIT
  const reconnect = options.reconnect
  const socketFactory =
    options.socketFactory ??
    ((target: string): TransportSocket => new WebSocket(target) as unknown as TransportSocket)

  let socket: TransportSocket
  let settled = false
  let open = false
  let closing = false
  let reconnecting = false
  let connectTimer: number | null = null
  let handshakeTimer: number | null = null
  let reconnectTimer: number | null = null
  let reconnectAttempt = 0
  const nextMessageId = createEpochMessageIdAllocator()
  let resolve: (result: RelayConnectResult) => void = () => undefined
  const queue: Array<{ id: string; data: string; encrypted: string | null }> = []
  const inFlight = new Map<string, { id: string; data: string; encrypted: string | null }>()
  const seenIds = new BoundedSet(queueLimit)

  function clearTimers(): void {
    if (handshakeTimer !== null) {
      clearTimeout(handshakeTimer)
      handshakeTimer = null
    }
    if (connectTimer !== null) {
      clearTimeout(connectTimer)
      connectTimer = null
    }
  }

  function finish(result: RelayConnectResult, event: RelayEvent): void {
    if (settled) return
    settled = true
    clearTimers()
    options.onEvent(event)
    resolve(result)
  }

  function enqueue(record: { id: string; data: string; encrypted: string | null }): void {
    if (queueLimit <= 0) return
    if (queue.length >= queueLimit) queue.shift()
    queue.push(record)
  }

  function requeueInFlight(): void {
    for (const record of inFlight.values()) enqueue(record)
    inFlight.clear()
  }

  async function transmit(record: {
    id: string
    data: string
    encrypted: string | null
  }): Promise<void> {
    if (!socket || !open) return
    let payload = record.encrypted
    if (payload === null) {
      payload = await encryptPayload(options.authSecret ?? '', record.data)
      record.encrypted = payload
    }
    if (!socket || !open) return
    inFlight.set(record.id, record)
    const envelope: DataEnvelope = { type: 'remote:data', id: record.id, payload }
    socket.send(JSON.stringify(envelope))
  }

  async function flushQueue(): Promise<void> {
    while (queue.length > 0) {
      const record = queue.shift()
      if (!record) break
      await transmit(record)
    }
  }

  function scheduleReconnect(reason: string): void {
    if (!reconnect || reconnectTimer !== null || closing) return
    const maxAttempts = reconnect.maxAttempts ?? DEFAULT_RECONNECT_MAX_ATTEMPTS
    if (reconnectAttempt >= maxAttempts) {
      reconnectAttempt = 0
      options.onEvent({ kind: 'disconnected', relay, reason })
      return
    }
    const delay = fullJitterDelay(
      reconnectAttempt,
      reconnect.initialDelayMs ?? DEFAULT_RECONNECT_INITIAL_DELAY_MS,
      reconnect.maxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS,
      reconnect.random
    )
    reconnectAttempt += 1
    options.onEvent({
      kind: 'disconnected',
      relay,
      reason: `${reason} (reconnect ${reconnectAttempt})`
    })
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      reconnecting = true
      void establishConnection()
    }, delay) as unknown as number
  }

  /** Terminal attempt outcome: reconnect loops retry, the initial connect settles. */
  function failOrRetry(result: RelayConnectResult, reason: string, event: RelayEvent): void {
    if (reconnecting) {
      scheduleReconnect(reason)
    } else {
      finish(result, event)
    }
  }

  function establishConnection(): Promise<RelayConnectResult> {
    settled = false
    open = false
    // MQTT signaling is optional and non-fatal when it fails.
    void attemptMqttSignaling(options, socketFactory, mqttSignalingTimeoutMs)

    socket = socketFactory(options.url)
    // Connect deadline: fail the attempt if the socket never opens.
    connectTimer = setTimeout(() => {
      if (!settled) {
        remoteLog.error(`Relay connect timed out for ${options.url}`)
        failOrRetry('failed', 'connect-timeout', {
          kind: 'disconnected',
          relay,
          reason: 'connect-timeout'
        })
        socket.close()
      }
    }, connectTimeoutMs) as unknown as number
    socket.onopen = () => {
      if (settled) return
      if (connectTimer !== null) {
        clearTimeout(connectTimer)
        connectTimer = null
      }
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
        failOrRetry('failed', 'handshake-timeout', {
          kind: 'disconnected',
          relay,
          reason: 'handshake-timeout'
        })
        socket.close()
      }, handshakeTimeoutMs) as unknown as number
    }

    socket.onmessage = (event) => {
      const ack = parseAck(event.data)
      if (ack) {
        inFlight.delete(ack.id)
        return
      }

      const reply = parseReply(event.data)
      if (reply) {
        if (reply.type === 'relay:hello:ok') {
          open = true
          reconnecting = false
          reconnectAttempt = 0
          remoteLog.dev(`Relay handshake accepted for ${options.url}`)
          finish('open', { kind: 'handshake:ok', relay })
          void flushQueue()
          return
        }
        remoteLog.error(`Relay handshake rejected for ${options.url}: ${reply.reason ?? 'unknown'}`)
        failOrRetry('rejected', 'auth-failed', {
          kind: 'handshake:rejected',
          relay,
          reason: reply.reason ?? 'auth-failed'
        })
        socket.close()
        return
      }

      const envelope = parseDataEnvelope(event.data)
      if (envelope) {
        // Duplicate suppression: an already delivered frame id is ignored.
        if (envelope.id !== undefined) {
          if (seenIds.has(envelope.id)) return
          seenIds.add(envelope.id)
        }
        void decryptPayload(options.authSecret ?? '', envelope.payload)
          .then((plaintext) => options.onEvent({ kind: 'message', data: plaintext }))
          .catch(() => {
            remoteLog.error(`Relay payload decryption failed for ${options.url}`)
            failOrRetry('failed', 'decrypt-failed', {
              kind: 'disconnected',
              relay,
              reason: 'decrypt-failed'
            })
            socket.close()
          })
        return
      }

      options.onEvent({ kind: 'message', data: event.data })
    }

    socket.onclose = () => {
      if (closing) {
        open = false
        return
      }
      if (open) {
        open = false
        requeueInFlight()
        scheduleReconnect('socket-closed')
        return
      }
      if (!settled) {
        failOrRetry('failed', 'socket-closed', {
          kind: 'disconnected',
          relay,
          reason: 'socket-closed'
        })
      }
    }

    socket.onerror = () => {
      remoteLog.error(`Relay transport error for ${options.url}`)
    }

    return new Promise<RelayConnectResult>((innerResolve) => {
      resolve = innerResolve
    })
  }

  return {
    connect(): Promise<RelayConnectResult> {
      closing = false
      return establishConnection()
    },
    async send(data: string): Promise<void> {
      const record = { id: nextMessageId(), data, encrypted: null }
      if (!open || !socket) {
        enqueue(record)
        return
      }
      await transmit(record)
    },

    close(): void {
      closing = true
      reconnecting = false
      reconnectAttempt = 0
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      if (!socket) return
      socket.close()
    }
  }
}
