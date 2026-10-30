import type { Database as DatabaseType } from 'better-sqlite3'
import type { SchemaMigration } from '../migration'
import { tableColumns } from '../migration-helpers'

/**
 * Record the authored-work session on the thread itself.
 *
 * The sidebar used to answer "is this a design or a video thread" by scanning
 * every listed thread's persisted messages for the session tag, a `parts LIKE`
 * that read the whole column on every render. The thread already carries the
 * answer the moment it enters a session, so the kind lives here and the row
 * draws it directly. Threads that predate the column are classified from the
 * durable folder record; a thread that only ever typed the tag self-heals on
 * its next turn, when the chat engine persists the kind it derives.
 *
 * The added column carries no `CHECK`: SQLite cannot attach one through
 * `ALTER TABLE ADD COLUMN`, so the reader enforces the domain and the fresh
 * schema's constraint documents the intent.
 */
export const threadAuthoredWorkKindMigration: SchemaMigration = {
  id: '0042-thread-authored-work-kind',
  summary: 'threads record which authored-work session they are in',
  apply(connection: DatabaseType): void {
    const columns = tableColumns(connection, 'threads')
    if (columns.has('authored_work_kind')) return
    connection.exec('ALTER TABLE threads ADD COLUMN authored_work_kind TEXT')
    connection.exec(
      `UPDATE threads
          SET authored_work_kind = (SELECT kind FROM thread_designs WHERE thread_id = threads.id)
        WHERE EXISTS (SELECT 1 FROM thread_designs WHERE thread_id = threads.id)`
    )
  }
}
