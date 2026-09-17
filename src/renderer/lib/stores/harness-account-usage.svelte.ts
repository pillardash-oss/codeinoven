import { APP_SLUG } from '$shared/brand'
import { invoke } from '$lib/ipc.svelte'
import type {
  AgentAccountUsage,
  AgentBankedResets,
  AgentRateLimitWindow,
  AgentUsageCredits,
  HarnessAccount
} from '$shared/types'
import { SvelteMap, SvelteSet } from 'svelte/reactivity'

const STORAGE_KEY = `${APP_SLUG}.harness-account-usage.v1`

/** How long a snapshot is trusted before the Accounts table re-probes it.
 *  Revisiting the tab still paints the persisted snapshot instantly; this only
 *  decides whether the background probe runs again. */
export const ACCOUNT_USAGE_FRESH_MS = 60_000

/** Concurrent probes. Each one may start a harness process (Codex spins up its
 *  app-server), so the ceiling stays low enough that opening Accounts never
 *  floods CPU, RAM, or the network. */
const PROBE_CONCURRENCY = 2

/** Breathing room between probe batches, so a long account list hydrates
 *  progressively instead of monopolising the main thread and event loop. */
const BATCH_GAP_MS = 120

/** Upper bound on persisted snapshots, keeping the cache bounded and small. */
const MAX_PERSISTED = 60

/** Coalesce localStorage writes; probing many accounts must not block the
 *  renderer with one synchronous write per account. */
const PERSIST_DEBOUNCE_MS = 800

export interface AccountUsageSnapshot {
  /** Latest telemetry, or `null` when the harness reported no quota at all. */
  usage: AgentAccountUsage | null
  /** Epoch ms of the last completed probe; `0` means "never probed". */
  fetchedAt: number
  /** Set when the probe itself failed, as opposed to reporting nothing. */
  error?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pickNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function pickString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' ? value : undefined
}

function pickBoolean(source: Record<string, unknown>, key: string): boolean | undefined {
  const value = source[key]
  return typeof value === 'boolean' ? value : undefined
}

function parseWindow(value: unknown): AgentRateLimitWindow | null {
  if (!isRecord(value)) return null
  const id = pickString(value, 'id')
  const label = pickString(value, 'label')
  if (id === undefined || label === undefined) return null
  return {
    id,
    label,
    status: pickString(value, 'status'),
    usedPercent: pickNumber(value, 'usedPercent'),
    remaining: pickNumber(value, 'remaining'),
    limit: pickNumber(value, 'limit'),
    resetsAt: pickNumber(value, 'resetsAt'),
    windowMinutes: pickNumber(value, 'windowMinutes'),
    model: pickString(value, 'model'),
    overageStatus: pickString(value, 'overageStatus'),
    overageDisabledReason: pickString(value, 'overageDisabledReason'),
    isUsingOverage: pickBoolean(value, 'isUsingOverage')
  }
}

function parseCredits(value: unknown): AgentUsageCredits | undefined {
  if (!isRecord(value)) return undefined
  return {
    balance: pickNumber(value, 'balance'),
    hasCredits: pickBoolean(value, 'hasCredits'),
    unlimited: pickBoolean(value, 'unlimited'),
    planType: pickString(value, 'planType')
  }
}

function parseBankedResets(value: unknown): AgentBankedResets | undefined {
  if (!isRecord(value)) return undefined
  const availableCount = pickNumber(value, 'availableCount')
  if (availableCount === undefined) return undefined
  const rawCredits = value['credits']
  const credits = Array.isArray(rawCredits)
    ? rawCredits.flatMap((entry) => {
        if (!isRecord(entry)) return []
        const id = pickString(entry, 'id')
        if (id === undefined) return []
        // `null` is meaningful (never expires); a missing key means unknown.
        const expiresAt = entry['expiresAt'] === null ? null : pickNumber(entry, 'expiresAt')
        return [{ id, ...(expiresAt === undefined ? {} : { expiresAt }) }]
      })
    : undefined
  return { availableCount, ...(credits ? { credits } : {}) }
}

/** Parse one persisted snapshot without trusting storage contents. */
function parseSnapshot(value: unknown): AccountUsageSnapshot | null {
  if (!isRecord(value)) return null
  const fetchedAt = value['fetchedAt']
  if (typeof fetchedAt !== 'number' || !Number.isFinite(fetchedAt)) return null
  const rawUsage = value['usage']
  let usage: AgentAccountUsage | null = null
  if (rawUsage !== null && rawUsage !== undefined) {
    if (!isRecord(rawUsage)) return null
    const harnessId = pickString(rawUsage, 'harnessId')
    const providerId = pickString(rawUsage, 'providerId')
    const rawWindows = rawUsage['rateLimits']
    if (harnessId === undefined || providerId === undefined || !Array.isArray(rawWindows)) {
      return null
    }
    const credits = parseCredits(rawUsage['credits'])
    const bankedResets = parseBankedResets(rawUsage['bankedResets'])
    usage = {
      harnessId,
      providerId,
      accountId: pickString(rawUsage, 'accountId'),
      rateLimits: rawWindows.flatMap((window) => parseWindow(window) ?? []),
      ...(credits ? { credits } : {}),
      ...(bankedResets ? { bankedResets } : {}),
      contextWindow: pickNumber(rawUsage, 'contextWindow'),
      contextUsed: pickNumber(rawUsage, 'contextUsed')
    }
  }
  const error = pickString(value, 'error')
  return { usage, fetchedAt, ...(error ? { error } : {}) }
}

function readStoredSnapshots(): Record<string, AccountUsageSnapshot> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return {}
    const snapshots: Record<string, AccountUsageSnapshot> = {}
    for (const [accountId, entry] of Object.entries(parsed)) {
      const snapshot = parseSnapshot(entry)
      if (snapshot) snapshots[accountId] = snapshot
    }
    return snapshots
  } catch {
    // A corrupt cache is disposable; the next probe rebuilds it.
    return {}
  }
}

function writeStoredSnapshots(snapshots: Record<string, AccountUsageSnapshot>): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshots))
  } catch {
    // Caching is optional; unavailable storage must not break usage display.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Account quota for the Harness settings Accounts table.
 *
 * Opening the tab must never block on quota probes: the last persisted
 * snapshot paints immediately and probes run afterwards in small batches, with
 * each finished account becoming visible as it lands. Probes are keyed by
 * account id, de-duplicated while in flight, and reused for a short freshness
 * window so switching tabs does not re-spawn harness processes.
 */
class HarnessAccountUsageCache {
  /** accountId → last known snapshot. Reactive: replaced wholesale on update. */
  private readonly snapshots = new SvelteMap<string, AccountUsageSnapshot>()
  /** Accounts waiting for a probe slot. */
  private queue: HarnessAccount[] = []
  /** Ids in {@link queue}, for O(1) de-duplication. */
  private readonly queuedIds = new Set<string>()
  /** Ids currently being probed. Reactive so each row can show its own
   *  in-flight state. */
  private readonly inflightIds = new SvelteSet<string>()
  private draining = false
  private hydrated = false
  private persistTimer: ReturnType<typeof setTimeout> | undefined

  constructor() {
    // Hydrate up front rather than on first read: a persisted snapshot must be
    // available to the very first render without writing state from a derived.
    this.hydrateOnce()
  }

  /** Accounts included in the current hydrate pass, for progress display. */
  probingTotal = $state(0)
  /** Accounts from that pass still waiting on a probe. */
  probingRemaining = $state(0)

  /** True while any account in this pass is still being probed. */
  get hydrating(): boolean {
    return this.probingRemaining > 0
  }

  /** Last known snapshot for an account, including a persisted one, or
   *  `undefined` when the account has never been probed. */
  snapshotFor(accountId: string): AccountUsageSnapshot | undefined {
    return this.snapshots.get(accountId)
  }

  /** Queue accounts for a background probe. Accounts with a fresh snapshot are
   *  skipped unless `force` is set; queued and in-flight accounts are never
   *  probed twice. */
  schedule(accounts: readonly HarnessAccount[], options?: { force?: boolean }): void {
    const force = options?.force === true
    let added = 0
    for (const account of accounts) {
      if (!this.needsProbe(account.id, force)) continue
      this.queuedIds.add(account.id)
      this.queue.push(account)
      added += 1
    }
    if (added === 0) return
    this.probingTotal += added
    this.probingRemaining += added
    void this.drain()
  }

  /** Drop snapshots and queued probes for accounts that no longer exist, so a
   *  removed account never keeps a slot or a stale row in the cache. */
  prune(keepIds: Iterable<string>): void {
    const keep = new Set(keepIds)
    const keptQueue = this.queue.filter((account) => keep.has(account.id))
    const droppedQueued = this.queue.length - keptQueue.length
    this.queue = keptQueue
    this.queuedIds.clear()
    for (const account of keptQueue) this.queuedIds.add(account.id)
    let removed = false
    for (const accountId of [...this.snapshots.keys()]) {
      if (keep.has(accountId)) continue
      this.snapshots.delete(accountId)
      removed = true
    }
    if (droppedQueued > 0) {
      this.probingTotal = Math.max(0, this.probingTotal - droppedQueued)
      this.probingRemaining = Math.max(0, this.probingRemaining - droppedQueued)
    }
    if (removed) this.persistSoon()
  }

  /** True while this account has a probe in flight, for per-row feedback. */
  isProbing(accountId: string): boolean {
    return this.inflightIds.has(accountId)
  }

  private needsProbe(accountId: string, force: boolean): boolean {
    if (this.queuedIds.has(accountId) || this.inflightIds.has(accountId)) return false
    const snapshot = this.snapshots.get(accountId)
    if (!snapshot) return true
    if (snapshot.fetchedAt === 0) return true
    if (force) return true
    return Date.now() - snapshot.fetchedAt > ACCOUNT_USAGE_FRESH_MS
  }

  /** One probe pass: bounded concurrency, a short gap between batches. */
  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, PROBE_CONCURRENCY)
        await Promise.all(batch.map((account) => this.probe(account)))
        if (this.queue.length > 0) await delay(BATCH_GAP_MS)
      }
    } finally {
      this.draining = false
      this.probingTotal = 0
      this.probingRemaining = 0
    }
  }

  private async probe(account: HarnessAccount): Promise<void> {
    this.queuedIds.delete(account.id)
    this.inflightIds.add(account.id)
    try {
      const results = await invoke('agent:refreshAccountUsage', {
        harnessId: account.harnessId,
        ...(account.providerId ? { providerId: account.providerId } : {}),
        accountId: account.id
      })
      const usage =
        // Strict id match: a drifted resolution must never attribute another
        // account's quota to this row.
        results.find((entry) => entry.accountId === account.id) ?? null
      this.commit(account.id, { usage, fetchedAt: Date.now() })
    } catch (error) {
      const previous = this.snapshots.get(account.id)
      this.commit(account.id, {
        usage: previous?.usage ?? null,
        // Keep a previous timestamp so a transient failure does not reset the
        // freshness window; a never-probed account stays due for a retry.
        fetchedAt: previous?.fetchedAt ?? 0,
        error: error instanceof Error ? error.message : 'Usage could not be read.'
      })
    } finally {
      this.inflightIds.delete(account.id)
      this.probingRemaining = Math.max(0, this.probingRemaining - 1)
    }
  }

  private commit(accountId: string, snapshot: AccountUsageSnapshot): void {
    this.snapshots.set(accountId, snapshot)
    this.persistSoon()
  }

  /** Persisted entries are replaced wholesale, keeping the on-disk cache small. */
  private persist(): void {
    const entries = [...this.snapshots.entries()]
      .filter(([, snapshot]) => snapshot.fetchedAt > 0)
      .toSorted((left, right) => right[1].fetchedAt - left[1].fetchedAt)
      .slice(0, MAX_PERSISTED)
    writeStoredSnapshots(Object.fromEntries(entries))
  }

  private persistSoon(): void {
    if (this.persistTimer !== undefined) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined
      this.persist()
    }, PERSIST_DEBOUNCE_MS)
  }

  private hydrateOnce(): void {
    if (this.hydrated) return
    this.hydrated = true
    const stored = readStoredSnapshots()
    for (const [accountId, snapshot] of Object.entries(stored)) {
      this.snapshots.set(accountId, snapshot)
    }
  }
}

export const harnessAccountUsageCache = new HarnessAccountUsageCache()
