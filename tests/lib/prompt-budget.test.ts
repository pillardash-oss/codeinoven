import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PROMPT_BUDGET,
  budgetTurnLayers,
  computePromptBudget,
  estimateTextTokens,
  truncateToTokenBudget
} from '../../src/lib/prompt-budget'

describe('computePromptBudget', () => {
  it('reserves output and tool headroom from the default window', () => {
    const budget = computePromptBudget()
    expect(budget.contextWindow).toBe(DEFAULT_PROMPT_BUDGET.contextWindowTokens)
    expect(budget.reservedOutputTokens).toBe(DEFAULT_PROMPT_BUDGET.outputReserveTokens)
    expect(budget.reservedToolTokens).toBe(DEFAULT_PROMPT_BUDGET.toolHeadroomTokens)
    expect(budget.availableInputTokens).toBe(
      DEFAULT_PROMPT_BUDGET.contextWindowTokens -
        DEFAULT_PROMPT_BUDGET.outputReserveTokens -
        DEFAULT_PROMPT_BUDGET.toolHeadroomTokens
    )
  })

  it('budgets by the selected model context window when provided', () => {
    const budget = computePromptBudget({
      contextWindow: 32_000,
      outputTokens: 2_000,
      toolHeadroomTokens: 4_000
    })
    expect(budget.availableInputTokens).toBe(26_000)
  })

  it('never produces a zero input budget', () => {
    const budget = computePromptBudget({
      contextWindow: 100,
      outputTokens: 200,
      toolHeadroomTokens: 200
    })
    expect(budget.availableInputTokens).toBeGreaterThanOrEqual(1)
  })

  it('falls back to the default window when the reported window is implausibly small', () => {
    // A stale/corrupt catalog record reporting a near-zero window must not
    // collapse the budget to ~1 token and reject every user message.
    for (const bogus of [0, 1, 10, 2048]) {
      const budget = computePromptBudget({ contextWindow: bogus })
      expect(budget.contextWindow).toBe(DEFAULT_PROMPT_BUDGET.contextWindowTokens)
      expect(budget.availableInputTokens).toBeGreaterThan(100_000)
    }
  })

  it('honors plausible small windows from genuinely compact models', () => {
    const budget = computePromptBudget({ contextWindow: 8_192 })
    expect(budget.contextWindow).toBe(8_192)
  })
})

describe('token estimation and truncation', () => {
  it('estimates tokens from characters', () => {
    expect(estimateTextTokens('')).toBe(0)
    expect(estimateTextTokens('abcd')).toBe(1)
    expect(estimateTextTokens('a'.repeat(9))).toBe(3)
  })

  it('truncates long text to the token budget', () => {
    const text = 'a'.repeat(1_000)
    expect(truncateToTokenBudget(text, 100)).toHaveLength(400)
    expect(truncateToTokenBudget(text, 500)).toHaveLength(1_000)
    expect(truncateToTokenBudget(text, 0)).toBe('')
  })
})

describe('budgetTurnLayers (final-composition contract)', () => {
  it('caps the total composition to the one aggregate input budget', () => {
    // Reserve output/tool headroom once from the model window, then budget all
    // four turn layers against the single remaining allowance.
    const budget = computePromptBudget({
      contextWindow: 32_000,
      outputTokens: 2_000,
      toolHeadroomTokens: 4_000
    })
    const layers = budgetTurnLayers(
      {
        userTokens: 4_000,
        systemTokens: 6_000,
        hiddenTokens: 8_000,
        recapTokens: 2_000_000
      },
      budget.availableInputTokens
    )
    expect(layers.totalTokens).toBeLessThanOrEqual(budget.availableInputTokens)
    expect(layers.totalTokens).toBe(26_000)
    // The recap takes only the headroom left after user + system + hidden.
    expect(layers.recapTokens).toBe(8_000)
    expect(layers.hiddenTokens).toBe(8_000)
  })

  it('caps the hidden orchestration context first when headroom is tight', () => {
    const layers = budgetTurnLayers(
      { userTokens: 5_000, systemTokens: 5_000, hiddenTokens: 8_000, recapTokens: 20_000 },
      12_000
    )
    expect(layers.hiddenTokens).toBe(2_000)
    expect(layers.recapTokens).toBe(0)
    expect(layers.totalTokens).toBe(12_000)
  })

  it('never lets dynamic layers exceed the remaining headroom', () => {
    const fixed = 200_000
    const available = 20_000
    const layers = budgetTurnLayers(
      { userTokens: 100_000, systemTokens: 100_000, hiddenTokens: 100_000, recapTokens: 100_000 },
      available
    )
    // The fixed user/system layers are preserved; no hidden/recap tokens are
    // allocated once the fixed layers already exceed the aggregate budget.
    expect(layers.hiddenTokens).toBe(0)
    expect(layers.recapTokens).toBe(0)
    expect(layers.hiddenTokens + layers.recapTokens).toBeLessThanOrEqual(
      Math.max(0, available - fixed)
    )
  })
})
