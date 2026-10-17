import { DEFAULT_WORK_ROOTS } from '../../../lib/design/work-roots'
import { workPathNoticeStatements } from '../../design/work-path-notices'
import { projectWorkRootPaths } from '../../design/work-roots-state'
import { dirname } from 'node:path'
import type { Database } from '../database'
import type { AuthoredWorkKind, ThreadDesignCurrent } from '../../../lib/ipc/design'

/**
 * The durable record of which folder a thread is working in.
 *
 * The `@cio-design` and `@cio-video` tags already live in the thread's persisted
 * messages, so "this thread is in a session" survives a restart on its own. The
 * folder the agent wrote into does not: it is chosen by the model at preview time
 * and appears nowhere else, so without this row a restarted app cannot put the
 * user back on their design or their composition.
 *
 * The kind is a column, not something recovered by reading the folder. Deriving it
 * from the path's root made the marker depend on the folder still being spellable
 * under a documented root, so a folder renamed, deleted, or written somewhere the
 * app does not document took a thread's marker with it even though the work had
 * happened. The row records what the preview knew at write time, which is what a
 * restarted app reads back.
 */

interface ThreadDesignRow {
  thread_id: string
  project_id: string
  directory: string
  entry: string | null
  kind: string
  updated_at: number
}

/**
 * The stored kind, read back as a kind the app switches on.
 *
 * The column only ever holds one of the two, so an unexpected value reads as a
 * design rather than as no work at all: a marker on the wrong word is better than
 * a thread silently losing that it did any.
 */
function kindOfRow(value: string): AuthoredWorkKind {
  return value === 'video' ? 'video' : 'design'
}

/** The stored row as the app reads it back. */
function toCurrent(row: ThreadDesignRow): ThreadDesignCurrent {
  return {
    directory: row.directory,
    entry: row.entry,
    kind: kindOfRow(row.kind),
    updatedAt: row.updated_at
  }
}

/**
 * The folder a preview's entry names inside the previewed root, or null.
 *
 * `entry` is a page inside `directory`, and a session may name a screen one folder
 * down (`entry: 'rail-icon-set/weight.html'` while the root is `.cio/designs`). The
 * design that session is working on is the folder holding that screen, not the root,
 * and the board lists folders rather than roots, so that is the folder that has to
 * carry a creator. Only the first segment counts, because the board reads a screen
 * as an HTML file in a design folder or one folder below it.
 */
function entryFolder(entry: string | null): string | null {
  if (entry === null) return null
  const segment = entry.split('/')[0]
  return segment === undefined || segment === '' || segment === entry ? null : segment
}

/** Columns every read of the table selects, so the row mappers stay one shape. */
const CURRENT_COLUMNS = 'thread_id, project_id, directory, entry, kind, updated_at'

export class DesignRepo {
  constructor(private readonly db: Database) {}

  /** Indexed redirect lookup for navigation callbacks completing during a move. */
  resolveDirectory(projectId: string, directory: string): string {
    return (
      this.db.get<{ destination: string }>(
        'SELECT destination FROM work_folder_relocations WHERE project_id = ? AND directory = ?',
        projectId,
        directory
      )?.destination ?? directory
    )
  }

  /**
   * Record (or refresh) the folder a thread is showing and the kind of work it
   * holds. Called on every preview, by the design capability and by the video
   * capability alike, so a thread that moves to another folder re-points the row
   * rather than accumulating folders the coordinator would have to choose between:
   * the project's folders are listed from disk, and the thread's current one is
   * what this row is for. The kind is refreshed with the folder, so a thread that
   * moves from a design into a composition (or back) keeps saying what it is doing.
   */
  upsert(input: {
    projectId: string
    threadId: string
    directory: string
    entry: string | null
    kind: AuthoredWorkKind
  }): void {
    // A navigation started before a move can finish after it. Never let that
    // stale callback recreate the old folder or steal the thread's current path.
    input = { ...input, directory: this.resolveDirectory(input.projectId, input.directory) }
    this.db.run(
      `INSERT INTO thread_designs (thread_id, project_id, directory, entry, kind, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         project_id = excluded.project_id,
         directory  = excluded.directory,
         entry      = excluded.entry,
         kind       = excluded.kind,
         updated_at = excluded.updated_at`,
      input.threadId,
      input.projectId,
      input.directory,
      input.entry,
      input.kind,
      Date.now()
    )
    // A generic HTML preview is not a new design. Register only a folder directly
    // under an authored-work root, including the project's explicit custom roots.
    const roots = [
      DEFAULT_WORK_ROOTS[input.kind],
      ...projectWorkRootPaths(input.projectId, input.kind)
    ]
    if (roots.includes(dirname(input.directory))) {
      this.db.run(
        `INSERT INTO authored_work_folders (project_id, directory, kind, created_at, updated_at, missing)
        VALUES (?, ?, ?, ?, ?, 0) ON CONFLICT(project_id, directory) DO UPDATE SET kind = excluded.kind, missing = 0`,
        input.projectId,
        input.directory,
        input.kind,
        Date.now(),
        Date.now()
      )
    } else {
      // Refresh an exact relocated record without adopting its parent as a default.
      this.db.run(
        'UPDATE authored_work_folders SET missing = 0 WHERE project_id = ? AND directory = ?',
        input.projectId,
        input.directory
      )
    }
    this.recordCreator(input.projectId, input.directory, input.threadId)
    // A preview of a root that names a screen inside a subfolder is showing that
    // subfolder's design, so the subfolder is the folder this thread created and the
    // folder the board has to name. It lists the designs under a root and offers to
    // reveal each one's creator, so recording the root alone left the design that was
    // open on screen looking unclaimed: the creator was filed against the root, the
    // root is not a design the board shows, and the design under it had no thread to
    // send the user to.
    const held = roots.includes(input.directory) ? entryFolder(input.entry) : null
    if (held !== null)
      this.recordCreator(input.projectId, `${input.directory}/${held}`, input.threadId)
  }

  /**
   * Record the thread that created a folder, once.
   *
   * The first thread to preview a folder is the one that created it, because the
   * agent writes a folder before showing it. The insert is ignored once the folder
   * has an origin, so a second thread previewing someone else's design, and the
   * same thread previewing it again, both leave the creator alone.
   */
  private recordCreator(projectId: string, directory: string, threadId: string): void {
    this.db.run(
      `INSERT OR IGNORE INTO design_origins (project_id, directory, thread_id, created_at)
       VALUES (?, ?, ?, ?)`,
      projectId,
      directory,
      threadId,
      Date.now()
    )
  }

  /**
   * The creator of each of a project's folders, by project-relative directory.
   *
   * Read on the worker's connection: the board draws a creator badge and a reveal
   * control for every folder it lists, so this sits on an interaction path and must
   * not touch SQLite on the Electron main thread (see `docs/APP-BIBLE.md`). A
   * directory with no row is simply absent from the map.
   */
  async originsViaWorker(projectId: string): Promise<Map<string, string>> {
    const result = await this.db.queryViaWorker(
      'SELECT directory, thread_id FROM design_origins WHERE project_id = ?',
      [projectId],
      0
    )
    const origins = new Map<string, string>()
    if (!result.ok) return origins
    for (const row of result.rows as unknown as Array<{ directory: string; thread_id: string }>) {
      origins.set(row.directory, row.thread_id)
    }
    return origins
  }

  /**
   * The folder a thread last previewed, or null when it never has.
   *
   * Read on the worker's connection: a thread's marker is drawn by every board that
   * shows it and by every preview, so this read is on interaction paths and must not
   * touch SQLite on the Electron main thread (see `docs/APP-BIBLE.md`).
   */
  async forThreadViaWorker(threadId: string): Promise<ThreadDesignCurrent | null> {
    const result = await this.db.queryViaWorker(
      `SELECT ${CURRENT_COLUMNS} FROM thread_designs WHERE thread_id = ?`,
      [threadId],
      1
    )
    if (!result.ok) return null
    const row = (result.rows as unknown as ThreadDesignRow[])[0]
    return row ? toCurrent(row) : null
  }

  deleteThread(threadId: string): void {
    this.db.run('DELETE FROM work_path_notices WHERE thread_id = ?', threadId)
    this.db.run('DELETE FROM thread_designs WHERE thread_id = ?', threadId)
  }

  /**
   * Re-point this project's rows at the folder they now live in.
   *
   * The row names a folder, and a folder moves when the user points the work root
   * somewhere else. Without this the board would open the old path, which no longer
   * exists, for every thread whose work had moved correctly on disk. Only rows under
   * the old root are touched, and the entry stays as it was: it is spelled inside the
   * folder, and the folder is what moved.
   *
   * The read runs on the database worker: this is reached from the save path that
   * moves a work root, which is an interaction path, so it must not touch SQLite
   * on the Electron main thread (see `docs/APP-BIBLE.md`). Updates run in one
   * worker transaction so thread links and creator links move together.
   */
  async rebaseRoot(input: { projectId: string; from: string; to: string }): Promise<number> {
    const result = await this.db.queryViaWorker(
      'SELECT thread_id, directory FROM thread_designs WHERE project_id = ?',
      [input.projectId],
      0
    )
    if (!result.ok) throw new Error('Could not read work tracking')
    const rows = result.rows as unknown as Array<{ thread_id: string; directory: string }>
    const matching = rows.filter(
      (row) => row.directory === input.from || row.directory.startsWith(`${input.from}/`)
    )
    const statements: Array<{ sql: string; params: unknown[] }> = matching.map((row) => ({
      sql: 'UPDATE thread_designs SET directory = ? WHERE thread_id = ?',
      params: [`${input.to}${row.directory.slice(input.from.length)}`, row.thread_id]
    }))
    for (const row of matching) {
      statements.push(
        ...workPathNoticeStatements(
          input.projectId,
          row.thread_id,
          row.directory,
          `${input.to}${row.directory.slice(input.from.length)}`
        )
      )
    }
    statements.push(
      {
        sql: 'DELETE FROM work_folder_relocations WHERE project_id = ? AND directory = ?',
        params: [input.projectId, input.to]
      },
      {
        sql: 'UPDATE work_folder_relocations SET destination = ? WHERE project_id = ? AND destination = ?',
        params: [input.to, input.projectId, input.from]
      },
      {
        sql: `INSERT INTO work_folder_relocations (project_id, directory, destination) VALUES (?, ?, ?)
          ON CONFLICT(project_id, directory) DO UPDATE SET destination = excluded.destination`,
        params: [input.projectId, input.from, input.to]
      }
    )
    statements.push({
      sql: `UPDATE design_origins SET directory = ? || SUBSTR(directory, ?)
        WHERE project_id = ? AND (directory = ? OR directory LIKE ? ESCAPE '\\')`,
      params: [
        input.to,
        input.from.length + 1,
        input.projectId,
        input.from,
        `${input.from.replace(/[%_\\]/gu, '\\$&')}/%`
      ]
    })
    statements.push({
      sql: 'UPDATE authored_work_folders SET directory = ? WHERE project_id = ? AND directory = ?',
      params: [input.to, input.projectId, input.from]
    })
    const saved = await this.db.transactionViaWorker(statements)
    if (!saved.ok) throw new Error(saved.error ?? 'Could not update work tracking')
    const updated = matching.length
    return updated
  }

  deleteProject(projectId: string): void {
    this.db.run('DELETE FROM work_path_notices WHERE project_id = ?', projectId)
    this.db.run('DELETE FROM work_folder_relocations WHERE project_id = ?', projectId)
    this.db.run('DELETE FROM authored_work_folders WHERE project_id = ?', projectId)
    this.db.run('DELETE FROM thread_designs WHERE project_id = ?', projectId)
    this.db.run('DELETE FROM design_origins WHERE project_id = ?', projectId)
  }
}
