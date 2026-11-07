import type { Database } from '../database/database'
import type { AutoAnswerItem } from '../../lib/types'

/** The task and provenance keys a settled gate is filed under. */
export type AutoAnswerScope = Pick<AutoAnswerItem, 'taskId' | 'assistantId'>

/**
 * Resolve a settled gate's scope from the thread it settled on.
 *
 * A decision is shown on the conversation that asked for it, and on the
 * assistant task that conversation ran for. The run thread is transient, so its
 * `assistantTaskId` is copied onto the record the moment it is written; after the
 * thread is evicted the record still points at the task the decision actually ran
 * for.
 *
 * The owning assistant is recorded too, but only as provenance: an assistant holds
 * many tasks, so its id never decides where the decision surfaces.
 *
 * Reads only the three columns it needs, synchronously, so recording an
 * auto-resolved gate never waits on the worker. A missing row (an ephemeral
 * chat, or a thread read after deletion) simply files the gate under its own
 * thread id.
 */
export function resolveAutoAnswerScope(
  database: Database,
  projectId: string,
  threadId: string
): AutoAnswerScope {
  try {
    const row = database.get<{
      project_id: string
      assistant_id: string | null
      assistant_task_id: string | null
    }>('SELECT project_id, assistant_id, assistant_task_id FROM threads WHERE id = ?', threadId)
    if (!row || row.project_id !== projectId) return {}
    return {
      ...(row.assistant_task_id !== null ? { taskId: row.assistant_task_id } : {}),
      ...(row.assistant_id !== null ? { assistantId: row.assistant_id } : {})
    }
  } catch {
    // The store still keeps the gate; only its task/assistant links are lost.
    return {}
  }
}
