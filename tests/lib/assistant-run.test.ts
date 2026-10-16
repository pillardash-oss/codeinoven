import { describe, expect, it } from 'vitest'
import {
  ASSISTANT_NEXT_STEPS_PROMPT,
  isAssistantNextStepsPrompt
} from '$shared/assistant-next-steps'
import {
  composeAssistantInstruction,
  assistantRunContext,
  assistantRunPrompt
} from '$shared/assistant-run'
import type { AssistantConnection } from '$shared/types'
import {
  ASSISTANT_BRIEF_REPLY_INSTRUCTION,
  ASSISTANT_VOICE_INSTRUCTION
} from '$shared/assistant-voice'

function connection(overrides: Partial<AssistantConnection> = {}): AssistantConnection {
  return {
    utilityId: 'required:slack',
    label: 'Slack',
    required: true,
    ...overrides
  }
}

describe('assistantRunContext', () => {
  it('names the assistant and points at the knowledge as the instruction set', () => {
    const context = assistantRunContext({ name: 'Slack digest', connections: [] })
    expect(context).toContain('"Slack digest"')
    expect(context).toContain('Its knowledge is your instruction set')
  })

  it('tells the agent to supply a missing connection itself, with the gateway tools', () => {
    const context = assistantRunContext({ name: 'Slack digest', connections: [] })
    expect(context).toContain('cio_util_find')
    expect(context).toContain('cio_util_manage')
    expect(context).toContain('install_bundle')
    expect(context).toContain('cio_ask_secret')
    expect(context).toContain('cio_ask_user')
  })

  it('tells the agent to go online when the library has nothing', () => {
    const context = assistantRunContext({ name: 'Slack digest', connections: [] })
    expect(context).toContain('go online')
    expect(context).toContain('cio_util_init')
    expect(context).toContain('official MCP endpoint')
  })

  it('routes credentials through cio_ask_secret and forbids pasting a secret in chat', () => {
    const context = assistantRunContext({ name: 'Slack digest', connections: [] })
    expect(context).toContain('environment_variable')
    expect(context).toContain('Never ask the user to paste a secret into chat')
  })

  it('frames the Connections tab as the last resort, never the first answer', () => {
    const context = assistantRunContext({ name: 'Slack digest', connections: [] })
    expect(context).toContain('Only when you genuinely cannot install it yourself')
    expect(context).toContain('Connections tab')
    expect(context).toContain('Never end a turn by telling the user to connect something')
  })

  it('lists the assistant connections with their required flag and setup note', () => {
    const context = assistantRunContext({
      name: 'Slack digest',
      connections: [
        connection(),
        connection({
          utilityId: 'cio:browser',
          label: 'In-app browser',
          required: false,
          setup: 'Open the browser and sign in to Slack.'
        })
      ]
    })
    expect(context).toContain('- Slack (required, not yet linked to a library utility)')
    expect(context).toContain('- In-app browser')
    expect(context).toContain('setup note: Open the browser and sign in to Slack.')
  })

  it('omits the connections section when the assistant records none', () => {
    const context = assistantRunContext({ name: 'Slack digest', connections: [] })
    expect(context).not.toContain('Connections this assistant records')
  })

  it('skips connections whose label is blank', () => {
    const context = assistantRunContext({
      name: 'Slack digest',
      connections: [connection({ utilityId: 'x', label: '   ', required: false })]
    })
    expect(context).not.toContain('Connections this assistant records')
  })
})

describe('composeAssistantInstruction', () => {
  it('puts the knowledge before the contract that calls it the instruction set', () => {
    const composed = composeAssistantInstruction(
      '1. Check every Slack channel.',
      assistantRunContext({ name: 'Slack digest', connections: [] })
    )
    expect(composed).toBeDefined()
    expect(composed?.indexOf('1. Check every Slack channel.')).toBe(0)
    expect(composed?.indexOf('Its knowledge is your instruction set')).toBeGreaterThan(0)
  })

  it('keeps the contract when the assistant has no knowledge text yet', () => {
    const contract = assistantRunContext({ name: 'Slack digest', connections: [] })
    expect(composeAssistantInstruction(undefined, contract)).toBe(contract)
    expect(composeAssistantInstruction('   ', contract)).toBe(contract)
  })

  it('keeps the knowledge when no contract applies', () => {
    expect(composeAssistantInstruction('1. Check Slack.', undefined)).toBe('1. Check Slack.')
  })

  it('returns undefined when neither piece exists, so no empty layer is added', () => {
    expect(composeAssistantInstruction(undefined, undefined)).toBeUndefined()
    expect(composeAssistantInstruction('  ', '  ')).toBeUndefined()
  })
})

describe('assistantRunPrompt', () => {
  it('names a user task by its own title', () => {
    expect(assistantRunPrompt({ title: 'Triage PRs' }, 'Shower News')).toBe(
      'Run this scheduled task now: Triage PRs'
    )
  })

  it('names a Getting started thread by the assistant, never by its authoring title', () => {
    // The seed thread's fixed "Getting started" title is the authoring host, so
    // a run of it must read as the assistant, not as another getting-started pass.
    expect(
      assistantRunPrompt({ title: 'Getting started', assistantGettingStarted: true }, 'Shower News')
    ).toBe('Run this scheduled task now: Shower News')
  })

  it('falls back to the bare prompt when neither label exists', () => {
    expect(assistantRunPrompt({ title: '   ' }, 'Shower News')).toBe('Run this scheduled task now.')
    expect(
      assistantRunPrompt({ title: 'Getting started', assistantGettingStarted: true }, '   ')
    ).toBe('Run this scheduled task now.')
  })
})

describe('isAssistantNextStepsPrompt', () => {
  it('matches only the app-owned next-steps message', () => {
    expect(isAssistantNextStepsPrompt(ASSISTANT_NEXT_STEPS_PROMPT)).toBe(true)
    expect(isAssistantNextStepsPrompt('Run this scheduled task now: Getting started')).toBe(false)
    expect(isAssistantNextStepsPrompt(`${ASSISTANT_NEXT_STEPS_PROMPT} `)).toBe(false)
  })
})

describe('concise assistant delivery', () => {
  it.each([
    undefined,
    { channel: 'in-app' as const },
    { channel: 'email' as const, target: 'reports@example.com' }
  ])('keeps the brief-output rule last for every delivery route: %j', (delivery) => {
    const context = assistantRunContext({
      name: 'Judge',
      connections: [connection({ setup: 'Verify the source account.' })],
      delivery,
      priority: { timeliness: 'today', impact: 'company' }
    })
    expect(context.endsWith(ASSISTANT_BRIEF_REPLY_INSTRUCTION)).toBe(true)
    expect(context).not.toContain('complete report itself')
    expect(context).toContain('at most 80 words')
    expect(context).toContain('Keep planning, self-talk, drafts')
    expect(context).toContain('Never append a translation')
    expect(context).toContain('Expand only when the user explicitly asks for detail')
  })
  it('applies the same brevity rule to setup and follow-up persona layers', () => {
    expect(ASSISTANT_VOICE_INSTRUCTION).toContain(ASSISTANT_BRIEF_REPLY_INSTRUCTION)
  })
})
