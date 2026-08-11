import { powerSaveBlocker } from 'electron'
import type { Thread, ThreadStatus } from '../lib/types'
import { Logger } from './logger'
import { ThreadRepo } from './database/repositories/thread-repo'
import type { Database } from './database/database'
import type { StorageEngine } from './storage-engine'

/** Thread states that count as "work in progress". */
const ACTIVE_STATUSES = new Set<ThreadStatus>(['planning', 'executing'])

/**
 * PowerWakeService — prevents the system and display from sleeping while
 * work is in progress or while a live remote (phone) session is using the
 * desktop. The thread side is gated by the General settings toggle
 * ("Keep device on while work is in progress"); the remote side is always on
 * so a connected phone session never gets dropped by the display sleeping.
 */
export class PowerWakeService {
  /** Blocker that keeps the whole system (CPU) from sleeping. */
  private systemBlockerId: number | null = null
  /** Blocker that keeps the display from sleeping. */
  private displayBlockerId: number | null = null
  private enabled = false
  private remoteSessionActive = false

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
    this.refresh()
  }

  /** Re-evaluate after any thread status/state change. */
  onThreadUpdate(_thread: Thread): void {
    if (this.enabled) this.refresh()
  }

  /** Keep the display awake while a remote phone session is live. */
  setRemoteSessionActive(active: boolean): void {
    this.remoteSessionActive = active
    this.refresh()
  }

  /** Release the blocker on shutdown. */
  stop(): void {
    this.release()
  }

  private refresh(): void {
    const shouldBlock = this.remoteSessionActive || (this.enabled && this.hasActiveThread())
    if (shouldBlock && this.systemBlockerId === null) {
      // 'prevent-app-suspension' keeps the whole system awake (the CPU does not
      // go to sleep); 'prevent-display-sleep' separately keeps the screen on.
      // Using only the display blocker lets the system sleep timer still fire,
      // which is exactly the bug this fix addresses.
      this.systemBlockerId = powerSaveBlocker.start('prevent-app-suspension')
      this.displayBlockerId = powerSaveBlocker.start('prevent-display-sleep')
      Logger.info('Power wake: preventing system + display sleep')
    } else if (!shouldBlock && this.systemBlockerId !== null) {
      this.release()
    }
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
    if (this.systemBlockerId !== null) {
      powerSaveBlocker.stop(this.systemBlockerId)
      this.systemBlockerId = null
    }
    if (this.displayBlockerId !== null) {
      powerSaveBlocker.stop(this.displayBlockerId)
      this.displayBlockerId = null
    }
    Logger.info('Power wake: system + display sleep re-enabled')
  }
}
