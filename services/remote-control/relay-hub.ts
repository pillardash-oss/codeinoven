/**
 * Production relay hub for the CodeInOven remote-control service.
 *
 * Owns the desktop↔mobile socket registries and the delivery semantics of the
 * account relay. Every `relay:data` frame carries a client-scoped epoch-based
 * `id` (unique across client restarts). Delivery is confirmed END TO END: the
 * hub retains every accepted frame (keyed by wire id) until the RECEIVER
 * acknowledges it, then forwards that receiver-generated ACK to the sender. The
 * hub never acknowledges server acceptance itself, so a frame is never reported
 * delivered unless the receiver actually got it.
 *
 * Loss safety: overflow rejects the incoming frame (retryable NACK, no silent
 * drop), TTL expiry sends a retryable NACK to the sender, and a server restart
 * cannot lose already-ACKed work because the sender only drops frames the
 * receiver confirmed. This module is framework-agnostic (no Bun/Electron
 * imports) so it is exercised directly by the app's end-to-end relay tests.
 */

export type RelayRole = 'desktop' | 'mobile'

export interface RelaySocket {
  send(data: string): void
  close(code: number, reason: string): void
}

export interface RelayHubOptions {
  /** Maximum outstanding (unacknowledged) frames per desktop. */
  bufferLimit?: number
  /** How long an accepted frame is retained before it expires. */
  bufferTtlMs?: number
  now?: () => number
}

export interface ForwardResult {
  /** True when the frame was accepted (delivered or buffered) awaiting ack. */
  accepted: boolean
  /** True when the frame went out on the wire immediately. */
  delivered: boolean
  /** Why a frame was rejected (`overflow`, `invalid-id`). */
  reason?: string
}

interface OutstandingFrame {
  id: string
  from: RelayRole
  to: RelayRole
  frame: string
  sender: RelaySocket
  delivered: boolean
  expiresAt: number
}

const DEFAULT_BUFFER_LIMIT = 256
const DEFAULT_BUFFER_TTL_MS = 60_000

/** Full wire-id shape: `<uuid sender instance>:<seq>`. */
const WIRE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[1-9]\d*$/i

function isValidWireId(id: string): boolean {
  return WIRE_ID_PATTERN.test(id)
}

/** Extract and validate the full wire id of a `relay:data` frame. */
function frameId(frame: string): string | null {
  try {
    const parsed = JSON.parse(frame) as { type?: string; id?: unknown }
    if (parsed.type !== 'relay:data') return null
    return typeof parsed.id === 'string' && isValidWireId(parsed.id) ? parsed.id : null
  } catch {
    return null
  }
}

export class RelayHub {
  private readonly desktopSockets = new Map<string, RelaySocket>()
  private readonly mobileSockets = new Map<string, RelaySocket>()
  private readonly outstanding = new Map<string, Map<string, OutstandingFrame>>()
  private readonly bufferLimit: number
  private readonly bufferTtlMs: number
  private readonly now: () => number

  constructor(options: RelayHubOptions = {}) {
    this.bufferLimit = options.bufferLimit ?? DEFAULT_BUFFER_LIMIT
    this.bufferTtlMs = options.bufferTtlMs ?? DEFAULT_BUFFER_TTL_MS
    this.now = options.now ?? Date.now
  }

  desktopOnline(desktopId: string): boolean {
    return this.desktopSockets.has(desktopId)
  }

  mobileOnline(desktopId: string): boolean {
    return this.mobileSockets.has(desktopId)
  }

  /** The currently live mobile socket for a desktop, if any. */
  mobileSocket(desktopId: string): RelaySocket | undefined {
    return this.mobileSockets.get(desktopId)
  }

  /** Register a live desktop socket and deliver any buffered frames to it. */
  connectDesktop(desktopId: string, socket: RelaySocket): string[] {
    const previous = this.desktopSockets.get(desktopId)
    if (previous && previous !== socket) previous.close(4000, 'replaced')
    this.desktopSockets.set(desktopId, socket)
    return this.replay(desktopId, 'desktop')
  }

  /** Register a live mobile socket and deliver any buffered frames to it. */
  connectMobile(desktopId: string, socket: RelaySocket): string[] {
    const previous = this.mobileSockets.get(desktopId)
    if (previous && previous !== socket) previous.close(4000, 'replaced')
    this.mobileSockets.set(desktopId, socket)
    return this.replay(desktopId, 'mobile')
  }

  /** Remove a socket from the registry when its connection closes. */
  disconnect(desktopId: string, role: RelayRole, socket: RelaySocket): void {
    const registry = role === 'desktop' ? this.desktopSockets : this.mobileSockets
    if (registry.get(desktopId) === socket) registry.delete(desktopId)
  }

  /** Close and remove every socket for a desktop (revocation / replacement). */
  closePeer(desktopId: string, code: number, reason: string): void {
    this.desktopSockets.get(desktopId)?.close(code, reason)
    this.mobileSockets.get(desktopId)?.close(code, reason)
    this.desktopSockets.delete(desktopId)
    this.mobileSockets.delete(desktopId)
  }

  /**
   * Route a `relay:data` frame from one peer to the other and retain it until
   * the receiver confirms delivery. No ACK is issued here — the receiver's
   * `relay:ack` is forwarded to the sender by `acknowledge`.
   */
  forward(desktopId: string, from: RelayRole, sender: RelaySocket, frame: string): ForwardResult {
    const id = frameId(frame)
    if (id === null) return { accepted: false, delivered: false, reason: 'invalid-id' }
    const to: RelayRole = from === 'desktop' ? 'mobile' : 'desktop'
    const target =
      to === 'desktop' ? this.desktopSockets.get(desktopId) : this.mobileSockets.get(desktopId)
    const frames = this.outstanding.get(desktopId)
    if (frames?.has(id)) {
      const existing = frames.get(id)
      if (existing) {
        // A retransmission is accepted ONLY when it is the same direction AND
        // the exact retained frame identity (byte-identical). Any other id
        // collision is rejected without delivery or sender replacement so a
        // different message can never alias an outstanding frame. On an
        // accepted retransmission the retained sender is REBOUND to the current
        // authenticated sender socket, so a receiver ACK/NACK reaches the live
        // client (e.g. after a sender reconnect) instead of the stale socket.
        if (existing.from === from && existing.frame === frame) {
          if (target) target.send(frame)
          existing.delivered = Boolean(target)
          existing.expiresAt = this.now() + this.bufferTtlMs
          existing.sender = sender
          return { accepted: true, delivered: Boolean(target) }
        }
        return { accepted: false, delivered: false, reason: 'id-collision' }
      }
    }
    if ((frames?.size ?? 0) >= this.bufferLimit) {
      return { accepted: false, delivered: false, reason: 'overflow' }
    }
    const delivered = Boolean(target)
    if (target) target.send(frame)
    const entry: OutstandingFrame = {
      id,
      from,
      to,
      frame,
      sender,
      delivered,
      expiresAt: this.now() + this.bufferTtlMs
    }
    const desktopFrames = frames ?? new Map<string, OutstandingFrame>()
    desktopFrames.set(id, entry)
    this.outstanding.set(desktopId, desktopFrames)
    return { accepted: true, delivered }
  }

  /**
   * The receiver confirmed delivery of `id`: forward the receiver-generated
   * `relay:ack` to the original sender and release the retained frame. The ACK
   * is authenticated against the retained intended receiver role and that
   * role's CURRENT live socket, so a sender can never self-ACK its own frame.
   */
  acknowledge(desktopId: string, id: string, ackRole: RelayRole, ackSocket: RelaySocket): boolean {
    const frames = this.outstanding.get(desktopId)
    const entry = frames?.get(id)
    if (!entry) return false
    if (entry.to !== ackRole) return false
    const live =
      ackRole === 'desktop' ? this.desktopSockets.get(desktopId) : this.mobileSockets.get(desktopId)
    if (live !== ackSocket) return false
    frames?.delete(id)
    if (frames?.size === 0) this.outstanding.delete(desktopId)
    entry.sender.send(JSON.stringify({ type: 'relay:ack', id }))
    return true
  }

  /**
   * Expire accepted frames whose retention TTL passed. Each expired frame is
   * surfaced as a retryable NACK to its sender so no accepted-but-unconfirmed
   * work is ever lost silently. Returns the number expired.
   */
  sweep(): number {
    const now = this.now()
    let removed = 0
    for (const [desktopId, frames] of this.outstanding) {
      for (const [id, entry] of frames) {
        if (entry.expiresAt <= now) {
          entry.sender.send(JSON.stringify({ type: 'relay:nack', id, reason: 'expired' }))
          frames.delete(id)
          removed += 1
        }
      }
      if (frames.size === 0) this.outstanding.delete(desktopId)
    }
    return removed
  }

  /** Number of frames currently retained awaiting receiver confirmation. */
  outstandingCount(): number {
    let count = 0
    for (const frames of this.outstanding.values()) count += frames.size
    return count
  }

  /** Number of frames buffered (accepted but not yet delivered). */
  bufferedCount(): number {
    let count = 0
    for (const frames of this.outstanding.values()) {
      for (const entry of frames.values()) if (!entry.delivered) count += 1
    }
    return count
  }

  private replay(desktopId: string, role: RelayRole): string[] {
    const frames = this.outstanding.get(desktopId)
    if (!frames) return []
    const now = this.now()
    const replayed: string[] = []
    const target =
      role === 'desktop' ? this.desktopSockets.get(desktopId) : this.mobileSockets.get(desktopId)
    for (const entry of frames.values()) {
      if (!entry.delivered && entry.to === role && target) {
        target.send(entry.frame)
        entry.delivered = true
        entry.expiresAt = now + this.bufferTtlMs
        replayed.push(entry.frame)
      }
    }
    return replayed
  }
}
