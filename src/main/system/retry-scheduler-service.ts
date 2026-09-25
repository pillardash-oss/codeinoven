import { Logger } from './logger'
import { instanceRegistry } from './instance-registry'
import type { StorageEngine } from '../storage/storage-engine'
import type { AgentProviderIssueKind } from '../../lib/types'

/** One thread awaiting provider recovery after a usage/rate-limit reset. */
export interface PendingRetryRecord {
  sessionId: string
  projectId: string
  threadId: string
  harnessId: string
  /** Epoch ms when the provider window resets; absent when only manual retry is available. */
  retryAt?: number
  /** Provider-reported retry attempt when the reset was surfaced. */
  attempt?: number
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
 * RetrySchedulerService   remembers every thread whose turn ended in a
 * quota/rate-limit reset, then automatically resumes the thread once a known
 * reset time passes while the app is open. Records without a reset time remain
 * persisted for restart recovery but are never fired automatically. Listeners
 * are notified on every pending-set change so dependents (e.g. the power-wake
 * service) can re-evaluate.
 */
export class RetrySchedulerService {
  private readonly pending = new Map<string, PendingRetryRecord>()
  private timer: ReturnType<typeof setInterval> | null = null
  private enabled = false
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
  attachContinue(callback: (record: PendingRetryRecord) => Promise<void>): Promise<void> {
    this.continueThread = callback
    // A record can come due while the engine is still booting; the veto must
    // exist before the first fire, so the latch query ships with the callback.
    return this.refreshStoppedVeto()
  }

  /**
   * A deliberate user stop vetoes the automatic resume, and the veto must
   * survive app restarts because the persisted pending ledger does. The chat
   * engine supplies the test so the scheduler never touches storage itself.
   */
  attachStoppedThreadTest(test: (projectId: string, threadId: string) => Promise<boolean>): void {
    this.isStopped = test
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
    this.pending.set(record.sessionId, record)
    void this.persist()
    Logger.info('Retry wait retained after usage reset', {
      projectId: record.projectId,
      threadId: record.threadId,
      harnessId: record.harnessId,
      retryAt: record.retryAt === undefined ? null : new Date(record.retryAt).toISOString(),
      automatic: this.enabled && record.retryAt !== undefined
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

  /** Number of pending reset retries (tests/logging). */
  get size(): number {
    return this.pending.size
  }

  /** Whether automatic retries are enabled in General settings. */
  get isEnabled(): boolean {
    return this.enabled
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  dispose(): void {
    this.stop()
    // In-memory state is dropped on shutdown, but the persisted file is kept so
    // the next launch can restore the pending resets and their warning cards.
    this.pending.clear()
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
      const record = this.validateSavedRecord(raw)
      if (record) this.pending.set(record.sessionId, record)
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
      ...(retryAt === undefined ? {} : { retryAt }),
      issueKind: issueKind as AgentProviderIssueKind,
      issueMessage,
      ...(typeof attempt === 'number' && Number.isFinite(attempt) ? { attempt } : {}),
      ...(typeof rawError === 'string' ? { rawError } : {})
    }
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

  private refreshTimer(): void {
    const shouldRun =
      this.enabled && [...this.pending.values()].some((record) => record.retryAt !== undefined)
    if (shouldRun && this.timer === null) {
      this.timer = setInterval(() => this.tick(), RETRY_TICK_MS)
    } else if (!shouldRun && this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private tick(): void {
    if (!this.enabled) return
    void this.tickAsync()
  }

  private async tickAsync(): Promise<void> {
    if (!this.enabled) return
    // The ledger of pending resets is shared by every instance using this config
    // root, and each instance holds its own in-memory copy of it. Only the
    // longest-running instance fires a continuation, so a second window can
    // never resume a thread the first one already owns, and a fired record is
    // removed from the shared ledger by exactly one process.
    if (!instanceRegistry.isIncumbentInstance()) return
    const now = Date.now()
    const due: PendingRetryRecord[] = []
    for (const record of this.pending.values()) {
      if (record.retryAt !== undefined && record.retryAt <= now) due.push(record)
    }
    if (due.length === 0) return
    // A deliberate user stop vetoes the fire. The check is async, so due
    // records are first parked out of `pending` and either re-added (run
    // still allowed) or discarded (stopped).
    const vetoed: PendingRetryRecord[] = []
    if (this.isStopped) {
      for (const record of due) {
        try {
          if (await this.isStopped(record.projectId, record.threadId)) vetoed.push(record)
        } catch {
          // Probe failed: keep the record rather than silently dropping work.
        }
      }
    }
    const runnable = due.filter((record) => !vetoed.includes(record))
    if (runnable.length === 0) {
      if (vetoed.length > 0) {
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
        void this.persist()
        if (this.pending.size === 0) this.refreshTimer()
        this.notifyChange()
      }
      return
    }
    for (const record of runnable) {
      // Fire each record exactly once; a re-reported error re-tracks it.
      if (this.pending.get(record.sessionId) === record) {
        this.pending.delete(record.sessionId)
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
      Logger.info('Auto-resume skipped   chat engine not attached', {
        sessionId: record.sessionId
      })
      return
    }
    Logger.info('Auto-resuming thread after usage reset', {
      projectId: record.projectId,
      threadId: record.threadId,
      harnessId: record.harnessId
    })
    try {
      await callback(record)
    } catch (error) {
      // Leave the thread in its error state; the user can still Retry manually.
      Logger.error('Auto-resume attempt failed', error)
    }
  }

  private notifyChange(): void {
    this.changeListener?.()
  }
}
