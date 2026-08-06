import { powerSaveBlocker } from 'electron'
import type { Thread, ThreadStatus } from '../lib/types'
import { Logger } from './logger'
import { ThreadRepo } from './database/repositories/thread-repo'
import type { Database } from './database/database'
import type { StorageEngine } from './storage-engine'

/** Thread states that count as "work in progress". */
const ACTIVE_STATUSES = new Set<ThreadStatus>(['planning', 'executing'])

/**
 * PowerWakeService — prevents the display (and system) from sleeping while any
 * agent thread is actively working. Enabled through the General settings toggle
 * ("Keep device on while work is in progress"); off by default.
 */
export class PowerWakeService {
  private blockerId: number | null = null
  private enabled = false

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

  /** Release the blocker on shutdown. */
  stop(): void {
    this.release()
  }

  private refresh(): void {
    if (!this.enabled) {
      this.release()
      return
    }
    if (!this.database.isOpen()) {
      this.release()
      return
    }
    let hasActive: boolean
    try {
      hasActive = new ThreadRepo(this.database)
        .listAll()
        .some((thread) => !thread.archived && ACTIVE_STATUSES.has(thread.status))
    } catch (error) {
      Logger.error('Power wake: could not query active threads', error)
      return
    }
    if (hasActive && this.blockerId === null) {
      this.blockerId = powerSaveBlocker.start('prevent-display-sleep')
      Logger.info('Power wake: preventing display sleep while work is in progress')
    } else if (!hasActive && this.blockerId !== null) {
      this.release()
    }
  }

  private release(): void {
    if (this.blockerId === null) return
    powerSaveBlocker.stop(this.blockerId)
    this.blockerId = null
    Logger.info('Power wake: display sleep re-enabled')
  }
}
