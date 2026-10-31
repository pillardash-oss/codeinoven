import { RECONCILE_THREAD_CONTEXT_USAGE_SQL } from '../thread-context-usage-sql'
import { Logger } from '../../system/logger'

/** What the repair pass needs from the database it belongs to. */
export interface ContextCostRepairHost {
  /** True once shutdown started; the pass stops at its next boundary. */
  isClosing(): boolean
  queryViaWorker(
    sql: string,
    params: unknown[],
    maxRows: number
  ): Promise<{ ok: boolean; rows: Record<string, unknown>[]; error?: string }>
  executeViaWorker(sql: string, params: unknown[]): Promise<{ ok: boolean; error?: string }>
}

/** Threads repaired per yield, so the worker stays responsive to live requests. */
const CONTEXT_COST_REPAIR_BATCH = 32

/**
 * One bounded worker-only repair pass for snapshots written before ledger
 * reconciliation.
 *
 * Rows recorded before the reconciliation carry context occupancy with no cost
 * beside it, so an upgraded database would show historical turns as free. The
 * pass walks threads in rowid order, one bounded batch at a time, and yields to
 * the event loop between batches; the marker it writes at the end makes it a
 * one-time cost. Everything runs on the worker, so the main thread never waits
 * on it, and shutdown interrupts it at a batch boundary.
 */
export async function reconcileLegacyContextUsageCosts(host: ContextCostRepairHost): Promise<void> {
  try {
    const marker = await host.queryViaWorker(
      "SELECT value FROM db_meta WHERE key = 'context_usage_cost_v1'",
      [],
      1
    )
    if (!marker.ok || marker.rows.length > 0) return
    let cursor = ''
    for (;;) {
      if (host.isClosing()) return
      const batch = await host.queryViaWorker(
        'SELECT id FROM threads WHERE id > ? AND context_usage IS NOT NULL ORDER BY id LIMIT ?',
        [cursor, CONTEXT_COST_REPAIR_BATCH],
        CONTEXT_COST_REPAIR_BATCH
      )
      if (!batch.ok) throw new Error(batch.error ?? 'Context cost repair read failed')
      if (batch.rows.length === 0) break
      for (const row of batch.rows) {
        if (host.isClosing()) return
        const id = String(row['id'])
        const result = await host.executeViaWorker(RECONCILE_THREAD_CONTEXT_USAGE_SQL, [id])
        if (!result.ok) throw new Error(result.error ?? 'Context cost repair failed')
        cursor = id
      }
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    await host.executeViaWorker(
      "INSERT OR REPLACE INTO db_meta(key,value) VALUES('context_usage_cost_v1','complete')",
      []
    )
  } catch (error) {
    Logger.error('Legacy context cost reconciliation failed:', error)
  }
}
