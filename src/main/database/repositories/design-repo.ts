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

  /** The folder a thread last previewed, or null when it never has. */
  forThread(threadId: string): ThreadDesignCurrent | null {
    const row = this.db.get<ThreadDesignRow>(
      'SELECT thread_id, project_id, directory, entry, kind, updated_at FROM thread_designs WHERE thread_id = ?',
      threadId
    )
    if (!row) return null
    return {
      directory: row.directory,
      entry: row.entry,
      kind: kindOfRow(row.kind),
      updatedAt: row.updated_at
    }
  }

  /**
   * The recorded folder of each of these threads, in one query.
   *
   * A list of thread rows asks about every thread it draws, so the read is batched
   * rather than per row: one `forThread` per row would be one query per row, on the
   * path that renders the sidebar.
   *
   * Scoped by project so a caller cannot read a folder recorded for another one.
   */
  forThreads(projectId: string, threadIds: readonly string[]): Map<string, ThreadDesignCurrent> {
    const found = new Map<string, ThreadDesignCurrent>()
    if (threadIds.length === 0) return found
    const placeholders = threadIds.map(() => '?').join(', ')
    const rows = this.db.all<ThreadDesignRow>(
      `SELECT thread_id, project_id, directory, entry, kind, updated_at FROM thread_designs
       WHERE project_id = ? AND thread_id IN (${placeholders})`,
      projectId,
      ...threadIds
    )
    for (const row of rows) {
      found.set(row.thread_id, {
        directory: row.directory,
        entry: row.entry,
        kind: kindOfRow(row.kind),
        updatedAt: row.updated_at
      })
    }
    return found
  }

  deleteThread(threadId: string): void {
    this.db.run('DELETE FROM thread_designs WHERE thread_id = ?', threadId)
  }

  deleteProject(projectId: string): void {
    this.db.run('DELETE FROM thread_designs WHERE project_id = ?', projectId)
  }
}
