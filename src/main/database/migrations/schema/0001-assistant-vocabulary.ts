import type { Database as DatabaseType } from 'better-sqlite3'
import type { SchemaMigration } from '../migration'
import { tableColumns, tableExists } from '../migration-helpers'

/**
 * Rename the assistant vocabulary in a database written before it.
 *
 * The feature was called a routine: its rows lived in `routines`, a task
 * carried `threads.routine_id`, and the listing index was
 * `idx_routines_listing`. Those names are user data, so they are renamed in
 * place rather than rebuilt: the table keeps its ids, its rows, and the
 * threads pointing at it. The old index is dropped because the schema
 * recreates it under its new name, and SQLite carries an index through a table
 * rename with its old name still attached.
 *
 * The assistant's written instruction set was its how-to: the `how_to` and
 * `how_to_updated_at` columns became `knowledge` and `knowledge_updated_at`.
 * The rename reached the schema but not the rows an existing database already
 * held, so the columns are renamed here rather than only added: a database
 * that predates the wording keeps its authored knowledge and the timestamp the
 * schedule anchor backfill reads, instead of failing on a column that only the
 * fresh schema carried. A table that already uses the new names is untouched.
 *
 * Runs first, before the schema snapshot is applied: `CREATE TABLE IF NOT
 * EXISTS assistants` would otherwise create an empty table the rename could not
 * replace, and the later migrations (the schedule anchor reads
 * `knowledge_updated_at`) would find the old columns. Idempotent, so a database
 * that has already migrated is untouched.
 */
export const assistantVocabularyMigration: SchemaMigration = {
  id: '0001-assistant-vocabulary',
  summary: 'routine vocabulary and how_to columns are renamed to assistant and knowledge',
  apply(connection: DatabaseType): void {
    if (tableExists(connection, 'routines') && !tableExists(connection, 'assistants')) {
      connection.exec('ALTER TABLE routines RENAME TO assistants')
      connection.exec('DROP INDEX IF EXISTS idx_routines_listing')
    }

    const threadColumns = tableColumns(connection, 'threads')
    if (threadColumns.has('routine_id') && !threadColumns.has('assistant_id')) {
      connection.exec('ALTER TABLE threads RENAME COLUMN routine_id TO assistant_id')
    }

    const assistantColumns = tableColumns(connection, 'assistants')
    if (!assistantColumns.has('knowledge')) {
      if (assistantColumns.has('how_to')) {
        connection.exec('ALTER TABLE assistants RENAME COLUMN how_to TO knowledge')
      } else if (assistantColumns.size > 0) {
        connection.exec("ALTER TABLE assistants ADD COLUMN knowledge TEXT NOT NULL DEFAULT ''")
      }
    }
    if (!assistantColumns.has('knowledge_updated_at')) {
      if (assistantColumns.has('how_to_updated_at')) {
        connection.exec(
          'ALTER TABLE assistants RENAME COLUMN how_to_updated_at TO knowledge_updated_at'
        )
      } else if (assistantColumns.size > 0) {
        connection.exec('ALTER TABLE assistants ADD COLUMN knowledge_updated_at INTEGER')
      }
    }
  }
}
