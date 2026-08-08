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
  /** Monotonic message id used for acknowledgement, dedup, and replay. */
  id: number
  payload: string
}

/** Delivery acknowledgement the relay sends back for a `relay:data` id. */
export interface RelayAckFrame {
  type: 'relay:ack'
  id: number
}

export type RelayEnvelopeFrame = RelayDataFrame | RelayAckFrame

/** Monotonic message-id allocator so ids are never reused across frames. */
export function createMessageIdAllocator(initial = 1): () => number {
  let next = initial
  return () => {
    const id = next
    next += 1
    return id
  }
}

export function serializeRelayDataFrame(id: number, payload: string): string {
  return JSON.stringify({ type: 'relay:data', id, payload } satisfies RelayDataFrame)
}

export function serializeRelayAckFrame(id: number): string {
  return JSON.stringify({ type: 'relay:ack', id } satisfies RelayAckFrame)
}

export function parseRelayDataFrame(value: string): RelayDataFrame | null {
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    if (record.type !== 'relay:data' || typeof record.payload !== 'string') return null
    return {
      type: 'relay:data',
      id: typeof record.id === 'number' ? record.id : NaN,
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
    if (record.type !== 'relay:ack' || typeof record.id !== 'number') return null
    return { type: 'relay:ack', id: record.id }
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

/** A fixed-capacity FIFO map that evicts the oldest entry when full. */
export class BoundedMap<V> {
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

/** A fixed-capacity set that evicts the oldest entry when full. */
export class BoundedSet {
  private readonly entries = new Set<number>()

  constructor(private readonly limit: number) {}

  get size(): number {
    return this.entries.size
  }

  has(key: number): boolean {
    return this.entries.has(key)
  }

  add(key: number): void {
    if (this.limit <= 0) return
    if (this.entries.has(key)) return
    this.entries.add(key)
    while (this.entries.size > this.limit) {
      const oldest = this.entries.values().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  clear(): void {
    this.entries.clear()
  }
}
