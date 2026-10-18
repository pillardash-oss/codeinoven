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
import { RESPONSE_STYLE_INSTRUCTION } from '../../src/main/chat/chat-engine/chat-engine-prompts'
import { assistantRunContext } from '$shared/assistant-run'
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

function implementSystemBase(): string {
  return composeTurnSystemPrompt({
    chatPrompt: 'You are the CodeInOven engineering agent.',
    memoryInstruction: 'Treat these as user preferences.',
    imageDescriptorNote: 'Describe any images with the vision model.',
    assignmentCoordinatorSystemPrompt: 'The coordinator thread controls this assignment.',
    behaviorPrompt: 'Implement only the approved specification.',
    utilityInstructions: 'Tools are available for the current project.',
    behaviorMode: 'implement'
  })
}

describe('production send-composition budget (composeBudgetedSend)', () => {
  it('caps large recap + hidden layers so the composed turn fits the budget', () => {
    const available = modelBudget()
    const systemBase = implementSystemBase()
    const composition = composeBudgetedSend({
      availableInputTokens: available,
      userText: 'Implement the login form with validation.',
      systemPrompt: systemBase,
      hiddenText: 'o'.repeat(50_000),
      recapText: 'h'.repeat(80_000),
      systemReserveTokens: 2_048
    })
    // The recap is delivered in the user channel (the driver's
    // `historyRecap` field), never the system prompt, but it still counts
    // against the one aggregate budget with the driver text and system base.
    const total =
      estimateTextTokens(systemBase) +
      estimateTextTokens(composition.driverText) +
      estimateTextTokens(composition.recapText)
    expect(total).toBeLessThanOrEqual(available)
    expect(composition.driverText).toContain('Implement the login form with validation.')
    expect(composition.recapText.length).toBeLessThan(80_000)
    expect(composition.hiddenText.length).toBeLessThanOrEqual(50_000)
    // The recap must never be a system-prompt layer.
    expect(systemBase).not.toContain(composition.recapText)
  })

  it('caps the hidden orchestration context first when headroom is tight', () => {
    const available = modelBudget()
    const systemBase = implementSystemBase()
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
    const hugeSystem = implementSystemBase().repeat(500)
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
      utilityInstructions: ''
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
      utilityInstructions: ''
    })
    const total =
      estimateTextTokens(finalSystem) +
      estimateTextTokens(composition.driverText) +
      estimateTextTokens(composition.recapText)
    expect(total).toBeLessThanOrEqual(available)
  })

  it('carries the assistant contract in the system prompt, never in the user message', () => {
    const available = modelBudget()
    const contract = assistantRunContext({ name: 'Slack digest', connections: [] })
    const systemBase = composeTurnSystemPrompt({
      chatPrompt: 'You are the CodeInOven assistant.',
      memoryInstruction: '',
      imageDescriptorNote: '',
      assignmentCoordinatorSystemPrompt: '',
      behaviorPrompt: '',
      utilityInstructions: 'CodeInOven utility contract (run)',
      assistantInstruction: contract,
      behaviorMode: 'chat'
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

  it('omits the assistant layer when no assistant thread applies', () => {
    const withoutAssistant = implementSystemBase()
    expect(withoutAssistant).not.toContain('install_bundle')
  })

  it('scopes the reply budget to day-to-day implementation and chat turns', () => {
    // Only regular implementation and chats carry the app-owned executive reply
    // budget. The engineering lifecycle needs the full technical detail, and an
    // assistant already owns a stricter reply contract of its own, so neither may
    // receive it. Every half is asserted so the scope cannot silently widen or
    // collapse to an omission everywhere.
    const implement = implementSystemBase()
    expect(implement.split(RESPONSE_STYLE_INSTRUCTION)).toHaveLength(2)

    const chat = composeTurnSystemPrompt({
      chatPrompt: 'You are a chat.',
      memoryInstruction: '',
      imageDescriptorNote: '',
      assignmentCoordinatorSystemPrompt: '',
      behaviorPrompt: '',
      utilityInstructions: '',
      behaviorMode: 'chat'
    })
    expect(chat.split(RESPONSE_STYLE_INSTRUCTION)).toHaveLength(2)

    const lifecycle = composeBrainstormSystemPrompt({
      activeBrainstormTurn: false,
      assignmentMode: false,
      engineeringSpecPrompt: 'Return the specification.',
      revisionPrompt: '',
      memoryInstruction: '',
      imageDescriptorNote: '',
      behaviorPrompt: '',
      utilityInstructions: ''
    })
    expect(lifecycle).not.toContain(RESPONSE_STYLE_INSTRUCTION)
    expect(lifecycle).toContain('keep artifact fences inside the appropriate Markdown string field')

    const assistant = composeTurnSystemPrompt({
      chatPrompt: 'You are the CodeInOven assistant.',
      memoryInstruction: '',
      imageDescriptorNote: '',
      assignmentCoordinatorSystemPrompt: '',
      behaviorPrompt: '',
      utilityInstructions: '',
      assistantInstruction: assistantRunContext({ name: 'Slack digest', connections: [] }),
      behaviorMode: 'assistant'
    })
    expect(assistant).not.toContain(RESPONSE_STYLE_INSTRUCTION)
    expect(assistant).toContain('at most 80 words')
  })
})
