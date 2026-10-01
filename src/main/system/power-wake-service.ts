import { powerSaveBlocker } from 'electron'
import type { Thread } from '../../lib/types'
import { SCHEDULED_RETRY_WAKE_WINDOW_MS } from '../../lib/provider-issue'
import { Logger } from './logger'
import { instanceRegistry } from './instance-registry'
import { ThreadRepo } from '../database/repositories/thread-repo'
import type { Database } from '../database/database'
import type { StorageEngine } from '../storage/storage-engine'
import type { RetrySchedulerService } from './retry-scheduler-service'

/**
 * Coordinated work can briefly have no active persisted thread while control
 * passes from one action to the next. Require a stable idle snapshot before
 * releasing the wake blockers so those handoffs do not let the device sleep.
 */
const IDLE_RELEASE_DELAY_MS = 5_000

/**
 * PowerWakeService   prevents the system and display from sleeping while
 * work is in progress or a scheduled auto-retry (usage/rate-limit reset) is due
 * within the shared wake window. The window itself lives in `provider-issue.ts`
 * so the renderer's working-activity badge classifies the same threshold.
 */
export class PowerWakeService {
  /** Blocker that keeps the whole system (CPU) from sleeping. */
  private systemBlockerId: number | null = null
  /** Blocker that keeps the display from sleeping. */
  private displayBlockerId: number | null = null
  private releaseTimer: ReturnType<typeof setTimeout> | null = null
  private enabled = false
  private retryScheduler: RetrySchedulerService | null = null
  private readonly retryWakeWindows = new Map<string, number>()
  /** Reads the next due scheduled assistant run, or null when none is set. */
  private scheduledRunSource: (() => number | null) | null = null
  /** Background-mode wake policy; off keeps the scheduled-run input inert. */
  private backgroundEnabled = false
  private wakeLeadMs = 0
  private maxHoldMs = 0
  /** When the machine started being held awake for an upcoming scheduled run. */
  private scheduledHoldStartedAt: number | null = null
  private backgroundTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private storage: StorageEngine,
    private database: Database
  ) {}

  /** Load the persisted preference and reconcile the power-save blocker. */
  async start(): Promise<void> {
    const config = await this.storage.getConfig()
    this.enabled = config.keepAwakeWhileWorking === true
    this.refresh()
  }

  /** Apply a config change without re-reading storage. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    this.refresh(!enabled)
  }

  /** Re-evaluate after any thread status/state change. */
  onThreadUpdate(_thread: Thread): void {
    if (this.enabled) this.refresh()
  }

  /** Re-evaluate after the pending auto-retry set changes (track/clear/fire). */
  onRetryScheduleChanged(): void {
    if (this.enabled) this.refresh()
  }

  /** Track a provider-owned retry window without taking ownership of resume. */
  onRetryWindowChanged(sessionId: string, retryAt: number | null): void {
    if (retryAt === null || !Number.isFinite(retryAt)) {
      this.retryWakeWindows.delete(sessionId)
    } else {
      this.retryWakeWindows.set(sessionId, retryAt)
    }
    if (this.enabled) this.refresh()
  }

  /** Let the service consider scheduled auto-retries when keeping the device awake. */
  attachRetryScheduler(scheduler: RetrySchedulerService): void {
    this.retryScheduler = scheduler
  }

  /** The next due scheduled assistant run, read lazily on each evaluation. */
  attachScheduledRunSource(source: (() => number | null) | null): void {
    this.scheduledRunSource = source
    this.onScheduledRunChanged()
  }

  /**
   * Apply the background-mode wake policy. When background mode is on, the
   * machine is held awake inside the lead window before a due run, capped by
   * `maxHoldMs` so a mis-scheduled task can never pin the machine indefinitely.
   */
  setBackgroundPolicy(policy: { enabled: boolean; wakeLeadMs: number; maxHoldMs: number }): void {
    this.backgroundEnabled = policy.enabled
    this.wakeLeadMs = Math.max(0, policy.wakeLeadMs)
    this.maxHoldMs = Math.max(0, policy.maxHoldMs)
    if (this.backgroundEnabled && this.backgroundTimer === null) {
      // Re-evaluate on a slow tick so the hold arms when the lead window opens
      // even when no thread or retry event happens to fire at that moment.
      this.backgroundTimer = setInterval(() => this.onScheduledRunChanged(), 30_000)
      this.backgroundTimer.unref?.()
    } else if (!this.backgroundEnabled && this.backgroundTimer !== null) {
      clearInterval(this.backgroundTimer)
      this.backgroundTimer = null
      this.scheduledHoldStartedAt = null
    }
    if (this.enabled) this.refresh()
  }

  /** Re-evaluate after the next scheduled run moved (fired, rescheduled, removed). */
  onScheduledRunChanged(): void {
    if (this.enabled) this.refresh()
  }

  /** Release the blocker on shutdown. */
  stop(): void {
    this.cancelScheduledRelease()
    this.retryWakeWindows.clear()
    if (this.backgroundTimer !== null) {
      clearInterval(this.backgroundTimer)
      this.backgroundTimer = null
    }
    this.scheduledHoldStartedAt = null
    this.release()
  }

  private refresh(releaseImmediately = false): void {
    if (this.shouldKeepAwake()) {
      this.cancelScheduledRelease()
      this.acquire()
      return
    }

    if (releaseImmediately) {
      this.cancelScheduledRelease()
      this.release()
      return
    }

    this.scheduleRelease()
  }

  private shouldKeepAwake(): boolean {
    return (
      this.enabled &&
      (this.hasActiveThread() || this.hasScheduledRetry() || this.isScheduledRunImminent())
    )
  }

  /**
   * True when a scheduled assistant run is due inside the background wake lead.
   * Owner-only, and bounded by `maxHoldMs` so an imminent-looking task cannot
   * keep the machine awake forever: past the cap the hold is dropped and the
   * slot is caught up on the next wake instead.
   */
  private isScheduledRunImminent(): boolean {
    if (!this.backgroundEnabled || !this.scheduledRunSource) return false
    if (!instanceRegistry.isIncumbentInstance()) return false
    let due: number | null
    try {
      due = this.scheduledRunSource()
    } catch (error) {
      Logger.error('Power wake: could not read the next scheduled run', error)
      return false
    }
    if (due === null) {
      this.scheduledHoldStartedAt = null
      return false
    }
    const now = Date.now()
    if (
      this.scheduledHoldStartedAt !== null &&
      now - this.scheduledHoldStartedAt > this.maxHoldMs
    ) {
      return false
    }
    if (due - now <= this.wakeLeadMs) {
      this.scheduledHoldStartedAt ??= now
      return true
    }
    // The run moved out of the lead window (or was rescheduled): stop counting
    // the current hold so the next approach gets a full cap.
    this.scheduledHoldStartedAt = null
    return false
  }

  /**
   * True when a pending auto-resume will fire within the keep-awake window  
   * the app can retry it unattended, so the device must not sleep through it.
   */
  private hasScheduledRetry(): boolean {
    const deadline = Date.now() + SCHEDULED_RETRY_WAKE_WINDOW_MS
    for (const [sessionId, retryAt] of this.retryWakeWindows) {
      if (retryAt <= Date.now() - IDLE_RELEASE_DELAY_MS) {
        this.retryWakeWindows.delete(sessionId)
        continue
      }
      if (retryAt <= deadline) return true
    }
    return this.retryScheduler?.hasPendingRetryBefore(deadline) ?? false
  }

  private acquire(): void {
    if (this.systemBlockerId === null) {
      // 'prevent-app-suspension' keeps the whole system awake (the CPU does not
      // go to sleep); 'prevent-display-sleep' separately keeps the screen on.
      // Using only the display blocker lets the system sleep timer still fire,
      // which is exactly the bug this fix addresses.
      this.systemBlockerId = powerSaveBlocker.start('prevent-app-suspension')
      this.displayBlockerId = powerSaveBlocker.start('prevent-display-sleep')
      Logger.info('Power wake: preventing system + display sleep')
    }
  }

  private scheduleRelease(): void {
    if (this.systemBlockerId === null || this.releaseTimer !== null) return

    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = null
      if (this.shouldKeepAwake()) return
      this.release()
    }, IDLE_RELEASE_DELAY_MS)
    this.releaseTimer.unref()
  }

  private cancelScheduledRelease(): void {
    if (this.releaseTimer === null) return
    clearTimeout(this.releaseTimer)
    this.releaseTimer = null
  }

  private hasActiveThread(): boolean {
    if (!this.database.isOpen()) return false
    try {
      return new ThreadRepo(this.database).hasActive()
    } catch (error) {
      Logger.error('Power wake: could not query active threads', error)
      return false
    }
  }

  private release(): void {
    const wasBlocking = this.systemBlockerId !== null || this.displayBlockerId !== null
    if (this.systemBlockerId !== null) {
      powerSaveBlocker.stop(this.systemBlockerId)
      this.systemBlockerId = null
    }
    if (this.displayBlockerId !== null) {
      powerSaveBlocker.stop(this.displayBlockerId)
      this.displayBlockerId = null
    }
    if (wasBlocking) Logger.info('Power wake: system + display sleep re-enabled')
  }
}
