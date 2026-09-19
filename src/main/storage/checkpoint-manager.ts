import { readFile } from 'fs/promises'
import { join, resolve, sep } from 'path'
import { APP_NAME } from '../../lib/brand'
import { generateId } from '../../lib/utils'
import type {
  TurnCheckpointChangeSummary,
  TurnCheckpointFileDiff,
  TurnCheckpointStatus,
  TurnCheckpointSummary
} from '../../lib/types'
import type { Database } from '../database/database'
import { CrossProcessMutex } from '../system/cross-process-mutex'
import {
  ChangeTrackingService,
  isBinary,
  type CheckpointChange,
  type CheckpointFile,
  type ProjectCheckpoint,
  type ProjectFingerprint
} from '../git/change-tracking-service'
import {
  calculateLineStats,
  captureWarning,
  decodeDiffWindow,
  DIFF_WINDOW_CONTEXT_BYTES,
  MAX_DIFF_WINDOW_BYTES,
  type CheckpointLineStats
} from './checkpoint/checkpoint-diff'
import { StorageCheckpointBlobStore, isMissing } from './checkpoint/checkpoint-blob-store'
import {
  assertId,
  boundCheckpointFailure,
  MAX_CHECKPOINT_FAILURE_LENGTH
} from './checkpoint/checkpoint-errors'
import {
  pruneUnusedBlobs,
  repairMisattributedInternalCheckpoints,
  repairTruncatedLineStats,
  type CheckpointMaintenanceHost
} from './checkpoint/checkpoint-maintenance'

export { MAX_CHECKPOINT_FAILURE_LENGTH }

export interface TurnCheckpoint {
  id: string
  projectId: string
  threadId: string
  sourceMessageId?: string
  label: string
  status: TurnCheckpointStatus
  before: ProjectCheckpoint
  after?: ProjectCheckpoint
  changes: CheckpointChange[]
  /** Whether completion deliberately restricted the snapshot diff to reported tool paths. */
  changeFilterApplied?: boolean
  lineStats?: Record<string, CheckpointLineStats>
  createdAt: number
  completedAt?: number
  rolledBackAt?: number
  rolledBackPaths?: string[]
  failure?: string
}

/**
 * Optional signals used to reconcile the turn diff against concurrent work.
 * A shell command's stat window cannot tell which process wrote a path, so a
 * path that another thread demonstrably edited during this turn is excluded
 * from this thread's card unless this thread itself claimed it with a precise
 * file tool.
 */
export interface TurnCompletionOptions {
  /** Paths this thread's precise file tools touched during the turn. */
  precisePaths?: ReadonlySet<string>
  /** Paths other active sessions' precise file tools touched, path → claimed ms. */
  foreignClaimedPaths?: ReadonlyMap<string, number>
  /**
   * Thread ids owned by this turn   the thread itself plus its orchestration
   * descendants (worker sub-agents). Checkpoints completed by these threads
   * during the turn are part of THIS turn's work, never foreign.
   */
  ownThreadIds?: ReadonlySet<string>
  /** Paths the user edited themselves (in-app editor saves, user-terminal
   *  activity) while the turn ran. These are never the thread's changes. */
  excludedPaths?: ReadonlySet<string>
}

/** Cap on foreign-thread checkpoints scanned while reconciling concurrent edits. */
const FOREIGN_CHECKPOINT_SCAN_LIMIT = 500

/** How recent a completed checkpoint must be for a late file-tool claim to
 *  reopen it. Bounds the risk of resurrecting an old turn for an unrelated
 *  straggler claim; a genuinely still-running model emits its late edits
 *  within seconds of the premature settle. */
export const LATE_CLAIM_REOPEN_WINDOW_MS = 15 * 60_000

/**
 * Persists pre/post-turn checkpoints and exposes selective, snapshot-backed rollback.
 * It never uses git reset or rewrites paths that are absent from the recorded diff.
 */
export class CheckpointManager {
  private readonly trackers = new Map<string, ChangeTrackingService>()
  private readonly blobLocks = new Map<string, CrossProcessMutex>()

  constructor(private readonly db: Database) {}

  private tracker(projectId: string): ChangeTrackingService {
    const existing = this.trackers.get(projectId)
    if (existing) return existing
    const tracker = new ChangeTrackingService(new StorageCheckpointBlobStore(projectId))
    this.trackers.set(projectId, tracker)
    return tracker
  }

  private blobLock(projectId: string): CrossProcessMutex {
    const existing = this.blobLocks.get(projectId)
    if (existing) return existing
    const lock = new CrossProcessMutex(`checkpoint-blobs-${projectId}`)
    this.blobLocks.set(projectId, lock)
    return lock
  }

  private async withBlobLock<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const release = await this.blobLock(projectId).acquire()
    try {
      return await operation()
    } finally {
      release()
    }
  }

  async beginTurn(
    projectId: string,
    threadId: string,
    projectPath: string,
    label: string,
    includeGitMetadata: boolean,
    sourceMessageId?: string
  ): Promise<TurnCheckpoint> {
    assertId(projectId)
    assertId(threadId)
    return this.withBlobLock(projectId, async () => {
      const id = generateId()
      const tracker = this.tracker(projectId)
      const checkpoint: TurnCheckpoint = {
        id,
        projectId,
        threadId,
        ...(sourceMessageId ? { sourceMessageId } : {}),
        label,
        status: 'active',
        before: await tracker.snapshot(projectPath, { includeGitMetadata }),
        changes: [],
        createdAt: Date.now()
      }
      await this.save(checkpoint)
      await this.writeRow(
        'INSERT OR REPLACE INTO active_turns(project_id, thread_id, turn_id, owner_pid) VALUES(?, ?, ?, ?)',
        [projectId, threadId, id, process.pid]
      )
      return checkpoint
    })
  }

  /** Paths whose current content differs from a checkpoint's before-snapshot.
   *  Used to attribute shell-command mutations that arrived as a late claim
   *  after their turn already settled   the workspace baseline is the turn's
   *  own before-snapshot, so only this turn's real mutations are returned. */
  async changedPathsSince(
    projectId: string,
    projectPath: string,
    before: ProjectCheckpoint
  ): Promise<string[]> {
    assertId(projectId)
    const tracker = this.tracker(projectId)
    const after = await tracker.snapshot(projectPath, {
      includeGitMetadata: before.git !== undefined
    })
    return tracker.calculateChanges(before, after).map((change) => change.path)
  }

  /** Stat-only project scan used to attribute shell-command mutations to their run window. */
  fingerprint(projectId: string, projectPath: string): Promise<ProjectFingerprint> {
    assertId(projectId)
    return this.tracker(projectId).fingerprint(projectPath)
  }

  /** Project-relative paths that changed between two fingerprints. */
  diffFingerprints(
    projectId: string,
    before: ProjectFingerprint,
    after: ProjectFingerprint
  ): string[] {
    assertId(projectId)
    return this.tracker(projectId).diffFingerprints(before, after)
  }

  async completeTurn(
    projectId: string,
    threadId: string,
    turnId: string,
    projectPath: string,
    status: Extract<TurnCheckpointStatus, 'completed' | 'failed' | 'interrupted'>,
    failure?: string,
    changedPaths?: ReadonlySet<string>,
    options: TurnCompletionOptions = {}
  ): Promise<TurnCheckpoint> {
    return this.withBlobLock(projectId, async () => {
      const checkpoint = await this.get(projectId, threadId, turnId)
      if (!checkpoint) throw new Error(`Turn checkpoint not found: ${turnId}`)
      if (checkpoint.status !== 'active' && checkpoint.status !== 'interrupted') return checkpoint

      const tracker = this.tracker(projectId)
      const after = await tracker.snapshot(projectPath, {
        includeGitMetadata: checkpoint.before.git !== undefined
      })
      const allChanges = tracker.calculateChanges(checkpoint.before, after)
      const foreign =
        allChanges.length > 0 ? await this.foreignClaimedPaths(checkpoint, options) : undefined
      const precisePaths = options.precisePaths ?? new Set<string>()
      const excludedPaths = options.excludedPaths
      const keepChange = (path: string): boolean =>
        (foreign === undefined || !foreign.has(path) || precisePaths.has(path)) &&
        !(excludedPaths?.has(path) ?? false)
      // `undefined` preserves the project-wide snapshot behavior used by
      // recovery and direct checkpoint callers. A supplied empty set means the
      // owning turn reported no mutations and must record no workspace diff.
      const changes = changedPaths
        ? allChanges.filter((change) => changedPaths.has(change.path) && keepChange(change.path))
        : allChanges.filter((change) => keepChange(change.path))
      const lineStats = await calculateLineStats(tracker, changes)
      const contentUnavailable = new Set([
        ...(checkpoint.before.unavailableFiles ?? []),
        ...(after.unavailableFiles ?? []),
        ...lineStats.unavailablePaths
      ])
      const captureNotice = captureWarning(
        changes.filter((change) => contentUnavailable.has(change.path)).map((change) => change.path)
      )
      const joinedFailure = [failure, captureNotice].filter(Boolean).join(' ')
      const completionFailure = joinedFailure ? boundCheckpointFailure(joinedFailure) : ''
      const updated: TurnCheckpoint = {
        ...checkpoint,
        status,
        after,
        changes,
        changeFilterApplied: changedPaths !== undefined || changes.length !== allChanges.length,
        lineStats: lineStats.stats,
        completedAt: Date.now(),
        ...(completionFailure ? { failure: completionFailure } : {})
      }
      await this.save(updated)
      await this.writeRow('DELETE FROM active_turns WHERE project_id = ? AND thread_id = ?', [
        projectId,
        threadId
      ])
      return updated
    })
  }

  /**
   * Paths another thread demonstrably edited while this turn ran, path → when
   * the other thread touched it (ms). Merges live precise-tool claims with
   * checkpoints other threads completed inside this turn's window. Only claims
   * made after this turn started count: a stale claim from an earlier turn must
   * not hide this thread's own shell-driven edit.
   */
  async foreignClaimedPathsForLive(
    checkpoint: TurnCheckpoint,
    foreignLive: ReadonlyMap<string, number>,
    ownThreadIds?: ReadonlySet<string>
  ): Promise<Map<string, number>> {
    const opts: TurnCompletionOptions = { foreignClaimedPaths: foreignLive, ownThreadIds }
    return this.foreignClaimedPaths(checkpoint, opts)
  }

  private async foreignClaimedPaths(
    checkpoint: TurnCheckpoint,
    options: TurnCompletionOptions
  ): Promise<Map<string, number>> {
    const foreign = new Map<string, number>()
    const turnStart = checkpoint.before.createdAt
    for (const [path, claimedAt] of options.foreignClaimedPaths ?? []) {
      if (claimedAt >= turnStart) foreign.set(path, claimedAt)
    }
    // Extract only (threadId, completedAt, path) in SQL. Shipping full checkpoint JSON
    // blobs across the worker port just to read two fields crashed the process
    // on large projects and spiked memory on every turn completion.
    const rows = await this.queryRows(
      `SELECT json_extract(tc.data, '$.threadId') AS tid,
              json_extract(tc.data, '$.completedAt') AS completed_at,
              json_extract(je.value, '$.path') AS path
       FROM turn_checkpoints tc, json_each(tc.data, '$.changes') je
       WHERE tc.project_id = ? AND tc.thread_id != ?
         AND json_extract(tc.data, '$.status') = 'completed'
         AND json_extract(tc.data, '$.completedAt') >= ?`,
      [checkpoint.projectId, checkpoint.threadId, turnStart],
      FOREIGN_CHECKPOINT_SCAN_LIMIT
    )
    const own = options.ownThreadIds
    for (const row of rows) {
      const path = row['path']
      const tid = row['tid']
      if (typeof path === 'string' && !foreign.has(path)) {
        // Worker sub-agent threads owned by this turn are part of this work
        // their completions must not mark paths as foreign.
        if (own?.has(typeof tid === 'string' ? tid : '')) continue
        foreign.set(path, Number(row['completed_at'] ?? turnStart))
      }
    }
    return foreign
  }

  /**
   * Re-bind the active turn's source message to the latest user expression (a
   * steer). A steer extends the same native turn, so the single checkpoint's
   * diff still spans both the original prompt and every follow-up; pointing its
   * `sourceMessageId` at the steer lets renderers attach the file card to the
   * turn that actually produced the changes. No-op when no active turn exists.
   */
  async rebindActiveSource(
    projectId: string,
    threadId: string,
    sourceMessageId: string
  ): Promise<void> {
    assertId(projectId)
    assertId(threadId)
    assertId(sourceMessageId)
    const active = this.db.get<{ turn_id: string | null }>(
      'SELECT turn_id FROM active_turns WHERE project_id = ? AND thread_id = ?',
      projectId,
      threadId
    )
    if (!active?.turn_id) return
    const checkpoint = await this.get(projectId, threadId, active.turn_id)
    if (!checkpoint || checkpoint.status !== 'active') return
    if (checkpoint.sourceMessageId === sourceMessageId) return
    await this.save({ ...checkpoint, sourceMessageId })
  }

  async markActiveInterrupted(projectId: string, threadId: string): Promise<TurnCheckpoint | null> {
    const active = this.db.get<{ turn_id: string | null }>(
      'SELECT turn_id FROM active_turns WHERE project_id = ? AND thread_id = ?',
      projectId,
      threadId
    )
    if (!active?.turn_id) return null
    const checkpoint = await this.get(projectId, threadId, active.turn_id)
    if (!checkpoint || checkpoint.status !== 'active') return checkpoint
    const interruption = `${APP_NAME} stopped before the harness reported completion.`
    try {
      return await this.completeTurn(
        projectId,
        threadId,
        checkpoint.id,
        checkpoint.before.projectRoot,
        'interrupted',
        interruption
      )
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const updated: TurnCheckpoint = {
        ...checkpoint,
        status: 'interrupted',
        failure: boundCheckpointFailure(`${interruption} Change capture failed: ${detail}`)
      }
      await this.save(updated)
      await this.writeRow('DELETE FROM active_turns WHERE project_id = ? AND thread_id = ?', [
        projectId,
        threadId
      ])
      return updated
    }
  }

  /**
   * Finalize the active turn as completed when restart recovery finds that the
   * harness demonstrably produced a terminal answer before the app stopped.
   * Distinct from `markActiveInterrupted`: no interruption failure text and no
   * premature partial snapshot   the full `before` → current disk diff is kept.
   */
  async markActiveCompleted(projectId: string, threadId: string): Promise<TurnCheckpoint | null> {
    const active = this.db.get<{ turn_id: string | null }>(
      'SELECT turn_id FROM active_turns WHERE project_id = ? AND thread_id = ?',
      projectId,
      threadId
    )
    if (!active?.turn_id) return null
    const checkpoint = await this.get(projectId, threadId, active.turn_id)
    if (!checkpoint || checkpoint.status !== 'active') return checkpoint
    try {
      return await this.completeTurn(
        projectId,
        threadId,
        checkpoint.id,
        checkpoint.before.projectRoot,
        'completed'
      )
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const updated: TurnCheckpoint = {
        ...checkpoint,
        status: 'completed',
        failure: boundCheckpointFailure(
          `Change capture failed while finalizing a completed turn: ${detail}`
        )
      }
      await this.save(updated)
      await this.writeRow('DELETE FROM active_turns WHERE project_id = ? AND thread_id = ?', [
        projectId,
        threadId
      ])
      return updated
    }
  }

  /** Downgrade a captured checkpoint when post-turn contract validation fails. */
  async markFailed(
    projectId: string,
    threadId: string,
    turnId: string,
    failure: string
  ): Promise<TurnCheckpoint> {
    const checkpoint = await this.get(projectId, threadId, turnId)
    if (!checkpoint) throw new Error(`Turn checkpoint not found: ${turnId}`)
    const updated: TurnCheckpoint = {
      ...checkpoint,
      status: 'failed',
      failure: boundCheckpointFailure(failure),
      completedAt: checkpoint.completedAt ?? Date.now()
    }
    await this.save(updated)
    await this.writeRow('DELETE FROM active_turns WHERE project_id = ? AND thread_id = ?', [
      projectId,
      threadId
    ])
    return updated
  }

  async list(projectId: string, threadId: string): Promise<TurnCheckpoint[]> {
    assertId(projectId)
    assertId(threadId)
    const rows = await this.queryRows(
      'SELECT data FROM turn_checkpoints WHERE project_id = ? AND thread_id = ? ORDER BY created_at DESC',
      [projectId, threadId],
      10_000
    )
    return rows.map((row) =>
      this.recoverUnfilteredChanges(projectId, JSON.parse(String(row['data'])) as TurnCheckpoint)
    )
  }

  /** Host bridge for the one-time maintenance passes. */
  private maintenanceHost(): CheckpointMaintenanceHost {
    return {
      get: (projectId, threadId, turnId) => this.get(projectId, threadId, turnId),
      save: (checkpoint) => this.save(checkpoint),
      tracker: (projectId) => this.tracker(projectId),
      queryRows: (sql, params, maxRows) => this.queryRows(sql, params, maxRows),
      withBlobLock: (projectId, operation) => this.withBlobLock(projectId, operation)
    }
  }

  async repairTruncatedLineStats(): Promise<number> {
    return repairTruncatedLineStats(this.maintenanceHost())
  }

  async repairMisattributedInternalCheckpoints(): Promise<number> {
    return repairMisattributedInternalCheckpoints(this.maintenanceHost())
  }

  /** Re-open a recently completed checkpoint so late tool claims   edits that
   *  landed after the engine settled the turn (e.g. a harness reported a
   *  usage-reset settle while the model was still working)   are captured in
   *  the same turn's card instead of falling outside every checkpoint. The
   *  reopened turn resumes with its recorded changes and is re-completed by
   *  the next idle finalization. Returns null when no terminal checkpoint is
   *  recent enough to be safely reopened. */
  async reopenTurn(
    projectId: string,
    threadId: string,
    maxAgeMs: number
  ): Promise<TurnCheckpoint | null> {
    assertId(projectId)
    assertId(threadId)
    return this.withBlobLock(projectId, async () => {
      const rows = await this.queryRows(
        `SELECT turn_id, data FROM turn_checkpoints
         WHERE project_id = ? AND thread_id = ?
           AND json_extract(data, '$.status') IN ('completed', 'failed')
           AND json_extract(data, '$.completedAt') >= ?
         ORDER BY json_extract(data, '$.completedAt') DESC`,
        [projectId, threadId, Date.now() - maxAgeMs],
        1
      )
      const row = rows[0]
      if (!row) return null
      const turnId = String(row['turn_id'])
      const checkpoint = JSON.parse(String(row['data'])) as TurnCheckpoint
      const reopened: TurnCheckpoint = { ...checkpoint, status: 'active' }
      delete reopened.completedAt
      await this.save(reopened)
      await this.writeRow(
        'INSERT OR REPLACE INTO active_turns(project_id, thread_id, turn_id, owner_pid) VALUES(?, ?, ?, ?)',
        [projectId, threadId, turnId, process.pid]
      )
      return reopened
    })
  }

  /** Remove project checkpoint blobs that no remaining thread references. */
  async pruneUnusedBlobs(projectId: string): Promise<number> {
    return pruneUnusedBlobs(this.maintenanceHost(), projectId)
  }

  async listSummaries(projectId: string, threadId: string): Promise<TurnCheckpointSummary[]> {
    return (await this.list(projectId, threadId)).map((checkpoint) => ({
      id: checkpoint.id,
      projectId: checkpoint.projectId,
      threadId: checkpoint.threadId,
      ...(checkpoint.sourceMessageId ? { sourceMessageId: checkpoint.sourceMessageId } : {}),
      label: checkpoint.label,
      status: checkpoint.status,
      changes: checkpoint.changes.map((change): TurnCheckpointChangeSummary => ({
        path: change.path,
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
      createdAt: checkpoint.createdAt,
      completedAt: checkpoint.completedAt,
      rolledBackAt: checkpoint.rolledBackAt,
      rolledBackPaths: checkpoint.rolledBackPaths,
      failure: checkpoint.failure,
      ...(checkpoint.after?.skippedFiles && checkpoint.after.skippedFiles.length > 0
        ? { skippedFiles: checkpoint.after.skippedFiles }
        : {}),
      gitHead: checkpoint.before.git?.head
    }))
  }

  async getFileDiff(
    projectId: string,
    threadId: string,
    turnId: string,
    path: string
  ): Promise<TurnCheckpointFileDiff> {
    const checkpoint = await this.get(projectId, threadId, turnId)
    if (!checkpoint) throw new Error(`Turn checkpoint not found: ${turnId}`)
    const change = checkpoint.changes.find((candidate) => candidate.path === path)
    if (!change) {
      // Stale renderer state (or a change filtered out at completion) can
      // request a path this checkpoint never recorded. Serve the live diff
      // for it instead of throwing so a hover popover degrades gracefully.
      return this.getLiveFileDiff(projectId, threadId, turnId, path)
    }
    const binary = change.before?.binary ?? change.after?.binary ?? false
    if (binary) {
      return { path, kind: change.kind, binary: true, truncated: false }
    }
    const tracker = this.tracker(projectId)
    const before = change.before ? await tracker.readBlob(change.before.hash) : null
    const after = change.after ? await tracker.readBlob(change.after.hash) : null
    if (change.before && !before) throw new Error(`Checkpoint blob is unavailable for ${path}`)
    if (change.after && !after) throw new Error(`Checkpoint blob is unavailable for ${path}`)
    const window = decodeDiffWindow(before, after, MAX_DIFF_WINDOW_BYTES, DIFF_WINDOW_CONTEXT_BYTES)
    return {
      path,
      kind: change.kind,
      binary: false,
      before: window.before,
      after: window.after,
      truncated: window.truncated
    }
  }

  async get(projectId: string, threadId: string, turnId: string): Promise<TurnCheckpoint | null> {
    assertId(projectId)
    assertId(threadId)
    assertId(turnId)
    const rows = await this.queryRows(
      'SELECT data FROM turn_checkpoints WHERE turn_id = ?',
      [turnId],
      2
    )
    const row = rows[0]
    return row
      ? this.recoverUnfilteredChanges(projectId, JSON.parse(String(row['data'])) as TurnCheckpoint)
      : null
  }

  /** The thread's most recently completed checkpoint, if any. Internal
   *  continuation prompts (search nudges, mermaid repairs, incomplete-turn
   *  retries) start a new turn after the previous one completed; they inherit
   *  this checkpoint's attribution so the resulting file-changes card reports
   *  against the user's original message instead of the hidden prompt text. */
  async getLatestCompleted(projectId: string, threadId: string): Promise<TurnCheckpoint | null> {
    assertId(projectId)
    assertId(threadId)
    const rows = await this.queryRows(
      `SELECT data FROM turn_checkpoints
       WHERE project_id = ? AND thread_id = ? AND json_extract(data, '$.status') != 'active'
       ORDER BY json_extract(data, '$.createdAt') DESC`,
      [projectId, threadId],
      1
    )
    const row = rows[0]
    return row
      ? this.recoverUnfilteredChanges(projectId, JSON.parse(String(row['data'])) as TurnCheckpoint)
      : null
  }

  /** The thread's in-flight checkpoint, if a turn is currently running. */
  async getActive(projectId: string, threadId: string): Promise<TurnCheckpoint | null> {
    assertId(projectId)
    assertId(threadId)
    const active = this.db.get<{ turn_id: string | null }>(
      'SELECT turn_id FROM active_turns WHERE project_id = ? AND thread_id = ?',
      projectId,
      threadId
    )
    if (!active?.turn_id) return null
    const checkpoint = await this.get(projectId, threadId, active.turn_id)
    return checkpoint && checkpoint.status === 'active' ? checkpoint : null
  }

  /**
   * Diff one file of the in-flight turn: `before` comes from the checkpoint's
   * opening snapshot blob, `after` is read straight from disk. Nothing is
   * persisted mid-turn, so this complements `getFileDiff`, which only serves
   * changes recorded at completion.
   */
  async getLiveFileDiff(
    projectId: string,
    threadId: string,
    turnId: string,
    path: string
  ): Promise<TurnCheckpointFileDiff> {
    const checkpoint = await this.get(projectId, threadId, turnId)
    if (!checkpoint) throw new Error(`Turn checkpoint not found: ${turnId}`)
    if (checkpoint.status !== 'active') {
      throw new Error(`Turn checkpoint is no longer active: ${turnId}`)
    }
    // Unlike persisted diffs (which only serve recorded change paths), a live
    // turn legitimately creates files absent from its opening snapshot   so
    // membership is enforced as containment within the project root instead.
    const root = resolve(checkpoint.before.projectRoot)
    const absolutePath = resolve(join(root, path))
    if (absolutePath !== root && !absolutePath.startsWith(root + sep)) {
      throw new Error(`Path is outside this checkpoint's project: ${path}`)
    }
    const beforeFile = checkpoint.before.files[path]
    const tracker = this.tracker(projectId)
    const before = beforeFile ? await tracker.readBlob(beforeFile.hash) : null
    if (beforeFile && !before) throw new Error(`Checkpoint blob is unavailable for ${path}`)
    let after: Uint8Array | null = null
    try {
      after = await readFile(absolutePath)
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    if (after !== null && isBinary(after)) {
      return { path, kind: beforeFile ? 'modified' : 'created', binary: true, truncated: false }
    }
    const window = decodeDiffWindow(before, after, MAX_DIFF_WINDOW_BYTES, DIFF_WINDOW_CONTEXT_BYTES)
    return {
      path,
      kind: beforeFile ? (after ? 'modified' : 'deleted') : 'created',
      binary: false,
      before: window.before,
      after: window.after,
      truncated: window.truncated
    }
  }

  /**
   * Older checkpoints can have complete before/after snapshots but no recorded
   * path filter. Rebuild their diff on read so persisted turns remain visible
   * and rollback-capable after the checkpoint format evolved.
   */
  private recoverUnfilteredChanges(projectId: string, checkpoint: TurnCheckpoint): TurnCheckpoint {
    // Read-time heal for legacy poison: checkpoints written before the failure
    // bound could carry an entire agent transcript as `failure`. Overlong
    // failure text is never a legitimate explanation   strip it so it can
    // never splash into the run-changes card, regardless of when it was saved.
    const healed =
      checkpoint.failure !== undefined && checkpoint.failure.length > MAX_CHECKPOINT_FAILURE_LENGTH
        ? { ...checkpoint, failure: undefined }
        : checkpoint
    if (healed.changes.length > 0 || !healed.after || healed.changeFilterApplied === true) {
      return healed
    }
    const changes = this.tracker(projectId).calculateChanges(healed.before, healed.after)
    return changes.length > 0 ? { ...healed, changes } : healed
  }

  async rollback(projectId: string, threadId: string, turnId: string): Promise<TurnCheckpoint> {
    const checkpoint = await this.get(projectId, threadId, turnId)
    if (!checkpoint) throw new Error(`Turn checkpoint not found: ${turnId}`)
    if (checkpoint.status === 'rolled_back') return checkpoint
    if (checkpoint.changes.length === 0) return checkpoint
    return this.rollbackPaths(
      projectId,
      threadId,
      turnId,
      checkpoint.changes.map((change) => change.path)
    )
  }

  async rollbackPaths(
    projectId: string,
    threadId: string,
    turnId: string,
    paths: string[]
  ): Promise<TurnCheckpoint> {
    const checkpoint = await this.get(projectId, threadId, turnId)
    if (!checkpoint) throw new Error(`Turn checkpoint not found: ${turnId}`)
    if (!checkpoint.after) throw new Error('Checkpoint has no completed after-state')
    const selected = new Set(paths)
    if (selected.size === 0) throw new Error('Select at least one checkpoint path to restore')
    const recordedPaths = new Set(checkpoint.changes.map((change) => change.path))
    for (const path of selected) {
      if (!recordedPaths.has(path)) throw new Error(`Path is not part of this checkpoint: ${path}`)
    }

    const tracker = this.tracker(projectId)
    const current = await tracker.snapshot(checkpoint.before.projectRoot, {
      includeGitMetadata: checkpoint.before.git !== undefined
    })
    for (const path of selected) {
      const expected = checkpoint.after.files[path]
      const actual = current.files[path]
      if (expected?.hash !== actual?.hash) {
        throw new Error(
          `Refusing to restore ${path}: it changed after this checkpoint was captured`
        )
      }
    }
    await tracker.restoreBefore(checkpoint.before, current, selected)
    const rolledBackPaths = [
      ...new Set([...(checkpoint.rolledBackPaths ?? []), ...selected])
    ].sort()
    const fullyRolledBack = checkpoint.changes.every((change) =>
      rolledBackPaths.includes(change.path)
    )
    const updated: TurnCheckpoint = {
      ...checkpoint,
      status: fullyRolledBack ? 'rolled_back' : checkpoint.status,
      rolledBackAt: Date.now(),
      rolledBackPaths
    }
    await this.save(updated)
    return updated
  }

  /** Re-applies the captured `after`-state for previously undone paths, so a
   *  rolled-back turn (or selection) can be redone from its snapshot. Only
   *  paths recorded in `rolledBackPaths` may be redone, and only when the
   *  working tree still matches the checkpoint's `before`-state for them. */
  async redoPaths(
    projectId: string,
    threadId: string,
    turnId: string,
    paths: string[]
  ): Promise<TurnCheckpoint> {
    const checkpoint = await this.get(projectId, threadId, turnId)
    if (!checkpoint) throw new Error(`Turn checkpoint not found: ${turnId}`)
    if (!checkpoint.after) throw new Error('Checkpoint has no completed after-state')
    const selected = new Set(paths)
    if (selected.size === 0) throw new Error('Select at least one checkpoint path to redo')
    const recordedPaths = new Set(checkpoint.changes.map((change) => change.path))
    const rolledBackPaths = new Set(checkpoint.rolledBackPaths ?? [])
    for (const path of selected) {
      if (!recordedPaths.has(path)) throw new Error(`Path is not part of this checkpoint: ${path}`)
      if (!rolledBackPaths.has(path)) throw new Error(`Path has not been undone: ${path}`)
    }

    const tracker = this.tracker(projectId)
    const current = await tracker.snapshot(checkpoint.before.projectRoot, {
      includeGitMetadata: checkpoint.before.git !== undefined
    })
    for (const path of selected) {
      const expected = checkpoint.before.files[path]
      const actual = current.files[path]
      if (expected?.hash !== actual?.hash) {
        throw new Error(`Refusing to redo ${path}: it changed after it was undone`)
      }
    }
    await tracker.restoreAfter(checkpoint.before, checkpoint.after, selected)
    const remainingRolledBack = [...rolledBackPaths].filter((path) => !selected.has(path))
    const updated: TurnCheckpoint = {
      ...checkpoint,
      status: remainingRolledBack.length === 0 ? 'completed' : 'rolled_back',
      rolledBackPaths: remainingRolledBack
    }
    await this.save(updated)
    return updated
  }

  private async save(checkpoint: TurnCheckpoint): Promise<void> {
    const stored = this.compactCheckpoint(checkpoint)
    await this.writeRow(
      'INSERT OR REPLACE INTO turn_checkpoints(turn_id, project_id, thread_id, data, created_at) VALUES(?, ?, ?, ?, ?)',
      [stored.id, stored.projectId, stored.threadId, JSON.stringify(stored), stored.createdAt]
    )
  }

  /**
   * Prune the project-wide `before`/`after` file maps down to the changed
   * paths. The full maps duplicate the per-change snapshots and dominate the
   * row size (each entry is a tracked repo file), so a finished checkpoint only
   * retains what rollback, summaries, diffs, and blob pruning actually need.
   * Unfiltered empty checkpoints keep their maps for legacy recovery. A
   * filtered empty checkpoint has proved that it owns no paths, so retaining
   * two full project maps would waste storage on every read-only turn.
   */
  private compactCheckpoint(checkpoint: TurnCheckpoint): TurnCheckpoint {
    if (checkpoint.changes.length === 0 && checkpoint.changeFilterApplied !== true) {
      return checkpoint
    }
    const paths = new Set(checkpoint.changes.map((change) => change.path))
    const trimFiles = (snapshot: ProjectCheckpoint): ProjectCheckpoint => {
      const files: Record<string, CheckpointFile> = {}
      for (const path of paths) {
        const file = snapshot.files[path]
        if (file) files[path] = file
      }
      return { ...snapshot, files }
    }
    return {
      ...checkpoint,
      before: trimFiles(checkpoint.before),
      ...(checkpoint.after ? { after: trimFiles(checkpoint.after) } : {})
    }
  }

  /**
   * Bounded read on the maintenance worker's connection so disk I/O and SQLite
   * iteration never block the Electron main process. A byte-truncated result is
   * returned as-is   re-running the query unbounded on the primary connection
   * would move exactly the oversized payload this boundary exists to avoid back
   * onto the main thread. The primary connection is only consulted when the
   * worker is unavailable (e.g. in-memory test databases).
   */
  private async queryRows(
    sql: string,
    params: unknown[],
    maxRows: number
  ): Promise<Record<string, unknown>[]> {
    const result = await this.db.queryViaWorker(sql, params, maxRows)
    if (!result.ok) {
      return this.db.all<Record<string, unknown>>(sql, ...params)
    }
    return result.rows ?? []
  }

  /** Single write statement on the maintenance worker's connection (primary fallback). */
  private async writeRow(sql: string, params: unknown[]): Promise<void> {
    const result = await this.db.executeViaWorker(sql, params)
    if (!result.ok) {
      throw new Error(result.error ?? 'checkpoint write failed')
    }
  }
}
