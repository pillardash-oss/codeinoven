import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn() }
}))

vi.mock('./memory-service', () => ({
  MemoryService: class {},
  estimateTokens: (text: string) => Math.ceil(text.length / 4),
  modelTitlesEnabled: () => false
}))

import { composeBrainstormSystemPrompt, composeTurnSystemPrompt } from './chat-engine'
import {
  budgetTurnLayers,
  computePromptBudget,
  estimateTextTokens,
  truncateToTokenBudget
} from '../lib/prompt-budget'

/**
 * Production send-composition contract: the final composed system prompt (built
 * with the real compose functions), the user text, and the budgeted hidden
 * context must all fit the ONE aggregate selected-model input budget derived
 * from `budgetTurnLayers`, with output/tool headroom reserved once.
 */
function compositionTotals(): {
  system: string
  recap: string
  hidden: string
  user: string
  totalTokens: number
  available: number
} {
  const budget = computePromptBudget({
    contextWindow: 32_000,
    outputTokens: 2_000,
    toolHeadroomTokens: 4_000
  })
  const available = budget.availableInputTokens

  const baseParts = {
    chatPrompt: 'You are the CodeInOven engineering agent.',
    memoryInstruction: 'Treat these as user preferences.',
    imageDescriptorNote: 'Describe any images with the vision model.',
    assignmentCoordinatorSystemPrompt: 'The coordinator thread controls this assignment.',
    behaviorPrompt: 'Implement only the approved specification.',
    utilityInstructions: 'Tools are available for the current project.',
    behaviorMode: 'implement' as const
  }
  const systemBase = composeTurnSystemPrompt({ ...baseParts, historyRecap: '' })
  const userText = 'Implement the login form with validation.'
  const hiddenContext = 'User requested the login form. Project references: src/main/auth.ts.'

  const layers = budgetTurnLayers(
    {
      userTokens: estimateTextTokens(userText),
      systemTokens: estimateTextTokens(systemBase),
      hiddenTokens: estimateTextTokens(hiddenContext),
      recapTokens: 2_000_000
    },
    available
  )
  const recapText = truncateToTokenBudget('Past messages', layers.recapTokens)
  const system = composeTurnSystemPrompt({ ...baseParts, historyRecap: recapText })
  const hidden = truncateToTokenBudget(hiddenContext, layers.hiddenTokens)
  const total =
    estimateTextTokens(system) + estimateTextTokens(userText) + estimateTextTokens(hidden)
  return { system, recap: recapText, hidden, user: userText, totalTokens: total, available }
}

describe('production send-composition budget contract', () => {
  it('keeps the implement/chat composition within the one aggregate input budget', () => {
    const { totalTokens, available } = compositionTotals()
    expect(totalTokens).toBeLessThanOrEqual(available)
  })

  it('keeps the brainstorm composition within the budget', () => {
    const budget = computePromptBudget({
      contextWindow: 32_000,
      outputTokens: 2_000,
      toolHeadroomTokens: 4_000
    })
    const available = budget.availableInputTokens
    const base = composeBrainstormSystemPrompt({
      activeBrainstormTurn: false,
      assignmentMode: true,
      revisionPrompt: 'Revise the existing specification.',
      memoryInstruction: 'Treat these as user preferences.',
      imageDescriptorNote: '',
      behaviorPrompt: 'Generate the engineering specification.',
      utilityInstructions: '',
      historyRecap: ''
    })
    const userTokens = 1_000
    const layers = budgetTurnLayers(
      {
        userTokens,
        systemTokens: estimateTextTokens(base),
        hiddenTokens: 0,
        recapTokens: 2_000_000
      },
      available
    )
    const system = composeBrainstormSystemPrompt({
      activeBrainstormTurn: false,
      assignmentMode: true,
      revisionPrompt: 'Revise the existing specification.',
      memoryInstruction: 'Treat these as user preferences.',
      imageDescriptorNote: '',
      behaviorPrompt: 'Generate the engineering specification.',
      utilityInstructions: '',
      historyRecap: truncateToTokenBudget('Prior context', layers.recapTokens)
    })
    const total = estimateTextTokens(system) + userTokens
    expect(total).toBeLessThanOrEqual(available)
  })

  it('caps dynamic layers to zero when fixed user/system layers exceed the budget', () => {
    const available = 10_000
    const layers = budgetTurnLayers(
      { userTokens: 8_000, systemTokens: 8_000, hiddenTokens: 5_000, recapTokens: 5_000 },
      available
    )
    // Fixed layers alone exceed the budget: no dynamic layer is allocated.
    expect(layers.hiddenTokens).toBe(0)
    expect(layers.recapTokens).toBe(0)
    expect(layers.totalTokens).toBeGreaterThanOrEqual(available)
    // The user text is preserved; the harness enforces its own truncation.
    const composed = composeTurnSystemPrompt({
      chatPrompt: 'a'.repeat(8_000 * 4),
      memoryInstruction: 'x'.repeat(8_000 * 4),
      imageDescriptorNote: '',
      assignmentCoordinatorSystemPrompt: '',
      behaviorPrompt: '',
      utilityInstructions: '',
      behaviorMode: 'chat',
      historyRecap: ''
    })
    expect(composed.length).toBeGreaterThan(0)
  })
})
