import { Logger } from './logger'
import type { StorageEngine } from './storage-engine'

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
}

/** How often the ticker checks whether any pending reset window has passed. */
const RETRY_TICK_MS = 15_000

/**
 * RetrySchedulerService — remembers every thread whose turn ended in a
 * quota/rate-limit reset with a reported `retryAt`, then automatically resumes
 * the thread once that time passes while the app is open. Only harnesses that
 * do not schedule their own provider retries are tracked; the chat engine
 * enforces that gate before handing records to this service (OpenCode manages
 * its own retries and is excluded).
 */
export class RetrySchedulerService {
  private readonly pending = new Map<string, PendingRetryRecord>()
  private timer: ReturnType<typeof setInterval> | null = null
  private enabled = false
  private continueThread: ((record: PendingRetryRecord) => Promise<void>) | null = null

  constructor(private storage: StorageEngine) {}

  /** Load the persisted preference and arm the ticker. */
  async start(): Promise<void> {
    const config = await this.storage.getConfig()
    this.enabled = config.autoRetryAfterReset === true
    this.refreshTimer()
  }

  /** Apply a config change without re-reading storage. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) this.pending.clear()
    this.refreshTimer()
  }

  /** The chat engine supplies the resume callback once registered. */
  attachContinue(callback: (record: PendingRetryRecord) => Promise<void>): void {
    this.continueThread = callback
  }

  /** Record (or refresh) a pending reset retry for a session. */
  track(record: PendingRetryRecord): void {
    if (!this.enabled) return
    this.pending.set(record.sessionId, record)
    Logger.info('Auto-resume scheduled after usage reset', {
      projectId: record.projectId,
      threadId: record.threadId,
      harnessId: record.harnessId,
      retryAt: new Date(record.retryAt).toISOString()
    })
    this.refreshTimer()
    // The reset may already have passed (e.g. the app was closed during the
    // wait and reopened after the window reset) — fire without waiting.
    this.tick()
  }

  /** Drop a session from the pending set once it resolves or retires. */
  clear(sessionId: string): void {
    if (this.pending.delete(sessionId) && this.pending.size === 0) this.refreshTimer()
  }

  /** Number of pending reset retries (tests/logging). */
  get size(): number {
    return this.pending.size
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  dispose(): void {
    this.stop()
    this.pending.clear()
    this.continueThread = null
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
    const now = Date.now()
    const due: PendingRetryRecord[] = []
    for (const record of this.pending.values()) {
      if (record.retryAt <= now) due.push(record)
    }
    for (const record of due) {
      // Fire each record exactly once; a re-reported error re-tracks it.
      if (this.pending.get(record.sessionId) === record) {
        this.pending.delete(record.sessionId)
        void this.fire(record)
      }
    }
    if (this.pending.size === 0) this.refreshTimer()
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
}
