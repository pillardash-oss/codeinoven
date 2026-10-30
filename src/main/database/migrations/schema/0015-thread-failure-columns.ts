import type { Database as DatabaseType } from 'better-sqlite3'
import type { SchemaMigration } from '../migration'
import { addColumn, tableColumns } from '../migration-helpers'

/**
 * Existing databases predate durable unattended-failure evidence: without
 * these columns a run that failed while no window was open reads back as a
 * bare `failed` status with no explanation. `last_outcome` is nullable so a
 * row that never settled carries no outcome, and the CHECK keeps the domain
 * closed on old rows (SQLite skips the check for NULL). Fresh databases
 * already carry all three, and the guarded `ALTER TABLE` is idempotent.
 */
export const threadFailureColumnsMigration: SchemaMigration = {
  id: '0015-thread-failure-columns',
  summary: 'threads record the error and outcome of a run that failed unattended',
  apply(connection: DatabaseType): void {
    const columns = tableColumns(connection, 'threads')
    addColumn(connection, columns, 'threads', 'last_error', 'TEXT')
    addColumn(connection, columns, 'threads', 'last_error_at', 'INTEGER')
    addColumn(
      connection,
      columns,
      'threads',
      'last_outcome',
      "TEXT CHECK(last_outcome IN ('completed','failed','parked'))"
    )
  }
}
