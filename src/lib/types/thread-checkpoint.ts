/**
 * A context checkpoint: the boundary where one harness session ended and the
 * next one took over the same thread.
 *
 * It is deliberately not a Git checkpoint (`TurnCheckpointSummary` in
 * `./checkpoints`) and not a harness compaction record. A checkpoint names a
 * session that has closed, so the app can say "the window before this one ran on
 * that session, and its rows are still in the mirror" without re-reading the
 * harness transcript.
 *
 * `threads.sessionId` always points at the session that is *running*, so a
 * checkpoint row and the thread never disagree: the row describes what ended,
 * the thread describes what continues.
 */
export type ThreadCheckpointKind =
  /** The session crossed the context line and was replaced. */
  | 'auto'
  /** The user asked for one. */
  | 'manual'
  /** The same thread moved to another harness. */
  | 'harness-switch'
  /** A fork's inherited boundary, naming the parent thread it came from. */
  | 'fork'
  /** An emergency rebuild after a failure, rather than a scheduled line. */
  | 'recovery'

export interface ThreadCheckpoint {
  id: string
  threadId: string
  /** 1, 2, 3 … per thread, so "the previous window" is a read, not a guess. */
  sequence: number
  kind: ThreadCheckpointKind
  harnessId: string
  providerId?: string
  modelId?: string
  accountId?: string
  /** The session that ended at this boundary. */
  sessionId: string
  /** The session that continued the thread, written when it is created. */
  nextSessionId?: string
  projectPath: string
  /** The last mirrored message the closed session saw. */
  boundaryMessageId?: string
  boundaryCreatedAt?: number
  /** What the closed session had consumed when it stopped, when known. */
  tokensBefore?: number
  contextWindow?: number
  /** The thread this checkpoint's history came from, for a fork. */
  parentThreadId?: string
  /** A short human-facing line for the UI and the next session's brief. */
  label?: string
  createdAt: number
  closedAt?: number
}
