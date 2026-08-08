import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PROMPT_BUDGET,
  computePromptBudget,
  estimateTextTokens,
  truncateToTokenBudget
} from './prompt-budget'

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
