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
import { BrowserWebRtcChannel, type WebRtcSessionDescription } from './webrtc-data-channel'
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
  iceServers?: RTCIceServer[]
}

interface OutboundRecord {
  id: string
  data: string
  encrypted: string | null
}

const DEFAULT_QUEUE_LIMIT = 1_000
const DEFAULT_RECONNECT_INITIAL_DELAY_MS = 1_000
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000
const PAYLOAD_AUTH_FAILURE_CLOSE_CODE = 4002

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
    const iceServers = Array.isArray(record.iceServers)
      ? record.iceServers.filter((entry): entry is RTCIceServer => {
          if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false
          const candidate = entry as Record<string, unknown>
          return typeof candidate.urls === 'string' || Array.isArray(candidate.urls)
        })
      : undefined
    return {
      type: typeof record.type === 'string' ? record.type : '',
      payload: typeof record.payload === 'string' ? record.payload : undefined,
      online: typeof record.online === 'boolean' ? record.online : undefined,
      iceServers
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
  let payloadAuthenticationFailed = false
  let settled = false
  let settle: (result: 'open' | 'offline' | 'failed') => void = () => undefined
  let timer: number | null = null
  let iceServers: RTCIceServer[] = []
  let rtc: BrowserWebRtcChannel | null = null
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
    const frame = serializeRelayDataFrame(record.id, payload)
    if (!rtc?.send(frame)) socket.send(frame)
  }

  async function flushQueue(): Promise<void> {
    while (queue.length > 0) {
      if (!socket || !open) return
      const record = queue.shift()
      if (!record) break
      await transmit(record)
    }
  }

  /** Send a receiver-generated `relay:ack` control frame on the open socket. */
  function sendAck(id: string, route: 'relay' | 'webrtc'): void {
    const frame = serializeRelayAckFrame(id)
    if (route === 'webrtc' && rtc?.send(frame)) return
    if (!socket || !open || socket.readyState !== WebSocket.OPEN) return
    socket.send(frame)
  }

  function startWebRtc(): void {
    if (rtc || typeof RTCPeerConnection === 'undefined') return
    const channel = new BrowserWebRtcChannel({
      iceServers,
      onOffer: (description) => {
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'relay:signal', description }))
        }
      },
      onMessage: (data) => handleIncoming(data, 'webrtc'),
      onStateChange: (state) => {
        if (state === 'closed' || state === 'failed') {
          if (rtc === channel) rtc = null
          requeueInFlight()
          void flushQueue()
        }
      }
    })
    rtc = channel
    void channel.start().catch(() => {
      if (rtc === channel) rtc = null
      channel.close()
      remoteLog.dev('WebRTC route unavailable; continuing over cloud relay')
    })
  }

  function parseSignal(value: string): WebRtcSessionDescription | null {
    try {
      const parsed: unknown = JSON.parse(value)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
      const record = parsed as Record<string, unknown>
      const description = record.description
      if (
        record.type !== 'relay:signal' ||
        typeof description !== 'object' ||
        description === null ||
        Array.isArray(description)
      ) {
        return null
      }
      const candidate = description as Record<string, unknown>
      return candidate.type === 'answer' && typeof candidate.sdp === 'string'
        ? { type: 'answer', sdp: candidate.sdp }
        : null
    } catch {
      return null
    }
  }

  function handleIncoming(value: string, route: 'relay' | 'webrtc'): void {
    const signal = parseSignal(value)
    if (signal) {
      void rtc?.acceptAnswer(signal).catch(() => {
        rtc?.close()
        rtc = null
      })
      return
    }
    const ack = parseRelayAckFrame(value)
    if (ack) {
      inFlight.delete(ack.id)
      return
    }
    const nack = parseRelayNackFrame(value)
    if (nack) {
      const record = inFlight.get(nack.id)
      if (record) {
        inFlight.delete(nack.id)
        enqueue(record)
      }
      return
    }
    const frame = parseFrame(value)
    if (!frame) return
    if (frame.type === 'relay:authenticated') {
      iceServers = frame.iceServers ?? []
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
    if (frame.type !== 'relay:data' || !frame.payload) return
    const dataFrame = parseRelayDataFrame(value)
    const wireId = dataFrame && dataFrame.id ? dataFrame.id : undefined
    if (wireId !== undefined) {
      if (seenInboundIds.has(wireId)) {
        sendAck(wireId, route)
        return
      }
      if (inboundProcessing.has(wireId)) return
      inboundProcessing.add(wireId)
    }
    void decryptPayload(options.controlSecret, frame.payload)
      .then((data) => {
        if (wireId !== undefined) {
          seenInboundIds.add(wireId)
          sendAck(wireId, route)
          inboundProcessing.delete(wireId)
        }
        try {
          const message = JSON.parse(data) as Record<string, unknown>
          if (message.type === 'remote:device:ok') startWebRtc()
        } catch {
          // Non-object RPC payloads are still delivered to the existing bridge.
        }
        options.onEvent({ kind: 'message', data })
      })
      .catch((error: unknown) => {
        if (wireId !== undefined) inboundProcessing.delete(wireId)
        if (
          wireId !== undefined &&
          error instanceof Error &&
          error.message === 'replayed-encrypted-payload'
        ) {
          seenInboundIds.add(wireId)
          sendAck(wireId, route)
          return
        }
        if (closing || payloadAuthenticationFailed) return
        payloadAuthenticationFailed = true
        remoteLog.error('Cloud relay payload authentication failed; automatic reconnect paused')
        socket?.close(PAYLOAD_AUTH_FAILURE_CLOSE_CODE, 'payload-authentication-failed')
      })
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
    payloadAuthenticationFailed = false
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
      if (typeof event.data === 'string') handleIncoming(event.data, 'relay')
    }
    socket.onclose = (event) => {
      if (timer !== null) window.clearTimeout(timer)
      const wasOpen = open
      open = false
      rtc?.close()
      rtc = null
      if (closing) return
      const reason = event.reason || `relay-closed-${event.code}`
      const controlKeyRotated = event.reason === 'control-key-rotated'
      const terminalAuthenticationFailure =
        controlKeyRotated ||
        payloadAuthenticationFailed ||
        event.reason === 'payload-authentication-failed'
      if (terminalAuthenticationFailure) {
        // Retrying with the in-memory key would reproduce the same decrypt
        // failure forever. Stop this client so the account screen can fetch
        // the newly uploaded encrypted grant before the next connection.
        queue.length = 0
        inFlight.clear()
      }
      if (wasOpen || settled) {
        if (!terminalAuthenticationFailure) requeueInFlight()
        options.onEvent({ kind: 'disconnected', reason })
        if (!terminalAuthenticationFailure) scheduleReconnect()
        return
      }
      if (!settled) finish('failed')
      options.onEvent({ kind: 'disconnected', reason })
      if (!terminalAuthenticationFailure) scheduleReconnect()
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
      rtc?.close()
      rtc = null
      socket?.close()
      socket = null
    }
  }
}
