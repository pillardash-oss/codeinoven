import type { Database as DatabaseType } from 'better-sqlite3'
import type { SchemaMigration } from '../migration'
import { addColumn, tableColumns } from '../migration-helpers'

/** Existing databases predate the independent (spec-less) audit thread flags. */
export const threadIndependentAuditColumnsMigration: SchemaMigration = {
  id: '0009-thread-independent-audit-columns',
  summary: 'threads gain the independent-audit flags',
  apply(connection: DatabaseType): void {
    const columns = tableColumns(connection, 'threads')
    addColumn(connection, columns, 'threads', 'independent_audit', 'INTEGER NOT NULL DEFAULT 0')
    addColumn(
      connection,
      columns,
      'threads',
      'independent_audit_initialized',
      'INTEGER NOT NULL DEFAULT 0'
    )
  }
}
