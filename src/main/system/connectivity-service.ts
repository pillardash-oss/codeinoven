import { resolve4 } from 'node:dns/promises'
import { Logger } from './logger'

/**
 * The device's connectivity, verified.
 *
 * A connection wait is only as good as the connectivity answer behind it, and
 * that answer is the difference between the two field failures this service
 * exists to remove: a resume storm fired against an outage that is still in
 * progress, and a thread parked forever because nothing ever noticed the link
 * had returned.
 *
 * `net.isOnline()` cannot be that answer on its own. Chromium reports it as a
 * hint   "true is inconclusive", and it stays true while an associated access
 * point has no uplink, which is exactly the Wi-Fi drop a user reports. So
 * connectivity is tracked here, in one place, with these rules:
 *
 * - Every announcement (the renderer's `online`/`offline` events, a wake from
 *   sleep, a request the app itself just watched fail) is a *signal*, never a
 *   verdict. A real round trip has to succeed before the device counts as
 *   online again.
 * - Signals are coalesced: a burst costs one probe, and listeners hear about
 *   transitions only, never repeats.
 * - While the device is offline, one bounded timer keeps re-probing with a
 *   backoff, so a reconnection the OS never announced is still found. That
 *   re-probe is the only background activity here, it is the only way to
 *   learn about a silent restoration, and it stops the moment the link is
 *   verified (an online device is probed on signals alone).
 *
 * Every timer is `unref`'d, so waiting for a network never keeps the app alive.
 */

/** The verified connectivity of the device. */
export type ConnectivityState = 'online' | 'offline' | 'unknown'

/**
 * The narrow surface connectivity consumers need. The chat engine holds this
 * rather than the service so nothing else can start, stop, or re-probe it.
 */
export interface ConnectivitySource {
  /** True only for a verified online state. */
  isOnline(): boolean
  /** True only for a verified offline state. */
  isOffline(): boolean
  /** Whether connectivity was verified absent inside the window. */
  wasOfflineWithin(windowMs: number): boolean
  /** A request the app just failed: the verified state is out of date. */
  invalidate(reason: string): void
  /** Fired on a transition into verified online. Returns an unsubscribe. */
  onRestored(listener: () => void): () => void
}

export interface ConnectivityServiceOptions {
  /** The verdict probe. Injected by tests; defaults to {@link probeDeviceConnectivity}. */
  probe?: (timeoutMs: number) => Promise<boolean>
  now?: () => number
}

/** One probe may take this long before the device counts as unreachable. */
const PROBE_TIMEOUT_MS = 4_000
/** Identical signals closer together than this are one announcement. */
const SIGNAL_DEDUPE_MS = 1_000
/**
 * Re-probe cadence while offline. Fast at first, because the common case is a
 * blip the user is already back from, and it backs off so a device that is
 * offline for an hour is not asked once a second.
 */
const OFFLINE_REPROBE_MS = [1_500, 3_000, 6_000, 12_000, 20_000, 30_000]
/** Independent resolvers, so one host's outage is not read as the device's. */
const PROBE_HOSTS = ['google.com', 'cloudflare.com']
/** One TLS request, taken only when DNS could not answer. */
const HTTPS_PROBE_URL = 'https://www.gstatic.com/generate_204'

export class ConnectivityService implements ConnectivitySource {
  private current: ConnectivityState = 'unknown'
  private started = false
  private probing = false
  private signalDuringProbe = false
  private lastSignalAt = Number.NEGATIVE_INFINITY
  private lastOfflineAt = Number.NEGATIVE_INFINITY
  private backoffIndex = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly listeners = new Set<() => void>()
  private readonly probe: (timeoutMs: number) => Promise<boolean>
  private readonly now: () => number

  constructor(options: ConnectivityServiceOptions = {}) {
    this.probe = options.probe ?? probeDeviceConnectivity
    this.now = options.now ?? Date.now
  }

  /** Verify the current connectivity once, then track it. */
  start(): void {
    if (this.started) return
    this.started = true
    this.requestVerification('startup')
  }

  /** Stop tracking and drop listeners; a probe in flight is ignored. */
  stop(): void {
    this.started = false
    this.probing = false
    this.signalDuringProbe = false
    this.clearTimer()
    this.listeners.clear()
  }

  isOnline(): boolean {
    return this.current === 'online'
  }

  isOffline(): boolean {
    return this.current === 'offline'
  }

  wasOfflineWithin(windowMs: number): boolean {
    return this.now() - this.lastOfflineAt <= windowMs
  }

  /**
   * A device-level announcement: the renderer's connection events, a wake from
   * sleep, and anything else the OS says changed. It schedules a verification
   * and never decides the state itself.
   */
  signal(reason: string): void {
    const at = this.now()
    if (at - this.lastSignalAt < SIGNAL_DEDUPE_MS) return
    this.lastSignalAt = at
    this.requestVerification(reason)
  }

  /**
   * The verified answer turned out to be wrong: a request that went out on it
   * failed at the transport. Consumers stop firing until a probe confirms the
   * link again, which also keeps the rest of a reconnect queue from stampeding
   * a network that is still flapping.
   */
  invalidate(reason: string): void {
    if (this.current === 'online') {
      this.current = 'unknown'
      Logger.info('Device connectivity marked unverified after a failed request', { reason })
    }
    this.requestVerification(reason)
  }

  onRestored(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Run one verification. A probe already in flight answers every request that
   * arrives while it runs, so a burst of signals costs exactly one round trip;
   * the newest signal still gets its own probe afterwards, because it may
   * already carry information the running probe could not see.
   */
  private requestVerification(reason: string): void {
    if (!this.started) return
    if (this.probing) {
      this.signalDuringProbe = true
      return
    }
    this.probing = true
    this.clearTimer()
    void this.runProbe(reason)
  }

  private async runProbe(reason: string): Promise<void> {
    let online = false
    try {
      online = await this.probe(PROBE_TIMEOUT_MS)
    } catch (error) {
      Logger.dev('Connectivity probe failed:', error)
    }
    this.probing = false
    this.applyVerdict(online, reason)
    if (this.signalDuringProbe && this.started) {
      this.signalDuringProbe = false
      this.requestVerification(`${reason} (signal queued during probe)`)
    }
  }

  private applyVerdict(online: boolean, reason: string): void {
    if (!this.started) return
    const previous = this.current
    if (online) {
      this.current = 'online'
      this.backoffIndex = 0
      this.clearTimer()
      if (previous === 'online') return
      Logger.info('Device connectivity verified online', { reason, previous })
      this.notifyRestored()
      return
    }
    this.current = 'offline'
    this.lastOfflineAt = this.now()
    if (previous === 'offline') {
      Logger.dev('Device still offline; re-probe scheduled', { reason })
    } else {
      Logger.info('Device connectivity verified offline', { reason, previous })
    }
    this.armReProbe()
  }

  private armReProbe(): void {
    this.clearTimer()
    if (!this.started) return
    const index = Math.min(this.backoffIndex, OFFLINE_REPROBE_MS.length - 1)
    const delay = OFFLINE_REPROBE_MS[index]
    if (delay === undefined) return
    this.backoffIndex = Math.min(index + 1, OFFLINE_REPROBE_MS.length - 1)
    const timer = setTimeout(() => {
      this.timer = null
      this.requestVerification('offline-recheck')
    }, delay)
    timer.unref?.()
    this.timer = timer
  }

  private clearTimer(): void {
    if (this.timer === null) return
    clearTimeout(this.timer)
    this.timer = null
  }

  private notifyRestored(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch (error) {
        Logger.error('Connectivity listener failed:', error)
      }
    }
  }
}

/**
 * The default verdict probe: an uncached DNS question, then one TLS request.
 *
 * Resolution is asked through the resolver rather than the platform's cache, so
 * an answer the device already holds can never pass for a live network. DNS is
 * the cheapest honest signal, and it answers the question that matters here  
 * whether any path to the outside exists at all. A device whose resolver is
 * unreachable while its link works is rare, and that case is covered by the
 * second, differently-shaped attempt: one HTTPS request through the platform
 * stack, whose TLS handshake also fails behind a captive portal that hijacks
 * plain HTTP.
 */
export async function probeDeviceConnectivity(timeoutMs: number): Promise<boolean> {
  for (const host of PROBE_HOSTS) {
    try {
      const addresses = await withTimeout(resolve4(host), timeoutMs)
      if (addresses.length > 0) return true
    } catch {
      // The next host, then the transport fallback.
    }
  }
  try {
    const response = await fetch(HTTPS_PROBE_URL, {
      method: 'HEAD',
      signal: AbortSignal.timeout(timeoutMs)
    })
    return response.ok
  } catch {
    return false
  }
}

/** Resolve `value`, or reject once `timeoutMs` has passed. */
function withTimeout<T>(value: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Connectivity probe timed out')), timeoutMs)
    timer.unref?.()
    value.then(
      (result) => {
        clearTimeout(timer)
        resolve(result)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    )
  })
}
