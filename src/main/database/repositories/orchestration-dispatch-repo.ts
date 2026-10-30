import type { Database } from '../database'
import type { OrchestrationDispatch, ThreadStatus } from '../../../lib/types'

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

/** A joined dispatch row: the ledger row plus the child thread and project it points at. */
interface DispatchRow {
  child_project_id: string
  child_thread_id: string
  title: string
  status: string
  oven_id: string
  oven_name: string
  harness_id: string
  provider_id: string
  model_id: string
  thinking_level: string | null
  created_at: number
  updated_at: number
  project_name: string
}

/**
 * The orchestrator board's ledger.
 *
 * A dispatch is written once, when the run is accepted, and never updated: the
 * run's status and title come from the child thread's own row on every read, so
 * the board cannot drift from the sidebar. Reads go through the database worker
 * because a board read is interaction-time work, and a machine with a large
 * database must never block the main thread to answer it.
 */
export class OrchestrationDispatchRepo {
  constructor(private db: Database) {}

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
   * Every dispatch one thread started, newest first, with the child's live title
   * and status.
   *
   * The join is what keeps the board honest: a run that finished, failed or was
   * interrupted after the app restarted still reports the state its own thread
   * carries, and a dispatch whose thread was deleted drops out instead of
   * pointing at nothing.
   */
  async listByInitiator(
    initiatorProjectId: string,
    initiatorThreadId: string
  ): Promise<OrchestrationDispatch[]> {
    const result = await this.db.queryViaWorker(
      `SELECT d.child_project_id, d.child_thread_id, d.oven_id, d.oven_name,
              d.harness_id, d.provider_id, d.model_id, d.thinking_level, d.created_at,
              t.title AS title, t.status AS status, t.updated_at AS updated_at,
              p.name AS project_name
         FROM orchestration_dispatches d
         JOIN threads t
           ON t.id = d.child_thread_id AND t.project_id = d.child_project_id
         JOIN projects p
           ON p.id = d.child_project_id
        WHERE d.initiator_project_id = ? AND d.initiator_thread_id = ?
        ORDER BY d.created_at DESC`,
      [initiatorProjectId, initiatorThreadId],
      0
    )
    if (!result.ok) return []
    return (result.rows as unknown as DispatchRow[]).map((row) => ({
      childProjectId: row.child_project_id,
      childProjectName: row.project_name,
      childThreadId: row.child_thread_id,
      title: row.title,
      status: row.status as ThreadStatus,
      ovenId: row.oven_id,
      ovenName: row.oven_name,
      harnessId: row.harness_id,
      providerId: row.provider_id,
      modelId: row.model_id,
      ...(row.thinking_level ? { thinkingLevel: row.thinking_level } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }))
  }
}
