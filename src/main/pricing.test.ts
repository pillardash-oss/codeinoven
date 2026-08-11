import { describe, expect, it } from 'vitest'
import type { AgentTokenUsage } from '../lib/types'
import { estimateTokenCostUsd } from './pricing'

const gpt5Tokens: AgentTokenUsage = {
  input: 100,
  output: 20,
  reasoning: 5,
  cacheRead: 10,
  cacheWrite: 5,
  total: 140
}

describe('estimateTokenCostUsd', () => {
  it('returns null when no token breakdown is available', () => {
    expect(estimateTokenCostUsd('gpt-5', 'openai', undefined)).toBeNull()
  })

  it('returns null when neither model nor provider has pricing data', () => {
    expect(estimateTokenCostUsd('unknown-model', 'unknown-provider', gpt5Tokens)).toBeNull()
  })

  it('estimates cost for an exact model match', () => {
    // gpt-5: uncached input 90 * 1.25 + cacheRead 10 * 0.125 + cacheWrite 5 * 1.5625
    //        + output 20 * 10 + reasoning 5 * 10, all / 1M
    expect(estimateTokenCostUsd('gpt-5', 'openai', gpt5Tokens)).toBeCloseTo(
      (90 * 1.25 + 10 * 0.125 + 5 * 1.5625 + 20 * 10 + 5 * 10) / 1_000_000,
      6
    )
  })

  it('resolves by longest model prefix (obfuscated version strings)', () => {
    const generic = estimateTokenCostUsd('gpt-5', 'openai', gpt5Tokens)
    expect(estimateTokenCostUsd('gpt-5.6-sol', 'openai', gpt5Tokens)).toBe(generic)
  })

  it('falls back to the provider generic price for an unknown model', () => {
    const openaiFallback = estimateTokenCostUsd('some-proprietary-model', 'openai', gpt5Tokens)
    const generic = estimateTokenCostUsd('gpt-5', 'openai', gpt5Tokens)
    expect(openaiFallback).toBe(generic)
  })

  it('clamps a malformed cache value that exceeds input to avoid negative cost', () => {
    const tokens: AgentTokenUsage = {
      input: 10,
      output: 1,
      reasoning: 0,
      cacheRead: 100,
      cacheWrite: 0,
      total: 111
    }
    const estimated = estimateTokenCostUsd('gpt-5', 'openai', tokens)
    expect(estimated).toBeGreaterThanOrEqual(0)
  })

  it('treats a zero token breakdown as a zero cost, not a missing one', () => {
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

  it('resolves the codex model family to its own rate', () => {
    const tokens: AgentTokenUsage = {
      input: 1_000_000,
      output: 100_000,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 1_100_000
    }
    expect(estimateTokenCostUsd('codex', 'openai', tokens)).toBeCloseTo(2 + 1.2, 6)
  })
})
