import type { Database as DatabaseType } from 'better-sqlite3'
import type { DatabaseMigration } from './migration'
import { addColumn, tableColumns } from './migration-helpers'

/**
 * Schema version 11: Achievement can run from a goal instead of a specification.
 *
 * Achievement used to be blocked unless the thread carried an approved
 * specification, so an agent told to keep going until the goal was reached
 * stopped dead on a thread that never had one. The loop now judges the work
 * against the approved specification when it exists, and otherwise against the
 * goal captured from the achievement tool call or the thread conversation.
 *
 * `threads.achievement_goal` is that captured goal. It is nullable and every
 * existing row reads exactly as it did, so an upgrade changes no behavior on a
 * thread that never used Achievement.
 *
 * Idempotent: `ALTER TABLE ... ADD COLUMN` runs only for a column the table does
 * not already list, so a rerun writes nothing and a fresh install (which gets the
 * snapshot instead of this chain) is untouched.
 */
export const versionElevenMigration: DatabaseMigration = {
  version: 11,
  summary: 'an Achievement goal that does not need an approved specification',
  apply(connection: DatabaseType): void {
    const threadColumns = tableColumns(connection, 'threads')
    addColumn(connection, threadColumns, 'threads', 'achievement_goal', 'TEXT')
  }
}
