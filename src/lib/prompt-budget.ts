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

/** Estimated tokens of each final-composition input layer. */
export interface TurnLayerTokens {
  /** User message text. */
  userTokens: number
  /** Final system/behavior/tool prompt WITHOUT the history recap. */
  systemTokens: number
  /** Hidden orchestration context (raw). */
  hiddenTokens: number
  /** History recap (raw; large when the recap should take all headroom). */
  recapTokens: number
}

export interface BudgetedTurnLayers {
  /** Hidden context tokens allowed after the aggregate subtraction. */
  hiddenTokens: number
  /** History recap tokens allowed with the remaining headroom. */
  recapTokens: number
  /** Total estimated input across all layers (must fit the budget). */
  totalTokens: number
}

/**
 * Enforce ONE aggregate selected-model input budget across the final turn
 * composition (user text + system/behavior/tool + hidden context + history
 * recap), with output/tool headroom reserved once by the caller's
 * `computePromptBudget`. The hidden orchestration context is capped first and
 * the history recap takes only the remaining headroom — no layer gets the full
 * allowance.
 */
export function budgetTurnLayers(
  layers: TurnLayerTokens,
  availableInputTokens: number
): BudgetedTurnLayers {
  const userTokens = Math.max(0, layers.userTokens)
  const systemTokens = Math.max(0, layers.systemTokens)
  const fixed = userTokens + systemTokens
  let remaining = Math.max(0, availableInputTokens - fixed)
  const hiddenTokens = Math.min(Math.max(0, layers.hiddenTokens), remaining)
  remaining -= hiddenTokens
  const recapTokens = Math.min(Math.max(0, layers.recapTokens), remaining)
  return {
    hiddenTokens,
    recapTokens,
    totalTokens: fixed + hiddenTokens + recapTokens
  }
}

/** Production input for a single turn's final composition. */
export interface ProductionSendCompositionInput {
  /** One aggregate selected-model input budget (headroom already reserved). */
  availableInputTokens: number
  /** The user message text. */
  userText: string
  /** Final system/behavior/tool prompt WITHOUT the history recap. */
  systemPrompt: string
  /** Hidden orchestration context (raw, before capping). */
  hiddenText: string
  /** History recap (raw; capped to the remaining headroom). */
  recapText: string
  /** Extra conservative reserve for the final system layer. */
  systemReserveTokens?: number
}

export interface ProductionSendComposition {
  /** The exact text sent to the harness: capped hidden + user message. */
  driverText: string
  /** Hidden context after the aggregate capping. */
  hiddenText: string
  /** History recap after the aggregate capping. */
  recapText: string
  /** Total estimated input across all layers after capping. */
  totalTokens: number
}

/**
 * The single production budget/composition function ChatEngine uses for a turn:
 * it enforces ONE aggregate selected-model input budget over user text + the
 * final system/behavior/tool prompt + hidden orchestration context + history
 * recap (output/tool headroom reserved once by the caller), recomposes the sent
 * driverText from the precise hidden allowance, and DETERMINISTICALLY REJECTS
 * when the fixed user + system layers alone exceed the budget — it never
 * silently relies on harness truncation.
 */
export function composeBudgetedSend(
  input: ProductionSendCompositionInput
): ProductionSendComposition {
  // The driver text joins the hidden context and the user message with a small
  // "User message:" wrapper, so reserve a few tokens for it in the aggregate.
  const wrapperTokens = input.hiddenText ? 4 : 0
  const fixedTokens =
    estimateTextTokens(input.userText) + wrapperTokens + estimateTextTokens(input.systemPrompt)
  if (fixedTokens > input.availableInputTokens) {
    throw new Error(
      `The selected model input budget (${input.availableInputTokens} tokens) is too small ` +
        'for this user message plus the system/behavior/tool prompt'
    )
  }
  const layers = budgetTurnLayers(
    {
      userTokens: estimateTextTokens(input.userText) + wrapperTokens,
      systemTokens: estimateTextTokens(input.systemPrompt) + (input.systemReserveTokens ?? 0),
      hiddenTokens: estimateTextTokens(input.hiddenText),
      recapTokens: estimateTextTokens(input.recapText)
    },
    input.availableInputTokens
  )
  const hiddenText = truncateToTokenBudget(input.hiddenText, layers.hiddenTokens)
  const recapText = truncateToTokenBudget(input.recapText, layers.recapTokens)
  const driverText = hiddenText
    ? `${hiddenText}\n\nUser message:\n${input.userText}`
    : input.userText
  return {
    driverText,
    hiddenText,
    recapText,
    totalTokens:
      estimateTextTokens(input.systemPrompt) +
      estimateTextTokens(input.userText) +
      estimateTextTokens(hiddenText) +
      estimateTextTokens(recapText) +
      wrapperTokens
  }
}
