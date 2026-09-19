/**
 * Which threads are running in *another* CodeInOven instance.
 *
 * Two instances share one config root, so they share the thread table and its
 * `active_turns` ledger, while each process owns only its own harness processes
 * and event stream. A window in instance B therefore sees a thread that instance
 * A is running as an ordinary persisted `planning`/`executing` row: it hydrates
 * from the shared database, receives none of A's stream, and can only render a
 * working spinner with no live output. This service is what lets that window say
 * so instead.
 *
 * Ownership is not re-derived here. `active_turns.owner_pid` already records the
 * process running each in-flight turn (the same fact restart recovery uses to
 * tell an orphan from a sibling's live work), so this service only projects it
 * for the instances it can prove are still alive. A window is told, and nothing
 * is inferred from status, output, or timing.
 *
 * Notification is deliberately cheap and infrequent: a sibling announces turn
 * activity when the work it is running actually changes, and this service
 * coalesces bursts before re-reading the ledger. Nothing here polls, and the
 * ledger read is one bounded query over a table that holds at most a handful of
 * in-flight turns.
 */

import { BrowserWindow } from 'electron'
import type { ForeignRunNotice } from '../../lib/types'
import type { Database } from '../database/database'
import { trustedIpcMain } from '../ipc/trusted-ipc-main'
import { sendToRenderer } from '../ipc/renderer-delivery'
import { instanceRegistry } from '../system/instance-registry'
import { Logger } from '../system/logger'

/** Coalesce the burst of registry writes one turn boundary produces. */
const REFRESH_DEBOUNCE_MS = 200
/** Hard cap on the ledger read, so a pathological table can never grow a notice. */
const MAX_ACTIVE_TURN_ROWS = 10_000

/**
 * Liveness probes, injectable so the notice rule can be exercised without a
 * second real app process. Defaults to the instance registry.
 */
export interface ForeignRunServiceOptions {
  /** Whether another CodeInOven process is registered and alive. */
  hasLiveSibling?: () => boolean
  /** Whether the process that recorded a turn is still running. */
  isRunOwnerAlive?: (pid: number) => boolean
}

export class ForeignRunService {
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private stopListeners: Array<() => void> = []
  private refreshing = false
  private refreshAgain = false
  private started = false
  private readonly hasLiveSibling: () => boolean
  private readonly isRunOwnerAlive: (pid: number) => boolean
  /** Last published set, so an unchanged snapshot never reaches a renderer. */
  private signature = ''

  constructor(
    private readonly db: Database,
    options: ForeignRunServiceOptions = {}
  ) {
    this.hasLiveSibling = options.hasLiveSibling ?? (() => instanceRegistry.hasOtherLiveInstance())
    this.isRunOwnerAlive =
      options.isRunOwnerAlive ?? ((pid) => instanceRegistry.isRunOwnerAlive(pid))
  }

  /**
   * Serve the current set on demand.
   *
   * A window that mounts after the last change hydrates from here instead of
   * waiting for the next push; register before `app:featuresReady` so the first
   * renderer request cannot race the handler.
   */
  registerIpc(): void {
    trustedIpcMain.handle('thread:listForeignRuns', () => this.listForeignRuns())
  }

  /**
   * Start reacting to turn-activity announcements.
   *
   * Local announcements arrive the moment this process starts or finishes a turn
   * (its own snapshot can change then, because a turn it starts takes the ledger
   * row over from a sibling); a sibling's announcement arrives as a registry
   * write through the watcher the registry already runs.
   */
  start(): void {
    if (this.started) return
    this.started = true
    this.stopListeners = [
      instanceRegistry.onTurnActivityChanged(() => this.scheduleRefresh()),
      instanceRegistry.onLiveInstancesChanged(() => this.scheduleRefresh())
    ]
    this.scheduleRefresh()
  }

  /** Stop reacting and drop the hydration handler. */
  dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = null
    }
    for (const stop of this.stopListeners) stop()
    this.stopListeners = []
    this.started = false
    trustedIpcMain.removeHandler('thread:listForeignRuns')
  }

  /**
   * Threads a live sibling is running right now.
   *
   * An instance that can see no other live instance owns every in-flight turn,
   * which is the single-instance case: no query, no notice.
   */
  async listForeignRuns(): Promise<ForeignRunNotice[]> {
    if (!this.hasLiveSibling()) return []
    const result = await this.db.queryViaWorker(
      'SELECT project_id, thread_id, owner_pid FROM active_turns',
      [],
      MAX_ACTIVE_TURN_ROWS
    )
    if (!result.ok) throw new Error(result.error ?? 'turn ownership query failed')

    const notices: ForeignRunNotice[] = []
    const seen = new Set<string>()
    for (const row of result.rows) {
      const ownerPid = Number(row['owner_pid'])
      if (!Number.isInteger(ownerPid) || ownerPid <= 0) continue
      if (ownerPid === process.pid) continue
      // A row whose owner is gone is an orphan the recovery pass will settle,
      // not work running somewhere else. Claiming otherwise would label a
      // thread as running in another instance with nothing running it at all.
      if (!this.isRunOwnerAlive(ownerPid)) continue
      const projectId = String(row['project_id'])
      const threadId = String(row['thread_id'])
      const key = `${projectId}:${threadId}`
      if (seen.has(key)) continue
      seen.add(key)
      notices.push({ projectId, threadId })
    }
    notices.sort(
      (left, right) =>
        left.projectId.localeCompare(right.projectId) || left.threadId.localeCompare(right.threadId)
    )
    return notices
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) return
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      void this.refresh()
    }, REFRESH_DEBOUNCE_MS)
    this.refreshTimer.unref?.()
  }

  /** Recompute and push, serialized so an older read can never win a race. */
  private async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true
      return
    }
    this.refreshing = true
    try {
      do {
        this.refreshAgain = false
        this.publish(await this.listForeignRuns())
      } while (this.refreshAgain)
    } catch (error) {
      // Advisory only: a renderer keeps the last snapshot it was given, and the
      // next announcement retries.
      Logger.error('Foreign run notice refresh failed (non-fatal):', error)
    } finally {
      this.refreshing = false
    }
  }

  private publish(notices: ForeignRunNotice[]): void {
    const signature = notices.map((notice) => `${notice.projectId}:${notice.threadId}`).join('|')
    if (signature === this.signature) return
    this.signature = signature
    for (const win of BrowserWindow.getAllWindows()) {
      sendToRenderer(win.webContents, 'thread:foreignRuns', notices)
    }
  }
}
