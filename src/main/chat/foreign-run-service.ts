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
 *
 * A thread that *leaves* the notice set is the one moment this instance is
 * provably holding a stale row for it. Its window hydrated that row from the
 * shared database while the sibling was running the turn, and it never saw the
 * status the sibling persisted when the turn ended, so the row would keep
 * claiming work in progress for good. The notice is not the whole truth then:
 * the departed rows are re-read from that same shared database and pushed, so
 * the row stops reading as work nobody is doing.
 */

import { BrowserWindow } from 'electron'
import type { ForeignRunNotice, Thread } from '../../lib/types'
import type { Database } from '../database/database'
import { ThreadRepo } from '../database/repositories/thread-repo'
import { trustedIpcMain } from '../ipc/trusted-ipc-main'
import { sendToRenderer } from '../ipc/renderer-delivery'
import { instanceRegistry } from '../system/instance-registry'
import { Logger } from '../system/logger'
import { broadcastCrossInstanceThreadUpdate } from './thread-events'

/** Coalesce the burst of registry writes one turn boundary produces. */
const REFRESH_DEBOUNCE_MS = 200
/** Hard cap on the ledger read, so a pathological table can never grow a notice. */
const MAX_ACTIVE_TURN_ROWS = 10_000

/**
 * Whether a joined `active_turns` row names a thread that belongs to a
 * coordinated workflow (its Sr. Engineer, a worker, or an auditor).
 */
function isWorkflowRow(row: Record<string, unknown>): boolean {
  return (
    row['assignment_role'] === 'coordinator' ||
    row['achievement_role'] === 'coordinator' ||
    row['coordinator_thread_id'] != null
  )
}

export interface ForeignRunServiceOptions {
  /** Whether another CodeInOven process is registered and alive. */
  hasLiveSibling?: () => boolean
  /** Whether the process that recorded a turn is still running. */
  isRunOwnerAlive?: (pid: number) => boolean
  /** Persisted rows for thread ids, read off the main thread. */
  readThreads?: (ids: readonly string[]) => Promise<Thread[]>
  /** Hand one corrected row to this instance's renderers. */
  publishThread?: (thread: Thread) => void
}

export class ForeignRunService {
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private stopListeners: Array<() => void> = []
  private refreshing = false
  private refreshAgain = false
  private started = false
  private readonly hasLiveSibling: () => boolean
  private readonly isRunOwnerAlive: (pid: number) => boolean
  private readonly readThreads: (ids: readonly string[]) => Promise<Thread[]>
  private readonly publishThread: (thread: Thread) => void
  /** Last published set, so an unchanged snapshot never reaches a renderer. */
  private signature = ''
  /**
   * Threads the last published snapshot named, keyed `projectId:threadId`. Kept
   * as the pair rather than the key alone because the rows of the threads that
   * leave this set have to be re-read by id.
   */
  private published = new Map<string, { projectId: string; threadId: string }>()

  constructor(
    private readonly db: Database,
    options: ForeignRunServiceOptions = {}
  ) {
    this.hasLiveSibling = options.hasLiveSibling ?? (() => instanceRegistry.hasOtherLiveInstance())
    this.isRunOwnerAlive =
      options.isRunOwnerAlive ?? ((pid) => instanceRegistry.isRunOwnerAlive(pid))
    this.readThreads =
      options.readThreads ?? ((ids) => new ThreadRepo(this.db).listByIdsViaWorker(ids))
    this.publishThread = options.publishThread ?? broadcastCrossInstanceThreadUpdate
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
    // The thread join is only there to say whether a notice is part of a
    // coordinated workflow, which the transfer card needs in order to state that
    // the whole group moves.
    const result = await this.db.queryViaWorker(
      `SELECT at.project_id, at.thread_id, at.owner_pid,
              t.coordinator_thread_id AS coordinator_thread_id,
              t.assignment_role AS assignment_role,
              t.achievement_role AS achievement_role
       FROM active_turns AS at
       LEFT JOIN threads AS t ON t.id = at.thread_id`,
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
      notices.push({ projectId, threadId, workflow: isWorkflowRow(row) })
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
        await this.publish(await this.listForeignRuns())
      } while (this.refreshAgain)
    } catch (error) {
      // Advisory only: a renderer keeps the last snapshot it was given, and the
      // next announcement retries.
      Logger.error('Foreign run notice refresh failed (non-fatal):', error)
    } finally {
      this.refreshing = false
    }
  }

  private async publish(notices: ForeignRunNotice[]): Promise<void> {
    const keys = new Set(notices.map((notice) => `${notice.projectId}:${notice.threadId}`))
    const departed = [...this.published.values()].filter(
      (thread) => !keys.has(`${thread.projectId}:${thread.threadId}`)
    )
    this.published = new Map(
      notices.map((notice) => [`${notice.projectId}:${notice.threadId}`, notice])
    )
    const signature = notices
      .map((notice) => `${notice.projectId}:${notice.threadId}:${notice.workflow ? 'w' : '-'}`)
      .join('|')
    if (signature !== this.signature) {
      this.signature = signature
      for (const win of BrowserWindow.getAllWindows()) {
        sendToRenderer(win.webContents, 'thread:foreignRuns', notices)
      }
    }
    if (departed.length > 0) await this.pushSettledThreads(departed)
  }

  /**
   * Re-read the rows of threads that just stopped being foreign, and push them.
   *
   * A row is read after the sibling released its turn, so the terminal status the
   * sibling persisted is already there. The read rides the database worker (a
   * main-thread read of the shared table is never allowed), and a failure is
   * advisory: the next announcement re-reads the same rows.
   */
  private async pushSettledThreads(
    departed: readonly { projectId: string; threadId: string }[]
  ): Promise<void> {
    try {
      const threads = await this.readThreads(departed.map((thread) => thread.threadId))
      for (const thread of threads) {
        this.publishThread(thread)
      }
    } catch (error) {
      Logger.error('Foreign run settlement refresh failed (non-fatal):', error)
    }
  }
}
