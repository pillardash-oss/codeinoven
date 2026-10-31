import type { TurnCheckpointChangeSummary, TurnCheckpointSummary } from '../../../lib/types'
import type { CheckpointChange, ProjectCheckpoint } from '../../git/change-tracking-service'
import type { TurnCheckpoint } from '../checkpoint-manager'
import { MAX_CHECKPOINT_FAILURE_LENGTH } from './checkpoint-errors'

/**
 * The read-side half of a turn checkpoint: diffing the two stored snapshots and
 * turning a checkpoint into the summary a conversation card draws from.
 *
 * Everything here is a pure function of rows that are already on disk, which is
 * what lets the database maintenance worker do it instead of the main process.
 * Reading one thread's checkpoints means parsing several megabytes of snapshot
 * JSON and repairing the turns that stored no diff, so the whole tail of that
 * work belongs beside the query that produced the rows, not on the thread that
 * answers IPC.
 */

/** Same wording the safety error uses, so a card never reports a different cause. */
export const CHECKPOINT_ROOT_MISMATCH = 'Cannot compare checkpoints from different project roots'

/**
 * The changed paths between two snapshots of one project.
 *
 * Pure: it reads the file maps the checkpoints already carry and never touches
 * the disk, so it runs unchanged on the maintenance worker.
 */
export function diffCheckpointFiles(
  before: ProjectCheckpoint,
  after: ProjectCheckpoint
): CheckpointChange[] {
  if (before.projectRoot !== after.projectRoot) {
    throw new Error(CHECKPOINT_ROOT_MISMATCH)
  }
  const paths = new Set([...Object.keys(before.files), ...Object.keys(after.files)])
  return [...paths].sort().flatMap((path): CheckpointChange[] => {
    const beforeFile = before.files[path]
    const afterFile = after.files[path]
    if (!beforeFile && afterFile) return [{ path, kind: 'created', after: afterFile }]
    if (beforeFile && !afterFile) return [{ path, kind: 'deleted', before: beforeFile }]
    if (beforeFile && afterFile && beforeFile.hash !== afterFile.hash) {
      return [{ path, kind: 'modified', before: beforeFile, after: afterFile }]
    }
    return []
  })
}

/**
 * A checkpoint healed for reading: the legacy poison where an entire agent
 * transcript was stored as `failure` is dropped, and a completed checkpoint that
 * recorded no changes gets them from its own snapshots.
 *
 * A checkpoint that already lists changes, or whose completion deliberately
 * filtered the snapshot diff, is returned untouched: recomputing either would
 * show files the turn was explicitly not credited with.
 */
export function repairCheckpointChanges(checkpoint: TurnCheckpoint): TurnCheckpoint {
  const healed =
    checkpoint.failure !== undefined && checkpoint.failure.length > MAX_CHECKPOINT_FAILURE_LENGTH
      ? { ...checkpoint, failure: undefined }
      : checkpoint
  if (healed.changes.length > 0 || !healed.after || healed.changeFilterApplied === true) {
    return healed
  }
  const changes = diffCheckpointFiles(healed.before, healed.after)
  return changes.length > 0 ? { ...healed, changes } : healed
}

/** The summary a renderer draws a turn's file-changes card from. */
export function toTurnCheckpointSummary(checkpoint: TurnCheckpoint): TurnCheckpointSummary {
  return {
    id: checkpoint.id,
    projectId: checkpoint.projectId,
    threadId: checkpoint.threadId,
    ...(checkpoint.sourceMessageId ? { sourceMessageId: checkpoint.sourceMessageId } : {}),
    ...(checkpoint.breakdown ? { breakdown: checkpoint.breakdown } : {}),
    label: checkpoint.label,
    status: checkpoint.status,
    changes: checkpoint.changes.map((change): TurnCheckpointChangeSummary => ({
      path: change.path,
      sources: checkpoint.changeSourceRefs?.[change.path]?.flatMap((reference) => {
        const source = checkpoint.toolSources?.[reference.toolPartId]
        return source
          ? [{ ...source, verification: reference.verification, window: reference.window }]
          : []
      }),
      beforeHash: change.before?.hash,
      afterHash: change.after?.hash,
      kind: change.kind,
      binary: change.after?.binary ?? change.before?.binary ?? false,
      ...(change.before ? { beforeSize: change.before.size } : {}),
      ...(change.after ? { afterSize: change.after.size } : {}),
      ...(checkpoint.lineStats?.[change.path]?.additions !== undefined
        ? { additions: checkpoint.lineStats[change.path].additions }
        : {}),
      ...(checkpoint.lineStats?.[change.path]?.deletions !== undefined
        ? { deletions: checkpoint.lineStats[change.path].deletions }
        : {}),
      ...(checkpoint.lineStats?.[change.path]?.truncated ? { lineCountsTruncated: true } : {})
    })),
    ...(checkpoint.stopReason ? { stopReason: checkpoint.stopReason } : {}),
    createdAt: checkpoint.createdAt,
    completedAt: checkpoint.completedAt,
    rolledBackAt: checkpoint.rolledBackAt,
    rolledBackPaths: checkpoint.rolledBackPaths,
    failure: checkpoint.failure,
    ...(checkpoint.after?.skippedFiles && checkpoint.after.skippedFiles.length > 0
      ? { skippedFiles: checkpoint.after.skippedFiles }
      : {}),
    gitHead: checkpoint.before.git?.head
  }
}

/**
 * Summaries from the stored rows, decoded and repaired off the main process.
 *
 * One row that cannot be decoded is skipped with its id reported rather than
 * failing the batch: a single bad row used to make the whole list unreadable,
 * and an unreadable list draws no cards at all.
 */
export function summarizeCheckpointRows(rows: readonly Record<string, unknown>[]): {
  summaries: TurnCheckpointSummary[]
  failed: string[]
} {
  const summaries: TurnCheckpointSummary[] = []
  const failed: string[] = []
  for (const row of rows) {
    try {
      const checkpoint = JSON.parse(String(row['data'])) as TurnCheckpoint
      summaries.push(toTurnCheckpointSummary(repairCheckpointChanges(checkpoint)))
    } catch {
      const id = row['turn_id']
      failed.push(typeof id === 'string' ? id : 'unknown')
    }
  }
  return { summaries, failed }
}
