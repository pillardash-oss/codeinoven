import type { Database as DatabaseType } from 'better-sqlite3'
import { repairUnpricedUsageCosts } from '../../usage-cost-repair'
import type { SchemaMigration } from '../migration'

/**
 * Reprice the usage rows an older build wrote with tokens and no price.
 *
 * A one-time data repair, not a launch task: it runs inside the upgrade and is
 * stamped with the schema version, so no later launch walks the ledger again.
 * `repairUnpricedUsageCosts` owns the pricing rules and reports what it
 * scanned and repriced.
 */
export const unpricedUsageCostsMigration: SchemaMigration = {
  id: '0046-unpriced-usage-costs',
  summary: 'usage rows recorded with tokens and no price are repriced once',
  apply(connection: DatabaseType): void {
    repairUnpricedUsageCosts(connection)
  }
}
