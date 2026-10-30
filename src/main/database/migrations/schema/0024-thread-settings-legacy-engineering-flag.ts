import type { Database as DatabaseType } from 'better-sqlite3'
import type { SchemaMigration } from '../migration'

/**
 * Rows persisted before the legacy `engineeringMode` settings flag was
 * scrubbed still carry it inside their settings JSON. Rewrite affected rows
 * without the flag: the Engineering lifecycle selection is the single source
 * of truth now. Idempotent and safe to re-run. Malformed rows are left
 * untouched; the read-path sanitizer in the thread repository still guards
 * them.
 */
export const threadSettingsLegacyEngineeringFlagMigration: SchemaMigration = {
  id: '0024-thread-settings-legacy-engineering-flag',
  summary: 'thread settings JSON no longer carries the retired engineeringMode flag',
  apply(connection: DatabaseType): void {
    const rows = connection
      .prepare('SELECT id, settings FROM threads WHERE settings LIKE \'%"engineeringMode"%\'')
      .all() as Array<{ id: string; settings: string }>
    if (rows.length === 0) return
    const update = connection.prepare('UPDATE threads SET settings = ? WHERE id = ?')
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.settings) as Record<string, unknown>
        if (!('engineeringMode' in parsed)) continue
        const { engineeringMode: _legacyEngineeringMode, ...rest } = parsed
        update.run(JSON.stringify(rest), row.id)
      } catch {
        // A malformed settings blob must never abort startup.
      }
    }
  }
}
