import { assessPreflight } from './oven-setup-capabilities'
import { Logger } from '../system/logger'
import type { OvenService } from './oven-service'
import type { OvenHarnessService } from './oven-harness-service'
import type { StorageEngine } from '../storage/storage-engine'
import type {
  OvenHarnessInventoryItem,
  OvenPeek,
  OvenPreflightReport,
  OvenProbe,
  OvenSshProtection
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
/**
 * How long one Oven's check may run before it is reported as unfinished.
 *
 * The SSH layer bounds every command, but a check is a probe, a preflight read
 * and a harness resolution, and it holds one of the five slots while it runs. A
 * check that never finished used to hold its slot and leave every surface showing
 * "Checking…" with nothing behind it, while direct requests to the same Oven kept
 * working.
 */
const PEEK_DEADLINE_MS = 150_000

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
    private readonly onProbe?: (
      ovenId: string,
      probe: OvenProbe,
      protection: OvenSshProtection
    ) => void
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
    let deadline: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        this.inspect(ovenId, refresh, started),
        new Promise<OvenPeek>((resolve) => {
          deadline = setTimeout(() => resolve(this.unfinished(ovenId, started)), PEEK_DEADLINE_MS)
        })
      ])
    } finally {
      if (deadline) clearTimeout(deadline)
      this.release()
    }
  }

  /** The answer a check that ran past its deadline leaves behind. */
  private unfinished(ovenId: string, started: number): OvenPeek {
    const cached = this.cache.get(ovenId)
    Logger.dev('Oven check did not finish in time', { ovenId, durationMs: Date.now() - started })
    return {
      ovenId,
      checkedAt: Date.now(),
      durationMs: Date.now() - started,
      probe: null,
      inventory: this.harness.cachedInventory(ovenId),
      preflight: cached?.preflight ?? null,
      error: 'The check did not finish. Press Check Oven to try again.',
      stale: false
    }
  }

  private async inspect(ovenId: string, refresh: boolean, started: number): Promise<OvenPeek> {
    try {
      // Both reads start together, but only the probe decides the answer. The
      // package read is the slow half (WMI on Windows costs tens of seconds), and
      // waiting for it is what kept a connected Oven on "Checking…"; it fills the
      // cache the moment it lands instead.
      const probeTask = this.service.probe(ovenId, refresh)
      const preflightTask = this.preflight(ovenId)
      const probeOutcome = await probeTask.then(
        (value) => ({ ok: true as const, value }),
        (reason: unknown) => ({ ok: false as const, reason })
      )
      const probe = probeOutcome.ok ? probeOutcome.value : null
      const protectionTask: Promise<OvenSshProtection> = probe
        ? this.service.ssh.inspectProtection(ovenId).catch(() => ({ state: 'unverified' }))
        : Promise.resolve({ state: 'unverified' })
      const cachedPreflight = this.cache.get(ovenId)?.preflight ?? null
      const report: OvenPreflightReport | null = cachedPreflight?.report ?? null
      void preflightTask.then(
        (value) => {
          const current = this.cache.get(ovenId)
          if (!current) return
          const filled: OvenPeek = {
            ...current,
            preflight: { report: value, assessment: assessPreflight(value) }
          }
          this.cache.set(ovenId, filled)
          if (filled.probe) void this.persist(ovenId, filled)
        },
        (reason: unknown) =>
          Logger.dev('Oven package check did not complete', {
            ovenId,
            error: messageOf(reason)
          })
      )
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
      const error = probeOutcome.ok ? undefined : messageOf(probeOutcome.reason)
      const sshProtection = await protectionTask
      const peek: OvenPeek = {
        ovenId,
        checkedAt: Date.now(),
        durationMs: Date.now() - started,
        sshProtection,
        probe,
        inventory,
        preflight: report ? { report, assessment: assessPreflight(report) } : null,
        ...(error ? { error } : {}),
        stale: false
      }
      this.cache.set(ovenId, peek)
      if (probe) {
        this.onProbe?.(ovenId, probe, sshProtection)
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
      // The slot is released by `run`, which owns the deadline too.
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
