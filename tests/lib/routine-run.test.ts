import { describe, expect, it } from 'vitest'
import { ROUTINE_NEXT_STEPS_PROMPT, isRoutineNextStepsPrompt } from '$shared/assistant-next-steps'
import { composeRoutineInstruction, routineRunContext } from '$shared/routine-run'
import type { RoutineConnection } from '$shared/types'

function connection(overrides: Partial<RoutineConnection> = {}): RoutineConnection {
  return {
    utilityId: 'required:slack',
    label: 'Slack',
    required: true,
    ...overrides
  }
}

describe('routineRunContext', () => {
  it('names the routine and points at the how-to as the instruction set', () => {
    const context = routineRunContext({ name: 'Slack digest', connections: [] })
    expect(context).toContain('"Slack digest"')
    expect(context).toContain('Its how-to is your instruction set')
  })

  it('tells the agent to supply a missing connection itself, with the gateway tools', () => {
    const context = routineRunContext({ name: 'Slack digest', connections: [] })
    expect(context).toContain('cio_util_find')
    expect(context).toContain('cio_util_manage')
    expect(context).toContain('install_bundle')
    expect(context).toContain('cio_ask_secret')
    expect(context).toContain('cio_ask_user')
  })

  it('tells the agent to go online when the library has nothing', () => {
    const context = routineRunContext({ name: 'Slack digest', connections: [] })
    expect(context).toContain('go online')
    expect(context).toContain('cio_util_init')
    expect(context).toContain('official MCP endpoint')
  })

  it('routes credentials through cio_ask_secret and forbids pasting a secret in chat', () => {
    const context = routineRunContext({ name: 'Slack digest', connections: [] })
    expect(context).toContain('environment_variable')
    expect(context).toContain('Never ask the user to paste a secret into chat')
  })

  it('frames the Connections tab as the last resort, never the first answer', () => {
    const context = routineRunContext({ name: 'Slack digest', connections: [] })
    expect(context).toContain('Only when you genuinely cannot install it yourself')
    expect(context).toContain('Connections tab')
    expect(context).toContain('Never end a turn by telling the user to connect something')
  })

  it('lists the routine connections with their required flag and setup note', () => {
    const context = routineRunContext({
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

  it('omits the connections section when the routine records none', () => {
    const context = routineRunContext({ name: 'Slack digest', connections: [] })
    expect(context).not.toContain('Connections this routine records')
  })

  it('skips connections whose label is blank', () => {
    const context = routineRunContext({
      name: 'Slack digest',
      connections: [connection({ utilityId: 'x', label: '   ', required: false })]
    })
    expect(context).not.toContain('Connections this routine records')
  })
})

describe('composeRoutineInstruction', () => {
  it('puts the how-to before the contract that calls it the instruction set', () => {
    const composed = composeRoutineInstruction(
      '1. Check every Slack channel.',
      routineRunContext({ name: 'Slack digest', connections: [] })
    )
    expect(composed).toBeDefined()
    expect(composed?.indexOf('1. Check every Slack channel.')).toBe(0)
    expect(composed?.indexOf('Its how-to is your instruction set')).toBeGreaterThan(0)
  })

  it('keeps the contract when the routine has no how-to text yet', () => {
    const contract = routineRunContext({ name: 'Slack digest', connections: [] })
    expect(composeRoutineInstruction(undefined, contract)).toBe(contract)
    expect(composeRoutineInstruction('   ', contract)).toBe(contract)
  })

  it('keeps the how-to when no contract applies', () => {
    expect(composeRoutineInstruction('1. Check Slack.', undefined)).toBe('1. Check Slack.')
  })

  it('returns undefined when neither piece exists, so no empty layer is added', () => {
    expect(composeRoutineInstruction(undefined, undefined)).toBeUndefined()
    expect(composeRoutineInstruction('  ', '  ')).toBeUndefined()
  })
})

describe('isRoutineNextStepsPrompt', () => {
  it('matches only the app-owned next-steps message', () => {
    expect(isRoutineNextStepsPrompt(ROUTINE_NEXT_STEPS_PROMPT)).toBe(true)
    expect(isRoutineNextStepsPrompt('Run this scheduled task now: Getting started')).toBe(false)
    expect(isRoutineNextStepsPrompt(`${ROUTINE_NEXT_STEPS_PROMPT} `)).toBe(false)
  })
})
