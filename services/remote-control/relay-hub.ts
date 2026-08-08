/**
 * Production relay hub for the CodeInOven remote-control service.
 *
 * Owns the desktop↔mobile socket registries and the delivery semantics of the
 * account relay: every `relay:data` frame carries a client-scoped monotonic
 * `id`; the hub routes it to the live peer or, when the peer is offline, stores
 * it in a bounded per-desktop buffer (with TTL). Reconnects replay buffered
 * frames. The caller decides acknowledgement from `forward()`'s result, so an
 * ACK is only ever sent for a frame that was actually accepted for delivery
 * (routed live or buffered), never for a dropped/overflowed frame.
 *
 * This module is framework-agnostic (no Bun/Electron imports) so it is
 * exercised directly by the app's end-to-end relay tests.
 */

export type RelayRole = 'desktop' | 'mobile'

export interface RelaySocket {
  send(data: string): void
  close(code: number, reason: string): void
}

export interface RelayHubOptions {
  /** Maximum buffered frames per desktop (deterministic FIFO overflow). */
  bufferLimit?: number
  /** How long a buffered frame is held before it expires. */
  bufferTtlMs?: number
  now?: () => number
}

export interface ForwardResult {
  /** True when the frame was delivered live or accepted into the buffer. */
  accepted: boolean
  /** True when the frame went out on the wire immediately. */
  delivered: boolean
}

interface BufferedFrame {
  to: RelayRole
  frame: string
  expiresAt: number
}

const DEFAULT_BUFFER_LIMIT = 256
const DEFAULT_BUFFER_TTL_MS = 60_000

export class RelayHub {
  private readonly desktopSockets = new Map<string, RelaySocket>()
  private readonly mobileSockets = new Map<string, RelaySocket>()
  private readonly buffers = new Map<string, BufferedFrame[]>()
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

  /** Register a live desktop socket and return buffered frames to replay. */
  connectDesktop(desktopId: string, socket: RelaySocket): string[] {
    const previous = this.desktopSockets.get(desktopId)
    if (previous && previous !== socket) previous.close(4000, 'replaced')
    this.desktopSockets.set(desktopId, socket)
    return this.replay(desktopId, 'desktop')
  }

  /** Register a live mobile socket and return buffered frames to replay. */
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
   * Route a `relay:data` frame from one peer to the other. When the target is
   * live the frame is delivered and acknowledged; when it is offline the frame
   * is accepted into the bounded per-desktop buffer (drop-oldest on overflow)
   * so it can be replayed on reconnect.
   */
  forward(desktopId: string, from: RelayRole, frame: string): ForwardResult {
    const target =
      from === 'desktop' ? this.mobileSockets.get(desktopId) : this.desktopSockets.get(desktopId)
    if (target) {
      target.send(frame)
      return { accepted: true, delivered: true }
    }
    const accepted = this.buffer(desktopId, from === 'desktop' ? 'mobile' : 'desktop', frame)
    return { accepted, delivered: false }
  }

  private buffer(desktopId: string, to: RelayRole, frame: string): boolean {
    if (this.bufferLimit <= 0) return false
    const frames = this.buffers.get(desktopId) ?? []
    frames.push({ to, frame, expiresAt: this.now() + this.bufferTtlMs })
    // Deterministic overflow: drop the oldest buffered frame for this desktop.
    while (frames.length > this.bufferLimit) frames.shift()
    this.buffers.set(desktopId, frames)
    return true
  }

  private replay(desktopId: string, role: RelayRole): string[] {
    const frames = this.buffers.get(desktopId)
    if (!frames) return []
    const now = this.now()
    const replayed: string[] = []
    const remaining: BufferedFrame[] = []
    for (const entry of frames) {
      if (entry.expiresAt <= now) continue
      if (entry.to === role) {
        replayed.push(entry.frame)
      } else {
        remaining.push(entry)
      }
    }
    if (remaining.length === 0) this.buffers.delete(desktopId)
    else this.buffers.set(desktopId, remaining)
    return replayed
  }

  /** Drop expired buffered frames; returns the number removed. */
  sweep(): number {
    const now = this.now()
    let removed = 0
    for (const [desktopId, frames] of this.buffers) {
      const alive = frames.filter((entry) => entry.expiresAt > now)
      removed += frames.length - alive.length
      if (alive.length === 0) this.buffers.delete(desktopId)
      else this.buffers.set(desktopId, alive)
    }
    return removed
  }

  /** Number of frames currently buffered across all desktops. */
  bufferedCount(): number {
    let count = 0
    for (const frames of this.buffers.values()) count += frames.length
    return count
  }
}
