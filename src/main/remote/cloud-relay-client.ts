import { Logger } from '../logger'
import { decryptPayload, encryptPayload } from '../../renderer/lib/remote/session-security'
import {
  BoundedMap,
  BoundedSet,
  createEpochMessageIdAllocator,
  fullJitterDelay,
  parseRelayAckFrame,
  parseRelayDataFrame,
  serializeRelayDataFrame
} from '../../renderer/lib/remote/relay-protocol'

export { fullJitterDelay } from '../../renderer/lib/remote/relay-protocol'

export interface CloudRelayClientOptions {
  apiOrigin: string
  deviceToken: string
  controlSecret: string
  onAuthenticated: () => void
  onDisconnected: (reason: string) => void
  onRpc: (
    channel: string,
    args: unknown[]
  ) => Promise<{ ok: boolean; result?: unknown; message?: string }>
  /** Abort the connection when the signal fires (shutdown / config change). */
  signal?: AbortSignal
  /** Deadlines in milliseconds. */
  connectTimeoutMs?: number
  authTimeoutMs?: number
  requestTimeoutMs?: number
  /** Bounded outbound queue/in-flight size; oldest messages are dropped when full. */
  queueLimit?: number
  /** Bounded idempotent-result replay cache for RPC invokes. */
  replayLimit?: number
  /** Opt-in self-reconnect with full-jitter backoff preserving the queue. */
  reconnect?: {
    maxAttempts?: number
    initialDelayMs?: number
    maxDelayMs?: number
    random?: () => number
  }
  /** Injectable WebSocket factory so connect/auth deadlines are unit-testable. */
  socketFactory?: (url: string) => WebSocket
}

interface OutboundRecord {
  id: number
  payload: unknown
}

export interface RpcOutcome {
  ok: boolean
  result?: unknown
  message?: string
}

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000
const DEFAULT_AUTH_TIMEOUT_MS = 10_000
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_QUEUE_LIMIT = 1_000
const DEFAULT_REPLAY_LIMIT = 4_096
const DEFAULT_RECONNECT_INITIAL_DELAY_MS = 1_000
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000

/** Resolve `promise` with `fallback` when it does not settle within `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return promise
  return new Promise<T>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => resolve(fallback), ms)
    void promise.then((value) => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
        resolve(value)
      }
    })
  })
}

export class CloudRelayClient {
  private socket: WebSocket | null = null
  private authenticated = false
  private closed = false
  private closing = false
  private reconnecting = false
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private authTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private readonly nextMessageId: () => number
  private readonly queue: OutboundRecord[] = []
  private readonly inFlight: BoundedMap<OutboundRecord>
  private readonly replay: BoundedMap<RpcOutcome>
  private readonly processing = new Set<number>()
  private readonly seenInboundIds: BoundedSet
  private readonly onAbort: () => void
  private readonly connectTimeoutMs: number
  private readonly authTimeoutMs: number
  private readonly requestTimeoutMs: number
  private readonly queueLimit: number
  private readonly replayLimit: number
  private readonly reconnect: CloudRelayClientOptions['reconnect']
  private readonly socketFactory: (url: string) => WebSocket

  constructor(private readonly options: CloudRelayClientOptions) {
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this.authTimeoutMs = options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.queueLimit = options.queueLimit ?? DEFAULT_QUEUE_LIMIT
    this.replayLimit = options.replayLimit ?? DEFAULT_REPLAY_LIMIT
    this.reconnect = options.reconnect
    this.inFlight = new BoundedMap<OutboundRecord>(this.queueLimit)
    this.replay = new BoundedMap<RpcOutcome>(this.replayLimit)
    this.seenInboundIds = new BoundedSet(this.replayLimit)
    this.nextMessageId = createEpochMessageIdAllocator()
    this.socketFactory =
      options.socketFactory ?? ((target: string): WebSocket => new WebSocket(target))
    this.onAbort = () => this.cancelConnection('cancelled')
    this.options.signal?.addEventListener('abort', this.onAbort, { once: true })
  }

  connect(): void {
    this.closing = false
    this.openSocket()
  }

  close(): void {
    this.closing = true
    this.closed = true
    this.authenticated = false
    this.clearTimers()
    this.options.signal?.removeEventListener('abort', this.onAbort)
    this.queue.length = 0
    this.inFlight.clear()
    this.socket?.close()
    this.socket = null
  }

  /** Handle an externally fired abort signal without discarding the queue. */
  private cancelConnection(reason: string): void {
    if (this.closing || this.closed) return
    this.closed = true
    this.authenticated = false
    this.clearTimers()
    this.options.signal?.removeEventListener('abort', this.onAbort)
    this.socket?.close()
    this.socket = null
    this.options.onDisconnected(reason)
  }

  private openSocket(): void {
    this.closed = false
    this.authenticated = false
    const target = new URL('/v1/relay', this.options.apiOrigin)
    target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:'
    target.searchParams.set('role', 'desktop')
    const socket = this.socketFactory(target.toString())
    this.socket = socket

    this.connectTimer = setTimeout(() => {
      if (!this.closed && (!socket || socket.readyState !== WebSocket.OPEN)) {
        Logger.error('Remote cloud relay connect deadline exceeded')
        this.dropAndRetry('connect-timeout')
      }
    }, this.connectTimeoutMs)

    socket.onopen = () => {
      if (this.connectTimer !== null) {
        clearTimeout(this.connectTimer)
        this.connectTimer = null
      }
      socket.send(JSON.stringify({ type: 'relay:authenticate', token: this.options.deviceToken }))
      this.authTimer = setTimeout(() => {
        if (!this.closed && !this.authenticated) {
          Logger.error('Remote cloud relay authentication deadline exceeded')
          this.dropAndRetry('auth-timeout')
        }
      }, this.authTimeoutMs)
    }
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return
      this.handleMessage(event.data)
    }
    socket.onerror = () => {
      Logger.error('Remote cloud relay WebSocket failed')
    }
    socket.onclose = (event) => {
      if (this.authTimer !== null) {
        clearTimeout(this.authTimer)
        this.authTimer = null
      }
      if (this.closing || this.closed) return
      this.authenticated = false
      this.dropAndRetry(event.reason || `relay-closed-${event.code}`)
    }
  }

  /** Terminal socket loss: requeue unacked work and schedule a reconnect. */
  private dropAndRetry(reason: string): void {
    if (this.closing || this.closed) return
    this.closed = true
    this.clearTimers()
    this.authenticated = false
    this.requeueInFlight()
    this.socket?.close()
    this.socket = null
    this.options.onDisconnected(reason)
    this.scheduleReconnect(reason)
  }

  private scheduleReconnect(reason: string): void {
    if (this.closing || this.reconnectTimer !== null) return
    if (!this.reconnect) return
    const maxAttempts = this.reconnect.maxAttempts
    if (maxAttempts !== undefined && this.reconnectAttempt >= maxAttempts) {
      this.reconnectAttempt = 0
      this.options.onDisconnected(`${reason} (reconnect exhausted)`)
      return
    }
    const delay = fullJitterDelay(
      this.reconnectAttempt,
      this.reconnect.initialDelayMs ?? DEFAULT_RECONNECT_INITIAL_DELAY_MS,
      this.reconnect.maxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS,
      this.reconnect.random
    )
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.reconnecting = true
      this.openSocket()
    }, delay)
  }

  private clearTimers(): void {
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer)
      this.connectTimer = null
    }
    if (this.authTimer !== null) {
      clearTimeout(this.authTimer)
      this.authTimer = null
    }
  }

  /** Return messages that were sent but never acknowledged to the queue. */
  private requeueInFlight(): void {
    for (const record of this.inFlight.values()) {
      this.enqueue(record)
    }
    this.inFlight.clear()
  }

  private enqueue(record: OutboundRecord): void {
    if (this.queueLimit <= 0) return
    if (this.queue.length >= this.queueLimit) this.queue.shift()
    this.queue.push(record)
  }

  async send(payload: unknown): Promise<void> {
    if (this.closed || this.closing) return
    const record: OutboundRecord = { id: this.nextMessageId(), payload }
    if (this.authenticated && this.socket && this.socket.readyState === WebSocket.OPEN) {
      await this.transmit(record)
      return
    }
    this.enqueue(record)
  }

  private async transmit(record: OutboundRecord): Promise<void> {
    if (!this.socket) return
    const encrypted = await encryptPayload(
      this.options.controlSecret,
      JSON.stringify(record.payload)
    )
    if (this.socket.readyState === WebSocket.OPEN) {
      this.inFlight.set(record.id, record)
      this.socket.send(serializeRelayDataFrame(record.id, encrypted))
    }
  }

  private handleMessage(text: string): void {
    const ack = parseRelayAckFrame(text)
    if (ack) {
      this.inFlight.delete(ack.id)
      return
    }
    let record: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
      record = parsed as Record<string, unknown>
    } catch {
      return
    }
    if (record['type'] === 'relay:authenticated') {
      if (this.authTimer !== null) {
        clearTimeout(this.authTimer)
        this.authTimer = null
      }
      this.authenticated = true
      this.reconnecting = false
      this.reconnectAttempt = 0
      this.options.onAuthenticated()
      void this.flushQueue()
      return
    }
    if (record['type'] === 'relay:data' && typeof record['payload'] === 'string') {
      const frame = parseRelayDataFrame(text)
      // Duplicate suppression: an already delivered inbound frame id is ignored.
      if (frame && !Number.isNaN(frame.id)) {
        if (this.seenInboundIds.has(frame.id)) return
        this.seenInboundIds.add(frame.id)
      }
      void decryptPayload(this.options.controlSecret, record['payload'])
        .then((plaintext) => this.handleEncryptedMessage(plaintext, frame?.id))
        .catch(() => {
          Logger.error('Remote cloud relay payload authentication failed')
          this.dropAndRetry('decrypt-failed')
        })
    }
  }

  private async flushQueue(): Promise<void> {
    while (this.queue.length > 0) {
      const record = this.queue.shift()
      if (!record) break
      await this.transmit(record)
    }
  }

  private handleEncryptedMessage(plaintext: string, wireId?: number): void {
    let record: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(plaintext)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
      record = parsed as Record<string, unknown>
    } catch {
      return
    }
    if (record['rpc'] !== 'invoke' || typeof record['id'] !== 'number') return
    const id = record['id']
    // Deduplicate and replay by the sender's wire id (epoch-scoped), so a
    // reloaded peer's fresh invokes are never mistaken for a retry.
    const dedupKey = typeof wireId === 'number' && !Number.isNaN(wireId) ? wireId : id
    // Duplicate suppression: an invoke already being processed is ignored.
    if (this.processing.has(dedupKey)) return
    // Idempotent result replay: an already answered invoke is replayed verbatim.
    const replayed = this.replay.get(dedupKey)
    if (replayed) {
      void this.send(
        replayed.ok
          ? { rpc: 'result', id, result: replayed.result }
          : { rpc: 'error', id, message: replayed.message ?? 'Remote invocation failed' }
      )
      return
    }
    const channel = typeof record['channel'] === 'string' ? record['channel'] : ''
    const args = Array.isArray(record['args']) ? record['args'] : []
    this.processing.add(dedupKey)
    void withTimeout(
      this.options
        .onRpc(channel, args)
        .catch((): RpcOutcome => ({ ok: false, message: 'Remote invocation failed' })),
      this.requestTimeoutMs,
      { ok: false, message: 'Relay RPC request timed out' }
    )
      .then((settled) => {
        this.replay.set(dedupKey, settled)
        return this.send(
          settled.ok
            ? { rpc: 'result', id, result: settled.result }
            : { rpc: 'error', id, message: settled.message ?? 'Remote invocation failed' }
        )
      })
      .finally(() => {
        this.processing.delete(dedupKey)
      })
  }
}
