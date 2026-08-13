/**
 * Shared cloud-relay wire protocol used by the desktop (main) and mobile
 * (renderer) relay clients and by the relay server. This module is the single
 * source of truth for the frame shapes, message-ID allocation, acknowledgement
 * semantics, full-jitter backoff, and bounded structures so that both sides
 * interoperate and the protocol can be exercised deterministically in
 * end-to-end tests against a protocol-conforming relay server.
 */

/** Version carried by the `relay:hello` handshake frame. */
export const RELAY_HELLO_VERSION = 1

/** Outbound application frame routed by the relay to the peer. */
export interface RelayDataFrame {
  type: 'relay:data'
  /** Full wire id: `<uuid sender instance>:<bounded seq>`, unique across
   *  client restarts. Used for acknowledgement, dedup, and replay. */
  id: string
  payload: string
}

/** Delivery acknowledgement the relay sends back for a `relay:data` id. */
export interface RelayAckFrame {
  type: 'relay:ack'
  id: string
}

/** Retryable rejection the relay sends when an accepted frame could not be
 *  retained (overflow, expiry, collision). The sender should re-queue/retry. */
export interface RelayNackFrame {
  type: 'relay:nack'
  id: string
  reason?: string
}

export type RelayEnvelopeFrame = RelayDataFrame | RelayAckFrame | RelayNackFrame

const SEQUENCE_BITS = 20
const MAX_SEQUENCE = 2 ** SEQUENCE_BITS

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const WIRE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[1-9]\d*$/i

/**
 * A random 128-bit sender-instance ID (UUIDv4). Fails closed: without a
 * cryptographic random source the client refuses to fabricate a weak instance
 * ID rather than risk wire-id collisions.
 */
export function randomInstanceId(): string {
  const cryptoApi = globalThis.crypto as { randomUUID?: () => string } | undefined
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID()
  throw new Error(
    'A cryptographic random source is required to generate a relay sender-instance ID'
  )
}

/** Validate a sender-instance UUID string. */
export function isValidSenderInstance(instanceId: string): boolean {
  return UUID_PATTERN.test(instanceId)
}

/** Validate a full wire id (`uuid:seq`) used on data/ack/nack frames. */
export function isValidWireId(id: string): boolean {
  return WIRE_ID_PATTERN.test(id)
}

/**
 * Message-id allocator whose ids are unique across client restarts: each id is
 * `<uuid sender instance>:<seq>`, with a fresh 128-bit UUID per client instance
 * plus a bounded monotonic sequence. A peer that reloads therefore never reuses
 * wire ids the recipient has already seen, so the recipient's
 * duplicate-suppression set cannot drop a reloaded peer's fresh frames. The
 * sender instance must be a valid UUID; tests inject fixed instance UUIDs for
 * determinism.
 */
export function createEpochMessageIdAllocator(
  instanceId: string = randomInstanceId()
): () => string {
  if (!isValidSenderInstance(instanceId)) {
    throw new TypeError('Relay message-id sender instance must be a UUID')
  }
  let seq = 0
  return () => {
    seq += 1
    if (seq >= MAX_SEQUENCE) {
      throw new Error('Relay message-id sequence space exhausted for this instance')
    }
    return `${instanceId}:${seq}`
  }
}

export function serializeRelayDataFrame(id: string, payload: string): string {
  return JSON.stringify({ type: 'relay:data', id, payload } satisfies RelayDataFrame)
}

export function serializeRelayAckFrame(id: string): string {
  return JSON.stringify({ type: 'relay:ack', id } satisfies RelayAckFrame)
}

export function serializeRelayNackFrame(id: string, reason?: string): string {
  return JSON.stringify({
    type: 'relay:nack',
    id,
    ...(reason ? { reason } : {})
  } satisfies RelayNackFrame)
}

export function parseRelayDataFrame(value: string): RelayDataFrame | null {
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    if (record.type !== 'relay:data' || typeof record.payload !== 'string') return null
    return {
      type: 'relay:data',
      id: typeof record.id === 'string' ? record.id : '',
      payload: record.payload
    }
  } catch {
    return null
  }
}

export function parseRelayAckFrame(value: string): RelayAckFrame | null {
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    if (record.type !== 'relay:ack' || typeof record.id !== 'string') return null
    return { type: 'relay:ack', id: record.id }
  } catch {
    return null
  }
}

export function parseRelayNackFrame(value: string): RelayNackFrame | null {
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    if (record.type !== 'relay:nack' || typeof record.id !== 'string') return null
    return {
      type: 'relay:nack',
      id: record.id,
      reason: typeof record.reason === 'string' ? record.reason : undefined
    }
  } catch {
    return null
  }
}

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

/** A fixed-capacity FIFO map (string-keyed) that evicts the oldest when full. */
export class BoundedMap<V> {
  private readonly entries = new Map<string, V>()

  constructor(private readonly limit: number) {}

  get size(): number {
    return this.entries.size
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  get(key: string): V | undefined {
    return this.entries.get(key)
  }

  set(key: string, value: V): void {
    if (this.limit <= 0) return
    if (this.entries.has(key)) this.entries.delete(key)
    this.entries.set(key, value)
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  delete(key: string): boolean {
    return this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
  }

  values(): V[] {
    return [...this.entries.values()]
  }
}

/** A fixed-capacity string set that evicts the oldest entry when full. */
export class BoundedSet {
  private readonly entries = new Set<string>()

  constructor(private readonly limit: number) {}

  get size(): number {
    return this.entries.size
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  add(key: string): void {
    if (this.limit <= 0) return
    if (this.entries.has(key)) return
    this.entries.add(key)
    while (this.entries.size > this.limit) {
      const oldest = this.entries.values().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  delete(key: string): boolean {
    return this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
  }
}
