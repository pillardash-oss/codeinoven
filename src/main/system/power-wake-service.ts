import { powerSaveBlocker } from 'electron'
import type { Thread, ThreadStatus } from '../../lib/types'
import { Logger } from './logger'
import { ThreadRepo } from '../database/repositories/thread-repo'
import type { Database } from '../database/database'
import type { StorageEngine } from '../storage/storage-engine'
import type { RetrySchedulerService } from './retry-scheduler-service'

/**
 * Thread states that count as "work in progress". `spec` is intentionally
 * absent: a review-ready artifact has finished its agent work and can wait for
 * the user indefinitely without keeping the device awake.
 */
const ACTIVE_STATUSES = new Set<ThreadStatus>(['planning', 'executing'])

/**
 * Coordinated work can briefly have no active persisted thread while control
 * passes from one action to the next. Require a stable idle snapshot before
 * releasing the wake blockers so those handoffs do not let the device sleep.
 */
const IDLE_RELEASE_DELAY_MS = 5_000

/**
 * Upper bound for an unattended scheduled auto-retry wait that justifies
 * keeping the device awake: waits under six hours are worth powering through so
 * the reset fires on time; longer waits fall back to normal sleep behavior.
 */
const SCHEDULED_RETRY_WAKE_WINDOW_MS = 6 * 60 * 60 * 1_000

/**
 * PowerWakeService — prevents the system and display from sleeping while
 * work is in progress, while a scheduled auto-retry (usage/rate-limit reset) is
 * due within six hours, or while a live remote (phone) session is using the
 * desktop. The thread and retry sides are gated by the General settings toggle
 * ("Keep device on while work is in progress"); the remote side is always on
 * so a connected phone session never gets dropped by the display sleeping.
 */
export class PowerWakeService {
  /** Blocker that keeps the whole system (CPU) from sleeping. */
  private systemBlockerId: number | null = null
  /** Blocker that keeps the display from sleeping. */
  private displayBlockerId: number | null = null
  private releaseTimer: ReturnType<typeof setTimeout> | null = null
  private enabled = false
  private remoteSessionActive = false
  private retryScheduler: RetrySchedulerService | null = null

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

  /** Let the service consider scheduled auto-retries when keeping the device awake. */
  attachRetryScheduler(scheduler: RetrySchedulerService): void {
    this.retryScheduler = scheduler
  }

  /** Keep the display awake while a remote phone session is live. */
  setRemoteSessionActive(active: boolean): void {
    this.remoteSessionActive = active
    this.refresh()
  }

  /** Release the blocker on shutdown. */
  stop(): void {
    this.cancelScheduledRelease()
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
      this.remoteSessionActive ||
      (this.enabled && (this.hasActiveThread() || this.hasScheduledRetry()))
    )
  }

  /**
   * True when a pending auto-resume will fire within the keep-awake window —
   * the app can retry it unattended, so the device must not sleep through it.
   */
  private hasScheduledRetry(): boolean {
    return (
      this.retryScheduler?.hasPendingRetryBefore(Date.now() + SCHEDULED_RETRY_WAKE_WINDOW_MS) ??
      false
    )
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
      return new ThreadRepo(this.database)
        .listAll()
        .some((thread) => !thread.archived && ACTIVE_STATUSES.has(thread.status))
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
