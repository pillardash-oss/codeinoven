/**
 * Reconnection with backoff and session-takeover conflict handling.
 *
 * `ReconnectController` schedules automatic reconnection attempts after a
 * route drops, with exponential backoff. `canTakeover` rejects a session
 * takeover while another peer is already live on the same desktop session and
 * allows a stale session to be resumed by its owning peer.
 */

export interface BackoffOptions {
  initialDelayMs: number
  maxDelayMs: number
  factor: number
  maxAttempts?: number
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  factor: 2
}

/** Delay before the given attempt, growing exponentially and capped. */
export function nextBackoffDelay(attempt: number, options: BackoffOptions): number {
  const safeAttempt = Math.max(1, Math.floor(attempt))
  const base = options.initialDelayMs * options.factor ** (safeAttempt - 1)
  return Math.min(Math.max(0, base), options.maxDelayMs)
}

export interface Scheduler {
  schedule(callback: () => void, delayMs: number): { cancel(): void }
}

export const defaultScheduler: Scheduler = {
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs) as unknown as number
    return { cancel: () => clearTimeout(timer) }
  }
}

export interface ReconnectOptions {
  backoff: BackoffOptions
  /** Fired for each reconnection attempt. */
  onAttempt: (attempt: number) => void
  /** Fired when the maximum attempt count is exhausted. */
  onGiveUp: () => void
  scheduler?: Scheduler
}

export class ReconnectController {
  private attempt = 0
  private active = false
  private timer: { cancel(): void } | null = null

  constructor(private readonly options: ReconnectOptions) {}

  /** Begin the reconnect loop; the first attempt fires immediately. */
  start(): void {
    this.active = true
    this.scheduleNext()
  }

  /** Stop the loop; no further attempts fire. */
  stop(): void {
    this.active = false
    this.timer?.cancel()
    this.timer = null
  }

  /** A connection succeeded — stop retrying and reset the backoff. */
  reset(): void {
    this.stop()
    this.attempt = 0
  }

  get isActive(): boolean {
    return this.active
  }

  get attemptCount(): number {
    return this.attempt
  }

  private scheduleNext(): void {
    if (!this.active) return
    const { backoff, onGiveUp } = this.options
    if (backoff.maxAttempts !== undefined && this.attempt >= backoff.maxAttempts) {
      this.active = false
      onGiveUp()
      return
    }
    this.attempt += 1
    this.options.onAttempt(this.attempt)
    const delay = nextBackoffDelay(this.attempt, backoff)
    const scheduler = this.options.scheduler ?? defaultScheduler
    this.timer = scheduler.schedule(() => this.scheduleNext(), delay)
  }
}

export interface SessionOccupancy {
  live: boolean
  peerId: string | null
}

export type TakeoverDecision = { allowed: true } | { allowed: false; reason: string }

/**
 * Decide whether a peer may take over (or resume) a desktop session.
 * Rejects takeover while another peer is live; allows the owning peer to
 * resume a stale session, and any peer when nothing is live.
 */
export function canTakeover(
  occupancy: SessionOccupancy,
  requestingPeerId: string
): TakeoverDecision {
  if (!occupancy.live) return { allowed: true }
  if (occupancy.peerId === requestingPeerId) return { allowed: true }
  return { allowed: false, reason: 'another-peer-live' }
}
