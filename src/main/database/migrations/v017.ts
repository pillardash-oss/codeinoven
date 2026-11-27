import type { Database as DatabaseType } from 'better-sqlite3'
import type { DatabaseMigration } from './migration'

/**
 * Schema version 17: the expert gate's table is gone.
 *
 * Design and video sessions used to hold their first send so a card could ask
 * whether the session might hand its craft work to models the user staffed. That
 * feature is removed, and with it the question: nothing reads this table, so
 * keeping it would only preserve a decision nobody can make again. A database
 * that never had the feature simply has nothing to drop.
 */
export const versionSeventeenMigration: DatabaseMigration = {
  version: 17,
  summary: 'drop the retired per-thread expert decision table',
  apply(connection: DatabaseType): void {
    connection.exec('DROP TABLE IF EXISTS thread_experts')
  }
}
