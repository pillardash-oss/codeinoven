import { describe, expect, it } from 'vitest'
import {
  ROUTINE_NEXT_STEPS_PROMPT,
  isRoutineNextStepsPrompt
} from '$shared/assistant-next-steps'
import { routineRunContext } from '$shared/routine-run'
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
    expect(context).toContain('The how-to above is your instruction set')
  })

  it('tells the agent to supply a missing connection itself, with the gateway tools', () => {
    const context = routineRunContext({ name: 'Slack digest', connections: [] })
    expect(context).toContain('cio_util_find')
    expect(context).toContain('cio_util_manage')
    expect(context).toContain('install_bundle')
    expect(context).toContain('cio_ask_secret')
    expect(context).toContain('cio_ask_user')
  })

  it('frames the Connections tab as the last resort, never the first answer', () => {
    const context = routineRunContext({ name: 'Slack digest', connections: [] })
    expect(context).toContain('Only when you genuinely cannot install it yourself')
    expect(context).toContain('Connections tab')
    expect(context).toContain('Never end a run by telling the user to connect something')
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

describe('isRoutineNextStepsPrompt', () => {
  it('matches only the app-owned next-steps message', () => {
    expect(isRoutineNextStepsPrompt(ROUTINE_NEXT_STEPS_PROMPT)).toBe(true)
    expect(isRoutineNextStepsPrompt('Run this scheduled task now: Getting started')).toBe(false)
    expect(isRoutineNextStepsPrompt(`${ROUTINE_NEXT_STEPS_PROMPT} `)).toBe(false)
  })
})
