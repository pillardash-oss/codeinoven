import type { Database } from '../database/database'
import type { AutoAnswerItem } from '../../lib/types'

/** The thread/task/routine keys a settled gate is filed under. */
export type AutoAnswerScope = Pick<AutoAnswerItem, 'taskId' | 'routineId'>

/**
 * Resolve a settled gate's scope from the thread it settled on.
 *
 * A decision is shown on the conversation that asked for it, and through that
 * conversation on the assistant task it ran for and the routine that owns the
 * task. The run thread is transient, so its `assistantTaskId` and `routineId`
 * are copied onto the record the moment it is written; after the thread is
 * evicted the record still points at what the decision actually concerned.
 *
 * Reads only the two columns it needs, synchronously, so recording an
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
      routine_id: string | null
      assistant_task_id: string | null
    }>('SELECT project_id, routine_id, assistant_task_id FROM threads WHERE id = ?', threadId)
    if (!row || row.project_id !== projectId) return {}
    return {
      ...(row.assistant_task_id !== null ? { taskId: row.assistant_task_id } : {}),
      ...(row.routine_id !== null ? { routineId: row.routine_id } : {})
    }
  } catch {
    // The store still keeps the gate; only its task/routine links are lost.
    return {}
  }
}
