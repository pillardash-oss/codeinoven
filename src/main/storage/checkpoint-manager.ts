import { mkdir, readFile, readdir, rm, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { APP_NAME } from '../../lib/brand'
import { generateId, getConfigRoot } from '../../lib/utils'
import type {
  TurnCheckpointChangeSummary,
  TurnCheckpointFileDiff,
  TurnCheckpointStatus,
  TurnCheckpointSummary
} from '../../lib/types'
import type { Database } from '../database/database'
import {
  ChangeTrackingService,
  type CheckpointBlobStore,
  type CheckpointChange,
  type CheckpointFile,
  type ProjectCheckpoint,
  type ProjectFingerprint
} from '../git/change-tracking-service'

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

interface CheckpointLineStats {
  additions?: number
  deletions?: number
  truncated?: boolean
}

const MAX_LINE_DIFF_BYTES = 1024 * 1024
const MAX_LINE_DIFF_LINES = 20_000
const MAX_LINE_DIFF_DISTANCE = 4_000
const MAX_LINE_DIFF_WORK = 4_000_000
/** Byte window returned for a per-file diff. Kept small to bound IPC payloads. */
const MAX_DIFF_WINDOW_BYTES = 64 * 1024
/** Context bytes kept around the changed region so the diff reads naturally. */
const DIFF_WINDOW_CONTEXT_BYTES = 8 * 1024

class StorageCheckpointBlobStore implements CheckpointBlobStore {
  constructor(private readonly projectId: string) {}

  async put(hash: string, content: Uint8Array): Promise<void> {
    assertHash(hash)
    const path = join(getConfigRoot(), `projects/${this.projectId}/blobs/${hash}`)
    await mkdir(dirname(path), { recursive: true })
    try {
      await writeFile(path, content, { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if (!isAlreadyExists(error)) throw error
    }
  }

  async get(hash: string): Promise<Uint8Array | null> {
    assertHash(hash)
    try {
      return await readFile(join(getConfigRoot(), `projects/${this.projectId}/blobs/${hash}`))
    } catch (error) {
      if (isMissing(error)) {
        try {
          return await readFile(join(getConfigRoot(), `blobs/${hash}`))
        } catch (legacyError) {
          if (isMissing(legacyError)) return null
          throw legacyError
        }
      }
      throw error
    }
  }
}

/**
 * Persists pre/post-turn checkpoints and exposes selective, snapshot-backed rollback.
 * It never uses git reset or rewrites paths that are absent from the recorded diff.
 */
export class CheckpointManager {
  private readonly trackers = new Map<string, ChangeTrackingService>()

  constructor(private readonly db: Database) {}

  private tracker(projectId: string): ChangeTrackingService {
    const existing = this.trackers.get(projectId)
    if (existing) return existing
    const tracker = new ChangeTrackingService(new StorageCheckpointBlobStore(projectId))
    this.trackers.set(projectId, tracker)
    return tracker
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
      'INSERT OR REPLACE INTO active_turns(project_id, thread_id, turn_id) VALUES(?, ?, ?)',
      [projectId, threadId, id]
    )
    return checkpoint
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
    changedPaths?: ReadonlySet<string>
  ): Promise<TurnCheckpoint> {
    const checkpoint = await this.get(projectId, threadId, turnId)
    if (!checkpoint) throw new Error(`Turn checkpoint not found: ${turnId}`)
    if (checkpoint.status !== 'active' && checkpoint.status !== 'interrupted') return checkpoint

    const tracker = this.tracker(projectId)
    const after = await tracker.snapshot(projectPath, {
      includeGitMetadata: checkpoint.before.git !== undefined
    })
    const allChanges = tracker.calculateChanges(checkpoint.before, after)
    const changes = changedPaths
      ? allChanges.filter((change) => changedPaths.has(change.path))
      : allChanges
    const updated: TurnCheckpoint = {
      ...checkpoint,
      status,
      after,
      changes,
      changeFilterApplied: changedPaths !== undefined,
      lineStats: await this.calculateLineStats(tracker, changes),
      completedAt: Date.now(),
      ...(failure ? { failure } : {})
    }
    await this.save(updated)
    await this.writeRow('DELETE FROM active_turns WHERE project_id = ? AND thread_id = ?', [
      projectId,
      threadId
    ])
    return updated
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
        failure: `${interruption} Change capture failed: ${detail}`
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
   * premature partial snapshot — the full `before` → current disk diff is kept.
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
        failure: `Change capture failed while finalizing a completed turn: ${detail}`
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
      failure,
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
    const rows = await this.queryDataRows(
      'SELECT data FROM turn_checkpoints WHERE project_id = ? AND thread_id = ? ORDER BY created_at DESC',
      [projectId, threadId],
      10_000
    )
    return rows.map((row) =>
      this.recoverUnfilteredChanges(projectId, JSON.parse(row.data) as TurnCheckpoint)
    )
  }

  /** Remove project checkpoint blobs that no remaining thread references. */
  async pruneUnusedBlobs(projectId: string): Promise<number> {
    assertId(projectId)
    const referenced = new Set<string>()
    const rows = await this.queryDataRows(
      'SELECT data FROM turn_checkpoints WHERE project_id = ?',
      [projectId],
      100_000
    )
    for (const row of rows) {
      try {
        const checkpoint = JSON.parse(row.data) as TurnCheckpoint
        for (const file of Object.values(checkpoint.before.files)) referenced.add(file.hash)
        for (const file of Object.values(checkpoint.after?.files ?? {})) referenced.add(file.hash)
      } catch {
        // A corrupt remaining checkpoint cannot safely identify its blobs, so
        // preserve the project blob directory rather than risk data loss.
        return 0
      }
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
    if (!change) throw new Error(`Path is not part of this checkpoint: ${path}`)
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
    const rows = await this.queryDataRows(
      'SELECT data FROM turn_checkpoints WHERE turn_id = ?',
      [turnId],
      2
    )
    const row = rows[0]
    return row
      ? this.recoverUnfilteredChanges(projectId, JSON.parse(row.data) as TurnCheckpoint)
      : null
  }

  /**
   * Checkpoints written before path-filter provenance was stored can contain
   * complete before/after snapshots but an empty change list when a harness's
   * mutation tool name was unknown. Rebuild that unfiltered diff on read so
   * those already-finished turns remain reviewable and rollback-capable.
   */
  private recoverUnfilteredChanges(projectId: string, checkpoint: TurnCheckpoint): TurnCheckpoint {
    if (
      checkpoint.changes.length > 0 ||
      !checkpoint.after ||
      checkpoint.changeFilterApplied === true
    ) {
      return checkpoint
    }
    const changes = this.tracker(projectId).calculateChanges(checkpoint.before, checkpoint.after)
    return changes.length > 0 ? { ...checkpoint, changes } : checkpoint
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
   * Checkpoints with an empty change list keep their full maps so the legacy
   * `recoverUnfilteredChanges` pass can still rebuild the diff.
   */
  private compactCheckpoint(checkpoint: TurnCheckpoint): TurnCheckpoint {
    if (checkpoint.changes.length === 0) return checkpoint
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
   * Bounded `turn_checkpoints.data` read on the maintenance worker's
   * connection so disk I/O and SQLite iteration never block the Electron main
   * process. Falls back to the primary connection when the worker is
   * unavailable or a query cannot be served.
   */
  private async queryDataRows(
    sql: string,
    params: unknown[],
    maxRows: number
  ): Promise<Array<{ data: string }>> {
    const result = await this.db.queryViaWorker(sql, params, maxRows)
    if (result.ok && !result.truncated) {
      return result.rows as Array<{ data: string }>
    }
    return this.db.all<{ data: string }>(sql, ...params)
  }

  /** Single write statement on the maintenance worker's connection (primary fallback). */
  private async writeRow(sql: string, params: unknown[]): Promise<void> {
    const result = await this.db.executeViaWorker(sql, params)
    if (!result.ok) {
      throw new Error(result.error ?? 'checkpoint write failed')
    }
  }

  private async calculateLineStats(
    tracker: ChangeTrackingService,
    changes: CheckpointChange[]
  ): Promise<Record<string, CheckpointLineStats>> {
    const stats: Record<string, CheckpointLineStats> = {}
    for (const change of changes) {
      if (change.before?.binary ?? change.after?.binary ?? false) continue
      const before = change.before ? await tracker.readBlob(change.before.hash) : new Uint8Array()
      const after = change.after ? await tracker.readBlob(change.after.hash) : new Uint8Array()
      if (change.before && !before)
        throw new Error(`Checkpoint blob is unavailable for ${change.path}`)
      if (change.after && !after)
        throw new Error(`Checkpoint blob is unavailable for ${change.path}`)
      stats[change.path] = calculateBoundedLineStats(
        before ?? new Uint8Array(),
        after ?? new Uint8Array()
      )
    }
    return stats
  }
}

function assertId(value: string): void {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error(`Unsafe checkpoint identifier: ${value}`)
}

function assertHash(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`Invalid checkpoint blob hash: ${value}`)
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

function calculateBoundedLineStats(
  beforeContent: Uint8Array,
  afterContent: Uint8Array
): CheckpointLineStats {
  if (
    beforeContent.byteLength > MAX_LINE_DIFF_BYTES ||
    afterContent.byteLength > MAX_LINE_DIFF_BYTES
  ) {
    return { truncated: true }
  }

  let before: string[]
  let after: string[]
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    before = splitLines(decoder.decode(beforeContent))
    after = splitLines(decoder.decode(afterContent))
  } catch {
    return { truncated: true }
  }
  if (before.length + after.length > MAX_LINE_DIFF_LINES) {
    return { truncated: true }
  }

  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1
  }
  let beforeEnd = before.length
  let afterEnd = after.length
  while (beforeEnd > prefix && afterEnd > prefix && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd -= 1
    afterEnd -= 1
  }

  const oldLines = before.slice(prefix, beforeEnd)
  const newLines = after.slice(prefix, afterEnd)
  if (oldLines.length === 0) return { additions: newLines.length, deletions: 0 }
  if (newLines.length === 0) return { additions: 0, deletions: oldLines.length }

  const distance = boundedEditDistance(oldLines, newLines)
  if (distance === null) return { truncated: true }
  const delta = newLines.length - oldLines.length
  return {
    additions: (distance + delta) / 2,
    deletions: (distance - delta) / 2
  }
}

function boundedEditDistance(before: string[], after: string[]): number | null {
  const maximumDistance = Math.min(before.length + after.length, MAX_LINE_DIFF_DISTANCE)
  const offset = maximumDistance + 1
  const frontier = new Int32Array(maximumDistance * 2 + 3)
  frontier.fill(-1)
  frontier[offset + 1] = 0
  let work = 0

  for (let distance = 0; distance <= maximumDistance; distance += 1) {
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      work += 1
      if (work > MAX_LINE_DIFF_WORK) return null
      const index = offset + diagonal
      let oldIndex =
        diagonal === -distance ||
        (diagonal !== distance && frontier[index - 1] < frontier[index + 1])
          ? frontier[index + 1]
          : frontier[index - 1] + 1
      let newIndex = oldIndex - diagonal
      while (
        oldIndex < before.length &&
        newIndex < after.length &&
        before[oldIndex] === after[newIndex]
      ) {
        oldIndex += 1
        newIndex += 1
        work += 1
        if (work > MAX_LINE_DIFF_WORK) return null
      }
      frontier[index] = oldIndex
      if (oldIndex >= before.length && newIndex >= after.length) return distance
    }
  }
  return null
}

function splitLines(content: string): string[] {
  if (!content) return []
  const lines = content.split(/\r?\n/u)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

interface DecodedDiffWindow {
  before: string | undefined
  after: string | undefined
  truncated: boolean
}

/**
 * Returns a bounded text window around the changed region of a file instead of
 * always the head. Without this, an edit sitting past the first `maxBytes` of a
 * large file made the diff look empty ("No textual changes"). For created or
 * deleted files the existing side is shown from its head.
 */
function decodeDiffWindow(
  before: Uint8Array | null,
  after: Uint8Array | null,
  maxBytes: number,
  contextBytes: number
): DecodedDiffWindow {
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true })

  if (!before || !after) {
    const content = before ?? after
    if (!content) return { before: undefined, after: undefined, truncated: false }
    const truncated = content.length > maxBytes
    const text = decoder.decode(content.subarray(0, maxBytes))
    return before
      ? { before: text, after: undefined, truncated }
      : { before: undefined, after: text, truncated }
  }

  const minLength = Math.min(before.length, after.length)
  let prefix = 0
  while (prefix < minLength && before[prefix] === after[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < minLength - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const changeEnd = Math.max(before.length - suffix, after.length - suffix)
  const changeSize = changeEnd - prefix

  const fitsWithContext = changeSize + contextBytes * 2 <= maxBytes
  let start = fitsWithContext
    ? Math.max(0, prefix - contextBytes)
    : Math.max(0, prefix + Math.floor(changeSize / 2) - Math.floor(maxBytes / 2))

  const snapped = lineStartIndex(before, start)
  if (snapped + maxBytes >= changeEnd) start = snapped

  const end = Math.min(start + maxBytes, Math.max(before.length, after.length))
  const beforeText = decoder.decode(before.subarray(start, Math.min(end, before.length)))
  const afterText = decoder.decode(after.subarray(start, Math.min(end, after.length)))
  const truncated = start > 0 || before.length > end || after.length > end
  return { before: beforeText, after: afterText, truncated }
}

/** Index just after the last newline at or before `index`, or 0. */
function lineStartIndex(data: Uint8Array, index: number): number {
  if (index <= 0) return 0
  let current = index
  while (current > 0 && data[current - 1] !== 0x0a) current -= 1
  return current
}
