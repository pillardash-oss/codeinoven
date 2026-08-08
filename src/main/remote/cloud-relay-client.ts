import { Logger } from '../logger'
import { decryptPayload, encryptPayload } from '../../renderer/lib/remote/session-security'

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

/**
 * Full-jitter backoff delay for the given reconnect attempt. Returns a value
 * in `[0, min(maxMs, baseMs * 2^attempt))` using the injected random source so
 * tests can drive it deterministically.
 */
export function fullJitterDelay(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random
): number {
  const safeAttempt = Math.max(0, Math.floor(attempt))
  const cap = Math.min(maxMs, baseMs * 2 ** safeAttempt)
  if (cap <= 0) return 0
  const sample = Math.min(1, Math.max(0, random()))
  return Math.floor(sample * cap)
}

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

/** A fixed-capacity FIFO map that evicts the oldest entry when full. */
class BoundedMap<V> {
  private readonly entries = new Map<number, V>()

  constructor(private readonly limit: number) {}

  get size(): number {
    return this.entries.size
  }

  has(key: number): boolean {
    return this.entries.has(key)
  }

  get(key: number): V | undefined {
    return this.entries.get(key)
  }

  set(key: number, value: V): void {
    if (this.limit <= 0) return
    if (this.entries.has(key)) this.entries.delete(key)
    this.entries.set(key, value)
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  delete(key: number): boolean {
    return this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
  }

  values(): V[] {
    return [...this.entries.values()]
  }
}

export class CloudRelayClient {
  private socket: WebSocket | null = null
  private authenticated = false
  private closed = false
  private nextMessageId = 1
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private authTimer: ReturnType<typeof setTimeout> | null = null
  private readonly queue: OutboundRecord[] = []
  private readonly inFlight = new BoundedMap<OutboundRecord>(DEFAULT_QUEUE_LIMIT)
  private readonly replay = new BoundedMap<RpcOutcome>(DEFAULT_REPLAY_LIMIT)
  private readonly processing = new Set<number>()
  private readonly onAbort: () => void
  private readonly connectTimeoutMs: number
  private readonly authTimeoutMs: number
  private readonly requestTimeoutMs: number
  private readonly queueLimit: number
  private readonly socketFactory: (url: string) => WebSocket

  constructor(private readonly options: CloudRelayClientOptions) {
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this.authTimeoutMs = options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.queueLimit = options.queueLimit ?? DEFAULT_QUEUE_LIMIT
    this.socketFactory =
      options.socketFactory ?? ((target: string): WebSocket => new WebSocket(target))
    this.onAbort = () => this.cancelConnection('cancelled')
    this.options.signal?.addEventListener('abort', this.onAbort, { once: true })
  }

  connect(): void {
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
        this.dropConnection('connect-timeout')
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
          this.dropConnection('auth-timeout')
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
      if (!this.closed) {
        this.requeueInFlight()
        this.authenticated = false
        this.options.onDisconnected(event.reason || `relay-closed-${event.code}`)
      }
    }
  }

  close(): void {
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
    if (this.closed) return
    this.closed = true
    this.authenticated = false
    this.clearTimers()
    this.options.signal?.removeEventListener('abort', this.onAbort)
    this.socket?.close()
    this.socket = null
    this.options.onDisconnected(reason)
  }

  /** Unexpected socket loss: clear deadlines and keep queued work retryable. */
  private dropConnection(reason: string): void {
    if (this.closed) return
    this.closed = true
    this.authenticated = false
    this.clearTimers()
    this.requeueInFlight()
    this.socket?.close()
    this.socket = null
    this.options.onDisconnected(reason)
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
    if (this.closed) return
    const record: OutboundRecord = { id: this.nextMessageId, payload }
    this.nextMessageId += 1
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
      this.socket.send(JSON.stringify({ type: 'relay:data', id: record.id, payload: encrypted }))
    }
  }

  private handleMessage(text: string): void {
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
      this.options.onAuthenticated()
      void this.flushQueue()
      return
    }
    if (record['type'] === 'relay:ack' && typeof record['id'] === 'number') {
      this.inFlight.delete(record['id'])
      return
    }
    if (record['type'] === 'relay:data' && typeof record['payload'] === 'string') {
      void decryptPayload(this.options.controlSecret, record['payload'])
        .then((plaintext) => this.handleEncryptedMessage(plaintext))
        .catch(() => {
          Logger.error('Remote cloud relay payload authentication failed')
          this.dropConnection('decrypt-failed')
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

  private handleEncryptedMessage(plaintext: string): void {
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
    // Duplicate suppression: an invoke already being processed is ignored.
    if (this.processing.has(id)) return
    // Idempotent result replay: an already answered invoke is replayed verbatim.
    const replayed = this.replay.get(id)
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
    this.processing.add(id)
    void withTimeout(
      this.options
        .onRpc(channel, args)
        .catch((): RpcOutcome => ({ ok: false, message: 'Remote invocation failed' })),
      this.requestTimeoutMs,
      { ok: false, message: 'Relay RPC request timed out' }
    )
      .then((settled) => {
        this.replay.set(id, settled)
        return this.send(
          settled.ok
            ? { rpc: 'result', id, result: settled.result }
            : { rpc: 'error', id, message: settled.message ?? 'Remote invocation failed' }
        )
      })
      .finally(() => {
        this.processing.delete(id)
      })
  }
}
