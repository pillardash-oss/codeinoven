import type { DesignRevisionCause } from '../../../lib/ipc/design'
import type { Database } from '../database'

/**
 * The durable side of a design's history.
 *
 * A design is iterated, and each iteration is kept as a whole-folder snapshot so
 * the user can step back and forward through it the way Git lets them step through
 * a project's commits. The table holds the snapshot's file map (paths to the hash,
 * size and binary flag of each file) while the file content lives in the project's
 * design blob store under that hash, which is what makes an unchanged file cost one
 * blob no matter how many revisions hold it.
 *
 * Reads run on the database worker: a board asks for a folder's history on
 * interaction paths, so the listing must not touch SQLite on the Electron main
 * thread (see `docs/APP-BIBLE.md`). Writes stay on the primary connection, where
 * each one is a bounded single-row statement or a bounded prune.
 */

/** One file of a snapshot, as the app stores and restores it. */
export interface DesignRevisionFile {
  /** Path inside the design folder, with forward slashes. */
  path: string
  /** Content hash; the blob store addresses the bytes by this. */
  hash: string
  size: number
  binary: boolean
}

/** One stored revision: a snapshot of a folder at a point in its history. */
export interface StoredDesignRevision {
  id: string
  projectId: string
  /** Project-relative folder, with forward slashes. */
  directory: string
  /** Position in this folder's history, oldest first, starting at 1. */
  sequence: number
  /** The revision this one follows, or null for the first. */
  parentId: string | null
  cause: DesignRevisionCause
  label?: string
  checkpointEntry?: string
  /** Digest of the file map, so an unchanged folder matches a revision by value. */
  digest: string
  /** Path → file, the whole folder the revision restores to. */
  files: Record<string, DesignRevisionFile>
  /** Paths skipped for exceeding the per-file ceiling; never restorable. */
  skippedFiles: string[]
  /** Paths whose blob could not be persisted; never restorable. */
  unavailableFiles: string[]
  /** Paths added, changed, or removed from `parentId`. */
  changedFiles: number
  /** The paths behind `changedFiles`, so a timeline row can name what moved. */
  changedPaths: string[]
  fileCount: number
  totalBytes: number
  createdAt: number
}

/** What a timeline row needs, without the snapshot's file map. */
export interface StoredDesignRevisionSummary {
  id: string
  sequence: number
  cause: DesignRevisionCause
  label?: string
  checkpointEntry?: string
  changedFiles: number
  changedPaths: string[]
  fileCount: number
  totalBytes: number
  createdAt: number
}

/** One folder a project keeps history for, for reconciliation. */
export interface DesignHistoryFolderRef {
  projectId: string
  directory: string
}

interface RevisionRow {
  id: string
  project_id: string
  directory: string
  sequence: number
  parent_id: string | null
  cause: string
  label: string | null
  checkpoint_entry: string | null
  digest: string
  files: string
  skipped_files: string | null
  unavailable_files: string | null
  changed_files: number
  changed_paths: string | null
  file_count: number
  total_bytes: number
  created_at: number
}

interface SummaryRow {
  id: string
  sequence: number
  cause: string
  label: string | null
  checkpoint_entry: string | null
  changed_files: number
  changed_paths: string | null
  file_count: number
  total_bytes: number
  created_at: number
}

/** The stored cause, read back as a cause the board switches on. */
function causeOfRow(value: string): DesignRevisionCause {
  return value === 'initial' || value === 'agent' ? value : 'user'
}

/** Parse a stored JSON column, falling back to an empty value rather than failing. */
function parseJson<T>(value: string | null, fallback: T): T {
  if (value === null || value === '') return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

const REVISION_COLUMNS =
  'id, project_id, directory, sequence, parent_id, cause, digest, files, skipped_files, ' +
  'unavailable_files, changed_files, changed_paths, file_count, total_bytes, created_at, label, checkpoint_entry'

function toRevision(row: RevisionRow): StoredDesignRevision {
  return {
    id: row.id,
    projectId: row.project_id,
    directory: row.directory,
    sequence: row.sequence,
    parentId: row.parent_id,
    cause: causeOfRow(row.cause),
    label: row.label ?? undefined,
    checkpointEntry: row.checkpoint_entry ?? undefined,
    digest: row.digest,
    files: parseJson<Record<string, DesignRevisionFile>>(row.files, {}),
    skippedFiles: parseJson<string[]>(row.skipped_files, []),
    unavailableFiles: parseJson<string[]>(row.unavailable_files, []),
    changedFiles: row.changed_files,
    changedPaths: parseJson<string[]>(row.changed_paths, []),
    fileCount: row.file_count,
    totalBytes: row.total_bytes,
    createdAt: row.created_at
  }
}

function toSummary(row: SummaryRow): StoredDesignRevisionSummary {
  return {
    id: row.id,
    sequence: row.sequence,
    cause: causeOfRow(row.cause),
    label: row.label ?? undefined,
    checkpointEntry: row.checkpoint_entry ?? undefined,
    changedFiles: row.changed_files,
    changedPaths: parseJson<string[]>(row.changed_paths, []),
    fileCount: row.file_count,
    totalBytes: row.total_bytes,
    createdAt: row.created_at
  }
}

export class DesignRevisionRepo {
  constructor(private readonly db: Database) {}

  /** A folder's revisions, oldest first, bounded by `maxRows`. */
  async listViaWorker(
    projectId: string,
    directory: string,
    maxRows: number,
    afterSequence = 0
  ): Promise<StoredDesignRevision[]> {
    const result = await this.db.queryViaWorker(
      `SELECT ${REVISION_COLUMNS} FROM design_revisions
        WHERE project_id = ? AND directory = ? AND sequence > ?
        ORDER BY sequence ASC LIMIT ?`,
      [projectId, directory, afterSequence, maxRows],
      maxRows
    )
    if (!result.ok) return []
    return (result.rows as unknown as RevisionRow[]).map(toRevision)
  }

  /** Return one file's hashes without sending whole snapshots to the main process. */
  async fileStatesViaWorker(
    projectId: string,
    directory: string,
    path: string,
    maxRows: number
  ): Promise<
    Array<{
      id: string
      sequence: number
      createdAt: number
      hash: string | null
      label: string | null
      checkpointEntry: string | null
    }>
  > {
    const result = await this.db.queryViaWorker(
      `SELECT id, sequence, created_at, label, checkpoint_entry,
      (SELECT json_extract(value, '$.hash') FROM json_each(files) WHERE key = ? LIMIT 1) AS hash
      FROM design_revisions WHERE project_id = ? AND directory = ? ORDER BY sequence LIMIT ?`,
      [path, projectId, directory, maxRows],
      maxRows
    )
    if (!result.ok) throw new Error('File history could not be read')
    return (
      result.rows as Array<{
        id: string
        sequence: number
        created_at: number
        label: string | null
        checkpoint_entry: string | null
        hash: string | null
      }>
    ).map((row) => ({
      id: row.id,
      sequence: row.sequence,
      createdAt: row.created_at,
      label: row.label,
      checkpointEntry: row.checkpoint_entry,
      hash: row.hash
    }))
  }

  /**
   * A folder's revisions as timeline rows, without their file maps.
   *
   * The board never reads a snapshot to draw the timeline, so selecting the file
   * map here would ship every hash of every revision for a listing that only needs
   * counts.
   */
  async listSummariesViaWorker(
    projectId: string,
    directory: string,
    maxRows: number
  ): Promise<StoredDesignRevisionSummary[]> {
    const result = await this.db.queryViaWorker(
      `SELECT id, sequence, cause, label, checkpoint_entry, changed_files, changed_paths, file_count, total_bytes, created_at
         FROM design_revisions
        WHERE project_id = ? AND directory = ?
        ORDER BY sequence ASC LIMIT ?`,
      [projectId, directory, maxRows],
      maxRows
    )
    if (!result.ok) return []
    return (result.rows as unknown as SummaryRow[]).map(toSummary)
  }

  /** The newest revision whose file map matches `digest`, or null. */
  async findByDigestViaWorker(
    projectId: string,
    directory: string,
    digest: string
  ): Promise<StoredDesignRevision | null> {
    const result = await this.db.queryViaWorker(
      `SELECT ${REVISION_COLUMNS} FROM design_revisions
        WHERE project_id = ? AND directory = ? AND digest = ?
        ORDER BY sequence DESC LIMIT 1`,
      [projectId, directory, digest],
      1
    )
    if (!result.ok) return null
    const row = (result.rows as unknown as RevisionRow[])[0]
    return row ? toRevision(row) : null
  }

  /** The newest revision of a folder, or null when it has no history. */
  async getLatestViaWorker(
    projectId: string,
    directory: string
  ): Promise<StoredDesignRevision | null> {
    const result = await this.db.queryViaWorker(
      `SELECT ${REVISION_COLUMNS} FROM design_revisions
        WHERE project_id = ? AND directory = ?
        ORDER BY sequence DESC LIMIT 1`,
      [projectId, directory],
      1
    )
    if (!result.ok) return null
    const row = (result.rows as unknown as RevisionRow[])[0]
    return row ? toRevision(row) : null
  }

  /** One revision by id, or null when it is gone. */
  async getViaWorker(
    projectId: string,
    directory: string,
    id: string
  ): Promise<StoredDesignRevision | null> {
    const result = await this.db.queryViaWorker(
      `SELECT ${REVISION_COLUMNS} FROM design_revisions
        WHERE project_id = ? AND directory = ? AND id = ?`,
      [projectId, directory, id],
      1
    )
    if (!result.ok) return null
    const row = (result.rows as unknown as RevisionRow[])[0]
    return row ? toRevision(row) : null
  }

  /** How many revisions a folder holds. */
  async countViaWorker(projectId: string, directory: string): Promise<number> {
    const result = await this.db.queryViaWorker(
      'SELECT COUNT(*) AS total FROM design_revisions WHERE project_id = ? AND directory = ?',
      [projectId, directory],
      1
    )
    if (!result.ok) return 0
    const row = result.rows[0] as { total?: number } | undefined
    return typeof row?.total === 'number' ? row.total : 0
  }

  /** The revision this folder is checked out at, or null when it has no history. */
  async cursorIdViaWorker(projectId: string, directory: string): Promise<string | null> {
    const result = await this.db.queryViaWorker(
      'SELECT cursor_id FROM design_history_heads WHERE project_id = ? AND directory = ?',
      [projectId, directory],
      1
    )
    if (!result.ok) return null
    const row = result.rows[0] as { cursor_id?: string | null } | undefined
    return typeof row?.cursor_id === 'string' && row.cursor_id.length > 0 ? row.cursor_id : null
  }

  async pageCursorViaWorker(
    projectId: string,
    directory: string,
    path: string
  ): Promise<string | null> {
    const result = await this.db.queryViaWorker(
      'SELECT revision_id FROM design_history_page_heads WHERE project_id = ? AND directory = ? AND path = ?',
      [projectId, directory, path],
      1
    )
    if (!result.ok) throw new Error('Page history cursor could not be read')
    const row = result.rows[0] as { revision_id?: string } | undefined
    return row?.revision_id ?? null
  }

  setPageCursor(projectId: string, directory: string, path: string, revisionId: string): void {
    this.db.run(
      `INSERT INTO design_history_page_heads (project_id, directory, path, revision_id)
      VALUES (?, ?, ?, ?) ON CONFLICT(project_id, directory, path)
      DO UPDATE SET revision_id = excluded.revision_id`,
      projectId,
      directory,
      path,
      revisionId
    )
  }

  clearPageCursors(projectId: string, directory: string): void {
    this.db.run(
      'DELETE FROM design_history_page_heads WHERE project_id = ? AND directory = ?',
      projectId,
      directory
    )
  }

  insert(revision: StoredDesignRevision): void {
    this.db.run(
      `INSERT INTO design_revisions (
         id, project_id, directory, sequence, parent_id, cause, digest, files,
         skipped_files, unavailable_files, changed_files, changed_paths, file_count,
         total_bytes, created_at, label, checkpoint_entry
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      revision.id,
      revision.projectId,
      revision.directory,
      revision.sequence,
      revision.parentId,
      revision.cause,
      revision.digest,
      JSON.stringify(revision.files),
      revision.skippedFiles.length > 0 ? JSON.stringify(revision.skippedFiles) : null,
      revision.unavailableFiles.length > 0 ? JSON.stringify(revision.unavailableFiles) : null,
      revision.changedFiles,
      revision.changedPaths.length > 0 ? JSON.stringify(revision.changedPaths) : null,
      revision.fileCount,
      revision.totalBytes,
      revision.createdAt,
      revision.label ?? null,
      revision.checkpointEntry ?? null
    )
  }

  labelCheckpoint(
    projectId: string,
    directory: string,
    revisionId: string,
    label: string,
    entry: string
  ): void {
    this.db.run(
      'UPDATE design_revisions SET label = ?, checkpoint_entry = ? WHERE project_id = ? AND directory = ? AND id = ? AND label IS NULL',
      label,
      entry,
      projectId,
      directory,
      revisionId
    )
  }

  /**
   * Every folder the app keeps history for, across projects, for reconciliation.
   *
   * Bounded so a database that somehow accumulated folders still answers: the
   * caller sweeps what it reads and the next pass reads the rest.
   */
  async listFoldersAllViaWorker(
    maxRows: number,
    afterProject = '',
    afterDirectory = ''
  ): Promise<DesignHistoryFolderRef[]> {
    const result = await this.db.queryViaWorker(
      `SELECT project_id, directory FROM design_history_heads
       WHERE project_id > ? OR (project_id = ? AND directory > ?)
       UNION
       SELECT project_id, directory FROM design_revisions
       WHERE project_id > ? OR (project_id = ? AND directory > ?)
       ORDER BY project_id, directory LIMIT ?`,
      [
        afterProject,
        afterProject,
        afterDirectory,
        afterProject,
        afterProject,
        afterDirectory,
        maxRows
      ],
      maxRows
    )
    if (!result.ok) return []
    return (result.rows as Array<{ project_id: string; directory: string }>).map((row) => ({
      projectId: row.project_id,
      directory: row.directory
    }))
  }

  /** Every folder one project keeps history for, for a project-scoped sweep. */
  async listFoldersViaWorker(projectId: string, maxRows: number): Promise<string[]> {
    const result = await this.db.queryViaWorker(
      'SELECT directory FROM design_revisions WHERE project_id = ? GROUP BY directory LIMIT ?',
      [projectId, maxRows],
      maxRows
    )
    if (!result.ok) return []
    return (result.rows as Array<{ directory: string }>).map((row) => row.directory)
  }

  /** Point a folder at one of its revisions, creating the row on first use. */
  setCursor(projectId: string, directory: string, cursorId: string): void {
    this.db.run(
      `INSERT INTO design_history_heads (project_id, directory, cursor_id, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(project_id, directory) DO UPDATE SET
         cursor_id  = excluded.cursor_id,
         updated_at = excluded.updated_at`,
      projectId,
      directory,
      cursorId,
      Date.now()
    )
  }

  /**
   * Cut away every revision after `sequence`.
   *
   * A fresh edit made while the folder sits behind the tip is the only reason
   * forward history is dropped, and it is deliberate: the timeline becomes one line
   * again from where the user actually is, the way editing after an undo does.
   */
  deleteAfter(projectId: string, directory: string, sequence: number): void {
    this.db.run(
      'DELETE FROM design_revisions WHERE project_id = ? AND directory = ? AND sequence > ?',
      projectId,
      directory,
      sequence
    )
  }

  /**
   * Remove the oldest `count` revisions of a folder.
   *
   * The cursor is never removed, so a folder parked in its own past keeps the point
   * it is parked at even while the history ahead of it is capped.
   */
  pruneOldest(projectId: string, directory: string, count: number, protectId: string | null): void {
    if (count <= 0) return
    this.db.run(
      `DELETE FROM design_revisions WHERE id IN (
         SELECT id FROM design_revisions
          WHERE project_id = ? AND directory = ? AND (? IS NULL OR id <> ?)
          ORDER BY sequence ASC LIMIT ?
       )`,
      projectId,
      directory,
      protectId,
      protectId,
      count
    )
  }

  deleteProject(projectId: string): void {
    this.db.run('DELETE FROM design_history_page_heads WHERE project_id = ?', projectId)
    this.db.run('DELETE FROM design_revisions WHERE project_id = ?', projectId)
    this.db.run('DELETE FROM design_history_heads WHERE project_id = ?', projectId)
  }

  /** Forget a folder's history entirely, for a folder that no longer exists. */
  async deleteFolder(projectId: string, directory: string): Promise<void> {
    for (const table of ['design_history_page_heads', 'design_revisions', 'design_history_heads']) {
      const result = await this.db.executeViaWorker(
        `DELETE FROM ${table} WHERE project_id = ? AND directory = ?`,
        [projectId, directory]
      )
      if (!result.ok) throw new Error(result.error ?? 'Design history removal failed')
    }
  }
}
