import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Database as DatabaseType } from 'better-sqlite3'
import { getConfigRoot } from '../../lib/utils'
import type { UsagePricingProvenance } from '../../lib/types'
import { Logger } from '../system/logger'
import { registerModelPricing, type ModelPriceEntry } from '../providers/pricing'
import {
  catalogCostForRun,
  needsCatalogPrice,
  type UsageCostInput
} from '../providers/usage-cost-reconcile'

/**
 * One-time repair of usage rows that recorded tokens without a defensible price.
 *
 * Two shapes were written before the ledger priced a gateway's zeroed cost
 * object and before the price catalog was guaranteed to be loaded: `unavailable`
 * rows with real tokens, and `known` rows at exactly `$0` for a model the
 * catalog prices. Both understate the Usage page, so they are corrected here,
 * once, as a schema step.
 *
 * This is deliberately a schema step and not a launch task: the repair runs
 * while an older database is upgraded, is stamped into `db_meta.schema_version`,
 * and never runs again. Afterwards the Usage page only ever renders what the
 * ledger already stores; nothing is derived on the way in.
 */

const PRICING_CACHE_FILE = 'model-pricing.json'

/** One ledger row as this repair reads it. */
export interface UsageLedgerCostRow extends UsageCostInput {
  id: string
}

/** The correction one row needs, ready to be written back. */
export interface UsageCostUpdate {
  id: string
  costUsd: number
  pricingProvenance: UsagePricingProvenance
}

/** Repair outcome, logged once at upgrade time. */
export interface UsageCostRepairResult {
  scanned: number
  repriced: number
}

/** Corrections for the rows the catalog can price, in input order. */
export function usageCostUpdates(rows: readonly UsageLedgerCostRow[]): UsageCostUpdate[] {
  const updates: UsageCostUpdate[] = []
  for (const row of rows) {
    if (!needsCatalogPrice(row)) continue
    const correction = catalogCostForRun(row)
    if (!correction) continue
    updates.push({
      id: row.id,
      costUsd: correction.costUsd,
      pricingProvenance: correction.pricingProvenance
    })
  }
  return updates
}

/** A cached price entry, validated so a malformed row cannot poison the repair. */
function isPriceEntry(value: unknown): value is ModelPriceEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry['id'] === 'string' &&
    entry['id'].includes('/') &&
    typeof entry['inputUsdPer1M'] === 'number' &&
    typeof entry['outputUsdPer1M'] === 'number' &&
    typeof entry['cacheReadUsdPer1M'] === 'number' &&
    typeof entry['cacheWriteUsdPer1M'] === 'number' &&
    typeof entry['reasoningUsdPer1M'] === 'number'
  )
}

/**
 * Prices from the on-disk catalog snapshot.
 *
 * The maintenance DB connection runs before the background pricing service has
 * loaded anything, so the repair reads the same snapshot the service will load a
 * moment later instead of waiting on the network. A missing or malformed cache
 * yields no prices, and the repair then leaves every row exactly as it was.
 */
function cachedPriceEntries(): ModelPriceEntry[] {
  try {
    const raw = readFileSync(join(getConfigRoot(), PRICING_CACHE_FILE), 'utf8')
    const parsed = JSON.parse(raw) as { entries?: unknown }
    const entries = Array.isArray(parsed.entries) ? parsed.entries : []
    return entries.filter(isPriceEntry)
  } catch {
    return []
  }
}

function integerOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null
}

function ledgerRow(record: Record<string, unknown>): UsageLedgerCostRow | null {
  const id = record['id']
  if (typeof id !== 'string' || id.length === 0) return null
  const costStatus = record['cost_status']
  const costUsd = record['cost_usd']
  return {
    id,
    modelId: typeof record['model_id'] === 'string' ? record['model_id'] : null,
    providerId: typeof record['provider_id'] === 'string' ? record['provider_id'] : null,
    createdAt: integerOf(record['created_at']) ?? 0,
    costStatus:
      costStatus === 'known' || costStatus === 'estimated' || costStatus === 'unavailable'
        ? costStatus
        : 'unavailable',
    costUsd: typeof costUsd === 'number' && Number.isFinite(costUsd) ? costUsd : null,
    tokens: {
      uncachedInput: integerOf(record['tokens_uncached_input']),
      cachedInput: integerOf(record['tokens_cached_input']),
      cacheWrite: integerOf(record['tokens_cache_write']),
      output: integerOf(record['tokens_output']),
      reasoning: integerOf(record['tokens_reasoning'])
    }
  }
}

/**
 * Correct every repairable row of an older database, inside the schema upgrade
 * transaction. Returns what it scanned and what it changed.
 */
export function repairUnpricedUsageCosts(connection: DatabaseType): UsageCostRepairResult {
  const empty: UsageCostRepairResult = { scanned: 0, repriced: 0 }
  const hasUsageTable = connection
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'usage_events'"
    )
    .get() as { present?: number } | undefined
  if (!hasUsageTable) return empty

  const rows = connection
    .prepare(
      `SELECT id, model_id, provider_id,
              tokens_uncached_input, tokens_cached_input, tokens_cache_write,
              tokens_output, tokens_reasoning, created_at, cost_status, cost_usd
       FROM usage_events
       WHERE cost_status = 'unavailable' OR (cost_status = 'known' AND cost_usd = 0)`
    )
    .all() as Record<string, unknown>[]
  if (rows.length === 0) return empty

  const entries = cachedPriceEntries()
  if (entries.length === 0) {
    Logger.info('Usage cost repair skipped: no price catalog on disk', {
      rowsWithoutPrice: rows.length
    })
    return { scanned: rows.length, repriced: 0 }
  }
  // The registry the estimator reads is the same one the pricing service fills a
  // moment later with these exact entries, so seeding it here changes nothing
  // for the rest of the session.
  registerModelPricing(entries)

  const candidates = rows
    .map((row) => ledgerRow(row))
    .filter((row): row is UsageLedgerCostRow => row !== null)
  const updates = usageCostUpdates(candidates)
  if (updates.length === 0) return { scanned: rows.length, repriced: 0 }

  const write = connection.prepare(
    `UPDATE usage_events
     SET cost_usd = ?, cost_status = 'estimated', pricing_provenance_json = ?
     WHERE id = ?`
  )
  for (const update of updates) {
    write.run(update.costUsd, JSON.stringify(update.pricingProvenance), update.id)
  }
  Logger.info('Usage cost repair completed', {
    scanned: rows.length,
    repriced: updates.length
  })
  return { scanned: rows.length, repriced: updates.length }
}
