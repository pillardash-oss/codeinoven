import { mkdir, readdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { getConfigRoot, generateId } from '../../../lib/utils'
import { Logger } from '../../system/logger'
import type { ChangeTrackingService } from '../../git/change-tracking-service'
import { assertId } from './checkpoint-errors'
import { isMissing } from './checkpoint-blob-store'
import { calculateLineStats, type CheckpointLineStats } from './checkpoint-diff'
import type { TurnCheckpoint } from '../checkpoint-manager'

/** Upper bounds for one line-stats repair pass so startup is never blocked. */
const REPAIR_MAX_CHECKPOINTS = 200
const REPAIR_MAX_FILES = 500

/**
 * The slice of `CheckpointManager` the one-time maintenance passes drive.
 * Every operation is supplied by the owning manager so the passes never reach
 * into its lifecycle state directly.
 */
export interface CheckpointMaintenanceHost {
  get(projectId: string, threadId: string, turnId: string): Promise<TurnCheckpoint | null>
  save(checkpoint: TurnCheckpoint): Promise<void>
  tracker(projectId: string): ChangeTrackingService
  queryRows(sql: string, params: unknown[], maxRows: number): Promise<Record<string, unknown>[]>
  withBlobLock<T>(projectId: string, operation: () => Promise<T>): Promise<T>
}

/**
 * One-time repair pass for checkpoints whose line stats were recorded as
 * `{ truncated: true }` by the previous gating, which measured whole-file
 * line counts instead of the trimmed changed region and therefore rejected
 * large files with small edits. The blob-backed history is intact, so the
 * exact counts can be recomputed and persisted. Idempotent: repaired
 * checkpoints no longer match the candidate query, and checkpoints whose
 * blobs are genuinely gone keep their honest truncated marker. Only terminal
 * checkpoints are touched   `active` and `interrupted` rows can still be
 * finalized by `completeTurn` and must never be rewritten from a read path.
 */
export async function repairTruncatedLineStats(host: CheckpointMaintenanceHost): Promise<number> {
  let rows: Record<string, unknown>[]
  try {
    rows = await host.queryRows(
      `SELECT DISTINCT tc.turn_id AS turn_id, tc.project_id AS project_id, tc.thread_id AS thread_id
         FROM turn_checkpoints tc, json_each(tc.data, '$.lineStats') ls
         WHERE json_extract(ls.value, '$.truncated') = 1
         LIMIT ?`,
      [REPAIR_MAX_CHECKPOINTS],
      REPAIR_MAX_CHECKPOINTS
    )
  } catch (error) {
    Logger.error('Line-stats repair could not list candidates (non-fatal):', error)
    return 0
  }
  let repaired = 0
  let repairedFiles = 0
  for (const row of rows) {
    if (repairedFiles >= REPAIR_MAX_FILES) break
    const turnId = row['turn_id']
    const projectId = row['project_id']
    const threadId = row['thread_id']
    if (
      typeof turnId !== 'string' ||
      typeof projectId !== 'string' ||
      typeof threadId !== 'string'
    ) {
      continue
    }
    try {
      const checkpoint = await host.get(projectId, threadId, turnId)
      if (!checkpoint) continue
      if (checkpoint.status === 'active' || checkpoint.status === 'interrupted') continue
      const pending = checkpoint.changes.filter((change) => {
        const stats = checkpoint.lineStats?.[change.path]
        return stats !== undefined && stats.truncated === true && stats.additions === undefined
      })
      if (pending.length === 0) continue
      const recomputed = await calculateLineStats(host.tracker(projectId), pending)
      const lineStats: Record<string, CheckpointLineStats> = { ...(checkpoint.lineStats ?? {}) }
      let recovered = 0
      for (const change of pending) {
        const stats = recomputed.stats[change.path]
        if (stats && stats.additions !== undefined) {
          lineStats[change.path] = stats
          recovered += 1
          repairedFiles += 1
        }
      }
      if (recovered === 0) {
        // Nothing recovered for this checkpoint (blobs genuinely unavailable);
        // keep the honest truncated marker instead of rewriting the row.
        continue
      }
      await host.save({ ...checkpoint, lineStats })
      repaired += 1
      // Yield between checkpoints so a large first-run repair never
      // monopolizes the main process.
      await new Promise<void>((resolve) => setImmediate(resolve))
    } catch (error) {
      Logger.error('Line-stats repair skipped a checkpoint (non-fatal):', error)
    }
  }
  return repaired
}

/** One-time repair pass for checkpoints created before internal-turn
 *  attribution existed: their label and sourceMessageId point at the hidden
 *  internal prompt (a search nudge, mermaid repair, incomplete-turn
 *  continuation) instead of the user's message, so the changes sidebar and
 *  file-changes cards showed the internal text as if the user asked for it.
 *  Repairs re-point them at the latest conversation-visible user message of
 *  the thread before the checkpoint started. Idempotent: repaired
 *  checkpoints no longer match the candidate query. Only terminal
 *  checkpoints are touched   active/interrupted rows can still be finalized
 *  by `completeTurn` and must never be rewritten from a read path. */
export async function repairMisattributedInternalCheckpoints(
  host: CheckpointMaintenanceHost
): Promise<number> {
  let rows: Record<string, unknown>[]
  try {
    rows = await host.queryRows(
      `SELECT tc.turn_id AS turn_id, tc.project_id AS project_id, tc.thread_id AS thread_id
         FROM turn_checkpoints tc, agent_messages am
         WHERE json_extract(tc.data, '$.sourceMessageId') = am.id
           AND am.role = 'user' AND am.visibility = 'hidden'
           AND json_extract(tc.data, '$.status') NOT IN ('active', 'interrupted')
         LIMIT ?`,
      [REPAIR_MAX_CHECKPOINTS],
      REPAIR_MAX_CHECKPOINTS
    )
  } catch (error) {
    Logger.error('Internal-attribution repair could not list candidates (non-fatal):', error)
    return 0
  }
  let repaired = 0
  for (const row of rows) {
    const turnId = row['turn_id']
    const projectId = row['project_id']
    const threadId = row['thread_id']
    if (
      typeof turnId !== 'string' ||
      typeof projectId !== 'string' ||
      typeof threadId !== 'string'
    ) {
      continue
    }
    try {
      const checkpoint = await host.get(projectId, threadId, turnId)
      if (!checkpoint || checkpoint.status === 'active' || checkpoint.status === 'interrupted') {
        continue
      }
      const userRows = await host.queryRows(
        `SELECT id, substr(json_extract(parts, '$[0].text'), 1, 80) AS label
           FROM agent_messages
           WHERE thread_id = ? AND role = 'user' AND visibility = 'conversation'
             AND created_at <= ?
           ORDER BY created_at DESC`,
        [threadId, checkpoint.createdAt],
        1
      )
      const userRow = userRows[0]
      const sourceMessageId = typeof userRow?.['id'] === 'string' ? userRow['id'] : undefined
      if (!sourceMessageId || sourceMessageId === checkpoint.sourceMessageId) continue
      const label =
        typeof userRow?.['label'] === 'string' && userRow['label'].trim()
          ? userRow['label']
          : checkpoint.label
      await host.save({ ...checkpoint, sourceMessageId, label })
      repaired += 1
      // Yield between checkpoints so a large first-run repair never
      // monopolizes the main process.
      await new Promise<void>((resolve) => setImmediate(resolve))
    } catch (error) {
      Logger.error('Internal-attribution repair skipped a checkpoint (non-fatal):', error)
    }
  }
  return repaired
}

/** Remove project checkpoint blobs that no remaining thread references. */
export async function pruneUnusedBlobs(
  host: CheckpointMaintenanceHost,
  projectId: string
): Promise<number> {
  assertId(projectId)
  return host.withBlobLock(projectId, async () => {
    // Invalidate every process's snapshot cache before deleting anything.
    // Snapshot capture uses the same cross-process lock, so the new revision
    // is observed before a later cache entry can be reused.
    const projectStorage = join(getConfigRoot(), `projects/${projectId}`)
    await mkdir(projectStorage, { recursive: true })
    await writeFile(join(projectStorage, 'blob-revision'), generateId(), {
      encoding: 'utf-8',
      mode: 0o600
    })
    // Collect referenced hashes in SQL   a full scan used to ship every
    // checkpoint JSON blob across the worker port, which crashed the process
    // on large projects.
    let rows: Record<string, unknown>[]
    try {
      rows = await host.queryRows(
        `SELECT json_extract(je.value, '$.hash') AS hash
           FROM turn_checkpoints tc, json_each(tc.data, '$.before.files') je
           WHERE tc.project_id = ?
           UNION
           SELECT json_extract(je.value, '$.hash') AS hash
           FROM turn_checkpoints tc, json_each(tc.data, '$.after.files') je
           WHERE tc.project_id = ?`,
        [projectId, projectId],
        100_000
      )
    } catch {
      // A malformed checkpoint row fails the whole extraction; preserving
      // the project blob directory is safer than risking data loss.
      return 0
    }
    const referenced = new Set<string>()
    for (const row of rows) {
      const hash = row['hash']
      if (typeof hash === 'string') referenced.add(hash)
    }

    const directory = join(getConfigRoot(), `projects/${projectId}/blobs`)
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (isMissing(error)) return 0
      throw error
    }
    let deleted = 0
    for (const entry of entries) {
      if (!entry.isFile() || referenced.has(entry.name)) continue
      await rm(join(directory, entry.name), { force: true })
      deleted++
    }
    return deleted
  })
}
