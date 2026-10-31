import { beforeEach, describe, expect, it } from 'vitest'
import type { UsageEvent, UsageEventCost, UsageEventDetails } from '../../src/lib/types'
import { registerModelPricing } from '../../src/main/providers/pricing'
import {
  catalogCostForRun,
  needsCatalogPrice,
  reconcileRecordedCost
} from '../../src/main/providers/usage-cost-reconcile'

const HAIKU = {
  id: 'anthropic/claude-haiku-5-5',
  inputUsdPer1M: 1,
  outputUsdPer1M: 5,
  cacheReadUsdPer1M: 0.1,
  cacheWriteUsdPer1M: 1.25,
  reasoningUsdPer1M: 5,
  official: true
}

/** One billed run, without the cost fields the two variants disagree on. */
const details: UsageEventDetails = {
  id: 'main:turn:call:1',
  threadId: 'thread-1',
  parentTurnId: 'turn-1',
  featureCallId: 'call-1',
  attempt: 1,
  feature: 'main',
  harnessId: 'pi',
  providerId: 'anthropic',
  modelId: 'claude-haiku-5-5',
  thinkingLevel: null,
  utilityId: null,
  rawProviderUsage: {},
  tokens: {
    uncachedInput: 1_000,
    cachedInput: 9_000,
    cacheWrite: 0,
    output: 100,
    reasoning: 0
  },
  rawTotal: 10_100,
  totalSemantics: 'provider_defined',
  toolFeeUsd: null,
  success: true,
  retryCause: null,
  createdAt: 1_700_000_000_000
}

/** The cost half of a row the provider priced itself. */
function providerCost(costUsd: number): UsageEventCost {
  return {
    costStatus: 'known',
    costUsd,
    pricingProvenance: { source: 'provider', currency: 'USD', capturedAt: 1_700_000_000_000 }
  }
}

/** A row carrying the gateway's own dollar figure. */
function event(overrides: Partial<UsageEventDetails> = {}): UsageEvent {
  return { ...details, ...overrides, ...providerCost(0) }
}

/** The same run with the shape a row takes when no price could be attached. */
function unpriced(overrides: Partial<UsageEventDetails> = {}): UsageEvent {
  return {
    ...details,
    ...overrides,
    costStatus: 'unavailable',
    costUsd: null,
    pricingProvenance: null
  }
}

/** Cost the catalog charges for the run `event()` describes. */
const expectedCost = (1_000 * 1 + 9_000 * 0.1 + 100 * 5) / 1_000_000

describe('usage cost reconciliation', () => {
  beforeEach(() => {
    registerModelPricing([HAIKU])
  })

  it('treats a provider zero for a priced model as a missing price', () => {
    expect(needsCatalogPrice(event())).toBe(true)
    const reconciled = reconcileRecordedCost(event())
    expect(reconciled.costStatus).toBe('estimated')
    expect(reconciled.costUsd).toBeCloseTo(expectedCost, 6)
    expect(reconciled.pricingProvenance?.source).toBe('model_catalog')
    expect(reconciled.pricingProvenance?.sourceId).toBe(HAIKU.id)
    expect(reconciled.pricingProvenance?.rates?.inputUsdPer1M).toBe(1)
  })

  it('prices a row the catalog could not price when it was written', () => {
    const reconciled = reconcileRecordedCost(unpriced())
    expect(reconciled.costStatus).toBe('estimated')
    expect(reconciled.costUsd).toBeCloseTo(expectedCost, 6)
  })

  it('keeps a real provider price untouched', () => {
    const paid: UsageEvent = { ...details, ...providerCost(0.42) }
    expect(needsCatalogPrice(paid)).toBe(false)
    expect(reconcileRecordedCost(paid)).toBe(paid)
  })

  it('keeps a free tier at its real zero even though a paid sibling is priced', () => {
    const free = event({ providerId: 'opencode', modelId: 'deepseek-v4.1-flash-free' })
    expect(needsCatalogPrice(free)).toBe(true)
    expect(catalogCostForRun(free)).toBeNull()
    expect(reconcileRecordedCost(free)).toBe(free)
  })

  it('leaves a run with no billed tokens alone', () => {
    const empty = event({
      tokens: {
        uncachedInput: 0,
        cachedInput: 0,
        cacheWrite: 0,
        output: 0,
        reasoning: 0
      }
    })
    expect(catalogCostForRun(empty)).toBeNull()
  })

  it('leaves an id no source publishes unpriced', () => {
    const unknown = unpriced({ providerId: 'anthropic', modelId: 'default' })
    expect(catalogCostForRun(unknown)).toBeNull()
    expect(reconcileRecordedCost(unknown)).toBe(unknown)
  })

  it('resolves a harness family alias to a priced model', () => {
    const alias = unpriced({ modelId: 'haiku' })
    expect(catalogCostForRun(alias)?.costUsd).toBeCloseTo(expectedCost, 6)
  })
})
