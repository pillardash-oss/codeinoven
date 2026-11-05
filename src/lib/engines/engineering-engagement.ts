import type { Database } from '../../main/database/database'

/**
 * Record that a thread now owns an Engineering artifact.
 *
 * `threads.engineering` is the durable marker the sidebar and the conversation
 * view read without a lifecycle round trip, and the view hydrates a thread's
 * Engineering state (lifecycle, Spec, Brainstorm, PRD, Assignment, audit) only
 * while it is set. The marker used to be written by one caller, the lifecycle
 * selection IPC handler, which made it an accident of *how* Engineering was
 * entered rather than of what the thread owns: an agent that created an
 * Assignment from the user's own request wrote a durable artifact, left the
 * marker off, and the card and the header's Studio control never appeared,
 * because the view had no reason to read state that existed.
 *
 * Every engine marks the coordinator thread where it persists an artifact, so
 * an artifact and the marker that makes it visible are written together on
 * every path, whether the user turned a stage on or an agent called a tool.
 *
 * Idempotent and guarded in SQL: a marked thread costs no write, and a thread
 * that no longer exists is a no-op rather than an error.
 */
export function markThreadEngineeringEngaged(
  db: Database,
  projectId: string,
  threadId: string
): void {
  db.run(
    'UPDATE threads SET engineering=1 WHERE project_id=? AND id=? AND engineering=0',
    projectId,
    threadId
  )
}
