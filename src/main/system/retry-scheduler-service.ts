import { Logger } from './logger'
import { instanceRegistry } from './instance-registry'
import type { StorageEngine } from '../storage/storage-engine'
import type { AgentProviderIssueKind } from '../../lib/types'
import {
  RATE_LIMIT_COOLDOWN_MAX_ATTEMPTS,
  rateLimitCooldownMs,
  TRANSIENT_PROVIDER_RETRY_MAX_MS,
  TRANSIENT_PROVIDER_RETRY_MS
} from '../../lib/provider-issue'

/** One thread awaiting provider reset or device connection recovery. */
export interface PendingRetryRecord {
  /** Live instance responsible for this wait; legacy records use the incumbent. */
  ownerPid?: number
  sessionId: string
  projectId: string
  threadId: string
  harnessId: string
  /** Epoch ms for admission after the reset buffer; absent for manual-only retries. */
  retryAt?: number
  /** Provider reset before the admission buffer. */
  resetAt?: number
  /** Provider-reported retry attempt when the reset was surfaced. */
  attempt?: number
  /**
   * The app's own consecutive retry number for a rate limit the provider gave
   * no retry time for (1-based). Absent on provider-scheduled waits.
   */
  cooldownAttempt?: number
  /** True when `retryAt` is the app's rate-limit cooldown, not a provider reset. */
  retryCooldown?: boolean
  /** Provider-neutral failure kind   drives how the restored card renders. */
  issueKind: AgentProviderIssueKind
  /** Human-readable failure message persisted for the restored warning card. */
  issueMessage: string
  /** Original exception message for developer diagnostics, when available. */
  rawError?: string
}

/** Every `AgentProviderIssueKind` value, for validating persisted records. */
const ISSUE_KINDS = new Set<AgentProviderIssueKind>([
  'rate_limit',
  'quota',
  'authentication',
  'billing',
  'provider_unavailable',
  'network',
  'unknown'
])

/** How often the ticker checks whether any pending reset window has passed. */
const RETRY_TICK_MS = 15_000
/**
 * Faster tick while a cooldown wait is due within the normal tick. A rate-limit
 * cooldown is seconds long, so the 15s sweep would fire every one of them late
 * (a 1s wait could turn into 15s).
 */
const RETRY_COOLDOWN_TICK_MS = 1_000

/**
 * How long after a cooldown wait ends a later rate limit still counts as the
 * same streak. If the retry succeeded, a new rate limit minutes later is a new
 * situation with a fresh budget instead of attempt seven on a dead streak.
 */
const RATE_LIMIT_COOLDOWN_STREAK_MS = 5 * 60 * 1_000

/** One thread's consecutive rate-limit cooldown streak. */
interface RateLimitCooldown {
  attempt: number
  /** When the reserved retry is due. */
  retryAt: number
}

/** A reserved cooldown retry: which attempt it is, and when it fires. */
export interface RateLimitCooldownReservation {
  attempt: number
  retryAt: number
}
/** Bound expensive session/context preparation when many windows reset together. */
const MAX_CONCURRENT_RESUMES = 2
/** Transport/admission failures must retain automatic recovery without a hot loop. */
const RESUME_FAILURE_COOLDOWN_MS = 60_000

/**
 * Maximum persisted card message accepted when restoring records. A genuine
 * provider failure message is short; before the textual usage-limit detection
 * was structurally guarded, an agent's entire final message could be persisted
 * here as the issue and would re-create the splashed card on every launch.
 * Reject overlong legacy records on load   the dropped prose is meaningless,
 * and a still-paused thread falls back to the generic restored card.
 */
const MAX_SAVED_ISSUE_MESSAGE_LENGTH = 1_000

/** Config-relative file holding pending retries so they survive app restarts. */
const PERSISTENCE_FILE = 'scheduler/retry-scheduler.json'

/**
 * RetrySchedulerService retains provider-reset and connection failures. A device
 * connection wait resumes as soon as connectivity is *verified* back (a real
 * round trip, not the operating system's guess), in bounded batches; usage
 * resets honor the autoRetryAfterReset preference. Records without a retry deadline remain
 * persisted for restart recovery but are never fired automatically. Listeners
 * are notified on every pending-set change so dependents (e.g. the power-wake
 * service) can re-evaluate.
 */
export class RetrySchedulerService {
  private readonly pending = new Map<string, PendingRetryRecord>()
  private readonly resuming = new Map<string, PendingRetryRecord>()
  private timer: ReturnType<typeof setInterval> | null = null
  private timerIntervalMs: number | null = null
  private timerStopped = false
  private enabled = false
  /**
   * Consecutive rate-limit cooldowns per thread. Kept in memory (plus the
   * pending records that persist an in-flight attempt) because the streak only
   * matters while the app is retrying; a restart starts a fresh budget.
   */
  private readonly rateLimitCooldowns = new Map<string, RateLimitCooldown>()
  private isOnline: (() => boolean) | null = null
  private continueThread: ((record: PendingRetryRecord) => Promise<void>) | null = null
  /** Fired whenever the pending set changes (track/clear/fire/restore). */
  private changeListener: (() => void) | null = null
  /** Serialized atomic writes so rapid track/clear never interleave snapshots. */
  private persistChain: Promise<void> = Promise.resolve()
  /** Returns true when a deliberate user stop is latched on the record's thread. */
  private isStopped: ((projectId: string, threadId: string) => Promise<boolean>) | null = null

  constructor(private storage: StorageEngine) {}

  /** Load the persisted preference and pending retries, then arm the ticker. */
  async start(): Promise<void> {
    this.timerStopped = false
    const config = await this.storage.getConfig()
    this.enabled = config.autoRetryAfterReset === true
    await this.loadPending()
    // Records whose thread was deliberately stopped by the user before the
    // last shutdown must be dropped here, before the launch tick can fire
    // them: restart is exactly when a stopped thread revives itself today.
    await this.refreshStoppedVeto()
    this.refreshTimer()
    // Resets that elapsed while the app was closed fire immediately on launch.
    this.tick()
  }

  /** Apply a config change without re-reading storage. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    this.refreshTimer()
    if (enabled) this.tick()
    this.notifyChange()
  }

  /** The chat engine supplies the resume callback once registered. */
  async attachContinue(callback: (record: PendingRetryRecord) => Promise<void>): Promise<void> {
    this.continueThread = callback
    // A record can come due while the engine is still booting; the veto must
    // exist before the first fire, so the latch query ships with the callback.
    await this.refreshStoppedVeto()
    this.tick()
  }

  /**
   * A deliberate user stop vetoes the automatic resume, and the veto must
   * survive app restarts because the persisted pending ledger does. The chat
   * engine supplies the test so the scheduler never touches storage itself.
   */
  attachStoppedThreadTest(test: (projectId: string, threadId: string) => Promise<boolean>): void {
    this.isStopped = test
  }

  /**
   * Main-process connectivity is authoritative; renderer events only wake the
   * queue. The test is expected to answer with *verified* connectivity (see
   * `ConnectivityService`), because a connection wait fired against a link that
   * is not actually up burns a resume attempt, while one that never fires
   * strands the thread.
   *
   * Without a test attached a network wait is never gated at all: a missing
   * wiring bug must fail towards resuming, never towards a wait that outlives
   * the reconnection it was parked on.
   */
  attachNetworkTest(test: () => boolean): void {
    this.isOnline = test
  }

  connectionRestored(): void {
    this.tick()
  }

  /**
   * Connectivity is only a gate for connection waits, and only when something
   * can actually answer for it. Every other kind of wait is the provider's
   * clock, not the device's link.
   */
  private networkReachable(record: PendingRetryRecord): boolean {
    if (record.issueKind !== 'network') return true
    if (this.isOnline === null) return true
    return this.isOnline()
  }

  /** Drop every pending record whose thread is currently user-stopped. */
  private async refreshStoppedVeto(): Promise<void> {
    const test = this.isStopped
    if (!test) return
    for (const record of [...this.pending.values()]) {
      let stopped: boolean
      try {
        stopped = await test(record.projectId, record.threadId)
      } catch {
        continue
      }
      if (stopped && this.pending.get(record.sessionId) === record) {
        this.pending.delete(record.sessionId)
        Logger.info('Auto-retry dropped: the user stopped this thread', {
          projectId: record.projectId,
          threadId: record.threadId,
          sessionId: record.sessionId
        })
      }
    }
    void this.persist()
    this.refreshTimer()
    this.notifyChange()
  }

  /** Drop every pending record of one thread (a deliberate user stop). */
  dropThread(threadId: string): void {
    for (const record of [...this.pending.values()]) {
      if (record.threadId === threadId) this.pending.delete(record.sessionId)
    }
    void this.persist()
    this.refreshTimer()
    this.notifyChange()
  }

  /** Register a callback fired whenever the pending-retry set changes. */
  attachChangeListener(callback: () => void): void {
    this.changeListener = callback
  }

  /**
   * Reserve the next automatic retry for a rate limit the provider gave no
   * retry time for. The first failure waits 1s, the next 3s, then 5s, 10s, 30s,
   * and 60s. A re-report of the same failure does not advance or push out the
   * wait. `undefined` means the six-step schedule is exhausted and the caller
   * must stop retrying.
   */
  reserveRateLimitCooldown(
    threadId: string,
    now = Date.now()
  ): RateLimitCooldownReservation | undefined {
    const previous = this.rateLimitCooldowns.get(threadId)
    if (previous && now < previous.retryAt) {
      // The same failure under another session of this thread: keep the attempt
      // and its deadline instead of charging the thread twice or delaying it.
      return { attempt: previous.attempt, retryAt: previous.retryAt }
    }
    const continuing =
      previous !== undefined && now - previous.retryAt <= RATE_LIMIT_COOLDOWN_STREAK_MS
    const attempt = continuing ? previous.attempt + 1 : 1
    const delayMs = rateLimitCooldownMs(attempt)
    if (delayMs === undefined) {
      // Remember the exhausted streak so a still-failing thread stays stopped
      // instead of rolling back to attempt one on the next report.
      this.rateLimitCooldowns.set(threadId, { attempt, retryAt: now })
      Logger.info('Rate-limit cooldown schedule exhausted', {
        threadId,
        attempts: RATE_LIMIT_COOLDOWN_MAX_ATTEMPTS
      })
      return undefined
    }
    const retryAt = now + delayMs
    this.rateLimitCooldowns.set(threadId, { attempt, retryAt })
    Logger.info('Rate-limit cooldown reserved', { threadId, attempt, delayMs })
    return { attempt, retryAt }
  }

  /** A completed turn or a manual retry starts a fresh cooldown budget. */
  clearRateLimitCooldown(threadId: string): void {
    this.rateLimitCooldowns.delete(threadId)
  }

  /**
   * The waits this instance is currently holding, one per session.
   *
   * Read by the attention mirror, which reports a parked dispatched thread into
   * the conversation that started it: an unattended rate-limit wait is otherwise
   * indistinguishable from work that is still running.
   */
  listPending(): PendingRetryRecord[] {
    return [...this.pending.values()]
  }

  /** True when any pending retry resets at or before `deadlineMs`. */
  hasPendingRetryBefore(deadlineMs: number): boolean {
    for (const record of this.pending.values()) {
      if (record.retryAt !== undefined && record.retryAt <= deadlineMs) return true
    }
    return false
  }

  /** Record (or refresh) a pending reset retry for a session. */
  async track(record: PendingRetryRecord): Promise<boolean> {
    // A deliberate user stop must never be overwritten by a fresh wait: the
    // failure that arrived under a successor session is exactly what Stop was
    // cancelling. The auto-retry toggle is honoured through `enabled` (kept
    // current by `start`/`setEnabled`) and by `tick`, which never fires while
    // it is off.
    try {
      if (this.isStopped && (await this.isStopped(record.projectId, record.threadId))) {
        Logger.info('Auto-retry not tracked: the user stopped this thread', {
          projectId: record.projectId,
          threadId: record.threadId,
          sessionId: record.sessionId
        })
        return false
      }
    } catch (error) {
      // The veto probe itself failed. Tracking a stopped thread is the worse
      // outcome (silent revival), so the record is not written and the thread
      // falls back to the visible warning card for manual recovery.
      Logger.error('Auto-retry veto probe failed; record not tracked', {
        projectId: record.projectId,
        threadId: record.threadId,
        error: error instanceof Error ? error.message : String(error)
      })
      return false
    }
    record.ownerPid = process.pid
    this.pending.set(record.sessionId, record)
    void this.persist()
    Logger.info('Retry wait retained', {
      projectId: record.projectId,
      threadId: record.threadId,
      harnessId: record.harnessId,
      ownerPid: record.ownerPid,
      issueKind: record.issueKind,
      retryAt: record.retryAt === undefined ? null : new Date(record.retryAt).toISOString(),
      automatic: (this.enabled || record.issueKind === 'network') && record.retryAt !== undefined
    })
    this.refreshTimer()
    // The reset may already have passed   fire without waiting.
    this.tick()
    this.notifyChange()
    // True means the wait is on the ledger. Whether it FIRES automatically is
    // `tick`'s decision: with auto-retry off the persisted record only backs
    // the visible "Waiting to retry" card, exactly as before this gate.
    return true
  }

  /** Drop a session from the pending set once it resolves or retires. */
  clear(sessionId: string): void {
    if (this.pending.delete(sessionId)) {
      void this.persist()
      if (this.pending.size === 0) this.refreshTimer()
      this.notifyChange()
    }
  }

  /** The live pending record for a session, restored from disk on restart. */
  getPendingRetry(sessionId: string): PendingRetryRecord | undefined {
    return this.pending.get(sessionId)
  }

  /** Admission ends when the harness starts, rather than when its turn finishes. */
  resumed(sessionId: string): void {
    if (this.resuming.delete(sessionId)) this.tick()
  }

  /** Number of pending reset retries (tests/logging). */
  get size(): number {
    return this.pending.size
  }

  /** Whether automatic retries are enabled in General settings. */
  get isEnabled(): boolean {
    return this.enabled
  }

  stop(): void {
    this.timerStopped = true
    this.clearTimer()
  }

  dispose(): void {
    this.stop()
    // In-memory state is dropped on shutdown, but the persisted file is kept so
    // the next launch can restore the pending resets and their warning cards.
    this.pending.clear()
    this.rateLimitCooldowns.clear()
    this.continueThread = null
  }

  private async loadPending(): Promise<void> {
    let saved: unknown
    try {
      saved = await this.storage.read(PERSISTENCE_FILE)
    } catch (error) {
      Logger.error('Auto-resume persisted records could not be read:', error)
      return
    }
    if (!Array.isArray(saved)) return
    for (const raw of saved) {
      const validated = this.validateSavedRecord(raw)
      if (!validated) continue
      const repaired = this.repairTransientRecord(validated)
      this.pending.set(repaired.sessionId, repaired)
      if (repaired.retryCooldown && repaired.cooldownAttempt !== undefined) {
        this.rateLimitCooldowns.set(repaired.threadId, {
          attempt: repaired.cooldownAttempt,
          retryAt: repaired.retryAt ?? Date.now()
        })
      }
    }
    if (this.pending.size > 0) {
      Logger.info('Auto-resume restored pending retries after restart', {
        count: this.pending.size
      })
    }
    this.notifyChange()
  }

  private validateSavedRecord(value: unknown): PendingRetryRecord | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    const {
      sessionId,
      projectId,
      threadId,
      harnessId,
      retryAt,
      issueKind,
      issueMessage,
      attempt,
      rawError
    } = record
    if (
      typeof sessionId !== 'string' ||
      typeof projectId !== 'string' ||
      typeof threadId !== 'string' ||
      typeof harnessId !== 'string' ||
      (retryAt !== undefined && (typeof retryAt !== 'number' || !Number.isFinite(retryAt))) ||
      typeof issueKind !== 'string' ||
      !ISSUE_KINDS.has(issueKind as AgentProviderIssueKind) ||
      typeof issueMessage !== 'string' ||
      issueMessage.length > MAX_SAVED_ISSUE_MESSAGE_LENGTH
    ) {
      return null
    }
    return {
      sessionId,
      projectId,
      threadId,
      harnessId,
      ...(typeof record.ownerPid === 'number' &&
      Number.isInteger(record.ownerPid) &&
      record.ownerPid > 0
        ? { ownerPid: record.ownerPid }
        : {}),
      ...(retryAt === undefined ? {} : { retryAt }),
      ...(typeof record.resetAt === 'number' && Number.isFinite(record.resetAt)
        ? { resetAt: record.resetAt }
        : {}),
      issueKind: issueKind as AgentProviderIssueKind,
      issueMessage,
      ...(typeof attempt === 'number' && Number.isFinite(attempt) ? { attempt } : {}),
      ...(typeof record.cooldownAttempt === 'number' && Number.isFinite(record.cooldownAttempt)
        ? { cooldownAttempt: record.cooldownAttempt }
        : {}),
      ...(record.retryCooldown === true ? { retryCooldown: true } : {}),
      ...(typeof rawError === 'string' ? { rawError } : {})
    }
  }

  /**
   * A transient provider-load wait is short by definition. Records written
   * before the fixed backoff (see `scheduleAutomaticRetry`) captured the
   * account's monthly reset for a 429 `overloaded`, parking a recoverable
   * thread weeks out. Clamp those on load so the fix also releases threads that
   * are already stuck instead of waiting for their saved deadline.
   */
  private repairTransientRecord(record: PendingRetryRecord): PendingRetryRecord {
    if (record.issueKind !== 'provider_unavailable' || record.retryAt === undefined) return record
    const now = Date.now()
    if (record.retryAt - now <= TRANSIENT_PROVIDER_RETRY_MAX_MS) return record
    const retryAt = now + TRANSIENT_PROVIDER_RETRY_MS
    Logger.info('Repaired a transient provider wait parked beyond its backoff', {
      sessionId: record.sessionId,
      projectId: record.projectId,
      threadId: record.threadId,
      savedRetryAt: new Date(record.retryAt).toISOString(),
      retryAt: new Date(retryAt).toISOString()
    })
    return { ...record, retryAt, resetAt: retryAt }
  }

  private persist(): Promise<void> {
    const snapshot = [...this.pending.values()]
    this.persistChain = this.persistChain
      .then(() => this.storage.write(PERSISTENCE_FILE, snapshot))
      .catch((error) => {
        Logger.error('Auto-resume persisted records could not be written:', error)
      })
    return this.persistChain
  }

  /** Await the serialized snapshot write so durability is observable (tests). */
  flush(): Promise<void> {
    return this.persistChain
  }

  private clearTimer(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    this.timerIntervalMs = null
  }

  private refreshTimer(): void {
    if (this.timerStopped) {
      this.clearTimer()
      return
    }
    const eligible = [...this.pending.values()].filter(
      (record) => this.enabled || record.issueKind === 'network'
    )
    const dueTimes = eligible.flatMap((record) =>
      record.retryAt === undefined ? [] : [record.retryAt]
    )
    if (dueTimes.length === 0) {
      this.clearTimer()
      return
    }
    // A rate-limit cooldown is seconds long, so the 15s sweep would fire it
    // late (a 1s wait could turn into 15s). Sweep at one second while one is on
    // the ledger; every other wait keeps the normal, cheaper sweep.
    const interval = eligible.some((record) => record.retryCooldown === true)
      ? RETRY_COOLDOWN_TICK_MS
      : RETRY_TICK_MS
    if (this.timer !== null && this.timerIntervalMs === interval) return
    this.clearTimer()
    this.timerIntervalMs = interval
    this.timer = setInterval(() => this.tick(), interval)
  }

  private tick(): void {
    if (this.timerStopped) return
    void this.tickAsync()
  }

  private ownsRetry(record: PendingRetryRecord): boolean {
    if (record.ownerPid === process.pid) return true
    if (record.ownerPid !== undefined && instanceRegistry.isRunOwnerAlive(record.ownerPid))
      return false
    return instanceRegistry.isIncumbentInstance()
  }

  private async tickAsync(): Promise<void> {
    if (this.timerStopped || !this.continueThread) return
    // A newly tracked wait exists only in its recording instance's memory.
    // Requiring the incumbent here stranded every secondary-instance wait:
    // the owner refused to fire and the incumbent never loaded the new record.
    // Live owners fire their own waits; only orphaned/legacy waits are elected.
    const now = Date.now()
    const due: PendingRetryRecord[] = []
    for (const record of this.pending.values()) {
      if (
        (this.enabled || record.issueKind === 'network') &&
        this.networkReachable(record) &&
        record.retryAt !== undefined &&
        record.retryAt <= now &&
        this.ownsRetry(record) &&
        !this.resuming.has(record.sessionId)
      )
        due.push(record)
    }
    if (due.length === 0) return
    // Recheck ownership after each asynchronous veto probe: another tick,
    // a manual retry, or Stop may have changed the pending record meanwhile.
    const vetoed: PendingRetryRecord[] = []
    const deferred = new Set<PendingRetryRecord>()
    if (this.isStopped) {
      for (const record of due) {
        try {
          if (await this.isStopped(record.projectId, record.threadId)) vetoed.push(record)
        } catch {
          // Fail closed for this tick; retain the record for the next probe.
          deferred.add(record)
        }
      }
    }
    if (this.timerStopped || !this.continueThread) return
    const runnable = due.filter(
      (record) =>
        !vetoed.includes(record) &&
        !deferred.has(record) &&
        this.ownsRetry(record) &&
        (this.enabled || record.issueKind === 'network') &&
        this.networkReachable(record)
    )
    for (const record of vetoed) {
      if (this.pending.get(record.sessionId) === record) {
        this.pending.delete(record.sessionId)
        Logger.info('Auto-retry vetoed: the user stopped this thread', {
          projectId: record.projectId,
          threadId: record.threadId,
          sessionId: record.sessionId
        })
      }
    }
    for (const record of runnable) {
      if (this.resuming.size >= MAX_CONCURRENT_RESUMES) break
      if (this.pending.get(record.sessionId) === record && !this.resuming.has(record.sessionId)) {
        // Keep the durable wait until admission succeeds. Reserve it before
        // calling the engine so overlapping ticks cannot dispatch it twice.
        this.resuming.set(record.sessionId, record)
        void this.fire(record)
      }
    }
    void this.persist()
    if (this.pending.size === 0) this.refreshTimer()
    this.notifyChange()
  }

  private async fire(record: PendingRetryRecord): Promise<void> {
    const callback = this.continueThread
    if (!callback) {
      this.resuming.delete(record.sessionId)
      Logger.info('Auto-resume skipped   chat engine not attached', {
        sessionId: record.sessionId
      })
      return
    }
    Logger.info('Auto-resuming retained thread', {
      projectId: record.projectId,
      threadId: record.threadId,
      harnessId: record.harnessId
    })
    try {
      await callback(record)
      if (this.pending.get(record.sessionId) === record) this.pending.delete(record.sessionId)
    } catch (error) {
      Logger.error('Auto-resume attempt failed', error)
      // The send pipeline can clear the original wait before its transport
      // fails. Restore it unless the engine already tracked a newer failure
      // or the user deliberately stopped this thread.
      const pending = this.pending.get(record.sessionId)
      if (this.continueThread === callback && (!pending || pending === record)) {
        try {
          const stopped = await this.isStopped?.(record.projectId, record.threadId)
          if (stopped && this.pending.get(record.sessionId) === record) {
            this.pending.delete(record.sessionId)
          }
          if (
            this.continueThread === callback &&
            !stopped &&
            (!this.pending.has(record.sessionId) || this.pending.get(record.sessionId) === record)
          ) {
            this.pending.set(record.sessionId, {
              ...record,
              retryAt: Date.now() + RESUME_FAILURE_COOLDOWN_MS
            })
          }
        } catch (probeError) {
          Logger.error('Auto-resume stop check failed; retaining pending recovery', probeError)
          if (this.continueThread === callback && !this.pending.has(record.sessionId)) {
            this.pending.set(record.sessionId, {
              ...record,
              retryAt: Date.now() + RESUME_FAILURE_COOLDOWN_MS
            })
          }
        }
      }
    } finally {
      if (this.resuming.get(record.sessionId) === record) this.resuming.delete(record.sessionId)
      // Shutdown clears the in-memory ledger but keeps its saved waits.
      // A late admission must not persist that cleared shutdown snapshot.
      if (this.continueThread === callback) {
        void this.persist()
        this.refreshTimer()
        this.notifyChange()
        this.tick()
      }
    }
  }

  private notifyChange(): void {
    this.changeListener?.()
  }
}
