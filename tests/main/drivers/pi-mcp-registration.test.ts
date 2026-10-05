import { describe, expect, it } from 'vitest'
import type { UtilityDefinitionFor } from '../../../src/lib/types'
import {
  PI_MCP_SERVERS_DOCUMENT_VERSION,
  buildPiMcpRegistrations,
  piMcpServerName,
  piMcpServersDocument,
  piMcpToolOwner
} from '../../../src/main/drivers/pi/pi-mcp-registration'

/** The registrations from one publication, failing the test on a reported utility. */
function registrationsOf(inputs: Parameters<typeof buildPiMcpRegistrations>[0]) {
  const result = buildPiMcpRegistrations(inputs)
  expect(result.failures).toEqual([])
  return result.registrations
}

/** A utility definition with only the fields the adapter reads. */
function mcpUtility(
  overrides: Partial<UtilityDefinitionFor<'mcp'>> & {
    config: UtilityDefinitionFor<'mcp'>['config']
  }
): UtilityDefinitionFor<'mcp'> {
  return {
    id: 'utility-id',
    kind: 'mcp',
    name: 'Utility',
    description: 'A utility.',
    enabled: true,
    activation: 'on_demand',
    scope: { level: 'global' },
    credentials: [],
    harnessBindings: [],
    appOwned: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

describe('piMcpServerName', () => {
  it('keeps a pi-valid name and drops the dash pi turns into an underscore', () => {
    // Pi rejects any other character and builds the tool namespace with
    // `-` replaced by `_`, so a dash would make two utilities collide.
    expect(piMcpServerName('svelte-mcp')).toBe('svelte_mcp')
    expect(piMcpServerName('cio:cua-driver')).toBe('cio_cua_driver')
    expect(piMcpServerName('Slack Official MCP')).toBe('slack_official_mcp')
  })

  it('falls back instead of producing an empty name', () => {
    expect(piMcpServerName('***')).toBe('utility')
  })
})

describe('buildPiMcpRegistrations', () => {
  it('registers a stdio server with its command, args and configured environment', () => {
    const [registration] = registrationsOf([
      {
        utility: mcpUtility({
          id: 'svelte-mcp',
          name: 'Svelte MCP',
          description: 'Current Svelte documentation.',
          config: {
            transport: 'stdio',
            command: 'bunx',
            args: ['-y', '@sveltejs/mcp'],
            environment: { MCP_MODE: 'docs', TOKEN: '{env:SVELTE_TOKEN}' }
          }
        }),
        environment: { SVELTE_TOKEN: 'token-value' }
      }
    ])

    expect(registration?.name).toBe('svelte_mcp')
    expect(registration?.utilityId).toBe('svelte-mcp')
    expect(registration?.config).toEqual({
      description: 'Current Svelte documentation.',
      exposure: 'codemode',
      type: 'stdio',
      command: 'bunx',
      args: ['-y', '@sveltejs/mcp'],
      env: { MCP_MODE: 'docs', TOKEN: 'token-value' }
    })
  })

  it('hands a declared credential to the server process', () => {
    const [registration] = registrationsOf([
      {
        utility: mcpUtility({
          id: 'slack',
          name: 'Slack MCP',
          config: { transport: 'stdio', command: 'npx', args: ['-y', 'slack-mcp'] },
          credentials: [
            {
              id: 'token',
              label: 'Slack token',
              secretRef: 'secret_1',
              required: false,
              environmentVariable: 'SLACK_MCP_XOXP_TOKEN'
            }
          ]
        }),
        environment: { SLACK_MCP_XOXP_TOKEN: 'xoxp-value' }
      }
    ])

    expect((registration?.config as { env?: Record<string, string> }).env).toEqual({
      SLACK_MCP_XOXP_TOKEN: 'xoxp-value'
    })
  })

  it('leaves out a credential the app could not resolve', () => {
    // An optional credential whose vault read failed must not become an empty
    // variable: pi would resolve it happily and the server would reject it as a
    // bad token instead of reporting a missing one.
    const [registration] = registrationsOf([
      {
        utility: mcpUtility({
          id: 'slack',
          name: 'Slack MCP',
          config: { transport: 'stdio', command: 'npx' },
          credentials: [
            {
              id: 'token',
              label: 'Slack token',
              secretRef: 'secret_1',
              required: false,
              environmentVariable: 'SLACK_MCP_XOXP_TOKEN'
            }
          ]
        }),
        environment: {}
      }
    ])

    expect((registration?.config as { env?: Record<string, string> }).env).toEqual({})
  })

  it('sends a remote server its URL, headers and auto-injected credential', () => {
    const [registration] = registrationsOf([
      {
        utility: mcpUtility({
          id: 'firecrawl',
          name: 'Firecrawl MCP',
          config: {
            transport: 'http',
            url: 'https://mcp.firecrawl.dev/v1',
            headers: { 'X-Client': '{env:CLIENT_ID}' }
          },
          credentials: [
            {
              id: 'key',
              label: 'Firecrawl key',
              secretRef: 'secret_2',
              required: false,
              environmentVariable: 'FIRECRAWL_API_KEY'
            }
          ]
        }),
        environment: { CLIENT_ID: 'client-1', FIRECRAWL_API_KEY: 'fc-value' }
      }
    ])

    expect(registration?.config).toEqual({
      description: 'A utility.',
      exposure: 'codemode',
      type: 'http',
      url: 'https://mcp.firecrawl.dev/v1',
      headers: { 'X-Client': 'client-1', Authorization: 'Bearer fc-value' }
    })
  })

  it('never overrides an Authorization header the utility configured', () => {
    const [registration] = registrationsOf([
      {
        utility: mcpUtility({
          id: 'custom',
          name: 'Custom',
          config: {
            transport: 'http',
            url: 'https://example.test/mcp',
            headers: { authorization: 'ApiKey {env:CUSTOM_KEY}' }
          },
          credentials: [
            {
              id: 'key',
              label: 'Key',
              secretRef: 'secret_3',
              required: false,
              environmentVariable: 'CUSTOM_KEY'
            }
          ]
        }),
        environment: { CUSTOM_KEY: 'key-value' }
      }
    ])

    expect((registration?.config as { headers?: Record<string, string> }).headers).toEqual({
      authorization: 'ApiKey key-value'
    })
  })

  it('reaches an sse utility over streamable http, which pi accepts', () => {
    const [registration] = registrationsOf([
      {
        utility: mcpUtility({
          id: 'legacy',
          name: 'Legacy',
          config: { transport: 'sse', url: 'https://example.test/sse' }
        }),
        environment: {}
      }
    ])

    expect((registration?.config as { type?: string }).type).toBe('http')
  })

  it('reports a misconfigured utility instead of registering a dead server', () => {
    // One broken entry must not cost the thread every other server.
    const result = buildPiMcpRegistrations([
      { utility: mcpUtility({ id: 'broken', config: { transport: 'stdio' } }), environment: {} },
      {
        utility: mcpUtility({
          id: 'healthy',
          name: 'Healthy',
          config: { transport: 'stdio', command: 'bunx' }
        }),
        environment: {}
      }
    ])

    expect(result.registrations.map((registration) => registration.utilityId)).toEqual(['healthy'])
    expect(result.failures).toEqual([
      {
        utilityId: 'broken',
        utilityName: 'Utility',
        reason: 'MCP utility "Utility" requires a stdio command'
      }
    ])
  })

  it('reports a remote utility with no URL', () => {
    const result = buildPiMcpRegistrations([
      { utility: mcpUtility({ id: 'b', config: { transport: 'http' } }), environment: {} }
    ])

    expect(result.failures[0]?.reason).toBe('MCP utility "Utility" requires a URL')
  })

  it('reports a configured reference with no credential value', () => {
    const result = buildPiMcpRegistrations([
      {
        utility: mcpUtility({
          id: 'a',
          config: {
            transport: 'http',
            url: 'https://example.test/mcp',
            headers: { Authorization: 'Bearer {env:MISSING}' }
          }
        }),
        environment: {}
      }
    ])

    expect(result.failures[0]?.reason).toContain('unavailable credential variable MISSING')
  })

  it('gives two utilities that claim one name distinct server names', () => {
    const registrations = registrationsOf([
      {
        utility: mcpUtility({
          id: 'docs-mcp',
          name: 'Docs',
          config: { transport: 'http', url: 'https://a.test/mcp' }
        }),
        environment: {}
      },
      {
        utility: mcpUtility({
          id: 'docs_mcp',
          name: 'Docs again',
          config: { transport: 'http', url: 'https://b.test/mcp' }
        }),
        environment: {}
      }
    ])

    expect(registrations.map((registration) => registration.name)).toEqual([
      'docs_mcp',
      'docs_mcp_2'
    ])
  })
})

describe('piMcpServersDocument', () => {
  it('writes the revision and the utilities behind each server', () => {
    const registrations = registrationsOf([
      {
        utility: mcpUtility({
          id: 'svelte-mcp',
          name: 'Svelte MCP',
          config: { transport: 'stdio', command: 'bunx' }
        }),
        environment: {}
      }
    ])

    const document = piMcpServersDocument(registrations)

    expect(document.version).toBe(PI_MCP_SERVERS_DOCUMENT_VERSION)
    expect(document.servers).toHaveLength(1)
    expect(document.servers[0]?.utilityId).toBe('svelte-mcp')
    expect(document.servers[0]?.utilityName).toBe('Svelte MCP')
    expect(document.servers[0]?.name).toBe('svelte_mcp')
    // The document crosses a process boundary as JSON, so it must survive one.
    expect(JSON.parse(JSON.stringify(document))).toEqual(document)
  })
})

describe('piMcpToolOwner', () => {
  const registrations = registrationsOf([
    {
      utility: mcpUtility({
        id: 'svelte-mcp',
        name: 'Svelte MCP',
        config: { transport: 'stdio', command: 'bunx' }
      }),
      environment: {}
    }
  ])

  it('attributes a script tool call to the utility that registered the server', () => {
    expect(piMcpToolOwner(registrations, 'mcp__svelte_mcp__svelte_autofixer')?.utilityId).toBe(
      'svelte-mcp'
    )
  })

  it('leaves anything that is not a registered server alone', () => {
    expect(piMcpToolOwner(registrations, 'mcp__other__tool')).toBeNull()
    expect(piMcpToolOwner(registrations, 'mcp__svelte')).toBeNull()
    expect(piMcpToolOwner(registrations, 'read_mcp_resource')).toBeNull()
    expect(piMcpToolOwner(registrations, 'bash')).toBeNull()
  })

  it('attributes a server whose name itself contains a double underscore', () => {
    const nested = registrationsOf([
      {
        utility: mcpUtility({
          id: 'docs--v2',
          name: 'Docs v2',
          config: { transport: 'http', url: 'https://docs.test/mcp' }
        }),
        environment: {}
      }
    ])

    expect(piMcpToolOwner(nested, 'mcp__docs__v2__search')?.utilityId).toBe('docs--v2')
  })
})
