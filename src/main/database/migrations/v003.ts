import type { Database as DatabaseType } from 'better-sqlite3'
import { repairUnpricedUsageCosts } from '../usage-cost-repair'
import type { DatabaseMigration } from './migration'

/**
 * Schema version 3: the usage rows an older build wrote with tokens and no
 * price are repriced once.
 *
 * `repairUnpricedUsageCosts` owns the pricing rules and reports what it scanned
 * and repriced. This is a one-time data repair, not a launch task: it runs
 * inside the upgrade, stamped with the schema version, so no later launch walks
 * the ledger again.
 */
export const versionThreeMigration: DatabaseMigration = {
  version: 3,
  summary: 'usage rows recorded with tokens and no price are repriced once',
  apply(connection: DatabaseType): void {
    repairUnpricedUsageCosts(connection)
  }
}
