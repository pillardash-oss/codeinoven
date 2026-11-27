import type { Thread, ThreadAnnounceOptions, ThreadSettings, ThreadStatus } from '../types'
import { scopeSliceForStatus, threadTracksReadStatus } from '../types'
import {
  canUpdateThreadStatus,
  threadSettledOutcome,
  type ThreadSettledOutcome
} from '../thread-status-policy'
import { Logger } from '../../main/system/logger'
import type { ThreadRepo } from '../../main/database/repositories/thread-repo'

/**
 * Owns every status transition of a thread row: the settled outcome of a run,
 * the parked reason a checkout could not be used, the spec-review dismissal, the
 * audit state, and the deliberate user stop latch that keeps an automatic resume
 * from reviving a thread the user ended.
 *
 * These transitions share one rule: each folds the previous row with the
 * columns its own transition owns, persists it, and announces it, so the
 * renderer and the coordinator that owns the row both re-read the truth instead
 * of inferring the change from the event that caused it.
 */
export class ThreadStatusService {
  /**
   * @param requireOwned Ownership guard for the row a transition names.
   * @param announce Announces the persisted row, and its coordinator when the
   * row was delegated work.
   * @param getThread Project-scoped read used by the stop latch, which has to
   * leave a thread it cannot read untouched instead of throwing.
   * @param onChange Direct report for the latch writes, which persist a whole
   * row without a transition.
   */
  constructor(
    private readonly threadRepo: ThreadRepo,
    private readonly requireOwned: (projectId: string, threadId: string) => Thread,
    private readonly announce: (thread: Thread, options?: ThreadAnnounceOptions) => Promise<void>,
    private readonly getThread: (projectId: string, threadId: string) => Promise<Thread | null>,
    private readonly onChange: (thread: Thread) => void
  ) {}

  /**
   * Park a run on a typed reason until the user repairs its scope.
   *
   * The status is `working-paused` rather than `failed`, because nothing went
   * wrong with the work: the checkout it needs is not usable yet, and the
   * repair action is the user's next step. The reason is stored whole so the
   * row and the receipt can name the category and repeat the app's own guidance
   * after a restart.
   */
  async parkThread(
    projectId: string,
    threadId: string,
    reason: NonNullable<Thread['parkReason']>
  ): Promise<Thread> {
    const existing = this.requireOwned(projectId, threadId)
    const now = Date.now()
    const updated: Thread = {
      ...existing,
      status: 'working-paused',
      lastOutcome: 'parked',
      parkReason: reason,
      lastError: reason.message,
      lastErrorAt: now,
      updatedAt: now,
      lastActivity: now,
      sortOrder: undefined,
      scopeSortOrder: undefined
    }
    await this.threadRepo.upsertViaWorker(updated)
    await this.announce(updated)
    return updated
  }

  async setStatus(
    projectId: string,
    threadId: string,
    status: ThreadStatus,
    opts?: {
      read?: boolean
      error?: string
      errorDetail?: string
      /** False when this settle repeats a completion already announced. */
      notify?: boolean
      /**
       * False for a transition that only finishes a row the user already knows
       * ended, so it must not pull anything back to the top of a list. Every
       * ordinary settle is news and stamps `last_activity` with it; a bookkeeping
       * write (a child closed out under a coordinator that settled long ago) keeps
       * the activity it had, because the coordinator's own `last_activity` is
       * raised from its children's (see the `threads_coordinator_activity`
       * trigger) and a sweep must not resurface a finished orchestration.
       */
      touchActivity?: boolean
    }
  ): Promise<Thread> {
    const existing = this.requireOwned(projectId, threadId)

    const now = Date.now()

    // Carry the failure's diagnostic text on the thread row so downstream
    // consumers (error notifications, the notification panel, and the next
    // launch after an unattended run) can show what actually went wrong. It is
    // persisted through `threadUpsertParams` and cleared the moment the thread
    // leaves `failed`.
    const lastError =
      status === 'failed'
        ? (() => {
            const detail = opts?.errorDetail?.trim()
            const message =
              opts?.error?.trim() ||
              existing.lastError ||
              (detail ? detail.split('\n', 1)[0]?.trim() || undefined : undefined)
            if (!message) return undefined
            return detail && detail !== message ? `${message}\n\n${detail}` : message
          })()
        : undefined

    // The outcome of the most recent settled run. A status that is not itself a
    // settle point (planning/executing/interrupted) leaves the previous outcome
    // in place, so resuming a failed run does not erase the fact that it failed.
    const lastOutcome: Thread['lastOutcome'] =
      status === 'failed'
        ? 'failed'
        : status === 'completed'
          ? 'completed'
          : status === 'awaiting_approval'
            ? 'parked'
            : existing.lastOutcome

    // A resumed run is no longer parked: the reason belongs to the attempt that
    // refused to start, so a turn that does start clears it.
    const clearedPark =
      existing.parkReason !== undefined &&
      (status === 'executing' || status === 'completed' || status === 'failed')

    const updated: Thread = {
      ...existing,
      status,
      ...(clearedPark ? { parkReason: undefined } : {}),
      scopeSortOrder:
        scopeSliceForStatus(existing.status) === scopeSliceForStatus(status)
          ? existing.scopeSortOrder
          : undefined,
      read: opts?.read ?? existing.read,
      lastError,
      lastErrorAt: status === 'failed' ? now : undefined,
      lastOutcome,
      updatedAt: now,
      lastActivity: opts?.touchActivity === false ? existing.lastActivity : now,
      sortOrder: undefined
    }

    await this.threadRepo.upsertViaWorker(updated)
    await this.announce(updated, { notify: opts?.notify })
    return updated
  }

  /**
   * Rewrite a settled thread's outcome at the user's request (the thread menu's
   * "Update status" submenu).
   *
   * The user is the authority here, so the write is a plain settle: `unread` is a
   * finished run nobody has opened (the one state `canMarkThreadUnread` reserves
   * for `completed`), `done` is the same run acknowledged, and `error` is the
   * needs-attention row. Nothing is announced as a completion or a failure: the
   * user just acted on the row they are looking at, so an OS notification about
   * their own click would be noise.
   *
   * A row that is still being driven (working, parked, retrying, spec) has no
   * outcome to rewrite and is refused rather than silently ignored, so a caller
   * that skipped the menu gate cannot park live work behind a `failed` badge.
   * A rewrite that lands on the state the row already reads as is a no-op and
   * keeps the row's activity where it was.
   *
   * `unread` is additionally refused for a row that never presents a read state
   * (an orchestration child   a pawn, a reporting worker, an auditor): the unread
   * rule is unchanged, so writing it there would claim a dot no surface draws.
   * Such a row still accepts `done` and `error`, which is why the delegation
   * board's pawn rows get the submenu at all.
   */
  async setSettledOutcome(
    projectId: string,
    threadId: string,
    outcome: ThreadSettledOutcome
  ): Promise<Thread> {
    const existing = this.requireOwned(projectId, threadId)
    if (!canUpdateThreadStatus(existing.status)) {
      throw new Error(
        `Thread ${threadId} cannot be marked ${outcome} while it is ${existing.status}`
      )
    }
    if (outcome === 'unread' && !threadTracksReadStatus(existing)) {
      throw new Error(`Thread ${threadId} never presents an unread state`)
    }
    if (threadSettledOutcome(existing) === outcome) return existing

    if (outcome === 'error') {
      return this.setStatus(projectId, threadId, 'failed', { read: true, notify: false })
    }
    return this.setStatus(projectId, threadId, 'completed', {
      read: outcome === 'done',
      notify: false
    })
  }

  async dismissSpecReview(
    projectId: string,
    threadId: string,
    specId: string,
    specVersion: number
  ): Promise<Thread> {
    const existing = this.requireOwned(projectId, threadId)

    const now = Date.now()
    const updated: Thread = {
      ...existing,
      status: 'completed',
      scopeSortOrder:
        scopeSliceForStatus(existing.status) === 'done' ? existing.scopeSortOrder : undefined,
      read: true,
      dismissedSpecId: specId,
      dismissedSpecVersion: specVersion,
      updatedAt: now,
      lastActivity: now,
      sortOrder: undefined
    }

    await this.threadRepo.upsertViaWorker(updated)
    await this.announce(updated)
    return updated
  }

  async setAuditState(
    projectId: string,
    threadId: string,
    auditState: Thread['auditState'],
    report?: { id: string; version: number }
  ): Promise<Thread> {
    const existing = this.requireOwned(projectId, threadId)
    const now = Date.now()
    const updated: Thread = {
      ...existing,
      auditState,
      ...(report
        ? { activeAuditId: report.id, activeAuditVersion: report.version }
        : auditState === undefined
          ? { activeAuditId: undefined, activeAuditVersion: undefined }
          : {}),
      updatedAt: now,
      lastActivity: now,
      sortOrder: undefined
    }
    await this.threadRepo.upsertViaWorker(updated)
    await this.announce(updated)
    return updated
  }

  /**
   * Latch a deliberate user stop so no automatic resume may revive this
   * thread. The flag lives inside the persisted settings, so it survives app
   * restarts, forks, and the settings round-trips of `updateThread`.
   */
  async markStoppedByUser(projectId: string, threadId: string): Promise<void> {
    try {
      const existing = await this.getThread(projectId, threadId)
      if (!existing?.settings) return
      const settings: ThreadSettings = {
        ...existing.settings,
        stoppedByUserAt: Date.now()
      }
      await this.threadRepo.upsertViaWorker({ ...existing, settings })
      this.onChange({ ...existing, settings })
    } catch (error) {
      Logger.error('Stop latch could not be persisted', {
        projectId,
        threadId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  async wasStoppedByUser(projectId: string, threadId: string): Promise<boolean> {
    const thread = await this.getThread(projectId, threadId)
    return thread?.settings?.stoppedByUserAt !== undefined
  }

  async clearStoppedByUser(projectId: string, threadId: string): Promise<void> {
    try {
      const existing = await this.getThread(projectId, threadId)
      if (!existing || existing.settings?.stoppedByUserAt === undefined) return
      const { stoppedByUserAt: _cleared, ...settings } = existing.settings
      const updated: Thread = { ...existing, settings, updatedAt: Date.now() }
      await this.threadRepo.upsertViaWorker(updated)
      this.onChange(updated)
    } catch (error) {
      Logger.error('Stop latch could not be cleared', {
        projectId,
        threadId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
}
