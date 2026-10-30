import type { Database } from '../database'
import { ThreadRepo } from './thread-repo'
import type { Thread } from '../../../lib/types'

/** One dispatch accepted by a workstation-control turn, before it is settled. */
export interface OrchestrationDispatchInput {
  initiatorProjectId: string
  initiatorThreadId: string
  childProjectId: string
  childThreadId: string
  title: string
  ovenId: string
  ovenName: string
  harnessId: string
  providerId: string
  modelId: string
  thinkingLevel?: string
}

/**
 * The orchestrator board's ledger.
 *
 * A dispatch is written once, when the run is accepted, and never updated: the
 * run's title and status come from the child thread's own row on every read, so
 * the board cannot drift from the sidebar and cannot show a status it
 * remembered instead of the one the run actually has. Reads go through the
 * database worker because a board read is interaction-time work, and a large
 * database must never block the main thread to answer it.
 */
export class OrchestrationDispatchRepo {
  private readonly threads: ThreadRepo

  constructor(private db: Database) {
    this.threads = new ThreadRepo(db)
  }

  /** Remember a dispatch. Re-dispatching the same child thread replaces its row. */
  async record(input: OrchestrationDispatchInput): Promise<void> {
    await this.db.executeViaWorker(
      `INSERT INTO orchestration_dispatches(
         child_project_id, child_thread_id, initiator_project_id, initiator_thread_id,
         title, oven_id, oven_name, harness_id, provider_id, model_id, thinking_level, created_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(child_project_id, child_thread_id) DO UPDATE SET
         initiator_project_id = excluded.initiator_project_id,
         initiator_thread_id  = excluded.initiator_thread_id,
         title                = excluded.title,
         oven_id              = excluded.oven_id,
         oven_name            = excluded.oven_name,
         harness_id           = excluded.harness_id,
         provider_id          = excluded.provider_id,
         model_id             = excluded.model_id,
         thinking_level       = excluded.thinking_level,
         created_at           = excluded.created_at`,
      [
        input.childProjectId,
        input.childThreadId,
        input.initiatorProjectId,
        input.initiatorThreadId,
        input.title,
        input.ovenId,
        input.ovenName,
        input.harnessId,
        input.providerId,
        input.modelId,
        input.thinkingLevel ?? null,
        Date.now()
      ]
    )
  }

  /**
   * Every thread one thread dispatched, newest dispatch first.
   *
   * The child threads are read as whole `Thread` rows through the same repo the
   * sidebar uses, so a board row is a real thread row: the same title, status,
   * project, branch and activity stamp the Threads view renders, never a parallel
   * description of them. A dispatch whose thread was deleted or archived drops out
   * instead of pointing at nothing.
   */
  async listByInitiator(initiatorProjectId: string, initiatorThreadId: string): Promise<Thread[]> {
    const result = await this.db.queryViaWorker(
      `SELECT child_thread_id
         FROM orchestration_dispatches
        WHERE initiator_project_id = ? AND initiator_thread_id = ?
        ORDER BY created_at DESC`,
      [initiatorProjectId, initiatorThreadId],
      0
    )
    if (!result.ok || result.rows.length === 0) return []
    const ids = (result.rows as unknown as { child_thread_id: string }[]).map(
      (row) => row.child_thread_id
    )
    // The ledger orders the runs, so restore that order after the id lookup.
    const threads = await this.threads.listByIdsViaWorker(ids)
    const byId = new Map(threads.map((thread) => [thread.id, thread]))
    return ids.flatMap((id) => {
      const thread = byId.get(id)
      return thread ? [thread] : []
    })
  }
}
