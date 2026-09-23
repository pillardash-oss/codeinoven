import { describe, expect, it } from 'vitest'
import { parseOpenCodeV2Status } from '../../../src/main/providers/provider-account-orchestrator'

/**
 * `opencode auth list --format json` prints an array of integrations, each with
 * a `connections` array. The payloads below are the shapes observed from a real
 * `opencode v2.0.14` store: one integration holding two keys, one holding one.
 */
describe('parseOpenCodeV2Status', () => {
  it('reports one account per connection, not per integration', () => {
    const output = JSON.stringify([
      {
        id: 'opencode-go',
        name: 'OpenCode Go',
        connections: [
          { type: 'credential', id: 'cred_a', label: 'personal', method: 'key' },
          { type: 'credential', id: 'cred_b', label: 'probe', method: 'key' }
        ]
      },
      {
        id: 'opencode',
        name: 'OpenCode Console',
        connections: [{ type: 'credential', id: 'cred_c', label: 'zen-main', method: 'key' }]
      }
    ])

    const status = parseOpenCodeV2Status(output, true)

    expect(status.state).toBe('authenticated')
    expect(status.accounts).toEqual([
      { id: 'cred_a', providerId: 'opencode-go', label: 'personal', method: 'key' },
      { id: 'cred_b', providerId: 'opencode-go', label: 'probe', method: 'key' },
      { id: 'cred_c', providerId: 'opencode', label: 'zen-main', method: 'key' }
    ])
  })

  it('skips env connections, which are not stored credentials', () => {
    const output = JSON.stringify([
      {
        id: 'opencode',
        name: 'OpenCode Console',
        connections: [
          { type: 'env', name: 'OPENCODE_API_KEY' },
          { type: 'credential', id: 'cred_a', label: 'zen', method: 'key' }
        ]
      }
    ])

    const status = parseOpenCodeV2Status(output, true)

    expect(status.accounts).toEqual([
      { id: 'cred_a', providerId: 'opencode', label: 'zen', method: 'key' }
    ])
  })

  it('treats an empty store as signed out', () => {
    expect(parseOpenCodeV2Status('[]', true)).toEqual({
      state: 'unauthenticated',
      accounts: []
    })
  })

  it('stays tolerant of the container and flat shapes', () => {
    const container = parseOpenCodeV2Status(
      JSON.stringify({
        credentials: [{ integrationID: 'opencode-go', label: 'Go', method: 'api' }]
      }),
      true
    )
    expect(container.accounts).toEqual([
      { id: 'go', providerId: 'opencode-go', label: 'Go', method: 'api' }
    ])

    const flat = parseOpenCodeV2Status(
      JSON.stringify([{ providerID: 'opencode', label: 'Zen', method: 'api' }]),
      true
    )
    expect(flat.accounts).toEqual([
      { id: 'zen', providerId: 'opencode', label: 'Zen', method: 'api' }
    ])
  })

  it('reports unknown rather than signed out when the output is unreadable', () => {
    expect(parseOpenCodeV2Status('not json', true)).toMatchObject({
      state: 'unknown',
      accounts: []
    })
    expect(parseOpenCodeV2Status('', false)).toMatchObject({ state: 'error', accounts: [] })
  })
})
