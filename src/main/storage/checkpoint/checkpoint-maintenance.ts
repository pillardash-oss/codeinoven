import { mkdir, readdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { getConfigRoot, generateId } from '../../../lib/utils'
import { Logger } from '../../system/logger'
import type {
  ChangeTrackingService,
  CheckpointFile,
  ProjectCheckpoint
} from '../../git/change-tracking-service'
import { assertId } from './checkpoint-errors'
import { isMissing } from './checkpoint-blob-store'
import { EXCLUDED_DIRECTORY_NAMES, isExcludedRelativePath } from '../../git/change-tracking-service'
import { snapshotChangeBreakdown } from './checkpoint-breakdown'
import { calculateLineStats, type CheckpointLineStats } from './checkpoint-diff'
import { diffCheckpointFiles } from './checkpoint-summary'
import {
  TRANSCRIPT_EVIDENCE_MESSAGE_LIMIT,
  transcriptWriteEvidence
} from './checkpoint-transcript-evidence'
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
  /**
   * Same read, but answered only by the maintenance worker's connection and
   * never by the primary one: a project-wide scan is far too expensive to run
   * on the Electron main thread, so a failure must reach the caller as an
   * error instead of being retried there. Throws when the read fails.
   */
  queryRowsStrict(
    sql: string,
    params: unknown[],
    maxRows: number
  ): Promise<Record<string, unknown>[]>
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

/** Most diff paths one evidence repair will consider, so a wide project diff
 *  can never turn startup into a long comparison. */
const EVIDENCE_REPAIR_MAX_PATHS = 2_000

/**
 * One-time repair pass for file-change cards that recorded nothing while the
 * turn really wrote files.
 *
 * A contested project diff keeps only the paths the turn can prove it wrote,
 * and a command whose write target was parsed in the wrong directory proved
 * nothing: the card ended up empty and its whole diff was filtered away. The
 * snapshots are still on the row (completion now keeps them for exactly this
 * state), so the real diff can be recomputed and intersected with the durable
 * transcript evidence for the turn. Idempotent: a repaired row holds changes
 * and no longer matches the candidate query.
 */
export async function repairEvidenceDroppedCheckpoints(
  host: CheckpointMaintenanceHost
): Promise<number> {
  let rows: Record<string, unknown>[]
  try {
    rows = await host.queryRows(
      `SELECT tc.turn_id AS turn_id,
              tc.project_id AS project_id,
              tc.thread_id AS thread_id,
              json_extract(tc.data, '$.createdAt') AS created_at
         FROM turn_checkpoints tc
        WHERE json_extract(tc.data, '$.status') = 'completed'
          AND json_array_length(json_extract(tc.data, '$.changes')) = 0
          AND json_extract(tc.data, '$.changeFilterApplied') = 1
          AND json_type(tc.data, '$.before.files') = 'object'
          AND json_type(tc.data, '$.after.files') = 'object'
        ORDER BY tc.created_at DESC
        LIMIT ?`,
      [REPAIR_MAX_CHECKPOINTS],
      REPAIR_MAX_CHECKPOINTS
    )
  } catch (error) {
    Logger.error('Evidence repair could not list candidates (non-fatal):', error)
    return 0
  }
  let repaired = 0
  let repairedPaths = 0
  for (const row of rows) {
    const turnId = row['turn_id']
    const projectId = row['project_id']
    const threadId = row['thread_id']
    const createdAt = row['created_at']
    if (
      typeof turnId !== 'string' ||
      typeof projectId !== 'string' ||
      typeof threadId !== 'string' ||
      typeof createdAt !== 'number'
    ) {
      continue
    }
    if (repairedPaths >= REPAIR_MAX_FILES) break
    try {
      const checkpoint = await host.get(projectId, threadId, turnId)
      if (!checkpoint || checkpoint.status !== 'completed' || !checkpoint.after) continue
      const projectRows = await host.queryRows(
        'SELECT path FROM projects WHERE id = ?',
        [projectId],
        1
      )
      const projectPath = projectRows[0]?.['path']
      if (typeof projectPath !== 'string' || projectPath.length === 0) continue
      const diff = diffCheckpointFiles(checkpoint.before, checkpoint.after)
      if (diff.length === 0 || diff.length > EVIDENCE_REPAIR_MAX_PATHS) continue
      const transcript = await host.queryRows(
        `SELECT parts FROM agent_messages
          WHERE thread_id = ? AND role = 'assistant' AND created_at >= ?
          ORDER BY created_at DESC, id DESC`,
        [threadId, checkpoint.before.createdAt],
        TRANSCRIPT_EVIDENCE_MESSAGE_LIMIT
      )
      const evidence = transcriptWriteEvidence(
        projectPath,
        transcript.map((row) => ({ parts: row['parts'] }))
      )
      const kept = diff.filter((change) => (evidence.get(change.path)?.length ?? 0) > 0)
      if (kept.length === 0) continue
      const lineStats = await calculateLineStats(host.tracker(projectId), kept)
      const breakdown = await snapshotChangeBreakdown(
        kept.map((change) => ({
          path: change.path,
          additions: lineStats.stats[change.path]?.additions,
          deletions: lineStats.stats[change.path]?.deletions
        }))
      )
      await host.save({
        ...checkpoint,
        changes: kept,
        toolSources: Object.fromEntries(
          kept.flatMap((change) =>
            (evidence.get(change.path) ?? []).map((source) => [source.toolPartId, source])
          )
        ),
        changeSourceRefs: Object.fromEntries(
          kept.map((change) => [
            change.path,
            (evidence.get(change.path) ?? []).map((source) => ({
              toolPartId: source.toolPartId,
              verification: source.verification,
              window: source.window
            }))
          ])
        ),
        lineStats: lineStats.stats,
        breakdown
      })
      repaired += 1
      repairedPaths += kept.length
      // Yield between checkpoints so a large first-run repair never
      // monopolizes the main process.
      await new Promise<void>((resolve) => setImmediate(resolve))
    } catch (error) {
      Logger.error('Evidence repair skipped a checkpoint (non-fatal):', error)
    }
  }
  return repaired
}

/**
 * One-time repair pass for cards that list files checkpoints never track.
 *
 * The app's own scratch folder and build output are not the turn's work, but an
 * older snapshot or a git-mode listing could still hand them to the diff, so
 * cards offered `.cio/tmp/report.txt` as a change beside the real ones. The
 * candidates are found in SQL on the scratch prefix, then every excluded path is
 * dropped from the stored changes and the snapshot maps (via the regular
 * compaction on save). Idempotent: a repaired row no longer matches the query.
 */
export async function dropExcludedPathChanges(host: CheckpointMaintenanceHost): Promise<number> {
  const matchers = EXCLUDED_DIRECTORY_NAMES.flatMap(() => [
    `json_extract(je.value, '$.path') LIKE ?`,
    `json_extract(je.value, '$.path') LIKE ?`
  ])
  const params = EXCLUDED_DIRECTORY_NAMES.flatMap((name) => [`${name}/%`, `%/${name}/%`])
  let rows: Record<string, unknown>[]
  try {
    rows = await host.queryRows(
      `SELECT tc.turn_id AS turn_id, tc.project_id AS project_id, tc.thread_id AS thread_id
         FROM turn_checkpoints tc
        WHERE EXISTS (
          SELECT 1 FROM json_each(json_extract(tc.data, '$.changes')) je
           WHERE ${matchers.join(' OR ')}
        )
        LIMIT ?`,
      [...params, REPAIR_MAX_CHECKPOINTS],
      REPAIR_MAX_CHECKPOINTS
    )
  } catch (error) {
    Logger.error('Excluded-path repair could not list candidates (non-fatal):', error)
    return 0
  }
  let repaired = 0
  for (const row of rows) {
    const turnId = row['turn_id']
    const projectId = row['project_id']
    const threadId = row['thread_id']
    if (typeof turnId !== 'string' || typeof projectId !== 'string' || typeof threadId !== 'string')
      continue
    try {
      const checkpoint = await host.get(projectId, threadId, turnId)
      if (!checkpoint) continue
      const kept = checkpoint.changes.filter((change) => !isExcludedRelativePath(change.path))
      if (kept.length === checkpoint.changes.length) continue
      const lineStats = await calculateLineStats(host.tracker(projectId), kept)
      await host.save({
        ...checkpoint,
        changes: kept,
        lineStats: lineStats.stats,
        changeSourceRefs: Object.fromEntries(
          kept.map((change) => [change.path, checkpoint.changeSourceRefs?.[change.path] ?? []])
        ),
        toolSources: Object.fromEntries(
          Object.entries(checkpoint.toolSources ?? {}).filter(([partId]) =>
            kept.some((change) =>
              (checkpoint.changeSourceRefs?.[change.path] ?? []).some(
                (reference) => reference.toolPartId === partId
              )
            )
          )
        )
      })
      repaired += 1
      // Yield between checkpoints so a large first-run repair never
      // monopolizes the main process.
      await new Promise<void>((resolve) => setImmediate(resolve))
    } catch (error) {
      Logger.error('Excluded-path repair skipped a checkpoint (non-fatal):', error)
    }
  }
  return repaired
}

/** How far back an unfinished sibling turn still overlaps a completion. Mirrors
 *  the manager's own window so a repair and a live completion agree. */
const OVERLAP_GRACE_MS = 10 * 60 * 1000

/**
 * One-time repair pass for cards that only hold another turn's abandoned work.
 *
 * A turn that proved nothing it wrote (`toolSources` empty and no per-path
 * evidence) cannot own the files a project-wide diff handed it, and it is only
 * plausible at all when nothing else was running. When a sibling turn was in
 * flight in the same window and never finished, those files are that turn's
 * leftovers, and the card reported work this turn never did. Idempotent: a
 * cleared card no longer matches the candidate query.
 */
export async function dropUnprovenOverlappingChanges(
  host: CheckpointMaintenanceHost
): Promise<number> {
  let rows: Record<string, unknown>[]
  try {
    rows = await host.queryRows(
      `SELECT a.turn_id AS turn_id, a.project_id AS project_id, a.thread_id AS thread_id
         FROM turn_checkpoints a
        WHERE json_array_length(json_extract(a.data, '$.changes')) > 0
          AND (SELECT COUNT(*) FROM json_each(json_extract(a.data, '$.toolSources'))) = 0
          AND (
            SELECT COUNT(*) FROM json_each(json_extract(a.data, '$.changeSourceRefs')) je
             WHERE json_array_length(je.value) > 0
          ) = 0
          AND EXISTS (
            SELECT 1 FROM turn_checkpoints b
             WHERE b.project_id = a.project_id
               AND b.thread_id != a.thread_id
               AND json_extract(b.data, '$.completedAt') IS NULL
               AND json_extract(b.data, '$.createdAt') BETWEEN
                   json_extract(a.data, '$.createdAt') - ? AND json_extract(a.data, '$.completedAt')
          )
        LIMIT ?`,
      [OVERLAP_GRACE_MS, REPAIR_MAX_CHECKPOINTS],
      REPAIR_MAX_CHECKPOINTS
    )
  } catch (error) {
    Logger.error('Unproven-change repair could not list candidates (non-fatal):', error)
    return 0
  }
  let repaired = 0
  for (const row of rows) {
    const turnId = row['turn_id']
    const projectId = row['project_id']
    const threadId = row['thread_id']
    if (typeof turnId !== 'string' || typeof projectId !== 'string' || typeof threadId !== 'string')
      continue
    try {
      const checkpoint = await host.get(projectId, threadId, turnId)
      if (!checkpoint || checkpoint.changes.length === 0) continue
      await host.save({
        ...checkpoint,
        changes: [],
        toolSources: {},
        changeSourceRefs: {},
        lineStats: {},
        breakdown: undefined,
        changeFilterApplied: true
      })
      repaired += 1
      await new Promise<void>((resolve) => setImmediate(resolve))
    } catch (error) {
      Logger.error('Unproven-change repair skipped a checkpoint (non-fatal):', error)
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
    // on large projects. The change list is unioned in as well: a change
    // rescued from this turn's write evidence can reference content the
    // snapshot maps never listed, and deleting that blob would leave the
    // change with no diff and no rollback source.
    //
    // A change entry is `{path, kind, before?, after?}`, and only its `before`
    // and `after` objects carry a `hash`. Reading every member instead hands
    // `json_extract` a raw path or kind string, which SQLite parses as JSON and
    // rejects as `malformed JSON`   that aborted this whole scan, so nothing
    // was ever pruned and every call fell back to the main thread.
    //
    // The read is strict: this scan covers every checkpoint of a project, so it
    // must never be answered by the primary connection on the main thread. A
    // failure throws and the catch below keeps the blobs.
    let rows: Record<string, unknown>[]
    try {
      rows = await host.queryRowsStrict(
        `SELECT json_extract(je.value, '$.hash') AS hash
           FROM turn_checkpoints tc, json_each(tc.data, '$.before.files') je
           WHERE tc.project_id = ?
           UNION
           SELECT json_extract(je.value, '$.hash') AS hash
           FROM turn_checkpoints tc, json_each(tc.data, '$.after.files') je
           WHERE tc.project_id = ?
           UNION
           SELECT json_extract(side.value, '$.hash') AS hash
           FROM turn_checkpoints tc, json_each(tc.data, '$.changes') je,
                json_each(je.value) side
           WHERE tc.project_id = ?
             AND side.key IN ('before', 'after')
             AND json_extract(side.value, '$.hash') IS NOT NULL`,
        [projectId, projectId, projectId],
        200_000
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

/**
 * How many of a thread's newest checkpoints keep their full project maps.
 *
 * The newest checkpoint's `after` map is the diff baseline for the next turn, and
 * the last few are what a user opens and rolls back. Everything older only needs
 * its own changed paths, which the `changes` array already names.
 */
const HISTORICAL_MAP_KEEP_PER_THREAD = 2

/** Only rows this large can still be carrying whole-project maps worth dropping. */
const HISTORICAL_MAP_MIN_ROW_BYTES = 60_000

/** Rows one pass rewrites, so the database worker stays responsive. */
const HISTORICAL_MAP_BATCH = 40

/**
 * Drop whole-project file maps from a thread's older checkpoints.
 *
 * A turn with no changes keeps both of its full project maps (that is deliberate:
 * an empty checkpoint is the legacy recovery record and the next diff reads the
 * map). Six agents exploring a repository therefore wrote hundreds of kilobytes
 * per turn, and `turn_checkpoints` grew to hundreds of megabytes, which is what
 * made every read and write on the database slow enough to stall the app.
 *
 * The newest checkpoints of each thread are untouched, so the diff baseline and
 * recent rollbacks are intact. Older rows keep every field that describes the
 * turn (changes, line stats, breakdown, timestamps) and the map entries for the
 * paths they actually changed; only the unchanged project-wide entries go.
 * Returns how many rows were rewritten.
 */
export async function trimHistoricalCheckpointMaps(
  host: CheckpointMaintenanceHost
): Promise<number> {
  let rows: Record<string, unknown>[]
  try {
    rows = await host.queryRowsStrict(
      `SELECT tc.turn_id AS turn_id, tc.project_id AS project_id, tc.thread_id AS thread_id
         FROM turn_checkpoints tc
        WHERE length(tc.data) > ?
          AND tc.turn_id NOT IN (
            SELECT recent.turn_id FROM turn_checkpoints recent
             WHERE recent.project_id = tc.project_id AND recent.thread_id = tc.thread_id
             ORDER BY recent.created_at DESC
             LIMIT ?
          )
        ORDER BY length(tc.data) DESC
        LIMIT ?`,
      [HISTORICAL_MAP_MIN_ROW_BYTES, HISTORICAL_MAP_KEEP_PER_THREAD, HISTORICAL_MAP_BATCH],
      HISTORICAL_MAP_BATCH
    )
  } catch (error) {
    Logger.info('Historical checkpoint maps could not be listed (non-fatal):', error)
    return 0
  }
  let trimmed = 0
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
      if (!checkpoint) continue
      const paths = new Set(checkpoint.changes.map((change) => change.path))
      const trimFiles = (snapshot: ProjectCheckpoint): ProjectCheckpoint => {
        const files: Record<string, CheckpointFile> = {}
        for (const path of paths) {
          const file = snapshot.files[path]
          if (file) files[path] = file
        }
        return { ...snapshot, files }
      }
      const next: TurnCheckpoint = {
        ...checkpoint,
        before: trimFiles(checkpoint.before),
        ...(checkpoint.after ? { after: trimFiles(checkpoint.after) } : {})
      }
      // Only write when the row actually shrinks: an old checkpoint whose maps
      // were already trimmed must never be rewritten for nothing.
      const beforeEntries = Object.keys(checkpoint.before.files).length
      const afterEntries = Object.keys(next.before.files).length
      if (beforeEntries === afterEntries) continue
      await host.save(next)
      trimmed += 1
    } catch (error) {
      Logger.info('Historical checkpoint map could not be trimmed (non-fatal):', {
        turnId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
  return trimmed
}
