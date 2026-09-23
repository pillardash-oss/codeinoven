import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn() }
}))

vi.mock('../../../src/main/memory-service', () => ({
  MemoryService: class {},
  estimateTokens: (text: string) => Math.ceil(text.length / 4)
}))

import {
  composeBrainstormSystemPrompt,
  composeTurnSystemPrompt
} from '../../src/main/chat/chat-engine'
import { routineRunContext } from '$shared/routine-run'
import {
  composeBudgetedSend,
  computePromptBudget,
  estimateTextTokens,
  truncateToTokenBudget
} from '../../src/lib/prompt-budget'

/**
 * Production send-composition contract coverage for the EXACT function
 * ChatEngine uses (`composeBudgetedSend`) with the REAL system-prompt compose
 * functions, including large recap/hidden/user/system inputs and deterministic
 * rejection of fixed user+system overflow.
 */

function modelBudget(): number {
  return computePromptBudget({
    contextWindow: 32_000,
    outputTokens: 2_000,
    toolHeadroomTokens: 4_000
  }).availableInputTokens
}

function implementSystemBase(recap: string): string {
  return composeTurnSystemPrompt({
    chatPrompt: 'You are the CodeInOven engineering agent.',
    memoryInstruction: 'Treat these as user preferences.',
    imageDescriptorNote: 'Describe any images with the vision model.',
    assignmentCoordinatorSystemPrompt: 'The coordinator thread controls this assignment.',
    behaviorPrompt: 'Implement only the approved specification.',
    utilityInstructions: 'Tools are available for the current project.',
    behaviorMode: 'implement',
    historyRecap: recap
  })
}

describe('production send-composition budget (composeBudgetedSend)', () => {
  it('caps large recap + hidden layers so the composed turn fits the budget', () => {
    const available = modelBudget()
    const systemBase = implementSystemBase('')
    const composition = composeBudgetedSend({
      availableInputTokens: available,
      userText: 'Implement the login form with validation.',
      systemPrompt: systemBase,
      hiddenText: 'o'.repeat(50_000),
      recapText: 'h'.repeat(80_000),
      systemReserveTokens: 2_048
    })
    const finalSystem = implementSystemBase(composition.recapText)
    // driverText already contains the hidden context + user message; the final
    // system prompt already contains the recap.
    const total = estimateTextTokens(finalSystem) + estimateTextTokens(composition.driverText)
    expect(total).toBeLessThanOrEqual(available)
    expect(composition.driverText).toContain('Implement the login form with validation.')
    expect(composition.recapText.length).toBeLessThan(80_000)
    expect(composition.hiddenText.length).toBeLessThanOrEqual(50_000)
  })

  it('caps the hidden orchestration context first when headroom is tight', () => {
    const available = modelBudget()
    const systemBase = implementSystemBase('')
    const composition = composeBudgetedSend({
      availableInputTokens: available,
      userText: 'u'.repeat(4_000),
      systemPrompt: systemBase,
      hiddenText: 'h'.repeat(200_000),
      recapText: 'r'.repeat(200_000)
    })
    expect(composition.driverText).toContain('User message:')
    expect(
      estimateTextTokens(composition.driverText) +
        estimateTextTokens(systemBase) +
        estimateTextTokens(composition.recapText)
    ).toBeLessThanOrEqual(available)
  })

  it('rejects deterministically when fixed user + system layers exceed the budget', () => {
    const available = modelBudget()
    const hugeSystem = implementSystemBase('').repeat(500)
    expect(() =>
      composeBudgetedSend({
        availableInputTokens: available,
        userText: 'u'.repeat(100_000),
        systemPrompt: hugeSystem,
        hiddenText: 'hidden',
        recapText: 'recap'
      })
    ).toThrow(/too small/)
  })

  it('keeps the brainstorm composition within the budget', () => {
    const available = modelBudget()
    const brainstormBase = composeBrainstormSystemPrompt({
      activeBrainstormTurn: false,
      assignmentMode: true,
      revisionPrompt: 'Revise the existing specification.',
      memoryInstruction: 'Treat these as user preferences.',
      imageDescriptorNote: '',
      behaviorPrompt: 'Generate the engineering specification.',
      utilityInstructions: '',
      historyRecap: ''
    })
    const composition = composeBudgetedSend({
      availableInputTokens: available,
      userText: 'Specify the login flow.',
      systemPrompt: brainstormBase,
      hiddenText: '',
      recapText: truncateToTokenBudget('Prior conversation context', 6_000)
    })
    const finalSystem = composeBrainstormSystemPrompt({
      activeBrainstormTurn: false,
      assignmentMode: true,
      revisionPrompt: 'Revise the existing specification.',
      memoryInstruction: 'Treat these as user preferences.',
      imageDescriptorNote: '',
      behaviorPrompt: 'Generate the engineering specification.',
      utilityInstructions: '',
      historyRecap: composition.recapText
    })
    const total = estimateTextTokens(finalSystem) + estimateTextTokens(composition.driverText)
    expect(total).toBeLessThanOrEqual(available)
  })

  it('carries the routine contract in the system prompt, never in the user message', () => {
    const available = modelBudget()
    const contract = routineRunContext({ name: 'Slack digest', connections: [] })
    const systemBase = composeTurnSystemPrompt({
      chatPrompt: 'You are the CodeInOven assistant.',
      memoryInstruction: '',
      imageDescriptorNote: '',
      assignmentCoordinatorSystemPrompt: '',
      behaviorPrompt: '',
      utilityInstructions: 'CodeInOven utility contract (run)',
      routineInstruction: contract,
      behaviorMode: 'chat',
      historyRecap: ''
    })
    expect(systemBase).toContain(contract)
    // The user message stays the user's own words: a contract appended here
    // would be kept in the harness transcript and replayed on every later turn.
    const composition = composeBudgetedSend({
      availableInputTokens: available,
      userText: 'Run this scheduled task now: Getting started',
      systemPrompt: systemBase,
      hiddenText: '',
      recapText: ''
    })
    expect(composition.driverText).toBe('Run this scheduled task now: Getting started')
    expect(composition.driverText).not.toContain('cio_util_manage')
  })

  it('omits the routine layer when no routine thread applies', () => {
    const withoutRoutine = implementSystemBase('')
    expect(withoutRoutine).not.toContain('install_bundle')
  })
})
