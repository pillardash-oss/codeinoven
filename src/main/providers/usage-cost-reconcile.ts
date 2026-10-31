import type {
  AgentTokenUsage,
  NormalizedUsageTokens,
  UsageEvent,
  UsagePricingProvenance
} from '../../lib/types'
import { estimateModelCost, isFreeTierModelId, type ModelCostEstimate } from './pricing'

/**
 * Repair a usage row whose recorded dollar figure cannot stand on its own.
 *
 * Two shapes reach the ledger without a usable price, and both understate the
 * user's spend on the Usage page:
 *
 * 1. `unavailable`, because the harness reported tokens but no dollar figure and
 *    the price catalog had not loaded yet (it is fetched in the background, so a
 *    run early in a session can precede it) or the fetch failed.
 * 2. `known` at exactly `$0` for a model the catalog prices, because gateways
 *    such as the design/opencode family answer with a zeroed `cost` object even
 *    when they bill the request. Recording that zero as a known price erases the
 *    run from every dollar total while its tokens still count.
 *
 * A true zero survives: nothing billed means nothing to correct, and a free-tier
 * id is billed at zero by definition so its paid sibling must never price it.
 */

/** The fields of a usage row the reconciliation reads. */
export type UsageCostInput = Pick<
  UsageEvent,
  'modelId' | 'providerId' | 'tokens' | 'createdAt' | 'costStatus' | 'costUsd'
>

/** Catalog price for one row, with the provenance that makes it auditable. */
export interface UsageCostCorrection {
  costUsd: number
  pricingProvenance: UsagePricingProvenance
}

/** Billed units of one row. Zero means the run billed nothing. */
function billedUnits(tokens: NormalizedUsageTokens): number {
  const categories = [
    tokens.uncachedInput,
    tokens.cachedInput,
    tokens.cacheWrite,
    tokens.output,
    tokens.reasoning
  ]
  let total = 0
  for (const value of categories) {
    if (typeof value === 'number' && value > 0) total += value
  }
  return total
}

/**
 * Normalized categories back to the estimation shape. Uncached and cached input
 * are recombined because `estimateModelCost` subtracts the cache reads itself,
 * exactly as the recording path does.
 */
function estimationUsage(tokens: NormalizedUsageTokens): AgentTokenUsage {
  const uncachedInput = tokens.uncachedInput ?? 0
  const cachedInput = tokens.cachedInput ?? 0
  const output = tokens.output ?? 0
  const reasoning = tokens.reasoning ?? 0
  const cacheWrite = tokens.cacheWrite ?? 0
  return {
    input: uncachedInput + cachedInput,
    output,
    reasoning,
    cacheRead: cachedInput,
    cacheWrite,
    total: uncachedInput + cachedInput + cacheWrite + output
  }
}

function provenanceFor(estimate: ModelCostEstimate, capturedAt: number): UsagePricingProvenance {
  return {
    source: 'model_catalog',
    sourceId: estimate.entryId,
    currency: 'USD',
    capturedAt,
    rates: estimate.rates,
    ...(estimate.priceVersion === null ? {} : { priceVersion: estimate.priceVersion }),
    ...(estimate.window ? { priceWindow: estimate.window } : {})
  }
}

/**
 * Catalog price for a row whose own price is missing, or null when the catalog
 * cannot price it. The row's own timestamp decides the time-of-day window, so a
 * backfilled estimate bills the rates that governed the run.
 */
export function catalogCostForRun(row: UsageCostInput): UsageCostCorrection | null {
  const billed = billedUnits(row.tokens)
  if (billed <= 0) return null
  if (isFreeTierModelId(row.modelId)) return null
  const estimate = estimateModelCost(
    row.modelId,
    row.providerId,
    estimationUsage(row.tokens),
    new Date(row.createdAt)
  )
  if (!estimate || estimate.costUsd <= 0) return null
  return {
    costUsd: estimate.costUsd,
    pricingProvenance: provenanceFor(estimate, row.createdAt)
  }
}

/** Whether the recorded figure is a hole rather than a price. */
export function needsCatalogPrice(row: UsageCostInput): boolean {
  if (row.costStatus === 'unavailable') return true
  return row.costStatus === 'known' && row.costUsd === 0
}

/**
 * The row with a price that can be defended, or the row unchanged when the
 * recorded figure already stands or nothing can price it.
 *
 * A correction is always recorded as `estimated` with `model_catalog`
 * provenance: the provider did not state this dollar figure, the catalog did.
 */
export function reconcileRecordedCost(event: UsageEvent): UsageEvent {
  if (!needsCatalogPrice(event)) return event
  const correction = catalogCostForRun(event)
  if (!correction) return event
  return {
    ...event,
    costStatus: 'estimated',
    costUsd: correction.costUsd,
    pricingProvenance: correction.pricingProvenance
  }
}
