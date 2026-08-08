/**
 * Same-origin account relay client (mobile / PWA).
 *
 * Connects to the hosted relay endpoint (`/v1/relay`) carrying the per-device
 * `desktopId` / `mobileDeviceId` so the relay can route frames between the phone
 * and its desktop. Implements the shared relay protocol: monotonic message IDs
 * on outbound frames, `relay:ack` delivery acknowledgements, bounded outbound
 * queue/in-flight with configured limits, inbound duplicate suppression, and
 * self-reconnect with full-jitter backoff that preserves queued work across
 * socket drops (same-client reconnect).
 */

import { decryptPayload, encryptPayload } from './session-security'
import { remoteLog } from './logger'
import {
  BoundedMap,
  BoundedSet,
  createEpochMessageIdAllocator,
  fullJitterDelay,
  parseRelayAckFrame,
  parseRelayDataFrame,
  parseRelayNackFrame,
  serializeRelayAckFrame,
  serializeRelayDataFrame
} from './relay-protocol'

export type AccountRelayEvent =
  | { kind: 'connected'; url: string }
  | { kind: 'offline' }
  | { kind: 'disconnected'; reason: string }
  | { kind: 'message'; data: string }

export interface AccountRelayClient {
  connect(): Promise<'open' | 'offline' | 'failed'>
  send(data: string): Promise<void>
  close(): void
}

export interface AccountRelayOptions {
  desktopId: string
  mobileDeviceId: string
  controlSecret: string
  relayPath?: string
  socketFactory?: (url: string) => WebSocket
  handshakeTimeoutMs?: number
  /** Bounded outbound queue/in-flight size; oldest messages are dropped when full. */
  queueLimit?: number
  /** Opt-in self-reconnect with full-jitter backoff preserving the queue. */
  reconnect?: {
    initialDelayMs?: number
    maxDelayMs?: number
    random?: () => number
  }
  onEvent: (event: AccountRelayEvent) => void
}

interface RelayFrame {
  type: string
  payload?: string
  online?: boolean
}

interface OutboundRecord {
  id: number
  data: string
  encrypted: string | null
}

const DEFAULT_QUEUE_LIMIT = 1_000
const DEFAULT_RECONNECT_INITIAL_DELAY_MS = 1_000
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000

function relayUrl(path: string): string {
  const target = new URL(path, window.location.origin)
  target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:'
  return target.toString()
}

function parseFrame(value: string): RelayFrame | null {
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    return {
      type: typeof record.type === 'string' ? record.type : '',
      payload: typeof record.payload === 'string' ? record.payload : undefined,
      online: typeof record.online === 'boolean' ? record.online : undefined
    }
  } catch {
    return null
  }
}

export function createAccountRelayClient(options: AccountRelayOptions): AccountRelayClient {
  const path = options.relayPath ?? '/v1/relay'
  const target = new URL(relayUrl(path))
  target.searchParams.set('role', 'mobile')
  target.searchParams.set('desktopId', options.desktopId)
  target.searchParams.set('mobileDeviceId', options.mobileDeviceId)
  const url = target.toString()
  const socketFactory = options.socketFactory ?? ((value: string) => new WebSocket(value))
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000
  const queueLimit = options.queueLimit ?? DEFAULT_QUEUE_LIMIT
  const reconnect = options.reconnect
  const nextMessageId = createEpochMessageIdAllocator()

  let socket: WebSocket | null = null
  let open = false
  let closing = false
  let reconnectTimer: number | null = null
  let reconnectAttempt = 0
  let settled = false
  let settle: (result: 'open' | 'offline' | 'failed') => void = () => undefined
  let timer: number | null = null
  const queue: OutboundRecord[] = []
  const inFlight = new BoundedMap<OutboundRecord>(queueLimit)
  const seenInboundIds = new BoundedSet(queueLimit)
  const inboundProcessing = new BoundedSet(queueLimit)

  function finish(result: 'open' | 'offline' | 'failed'): void {
    if (settled) return
    settled = true
    if (timer !== null) window.clearTimeout(timer)
    settle(result)
  }

  function enqueue(record: OutboundRecord): void {
    if (queueLimit <= 0) return
    if (queue.length >= queueLimit) queue.shift()
    queue.push(record)
  }

  function requeueInFlight(): void {
    for (const record of inFlight.values()) enqueue(record)
    inFlight.clear()
  }

  async function transmit(record: OutboundRecord): Promise<void> {
    if (!socket || !open) return
    let payload = record.encrypted
    if (payload === null) {
      payload = await encryptPayload(options.controlSecret, record.data)
      record.encrypted = payload
    }
    if (!socket || !open) return
    inFlight.set(record.id, record)
    socket.send(serializeRelayDataFrame(record.id, payload))
  }

  async function flushQueue(): Promise<void> {
    while (queue.length > 0) {
      const record = queue.shift()
      if (!record) break
      await transmit(record)
    }
  }

  /** Send a receiver-generated `relay:ack` control frame on the open socket. */
  function sendAck(id: number): void {
    if (!socket || !open || socket.readyState !== WebSocket.OPEN) return
    socket.send(serializeRelayAckFrame(id))
  }

  function scheduleReconnect(): void {
    if (closing || reconnectTimer !== null) return
    if (!reconnect) return
    const delay = fullJitterDelay(
      reconnectAttempt,
      reconnect.initialDelayMs ?? DEFAULT_RECONNECT_INITIAL_DELAY_MS,
      reconnect.maxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS,
      reconnect.random
    )
    reconnectAttempt += 1
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null
      void establishConnection()
    }, delay)
  }

  function establishConnection(): Promise<'open' | 'offline' | 'failed'> {
    settled = false
    socket = socketFactory(url)
    timer = window.setTimeout(() => {
      finish('failed')
      socket?.close()
      if (!closing) {
        options.onEvent({ kind: 'disconnected', reason: 'connect-timeout' })
        scheduleReconnect()
      }
    }, handshakeTimeoutMs)

    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return
      const ack = parseRelayAckFrame(event.data)
      if (ack) {
        inFlight.delete(ack.id)
        return
      }
      const nack = parseRelayNackFrame(event.data)
      if (nack) {
        // Explicit retryable rejection: requeue the frame for retransmission.
        const record = inFlight.get(nack.id)
        if (record) {
          inFlight.delete(nack.id)
          enqueue(record)
        }
        return
      }
      const frame = parseFrame(event.data)
      if (!frame) return
      if (frame.type === 'relay:authenticated') {
        if (timer !== null) window.clearTimeout(timer)
        if (frame.online !== true) {
          options.onEvent({ kind: 'offline' })
          finish('offline')
          socket?.close()
          if (!closing) scheduleReconnect()
          return
        }
        open = true
        reconnectAttempt = 0
        options.onEvent({ kind: 'connected', url })
        finish('open')
        void flushQueue()
        return
      }
      if (frame.type === 'relay:data' && frame.payload) {
        const dataFrame = parseRelayDataFrame(event.data)
        const wireId = dataFrame && !Number.isNaN(dataFrame.id) ? dataFrame.id : undefined
        if (wireId !== undefined) {
          if (seenInboundIds.has(wireId)) {
            // Duplicate delivery of a successfully-decrypted frame: the receiver
            // already accepted it, so acknowledge without re-decrypting.
            sendAck(wireId)
            return
          }
          if (inboundProcessing.has(wireId)) {
            // A concurrent duplicate of a frame being decrypted: ack without
            // re-decrypting so exactly one dispatch happens.
            sendAck(wireId)
            return
          }
          inboundProcessing.add(wireId)
        }
        void decryptPayload(options.controlSecret, frame.payload)
          .then((data) => {
            // Mark seen and acknowledge only after decryption succeeds; remove
            // the pending marker so a failed-decrypt frame can be replayed.
            if (wireId !== undefined) {
              seenInboundIds.add(wireId)
              sendAck(wireId)
              inboundProcessing.delete(wireId)
            }
            options.onEvent({ kind: 'message', data })
          })
          .catch(() => {
            if (wireId !== undefined) inboundProcessing.delete(wireId)
            remoteLog.error('Cloud relay payload authentication failed')
            socket?.close()
          })
      }
    }
    socket.onclose = (event) => {
      if (timer !== null) window.clearTimeout(timer)
      const wasOpen = open
      open = false
      if (closing) return
      const reason = event.reason || `relay-closed-${event.code}`
      if (wasOpen || settled) {
        requeueInFlight()
        options.onEvent({ kind: 'disconnected', reason })
        scheduleReconnect()
        return
      }
      if (!settled) finish('failed')
      options.onEvent({ kind: 'disconnected', reason })
      scheduleReconnect()
    }
    socket.onerror = () => {
      remoteLog.error('Cloud relay WebSocket failed')
    }

    return new Promise((resolve) => {
      settle = resolve
    })
  }

  return {
    connect(): Promise<'open' | 'offline' | 'failed'> {
      closing = false
      return establishConnection()
    },

    async send(data: string): Promise<void> {
      const record: OutboundRecord = { id: nextMessageId(), data, encrypted: null }
      if (!open || !socket || socket.readyState !== WebSocket.OPEN) {
        enqueue(record)
        return
      }
      await transmit(record)
    },

    close(): void {
      closing = true
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
      reconnectTimer = null
      open = false
      socket?.close()
      socket = null
    }
  }
}
