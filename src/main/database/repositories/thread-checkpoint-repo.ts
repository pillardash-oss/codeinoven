import { randomUUID } from 'node:crypto'
import type { Database } from '../database'
import type { ThreadCheckpoint, ThreadCheckpointKind } from '../../../lib/types'

/**
 * The thread's context checkpoints: one row per harness session that ended at a
 * boundary, plus the fork's lineage row.
 *
 * Reads run on the worker because every caller is an interaction path (the turn
 * that decides to checkpoint, the brief a rebuilt session opens with, and the
 * renderer's checkpoint list). Writes are ordinary main-process statements: a
 * checkpoint happens between turns, never inside a read.
 */

interface ThreadCheckpointRow {
  id: string
  thread_id: string
  sequence: number
  kind: string
  harness_id: string
  provider_id: string | null
  model_id: string | null
  account_id: string | null
  session_id: string
  next_session_id: string | null
  project_path: string
  boundary_message_id: string | null
  boundary_created_at: number | null
  tokens_before: number | null
  context_window: number | null
  parent_thread_id: string | null
  label: string | null
  created_at: number
  closed_at: number | null
}

const CHECKPOINT_COLUMNS = `id, thread_id, sequence, kind, harness_id, provider_id, model_id,
  account_id, session_id, next_session_id, project_path, boundary_message_id,
  boundary_created_at, tokens_before, context_window, parent_thread_id, label,
  created_at, closed_at`

/** Kinds are a closed set; an unknown value from an older row reads as `auto`. */
function toKind(value: string): ThreadCheckpointKind {
  return value === 'manual' ||
    value === 'harness-switch' ||
    value === 'fork' ||
    value === 'recovery'
    ? value
    : 'auto'
}

function rowToCheckpoint(row: Record<string, unknown>): ThreadCheckpoint {
  const record = row as unknown as ThreadCheckpointRow
  const checkpoint: ThreadCheckpoint = {
    id: record.id,
    threadId: record.thread_id,
    sequence: record.sequence,
    kind: toKind(record.kind),
    harnessId: record.harness_id,
    sessionId: record.session_id,
    projectPath: record.project_path,
    createdAt: record.created_at
  }
  if (record.provider_id) checkpoint.providerId = record.provider_id
  if (record.model_id) checkpoint.modelId = record.model_id
  if (record.account_id) checkpoint.accountId = record.account_id
  if (record.next_session_id) checkpoint.nextSessionId = record.next_session_id
  if (record.boundary_message_id) checkpoint.boundaryMessageId = record.boundary_message_id
  if (record.boundary_created_at !== null) checkpoint.boundaryCreatedAt = record.boundary_created_at
  if (record.tokens_before !== null) checkpoint.tokensBefore = record.tokens_before
  if (record.context_window !== null) checkpoint.contextWindow = record.context_window
  if (record.parent_thread_id) checkpoint.parentThreadId = record.parent_thread_id
  if (record.label) checkpoint.label = record.label
  if (record.closed_at !== null) checkpoint.closedAt = record.closed_at
  return checkpoint
}

/** The fields a new checkpoint is created with; the rest is filled in later. */
export interface NewThreadCheckpoint {
  threadId: string
  kind: ThreadCheckpointKind
  harnessId: string
  sessionId: string
  projectPath?: string
  providerId?: string
  modelId?: string
  accountId?: string
  parentThreadId?: string
  label?: string
  createdAt?: number
}

/** What finalizing a checkpoint adds: how it ended and what it had consumed. */
export interface ClosedCheckpoint {
  nextSessionId?: string
  boundaryMessageId?: string
  boundaryCreatedAt?: number
  tokensBefore?: number
  contextWindow?: number
  closedAt?: number
}

/** Columns a checkpoint update may set, by field name. */
const FINAL_COLUMNS: Record<string, string> = {
  nextSessionId: 'next_session_id',
  boundaryMessageId: 'boundary_message_id',
  boundaryCreatedAt: 'boundary_created_at',
  tokensBefore: 'tokens_before',
  contextWindow: 'context_window',
  closedAt: 'closed_at'
}

export class ThreadCheckpointRepo {
  constructor(private readonly db: Database) {}

  /**
   * Insert a checkpoint, taking the thread's next sequence number in the same
   * statement. Two checkpoints of one thread can never race for a number: the
   * `UNIQUE (thread_id, sequence)` constraint fails the loser rather than
   * writing two rows that both claim to be the second window.
   */
  create(input: NewThreadCheckpoint): ThreadCheckpoint {
    const id = randomUUID()
    const createdAt = input.createdAt ?? Date.now()
    // One statement: the sequence is the thread's next number and comes back
    // with the row through RETURNING. Reading it back afterwards would be a
    // second round trip for a value this write already knows, and a separate
    // SELECT MAX would leave a race between two checkpoints of one thread.
    const inserted = this.db
      .prepare(
        `INSERT INTO thread_checkpoints (
           id, thread_id, sequence, kind, harness_id, provider_id, model_id, account_id,
           session_id, project_path, parent_thread_id, label, created_at
         ) VALUES (
           ?, ?,
           (SELECT COALESCE(MAX(sequence), 0) + 1 FROM thread_checkpoints WHERE thread_id = ?),
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         )
         RETURNING sequence`
      )
      .get(
        id,
        input.threadId,
        input.threadId,
        input.kind,
        input.harnessId,
        input.providerId ?? null,
        input.modelId ?? null,
        input.accountId ?? null,
        input.sessionId,
        input.projectPath ?? '',
        input.parentThreadId ?? null,
        input.label ?? null,
        createdAt
      ) as { sequence: number } | undefined
    return {
      id,
      threadId: input.threadId,
      sequence: inserted?.sequence ?? 0,
      kind: input.kind,
      harnessId: input.harnessId,
      sessionId: input.sessionId,
      projectPath: input.projectPath ?? '',
      createdAt,
      ...(input.providerId ? { providerId: input.providerId } : {}),
      ...(input.modelId ? { modelId: input.modelId } : {}),
      ...(input.accountId ? { accountId: input.accountId } : {}),
      ...(input.parentThreadId ? { parentThreadId: input.parentThreadId } : {}),
      ...(input.label ? { label: input.label } : {})
    }
  }

  /** Fill in what finalizing the boundary added. Absent fields are left alone. */
  close(id: string, closed: ClosedCheckpoint): void {
    const assignments: string[] = []
    const params: unknown[] = []
    for (const [field, column] of Object.entries(FINAL_COLUMNS)) {
      const value = closed[field as keyof ClosedCheckpoint]
      if (value === undefined) continue
      assignments.push(`${column} = ?`)
      params.push(value)
    }
    if (assignments.length === 0) return
    // A closed row always records when it closed, so the renderer can order
    // windows without inventing a time from the next one's start.
    if (closed.closedAt === undefined) {
      assignments.push('closed_at = ?')
      params.push(Date.now())
    }
    this.db.run(
      `UPDATE thread_checkpoints SET ${assignments.join(', ')} WHERE id = ?`,
      ...params,
      id
    )
  }

  /** The thread's newest checkpoints, newest first, bounded. */
  async listViaWorker(threadId: string, limit = 20): Promise<ThreadCheckpoint[]> {
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit) || 20))
    const result = await this.db.queryViaWorker(
      `SELECT ${CHECKPOINT_COLUMNS} FROM thread_checkpoints
        WHERE thread_id = ? ORDER BY sequence DESC LIMIT ?`,
      [threadId, bounded],
      bounded
    )
    if (!result.ok) throw new Error(result.error ?? 'Cannot read thread checkpoints')
    return result.rows.map(rowToCheckpoint)
  }

  /** The thread's newest checkpoint, or undefined when it has never checked one. */
  async latestViaWorker(threadId: string): Promise<ThreadCheckpoint | undefined> {
    const [latest] = await this.listViaWorker(threadId, 1)
    return latest
  }

  /** The checkpoint a session ended at, if that session is already closed. */
  async bySessionViaWorker(sessionId: string): Promise<ThreadCheckpoint | undefined> {
    const result = await this.db.queryViaWorker(
      `SELECT ${CHECKPOINT_COLUMNS} FROM thread_checkpoints
        WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`,
      [sessionId],
      1
    )
    if (!result.ok) throw new Error(result.error ?? 'Cannot read the thread checkpoint')
    const [row] = result.rows
    return row ? rowToCheckpoint(row) : undefined
  }
}
