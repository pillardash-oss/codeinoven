import { Logger } from '../logger'
import { randomBytes } from 'node:crypto'
import { decryptPayload, encryptPayload } from '../../renderer/lib/remote/session-security'
import { handshakeTranscript } from '../../renderer/lib/remote/device-identity'
import type { RemoteRpcDeviceContext } from '../../lib/remote-rpc'
import type { DeviceCredentialService, EnrolledDevice } from './device-credential-service'
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
    args: unknown[],
    device?: RemoteRpcDeviceContext
  ) => Promise<{ ok: boolean; result?: unknown; message?: string }>
  /**
   * Device credential service used to authenticate the phone over the relay.
   * Every RPC invoke is bound to the device that authenticated this relay
   * session; without it, invokes fail closed (no device-less cloud bypass).
   */
  credentials?: DeviceCredentialService
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
  id: string
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
  private readonly nextMessageId: () => string
  private readonly queue: OutboundRecord[] = []
  private readonly inFlight: BoundedMap<OutboundRecord>
  private readonly replay: BoundedMap<RpcOutcome>
  private readonly processing = new Set<string>()
  private readonly seenInboundIds: BoundedSet
  private readonly inboundProcessing: BoundedSet
  private readonly onAbort: () => void
  private readonly connectTimeoutMs: number
  private readonly authTimeoutMs: number
  private readonly requestTimeoutMs: number
  private readonly queueLimit: number
  private readonly replayLimit: number
  private readonly reconnect: CloudRelayClientOptions['reconnect']
  private readonly socketFactory: (url: string) => WebSocket
  private readonly credentials: DeviceCredentialService | null
  /** The authenticated phone device bound to this relay session. */
  private boundDevice: RemoteRpcDeviceContext | null = null
  /** The unspent desktop-issued relay device challenge (single-use). */
  private pendingDeviceChallenge = ''

  constructor(private readonly options: CloudRelayClientOptions) {
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this.authTimeoutMs = options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.queueLimit = options.queueLimit ?? DEFAULT_QUEUE_LIMIT
    this.replayLimit = options.replayLimit ?? DEFAULT_REPLAY_LIMIT
    this.reconnect = options.reconnect
    this.credentials = options.credentials ?? null
    this.inFlight = new BoundedMap<OutboundRecord>(this.queueLimit)
    this.replay = new BoundedMap<RpcOutcome>(this.replayLimit)
    this.seenInboundIds = new BoundedSet(this.replayLimit)
    this.inboundProcessing = new BoundedSet(this.replayLimit)
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
    this.boundDevice = null
    this.pendingDeviceChallenge = ''
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
    this.boundDevice = null
    this.pendingDeviceChallenge = ''
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
    this.boundDevice = null
    this.pendingDeviceChallenge = ''
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
    const nack = parseRelayNackFrame(text)
    if (nack) {
      // Explicit retryable rejection: requeue the frame for retransmission.
      const record = this.inFlight.get(nack.id)
      if (record) {
        this.inFlight.delete(nack.id)
        this.enqueue(record)
      }
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
      this.issueDeviceChallenge()
      void this.flushQueue()
      return
    }
    if (record['type'] === 'relay:data' && typeof record['payload'] === 'string') {
      const frame = parseRelayDataFrame(text)
      const wireId = frame && frame.id ? frame.id : undefined
      if (wireId !== undefined) {
        if (this.seenInboundIds.has(wireId)) {
          // Duplicate delivery of a successfully-decrypted frame: the receiver
          // already accepted it, so acknowledge without re-decrypting.
          this.sendAck(wireId)
          return
        }
        if (this.inboundProcessing.has(wireId)) {
          // A concurrent duplicate of a frame being decrypted/dispatched is
          // coalesced/ignored — the single in-flight decrypt will emit exactly
          // one ACK on success and none on failure so replay stays possible.
          return
        }
        this.inboundProcessing.add(wireId)
      }
      void decryptPayload(this.options.controlSecret, record['payload'])
        .then((plaintext) => {
          // Mark seen and acknowledge only after decryption succeeds; remove the
          // pending marker so a failed-decrypt frame can be replayed.
          if (wireId !== undefined) {
            this.seenInboundIds.add(wireId)
            this.sendAck(wireId)
            this.inboundProcessing.delete(wireId)
          }
          this.handleEncryptedMessage(plaintext, wireId)
        })
        .catch(() => {
          if (wireId !== undefined) this.inboundProcessing.delete(wireId)
          Logger.error('Remote cloud relay payload authentication failed')
          this.dropAndRetry('decrypt-failed')
        })
    }
  }

  /** Send a receiver-generated `relay:ack` control frame on the open socket. */
  private sendAck(id: string): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return
    this.socket.send(serializeRelayAckFrame(id))
  }

  private async flushQueue(): Promise<void> {
    while (this.queue.length > 0) {
      const record = this.queue.shift()
      if (!record) break
      await this.transmit(record)
    }
  }

  private handleEncryptedMessage(plaintext: string, wireId?: string): void {
    let record: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(plaintext)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
      record = parsed as Record<string, unknown>
    } catch {
      return
    }
    if (record['type'] === 'remote:device:auth') {
      void this.handleDeviceAuth(record, wireId)
      return
    }
    if (record['rpc'] !== 'invoke' || typeof record['id'] !== 'number') return
    const id = record['id']
    // Deduplicate and replay by the sender's wire id (epoch-scoped), so a
    // reloaded peer's fresh invokes are never mistaken for a retry.
    const dedupKey = typeof wireId === 'string' && wireId.length > 0 ? wireId : `rpc:${id}`
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
        .onRpc(channel, args, this.boundDevice ?? undefined)
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

  /**
   * Issue a fresh, single-use per-connection device challenge. The phone must
   * sign this nonce; the desktop recomputes the canonical relay transcript
   * server-side from the challenge plus the enrolled identity/authVersion (or
   * the enrollment bootstrap), so a captured proof from an earlier connection
   * cannot be replayed against a new challenge.
   */
  private issueDeviceChallenge(): void {
    if (!this.credentials) return
    this.pendingDeviceChallenge = randomBytes(32).toString('base64url')
    void this.send({ type: 'remote:device:challenge', nonce: this.pendingDeviceChallenge })
  }

  /**
   * Authenticate (or enroll) the phone device for this relay session using a
   * desktop-issued single-use challenge and proof-of-possession — the same
   * contract as the LAN handshake. The bound device context is then attached
   * to every RPC invoke on this session. Caller-supplied device ids in invoke
   * frames are never trusted; the context always comes from this verified
   * handshake, and the transcript is recomputed server-side (never taken from
   * the peer), so unsolicited, replayed, or mismatched proofs are rejected.
   */
  private async handleDeviceAuth(record: Record<string, unknown>, wireId?: string): Promise<void> {
    const signature = typeof record['signature'] === 'string' ? record['signature'] : ''
    const presentedNonce = typeof record['nonce'] === 'string' ? record['nonce'] : ''
    const bootstrap = typeof record['bootstrap'] === 'string' ? record['bootstrap'] : ''
    const deviceName = typeof record['deviceName'] === 'string' ? record['deviceName'].trim() : ''
    const deviceId = typeof record['deviceId'] === 'string' ? record['deviceId'].trim() : ''
    const authVersion =
      typeof record['authVersion'] === 'number' ? record['authVersion'] : undefined
    const signingJwk =
      typeof record['signingPublicJwk'] === 'object' && record['signingPublicJwk'] !== null
        ? (record['signingPublicJwk'] as JsonWebKey)
        : undefined
    const agreementJwk =
      typeof record['agreementPublicJwk'] === 'object' && record['agreementPublicJwk'] !== null
        ? (record['agreementPublicJwk'] as JsonWebKey)
        : undefined

    const fail = (reason: string): void => {
      this.credentials?.audit({
        decision: 'auth_failed',
        reasonCode:
          reason === 'bootstrap_used' || reason === 'signature_invalid' || reason === 'mismatch'
            ? reason
            : 'malformed',
        deviceId: deviceId || null,
        deviceName: deviceName || null,
        transport: 'relay'
      })
      void this.send({ type: 'remote:device:error', reason })
    }

    if (!signature || !this.credentials) {
      fail('malformed')
      return
    }
    // Unsolicited or replayed proof: the nonce must be the exact unspent
    // challenge issued for THIS connection. Re-challenge instead of binding so
    // a phone that reconnected after missing the challenge can retry, while a
    // stale captured proof (different nonce) can never bind.
    if (
      presentedNonce !== this.pendingDeviceChallenge ||
      this.pendingDeviceChallenge.length === 0
    ) {
      this.credentials.audit({
        decision: 'auth_failed',
        reasonCode: 'mismatch',
        deviceId: deviceId || null,
        deviceName: deviceName || null,
        transport: 'relay'
      })
      this.pendingDeviceChallenge = ''
      this.issueDeviceChallenge()
      return
    }
    // Consume the single-use challenge; any subsequent replay is a mismatch.
    this.pendingDeviceChallenge = ''

    let device: EnrolledDevice
    if (bootstrap && signingJwk && agreementJwk) {
      const transcript = handshakeTranscript({
        nonce: presentedNonce,
        bootstrap,
        context: 'relay'
      })
      const outcome = await this.credentials.enrollDevice({
        bootstrapValue: bootstrap,
        name: deviceName,
        signingPublicJwk: signingJwk,
        agreementPublicJwk: agreementJwk,
        signingProof: signature,
        proofTranscript: transcript,
        transport: 'relay'
      })
      if (!outcome.ok || !outcome.device) {
        fail(outcome.reason ?? 'malformed')
        return
      }
      device = outcome.device
    } else if (deviceId && typeof authVersion === 'number') {
      const transcript = handshakeTranscript({
        nonce: presentedNonce,
        deviceId,
        authVersion,
        context: 'relay'
      })
      const result = await this.credentials.authenticateDevice({
        deviceId,
        authVersion,
        transcript,
        signature,
        transport: 'relay'
      })
      if (!result.ok || !result.device) {
        fail(result.reason ?? 'auth_failed')
        return
      }
      device = result.device
    } else {
      fail('malformed')
      return
    }

    // Bind the authenticated device to this relay session.
    this.boundDevice = {
      deviceId: device.deviceId,
      name: device.name,
      fingerprint: device.publicKeyFingerprint,
      authVersion: device.authVersion,
      sessionId: wireId ?? '',
      requestId: '',
      scopes: device.scopes
    }
    void this.send({
      type: 'remote:device:ok',
      device: { id: device.deviceId, authVersion: device.authVersion }
    })
  }
}
