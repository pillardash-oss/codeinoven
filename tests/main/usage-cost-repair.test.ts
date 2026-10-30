import { describe, expect, it } from 'vitest'
import { registerModelPricing } from '../../src/main/providers/pricing'
import type { UsageCostInput } from '../../src/main/providers/usage-cost-reconcile'
import {
  usageCostUpdates,
  type UsageLedgerCostRow
} from '../../src/main/database/usage-cost-repair'

registerModelPricing([
  {
    id: 'anthropic/claude-haiku-5-5',
    inputUsdPer1M: 1,
    outputUsdPer1M: 5,
    cacheReadUsdPer1M: 0.1,
    cacheWriteUsdPer1M: 1.25,
    reasoningUsdPer1M: 5,
    official: true
  }
])

/** One ledger row of an older database, priced or not, at the given model. */
function row(id: string, overrides: Partial<UsageCostInput> = {}): UsageLedgerCostRow {
  return {
    id,
    modelId: 'claude-haiku-5-5',
    providerId: 'cio-opendesign',
    createdAt: 1_700_000_000_000,
    costStatus: 'known',
    costUsd: 0,
    tokens: {
      uncachedInput: 1_000,
      cachedInput: 9_000,
      cacheWrite: 0,
      output: 100,
      reasoning: 0
    },
    ...overrides
  }
}

/** Cost the catalog charges for the run `row()` describes. */
const expectedCost = (1_000 * 1 + 9_000 * 0.1 + 100 * 5) / 1_000_000

describe('usage cost repair', () => {
  it('corrects the zero a gateway reported for a priced model', () => {
    const updates = usageCostUpdates([row('a')])
    expect(updates).toHaveLength(1)
    expect(updates[0]?.id).toBe('a')
    expect(updates[0]?.costUsd).toBeCloseTo(expectedCost, 6)
    expect(updates[0]?.pricingProvenance.source).toBe('model_catalog')
  })

  it('corrects a row that was written before the catalog was available', () => {
    const updates = usageCostUpdates([row('b', { costStatus: 'unavailable', costUsd: null })])
    expect(updates).toHaveLength(1)
    expect(updates[0]?.costUsd).toBeCloseTo(expectedCost, 6)
  })

  it('leaves priced rows, free tiers and unmatched models alone', () => {
    expect(usageCostUpdates([row('c', { costUsd: 0.42 })])).toHaveLength(0)
    expect(
      usageCostUpdates([row('d', { providerId: 'opencode', modelId: 'haiku-free' })])
    ).toHaveLength(0)
    expect(
      usageCostUpdates([row('e', { modelId: 'default', costStatus: 'unavailable', costUsd: null })])
    ).toHaveLength(0)
  })

  it('leaves a run that billed nothing alone', () => {
    const updates = usageCostUpdates([
      row('f', {
        tokens: { uncachedInput: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0 }
      })
    ])
    expect(updates).toHaveLength(0)
  })
})
