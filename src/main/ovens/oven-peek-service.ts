import { assessPreflight } from './oven-setup-capabilities'
import { Logger } from '../system/logger'
import type { OvenService } from './oven-service'
import type { OvenHarnessService } from './oven-harness-service'
import type { StorageEngine } from '../storage/storage-engine'
import type {
  OvenHarnessInventoryItem,
  OvenPeek,
  OvenPreflightReport,
  OvenProbe
} from '../../lib/ovens'

/** A live answer is reused for a moment, so surfaces opening together share one read. */
const PEEK_TTL_MS = 60_000
/** An explicit refresh is throttled, so a burst of page opens runs one check, not many. */
const REFRESH_FLOOR_MS = 10_000
/** At most two Ovens are read at once; each read opens its own SSH sessions. */
const CONCURRENCY = 5
/** Persisted last-known checks, so the first open after launch draws from disk. */
const PEEK_STORE_PATH = 'ovens/peeks.json'
/** A peek this old is not a safe authorization for a mutating setup. */
const SETUP_REUSE_MS = 5 * 60_000

interface StoredPeeks {
  version: 1
  ovens: Record<string, OvenPeek>
}

const EMPTY_STORE: StoredPeeks = { version: 1, ovens: {} }

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * One cached read per remote Oven, shared by every surface.
 *
 * Opening the Ovens page used to ping each Oven and the setup dialog then
 * checked again, so a session of setup work paid for the same reads several
 * times. This service answers the device, the harnesses, and the packages from
 * a single check, deduplicates concurrent callers, keeps up to five Ovens in
 * flight, and persists the last known answer so a later open can draw from disk
 * before refreshing. It never blocks the Electron main thread: every read is an
 * asynchronous SSH round trip and nothing here touches SQLite.
 */
export class OvenPeekService {
  private readonly cache = new Map<string, OvenPeek>()
  private readonly inflight = new Map<string, Promise<OvenPeek>>()
  private readonly waiters: Array<() => void> = []
  private active = 0
  private stored: StoredPeeks | null = null
  private storedLoading: Promise<void> | null = null
  private writeTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly service: OvenService,
    private readonly harness: OvenHarnessService,
    private readonly storage: StorageEngine,
    /** Read-only observation of one Oven, shared with the setup contract. */
    private readonly preflight: (ovenId: string) => Promise<OvenPreflightReport>,
    /** Record a successful probe on the Oven entry, so a later `oven:state` agrees. */
    private readonly onProbe?: (ovenId: string, probe: OvenProbe) => void
  ) {}

  /**
   * Read one Oven.
   *
   * Without `refresh`, a cached copy is returned immediately (flagged `stale`
   * once it is older than the reuse window). With `refresh`, a recent copy is
   * still used if another check just finished, so a burst of opens runs one
   * check rather than one per open. Concurrent callers always share one run.
   */
  async peek(ovenId: string, refresh = false): Promise<OvenPeek> {
    const existing = this.inflight.get(ovenId)
    if (existing) return existing
    // Register the run before the first await, so a caller that arrives while
    // this one is still loading the stored copy shares it instead of starting
    // a second read of the same Oven.
    const task = this.resolve(ovenId, refresh)
    this.inflight.set(ovenId, task)
    return task.finally(() => {
      if (this.inflight.get(ovenId) === task) this.inflight.delete(ovenId)
    })
  }

  private async resolve(ovenId: string, refresh: boolean): Promise<OvenPeek> {
    await this.ensureStored()
    const cached = this.cache.get(ovenId)
    if (cached) {
      const age = Date.now() - cached.checkedAt
      if (!refresh || age < REFRESH_FLOOR_MS)
        return { ...cached, stale: !refresh && age > PEEK_TTL_MS }
    }
    return this.run(ovenId, refresh)
  }

  /** Read several Ovens, letting the shared five-at-a-time limit bound the work. */
  async peekAll(ovenIds: readonly string[], refresh = false): Promise<OvenPeek[]> {
    return Promise.all(ovenIds.map((ovenId) => this.peek(ovenId, refresh)))
  }

  /** The already-read answer for one Oven, or null before the first read. */
  cached(ovenId: string): OvenPeek | null {
    return this.cache.get(ovenId) ?? null
  }

  /**
   * The most recent completed report for one Oven, while it is young enough to
   * authorize a mutating setup. Synchronous: the setup engine asks this while it
   * builds a plan, and an absent or too-old answer simply means it re-reads.
   */
  recentPreflight(ovenId: string, maxAgeMs = SETUP_REUSE_MS): OvenPreflightReport | null {
    const peek = this.cache.get(ovenId)
    if (!peek?.preflight) return null
    if (Date.now() - peek.checkedAt > maxAgeMs) return null
    return peek.preflight.report
  }

  /** Drop one Oven's cached answer, e.g. after it was removed. */
  invalidate(ovenId: string): void {
    this.cache.delete(ovenId)
  }

  private async run(ovenId: string, refresh: boolean): Promise<OvenPeek> {
    await this.acquire()
    const started = Date.now()
    try {
      // The service probe and the shell preflight are independent reads, so they
      // run together; each fails on its own without discarding the other.
      const [probeOutcome, preflightOutcome] = await Promise.allSettled([
        this.service.probe(ovenId, refresh),
        this.preflight(ovenId)
      ])
      const probe = probeOutcome.status === 'fulfilled' ? probeOutcome.value : null
      const report = preflightOutcome.status === 'fulfilled' ? preflightOutcome.value : null
      let inventory: OvenHarnessInventoryItem[] = this.harness.cachedInventory(ovenId)
      if (probe) {
        try {
          inventory = await this.harness.inventoryFromProbe(ovenId, probe)
        } catch (error) {
          Logger.dev('Oven check could not resolve harness versions', {
            ovenId,
            error: messageOf(error)
          })
        }
      }
      const error =
        probeOutcome.status === 'rejected'
          ? messageOf(probeOutcome.reason)
          : preflightOutcome.status === 'rejected'
            ? `The package check did not complete: ${messageOf(preflightOutcome.reason)}`
            : undefined
      const peek: OvenPeek = {
        ovenId,
        checkedAt: Date.now(),
        durationMs: Date.now() - started,
        probe,
        inventory,
        preflight: report ? { report, assessment: assessPreflight(report) } : null,
        ...(error ? { error } : {}),
        stale: false
      }
      this.cache.set(ovenId, peek)
      if (probe) {
        this.onProbe?.(ovenId, probe)
        void this.persist(ovenId, peek)
      }
      Logger.dev('Oven check finished', {
        ovenId,
        durationMs: peek.durationMs,
        device: Boolean(probe),
        packages: Boolean(report)
      })
      return peek
    } finally {
      this.release()
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < CONCURRENCY) {
      this.active++
      return
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve))
  }

  private release(): void {
    const next = this.waiters.shift()
    // Handing the slot to a waiter keeps the active count unchanged.
    if (next) next()
    else this.active--
  }

  private async ensureStored(): Promise<void> {
    if (this.stored) return
    this.storedLoading ??= (async () => {
      const value = await this.storage.read<StoredPeeks>(PEEK_STORE_PATH).catch(() => null)
      const store = value && value.version === 1 && value.ovens ? value : EMPTY_STORE
      this.stored = store
      for (const [ovenId, peek] of Object.entries(store.ovens))
        if (!this.cache.has(ovenId)) this.cache.set(ovenId, { ...peek, stale: true })
      this.storedLoading = null
    })()
    await this.storedLoading
  }

  private persist(ovenId: string, peek: OvenPeek): Promise<void> {
    const store = (this.stored ??= { version: 1, ovens: {} })
    store.ovens[ovenId] = { ...peek, stale: true }
    this.writeTail = this.writeTail
      .then(() =>
        this.storage
          .write(PEEK_STORE_PATH, store)
          .catch((error: unknown) =>
            Logger.dev('Oven check could not be persisted', { ovenId, error: messageOf(error) })
          )
      )
      .catch(() => undefined)
    return this.writeTail
  }
}
