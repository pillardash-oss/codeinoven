import { describe, expect, it } from 'vitest'
import { UtilityOrchestrationServiceOvenUtilities } from '../../../src/main/utilities/utility-orchestration-service/utility-orchestration-service-oven-utilities'
import type {
  UtilityOrchestrationService,
  TurnState
} from '../../../src/main/utilities/utility-orchestration-service'
import type { ResolvedUtility, UtilityDefinition } from '../../../src/lib/types'

/**
 * The catalogue an Oven is handed.
 *
 * An Oven has no registry and no vault, so whatever this builder leaves out is a
 * capability that machine cannot run, and whatever it puts in with credentials
 * travels off this device. These tests fix both halves of that: a skill carries
 * its instructions, an MCP server carries its resolved command and environment,
 * and a utility whose work only exists in this app is never described at all.
 */
function definition(overrides: Partial<UtilityDefinition>): UtilityDefinition {
  const base = {
    id: 'utility-1',
    kind: 'skill',
    name: 'A skill',
    description: 'What it does',
    enabled: true,
    activation: 'on_demand',
    scope: { kind: 'global' },
    credentials: [],
    harnessBindings: [],
    appOwned: false,
    createdAt: 0,
    updatedAt: 0
  }
  return { ...base, ...overrides } as UtilityDefinition
}

function resolved(utility: UtilityDefinition): ResolvedUtility {
  return { utility, binding: { harnessId: '*', strategy: 'skill' } }
}

function stateOf(entries: ResolvedUtility[]): TurnState {
  return {
    eligible: new Map(entries.map((entry) => [entry.utility.id, entry])),
    activated: new Map()
  } as unknown as TurnState
}

function builder(environment: Record<string, string> = {}, authorization: string | null = null) {
  const host = {
    units: { orchestration: { credentialEnvironment: async () => environment } },
    mcpOAuth: { accessToken: async () => authorization }
  }
  return new UtilityOrchestrationServiceOvenUtilities(
    host as unknown as UtilityOrchestrationService
  )
}

describe('the Oven utility snapshot', () => {
  it('describes a skill with the instructions the Oven reads', async () => {
    const skill = definition({
      id: 'skill-1',
      kind: 'skill',
      name: 'Design studio',
      config: { instructions: 'Read this before you draw.' }
    })

    const snapshot = await builder().snapshot(stateOf([resolved(skill)]))

    expect(snapshot).toEqual([
      {
        id: 'skill-1',
        kind: 'skill',
        name: 'Design studio',
        description: 'What it does',
        docs: 'Read this before you draw.'
      }
    ])
  })

  it('describes a stdio MCP server with its resolved environment', async () => {
    const mcp = definition({
      id: 'mcp-1',
      kind: 'mcp',
      name: 'Slack',
      config: { transport: 'stdio', command: 'npx', args: ['-y', 'slack-mcp'] }
    })

    const snapshot = await builder({ SLACK_TOKEN: 'resolved-secret' }).snapshot(
      stateOf([resolved(mcp)])
    )

    expect(snapshot[0]?.server).toEqual({
      utilityId: 'mcp-1',
      name: 'Slack',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'slack-mcp'],
      env: { SLACK_TOKEN: 'resolved-secret' }
    })
  })

  it('carries the headers a remote server authenticates with', async () => {
    const mcp = definition({
      id: 'mcp-2',
      kind: 'mcp',
      name: 'Remote',
      config: { transport: 'http', url: 'https://example.test/mcp' }
    })

    const snapshot = await builder({ REMOTE_TOKEN: 'bearer-value' }, 'oauth-grant').snapshot(
      stateOf([resolved(mcp)])
    )

    expect(snapshot[0]?.server).toMatchObject({
      transport: 'http',
      url: 'https://example.test/mcp',
      headers: { Authorization: 'Bearer oauth-grant' }
    })
  })

  it('leaves out a utility whose work only exists in this app', async () => {
    const browser = definition({
      id: 'cio:browser',
      kind: 'computer_use',
      name: 'Browser',
      config: {}
    })

    expect(await builder().snapshot(stateOf([resolved(browser)]))).toEqual([])
  })

  it('leaves out an MCP utility with nothing to start', async () => {
    const broken = definition({
      id: 'mcp-3',
      kind: 'mcp',
      name: 'No transport',
      config: { transport: 'stdio' }
    })

    expect(await builder().snapshot(stateOf([resolved(broken)]))).toEqual([])
  })

  it('lists an activated utility that was not in the eligible set', async () => {
    const activated = definition({
      id: 'skill-2',
      kind: 'skill',
      name: 'Later',
      config: { instructions: 'Read me after activation.' }
    })
    const state = stateOf([])
    state.activated.set('skill-2', resolved(activated))

    const snapshot = await builder().snapshot(state)

    expect(snapshot.map((entry) => entry.id)).toEqual(['skill-2'])
  })
})
