import type { Database } from '../database'
import { ThreadRepo } from './thread-repo'
import type { OrchestrationDispatch } from '../../../lib/types'

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

/** The dispatch row, before the child thread is resolved for it. */
interface DispatchRow {
  child_project_id: string
  child_thread_id: string
  oven_id: string
  oven_name: string
  harness_id: string
  provider_id: string
  model_id: string
  thinking_level: string | null
  created_at: number
  project_name: string
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
   * Every dispatch one thread started, newest first.
   *
   * The child threads are read as whole `Thread` rows through the same repo the
   * sidebar uses, so a board row is a real thread row: the same title, status,
   * branch and activity stamp the Threads view renders, never a parallel
   * description of them. A dispatch whose thread was deleted or archived drops
   * out instead of pointing at nothing.
   */
  async listByInitiator(
    initiatorProjectId: string,
    initiatorThreadId: string
  ): Promise<OrchestrationDispatch[]> {
    const result = await this.db.queryViaWorker(
      `SELECT d.child_project_id, d.child_thread_id, d.oven_id, d.oven_name,
              d.harness_id, d.provider_id, d.model_id, d.thinking_level, d.created_at,
              p.name AS project_name
         FROM orchestration_dispatches d
         JOIN projects p ON p.id = d.child_project_id
        WHERE d.initiator_project_id = ? AND d.initiator_thread_id = ?
        ORDER BY d.created_at DESC`,
      [initiatorProjectId, initiatorThreadId],
      0
    )
    if (!result.ok || result.rows.length === 0) return []
    const dispatches = result.rows as unknown as DispatchRow[]
    const threads = await this.threads.listByIdsViaWorker(
      dispatches.map((row) => row.child_thread_id)
    )
    const byId = new Map(threads.map((thread) => [thread.id, thread]))
    return dispatches.flatMap((row) => {
      const thread = byId.get(row.child_thread_id)
      if (!thread) return []
      return [
        {
          thread,
          projectName: row.project_name,
          ovenId: row.oven_id,
          ovenName: row.oven_name,
          harnessId: row.harness_id,
          providerId: row.provider_id,
          modelId: row.model_id,
          ...(row.thinking_level ? { thinkingLevel: row.thinking_level } : {}),
          createdAt: row.created_at
        }
      ]
    })
  }
}
