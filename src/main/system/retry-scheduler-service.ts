import { Logger } from './logger'
import type { StorageEngine } from '../storage/storage-engine'
import type { AgentProviderIssueKind } from '../../lib/types'

/** One thread awaiting automatic resume after a usage/rate-limit reset. */
export interface PendingRetryRecord {
  sessionId: string
  projectId: string
  threadId: string
  harnessId: string
  /** Epoch ms when the provider window resets and the thread may resume. */
  retryAt: number
  /** Provider-reported retry attempt when the reset was surfaced. */
  attempt?: number
  /** Provider-neutral failure kind — drives how the restored card renders. */
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

/** Config-relative file holding pending retries so they survive app restarts. */
const PERSISTENCE_FILE = 'retry-scheduler.json'

/**
 * RetrySchedulerService — remembers every thread whose turn ended in a
 * quota/rate-limit reset with a reported `retryAt`, then automatically resumes
 * the thread once that time passes while the app is open. Pending retries are
 * persisted so they survive app restarts, and the restored warning card proves
 * the resume is still scheduled. Only harnesses that do not schedule their own
 * provider retries are tracked; the chat engine enforces that gate before
 * handing records to this service (OpenCode manages its own retries). Listeners
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

  constructor(private storage: StorageEngine) {}

  /** Load the persisted preference and pending retries, then arm the ticker. */
  async start(): Promise<void> {
    const config = await this.storage.getConfig()
    this.enabled = config.autoRetryAfterReset === true
    await this.loadPending()
    this.refreshTimer()
    // Resets that elapsed while the app was closed fire immediately on launch.
    this.tick()
  }

  /** Apply a config change without re-reading storage. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) {
      this.pending.clear()
      void this.persist()
    }
    this.refreshTimer()
    this.notifyChange()
  }

  /** The chat engine supplies the resume callback once registered. */
  attachContinue(callback: (record: PendingRetryRecord) => Promise<void>): void {
    this.continueThread = callback
  }

  /** Register a callback fired whenever the pending-retry set changes. */
  attachChangeListener(callback: () => void): void {
    this.changeListener = callback
  }

  /** True when any pending retry resets at or before `deadlineMs`. */
  hasPendingRetryBefore(deadlineMs: number): boolean {
    for (const record of this.pending.values()) {
      if (record.retryAt <= deadlineMs) return true
    }
    return false
  }

  /** Record (or refresh) a pending reset retry for a session. */
  track(record: PendingRetryRecord): boolean {
    if (!this.enabled) return false
    this.pending.set(record.sessionId, record)
    void this.persist()
    Logger.info('Auto-resume scheduled after usage reset', {
      projectId: record.projectId,
      threadId: record.threadId,
      harnessId: record.harnessId,
      retryAt: new Date(record.retryAt).toISOString()
    })
    this.refreshTimer()
    // The reset may already have passed — fire without waiting.
    this.tick()
    this.notifyChange()
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

  /** Whether automatic retry tracking is enabled in General settings. */
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
    if (!this.enabled) {
      // Feature is off — drop any leftovers from a previous enable.
      void this.persist()
      return
    }
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
      typeof retryAt !== 'number' ||
      !Number.isFinite(retryAt) ||
      typeof issueKind !== 'string' ||
      !ISSUE_KINDS.has(issueKind as AgentProviderIssueKind) ||
      typeof issueMessage !== 'string'
    ) {
      return null
    }
    return {
      sessionId,
      projectId,
      threadId,
      harnessId,
      retryAt,
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

  private refreshTimer(): void {
    const shouldRun = this.enabled && this.pending.size > 0
    if (shouldRun && this.timer === null) {
      this.timer = setInterval(() => this.tick(), RETRY_TICK_MS)
    } else if (!shouldRun && this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private tick(): void {
    if (!this.enabled) return
    const now = Date.now()
    const due: PendingRetryRecord[] = []
    for (const record of this.pending.values()) {
      if (record.retryAt <= now) due.push(record)
    }
    if (due.length === 0) return
    for (const record of due) {
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
      Logger.info('Auto-resume skipped — chat engine not attached', {
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
