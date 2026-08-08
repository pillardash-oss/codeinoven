/**
 * Selected-model prompt budget with reserved output and tool headroom.
 *
 * The app caps dynamic prompt layers (e.g. the history recap) by the selected
 * model's context window and always reserves headroom for the model's output
 * and the tool schema/result surface, so a rebuilt conversation can never crowd
 * the entire window with input.
 */

/** Fallback context window when the selected model reports none. */
export const DEFAULT_PROMPT_BUDGET = {
  contextWindowTokens: 128_000,
  outputReserveTokens: 4_096,
  toolHeadroomTokens: 8_192
} as const

export interface PromptBudgetInput {
  /** Selected model's maximum context tokens (`ProviderModel.contextWindow`). */
  contextWindow?: number
  /** Tokens reserved for the model's output. */
  outputTokens?: number
  /** Tokens reserved for tool schemas and tool results. */
  toolHeadroomTokens?: number
}

export interface PromptBudget {
  contextWindow: number
  reservedOutputTokens: number
  reservedToolTokens: number
  availableInputTokens: number
}

export function computePromptBudget(input: PromptBudgetInput = {}): PromptBudget {
  const contextWindow = input.contextWindow ?? DEFAULT_PROMPT_BUDGET.contextWindowTokens
  const reservedOutputTokens = Math.max(
    0,
    input.outputTokens ?? DEFAULT_PROMPT_BUDGET.outputReserveTokens
  )
  const reservedToolTokens = Math.max(
    0,
    input.toolHeadroomTokens ?? DEFAULT_PROMPT_BUDGET.toolHeadroomTokens
  )
  const availableInputTokens = Math.max(
    1,
    contextWindow - reservedOutputTokens - reservedToolTokens
  )
  return {
    contextWindow,
    reservedOutputTokens,
    reservedToolTokens,
    availableInputTokens
  }
}

/** Coarse token estimate (~4 characters per token) for cheap budgeting. */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Truncate text to a token budget using the ~4 chars/token estimate. */
export function truncateToTokenBudget(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return ''
  const maxCharacters = maxTokens * 4
  return text.length > maxCharacters ? text.slice(0, maxCharacters) : text
}
