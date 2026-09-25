import type { Database } from '../database'
import type { ThreadDesignCurrent } from '../../../lib/ipc/design'

/**
 * The durable record of which design folder a thread is working on.
 *
 * The `@cio-design` tag already lives in the thread's persisted messages, so
 * "this thread is a design session" survives a restart on its own. The folder
 * the agent wrote into does not: it is chosen by the model at preview time and
 * appears nowhere else, so without this row a restarted app cannot put the user
 * back on their design.
 */

interface ThreadDesignRow {
  thread_id: string
  project_id: string
  directory: string
  entry: string | null
  updated_at: number
}

export class DesignRepo {
  constructor(private readonly db: Database) {}

  /**
   * Record (or refresh) the design a thread is showing. Called on every preview,
   * so a thread that moves to another folder re-points the row rather than
   * accumulating designs the coordinator would have to choose between: the
   * project's folders are listed from disk, and the thread's current one is what
   * this row is for.
   */
  upsert(input: {
    projectId: string
    threadId: string
    directory: string
    entry: string | null
  }): void {
    this.db.run(
      `INSERT INTO thread_designs (thread_id, project_id, directory, entry, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         project_id = excluded.project_id,
         directory  = excluded.directory,
         entry      = excluded.entry,
         updated_at = excluded.updated_at`,
      input.threadId,
      input.projectId,
      input.directory,
      input.entry,
      Date.now()
    )
  }

  /** The design a thread last previewed, or null when it never has. */
  forThread(threadId: string): ThreadDesignCurrent | null {
    const row = this.db.get<ThreadDesignRow>(
      'SELECT thread_id, project_id, directory, entry, updated_at FROM thread_designs WHERE thread_id = ?',
      threadId
    )
    if (!row) return null
    return { directory: row.directory, entry: row.entry }
  }

  deleteThread(threadId: string): void {
    this.db.run('DELETE FROM thread_designs WHERE thread_id = ?', threadId)
  }

  deleteProject(projectId: string): void {
    this.db.run('DELETE FROM thread_designs WHERE project_id = ?', projectId)
  }
}
