import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { APP_NAME } from '../lib/brand'
import { generateId, getConfigRoot } from '../lib/utils'
import type {
  TurnCheckpointChangeSummary,
  TurnCheckpointFileDiff,
  TurnCheckpointStatus,
  TurnCheckpointSummary
} from '../lib/types'
import type { Database } from './database/database'
import {
  ChangeTrackingService,
  type CheckpointBlobStore,
  type CheckpointChange,
  type ProjectCheckpoint
} from './change-tracking-service'

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
  constructor(private readonly db: Database) {}

  private tracker(projectId: string): ChangeTrackingService {
    return new ChangeTrackingService(new StorageCheckpointBlobStore(projectId))
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
    this.db.run(
      'INSERT OR REPLACE INTO active_turns(project_id, thread_id, turn_id) VALUES(?, ?, ?)',
      projectId,
      threadId,
      id
    )
    return checkpoint
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
    this.db.run(
      'DELETE FROM active_turns WHERE project_id = ? AND thread_id = ?',
      projectId,
      threadId
    )
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
      this.db.run(
        'DELETE FROM active_turns WHERE project_id = ? AND thread_id = ?',
        projectId,
        threadId
      )
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
    this.db.run(
      'DELETE FROM active_turns WHERE project_id = ? AND thread_id = ?',
      projectId,
      threadId
    )
    return updated
  }

  async list(projectId: string, threadId: string): Promise<TurnCheckpoint[]> {
    assertId(projectId)
    assertId(threadId)
    const rows = this.db.all<{ data: string }>(
      'SELECT data FROM turn_checkpoints WHERE project_id = ? AND thread_id = ? ORDER BY created_at DESC',
      projectId,
      threadId
    )
    return rows.map((row) =>
      this.recoverUnfilteredChanges(projectId, JSON.parse(row.data) as TurnCheckpoint)
    )
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
    const maxBytes = 64 * 1024
    const before = change.before ? await tracker.readBlob(change.before.hash) : null
    const after = change.after ? await tracker.readBlob(change.after.hash) : null
    if (change.before && !before) throw new Error(`Checkpoint blob is unavailable for ${path}`)
    if (change.after && !after) throw new Error(`Checkpoint blob is unavailable for ${path}`)
    const decode = (content: Uint8Array | null): string | undefined =>
      content ? new TextDecoder().decode(content.subarray(0, maxBytes)) : undefined
    return {
      path,
      kind: change.kind,
      binary: false,
      before: decode(before),
      after: decode(after),
      truncated: (before?.byteLength ?? 0) > maxBytes || (after?.byteLength ?? 0) > maxBytes
    }
  }

  async get(projectId: string, threadId: string, turnId: string): Promise<TurnCheckpoint | null> {
    assertId(projectId)
    assertId(threadId)
    assertId(turnId)
    const row = this.db.get<{ data: string }>(
      'SELECT data FROM turn_checkpoints WHERE turn_id = ?',
      turnId
    )
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
    this.db.run(
      'INSERT OR REPLACE INTO turn_checkpoints(turn_id, project_id, thread_id, data, created_at) VALUES(?, ?, ?, ?, ?)',
      checkpoint.id,
      checkpoint.projectId,
      checkpoint.threadId,
      JSON.stringify(checkpoint),
      checkpoint.createdAt
    )
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
