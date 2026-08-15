import { describe, expect, it } from 'vitest'
import type { AgentTokenUsage } from '../../src/lib/types'
import { registerModelPricing, estimateTokenCostUsd } from '../../src/main/providers/pricing'

const gpt5Tokens: AgentTokenUsage = {
  input: 100,
  output: 20,
  reasoning: 5,
  cacheRead: 10,
  cacheWrite: 5,
  total: 140
}

describe('estimateTokenCostUsd', () => {
  it('returns null when no tokens or no registered pricing', () => {
    registerModelPricing([])
    expect(estimateTokenCostUsd('gpt-5', 'openai', gpt5Tokens)).toBeNull()
    expect(estimateTokenCostUsd('gpt-5', 'openai', undefined)).toBeNull()
  })

  it('estimates cost from the matching registered entry', () => {
    registerModelPricing([
      {
        id: 'openai/gpt-5',
        inputUsdPer1M: 1.25,
        outputUsdPer1M: 10,
        cacheReadUsdPer1M: 0.125,
        cacheWriteUsdPer1M: 1.5625,
        reasoningUsdPer1M: 10,
        official: true
      }
    ])
    // uncached input 90 * 1.25 + cacheRead 10 * 0.125 + cacheWrite 5 * 1.5625
    //        + output 20 * 10 + reasoning 5 * 10, all / 1M
    expect(estimateTokenCostUsd('gpt-5', 'openai', gpt5Tokens)).toBeCloseTo(
      (90 * 1.25 + 10 * 0.125 + 5 * 1.5625 + 20 * 10 + 5 * 10) / 1_000_000,
      6
    )
  })

  it('is provider-aware: prefers the lab matching the provider', () => {
    registerModelPricing([
      {
        id: 'openai/gpt-5',
        inputUsdPer1M: 1.25,
        outputUsdPer1M: 10,
        cacheReadUsdPer1M: 0.125,
        cacheWriteUsdPer1M: 1.5625,
        reasoningUsdPer1M: 10,
        official: true
      },
      {
        id: 'azure/gpt-5',
        inputUsdPer1M: 2.0,
        outputUsdPer1M: 12,
        cacheReadUsdPer1M: 0.2,
        cacheWriteUsdPer1M: 2.5,
        reasoningUsdPer1M: 12
      }
    ])
    const openai = estimateTokenCostUsd('gpt-5', 'openai', gpt5Tokens)
    const azure = estimateTokenCostUsd('gpt-5', 'azure', gpt5Tokens)
    expect(openai).not.toBeNull()
    expect(azure).not.toBeNull()
    expect(openai).toBeLessThan(azure ?? Infinity)
  })

  it('matches a more-specific runtime model to its base entry', () => {
    registerModelPricing([
      {
        id: 'openai/gpt-5.1',
        inputUsdPer1M: 1.25,
        outputUsdPer1M: 10,
        cacheReadUsdPer1M: 0.125,
        cacheWriteUsdPer1M: 1.5625,
        reasoningUsdPer1M: 10,
        official: true
      }
    ])
    expect(estimateTokenCostUsd('gpt-5.1-2025-11-13', 'openai', gpt5Tokens)).not.toBeNull()
  })

  it('falls back across labs for unknown/custom providers', () => {
    registerModelPricing([
      {
        id: 'openai/gpt-5',
        inputUsdPer1M: 1.25,
        outputUsdPer1M: 10,
        cacheReadUsdPer1M: 0.125,
        cacheWriteUsdPer1M: 1.5625,
        reasoningUsdPer1M: 10,
        official: true
      }
    ])
    expect(estimateTokenCostUsd('gpt-5', 'my-custom-gateway', gpt5Tokens)).not.toBeNull()
  })

  it('clamps a malformed cache value that exceeds input to avoid negative cost', () => {
    registerModelPricing([
      {
        id: 'openai/gpt-5',
        inputUsdPer1M: 1.25,
        outputUsdPer1M: 10,
        cacheReadUsdPer1M: 0.125,
        cacheWriteUsdPer1M: 1.5625,
        reasoningUsdPer1M: 10
      }
    ])
    const tokens: AgentTokenUsage = {
      input: 10,
      output: 1,
      reasoning: 0,
      cacheRead: 100,
      cacheWrite: 0,
      total: 111
    }
    expect(estimateTokenCostUsd('gpt-5', 'openai', tokens)).toBeGreaterThanOrEqual(0)
  })

  it('treats a zero token breakdown as a zero cost, not a missing one', () => {
    registerModelPricing([
      {
        id: 'openai/gpt-5',
        inputUsdPer1M: 1.25,
        outputUsdPer1M: 10,
        cacheReadUsdPer1M: 0.125,
        cacheWriteUsdPer1M: 1.5625,
        reasoningUsdPer1M: 10
      }
    ])
    const zero: AgentTokenUsage = {
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0
    }
    expect(estimateTokenCostUsd('gpt-5', 'openai', zero)).toBe(0)
  })
})
