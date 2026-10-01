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

/** Columns every read of the table selects, so the row mappers stay one shape. */
const CURRENT_COLUMNS = 'thread_id, project_id, directory, entry, kind, updated_at'

export class DesignRepo {
  constructor(private readonly db: Database) {}

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
   * on the Electron main thread (see `docs/APP-BIBLE.md`). The writes stay on the
   * primary connection, where a bounded UPDATE is the tail of the same action.
   */
  async rebaseRoot(input: { projectId: string; from: string; to: string }): Promise<number> {
    const result = await this.db.queryViaWorker(
      'SELECT thread_id, directory FROM thread_designs WHERE project_id = ?',
      [input.projectId],
      0
    )
    if (!result.ok) return 0
    const rows = result.rows as unknown as Array<{ thread_id: string; directory: string }>
    let updated = 0
    for (const row of rows) {
      if (row.directory !== input.from && !row.directory.startsWith(`${input.from}/`)) continue
      this.db.run(
        'UPDATE thread_designs SET directory = ? WHERE thread_id = ?',
        `${input.to}${row.directory.slice(input.from.length)}`,
        row.thread_id
      )
      updated += 1
    }
    return updated
  }

  deleteProject(projectId: string): void {
    this.db.run('DELETE FROM thread_designs WHERE project_id = ?', projectId)
  }
}
