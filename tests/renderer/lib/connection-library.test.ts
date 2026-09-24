import { describe, expect, it } from 'vitest'
import {
  buildConnectionLibrary,
  capabilityConnectionId,
  findConnectionEntry
} from '$lib/components/assistant/connection-library'
import { resolveConnections } from '$lib/components/assistant/assistant-view'
import type {
  AgentCapabilityCatalog,
  AgentCapabilityEntry,
  RoutineConnection,
  UtilityCatalog,
  UtilityDefinitionFor
} from '$shared/types'

function registryUtility(
  overrides: Partial<UtilityDefinitionFor<'skill'>> = {}
): UtilityDefinitionFor<'skill'> {
  return {
    id: 'firecrawl',
    kind: 'skill',
    name: 'firecrawl',
    description: 'Scrape pages',
    enabled: true,
    activation: 'on_demand',
    scope: { level: 'global' },
    config: { instructions: 'Use firecrawl to fetch pages.' },
    credentials: [],
    harnessBindings: [],
    appOwned: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

function catalog(utilities: UtilityDefinitionFor<'skill'>[]): UtilityCatalog {
  return { utilities, secureStorageAvailable: true }
}

function capability(overrides: Partial<AgentCapabilityEntry> = {}): AgentCapabilityEntry {
  return {
    id: 'svelte-mcp',
    name: 'Svelte MCP',
    kind: 'mcp',
    origin: 'harness',
    enabled: true,
    description: 'Svelte docs server',
    detail: 'stdio: npx -y svelte-mcp',
    source: {
      kind: 'mcp',
      configPath: '/tmp/opencode.json',
      format: 'opencode',
      serverName: 'svelte'
    },
    ...overrides
  }
}

function capabilities(entries: Partial<AgentCapabilityCatalog> = {}): AgentCapabilityCatalog {
  return { mcp: entries.mcp ?? [], skill: entries.skill ?? [] }
}

describe('connection library', () => {
  it('offers registry utilities and harness-discovered capabilities together', () => {
    const library = buildConnectionLibrary(
      catalog([registryUtility()]),
      capabilities({ mcp: [capability()] })
    )
    expect(library.map((entry) => entry.name).sort()).toEqual(['Svelte MCP', 'firecrawl'])
  })

  it('addresses a discovered capability with a prefixed id so it cannot collide', () => {
    const library = buildConnectionLibrary(null, capabilities({ mcp: [capability()] }))
    expect(library[0]?.id).toBe(capabilityConnectionId({ id: 'svelte-mcp' }))
    expect(library[0]?.source).toBe('harness')
  })

  it('keeps the registry record when a discovered capability points back at it', () => {
    const library = buildConnectionLibrary(
      catalog([registryUtility({ id: 'registry-skill', name: 'firecrawl' })]),
      capabilities({
        skill: [
          capability({
            id: 'registry-skill',
            name: 'firecrawl',
            kind: 'skill',
            source: { kind: 'registry', utilityId: 'registry-skill' }
          })
        ]
      })
    )
    expect(library).toHaveLength(1)
    expect(library[0]?.source).toBe('library')
  })

  it('dedupes one capability discovered by several harnesses, preferring the global copy', () => {
    const library = buildConnectionLibrary(
      null,
      capabilities({
        skill: [
          capability({
            id: 'harness-a:firecrawl',
            name: 'firecrawl',
            kind: 'skill',
            origin: 'harness',
            harnessId: 'harness-a'
          }),
          capability({
            id: 'global:firecrawl',
            name: 'firecrawl',
            kind: 'skill',
            origin: 'global'
          })
        ]
      })
    )
    expect(library).toHaveLength(1)
    expect(library[0]?.source).toBe('global')
  })

  it('keeps a disabled connection in the library but sorts it below the enabled ones', () => {
    const library = buildConnectionLibrary(
      catalog([registryUtility({ id: 'off-skill', name: 'AAA off', enabled: false })]),
      capabilities({ mcp: [capability({ name: 'ZZZ on' })] })
    )
    expect(library.map((entry) => entry.name)).toEqual(['ZZZ on', 'AAA off'])
  })

  it('links a stored connection to a discovered capability by its prefixed id', () => {
    const library = buildConnectionLibrary(null, capabilities({ mcp: [capability()] }))
    const connection: RoutineConnection = {
      utilityId: capabilityConnectionId({ id: 'svelte-mcp' }),
      label: 'Svelte MCP'
    }
    expect(findConnectionEntry(library, connection)?.name).toBe('Svelte MCP')
  })
})

describe('routine connections against discovered capabilities', () => {
  it('reports an enabled discovered MCP as ready', () => {
    const views = resolveConnections(
      [{ utilityId: capabilityConnectionId({ id: 'svelte-mcp' }), label: 'Svelte MCP' }],
      null,
      capabilities({ mcp: [capability()] })
    )
    expect(views[0]?.status).toBe('ready')
    expect(views[0]?.entry?.source).toBe('harness')
  })

  it('reports a switched-off discovered capability as disabled', () => {
    const views = resolveConnections(
      [{ utilityId: capabilityConnectionId({ id: 'svelte-mcp' }), label: 'Svelte MCP' }],
      null,
      capabilities({ mcp: [capability({ enabled: false })] })
    )
    expect(views[0]?.status).toBe('disabled')
  })

  it('reports a discovered MCP with no transport as incomplete', () => {
    const views = resolveConnections(
      [{ utilityId: capabilityConnectionId({ id: 'svelte-mcp' }), label: 'Svelte MCP' }],
      null,
      capabilities({ mcp: [capability({ detail: '' })] })
    )
    expect(views[0]?.status).toBe('incomplete')
    expect(views[0]?.detail).toBe('No server command or URL')
  })

  it('still reports a connection the whole library lacks as needing setup', () => {
    const views = resolveConnections(
      [{ utilityId: 'required:slack', label: 'Slack', required: true }],
      null,
      capabilities({ mcp: [capability()] })
    )
    expect(views[0]?.status).toBe('needs-setup')
  })
})
