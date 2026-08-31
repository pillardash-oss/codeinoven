import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, ProviderCatalog } from '$shared/types'

const invoke = vi.hoisted(() => vi.fn())
const subscribe = vi.hoisted(() => vi.fn())

vi.mock('$lib/ipc.svelte', () => ({ invoke, subscribe }))

const MIRROR_KEY = 'codeinoven.providerCatalog.mirror.v2'
const ZOMBIE_PROJECT = 'zombie-project'
const ACTIVE_PROJECT = 'active-project'
const INBOX_PROJECT = 'inbox-project'

function model(id: string, providerId: string) {
  return {
    id,
    providerId,
    name: id,
    reasoning: false,
    attachment: true,
    toolcall: true
  }
}

function catalog(id: string, harnessId: string, modelIds: string[]): ProviderCatalog {
  return {
    id,
    name: id,
    harnessId,
    models: modelIds.map((modelId) => model(modelId, id))
  }
}

/**
 * Catalogs as a pre-filter-era mirror would have frozen them: the zombie
 * project holds the full pi registry, the active project a stale entry too.
 */
const zombieCatalogs: ProviderCatalog[] = [
  catalog('amazon-bedrock', 'pi', ['bedrock-a', 'bedrock-b']),
  catalog('anthropic', 'pi', ['claude-a'])
]
const staleActiveCatalogs: ProviderCatalog[] = [catalog('stale-openai', 'pi', ['gpt-stale'])]

const cleanSnapshot = [catalog('cloudflare-ai-gateway', 'pi', ['cf-model-1'])]

function makeStorage(initial: Record<string, string> = {}): Map<string, string> {
  return new Map(Object.entries(initial))
}

/**
 * Import a fresh store singleton with `window.localStorage` pre-seeded so the
 * constructor's loadMirror() picks it up — the same path a real renderer takes
 * at startup. Returns the store plus the agent:event handler captured from the
 * mocked subscribe so tests can fire main-process broadcasts.
 */
async function loadStore(mirror: Record<string, ProviderCatalog[]>): Promise<{
  providerCatalog: typeof import('$lib/stores/provider-catalog.svelte').providerCatalog
  fireAgentEvent: (event: AgentEvent) => void
  storage: Map<string, string>
}> {
  const storage = makeStorage({ [MIRROR_KEY]: JSON.stringify(mirror) })
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value)
      },
      removeItem: (key: string) => {
        storage.delete(key)
      }
    }
  })
  vi.resetModules()
  invoke.mockReset()
  subscribe.mockReset()
  const store = await import('$lib/stores/provider-catalog.svelte')
  const registration = subscribe.mock.calls.find(([channel]) => channel === 'agent:event')
  expect(registration).toBeDefined()
  const fireAgentEvent = (event: AgentEvent) => {
    const handler = registration?.[1] as (...args: unknown[]) => void
    handler(event)
  }
  return { providerCatalog: store.providerCatalog, fireAgentEvent, storage }
}

function providerIds(catalogs: ProviderCatalog[]): string[] {
  return catalogs.map((catalog) => catalog.id)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('provider catalog store — stale mirror isolation', () => {
  it('never serves mirror-seeded entries for unvalidated projects through allCached', async () => {
    const { providerCatalog } = await loadStore({ [ZOMBIE_PROJECT]: zombieCatalogs })
    // Before any init the store knows no validated project, so the cross-project
    // union must be empty even though the zombie entry sits in the cache.
    expect(providerCatalog.allCached()).toEqual([])
  })

  it('the active project keeps its mirror bridge until init validates it', async () => {
    const { providerCatalog } = await loadStore({ [ACTIVE_PROJECT]: staleActiveCatalogs })
    // Instant-render bridge: the active project's mirror entry is readable
    // through cached() before the snapshot IPC resolves.
    expect(providerCatalog.cached(ACTIVE_PROJECT)?.map((entry) => entry.id)).toEqual([
      'stale-openai'
    ])
  })

  it('init prunes zombie projects from the cache and the persisted mirror', async () => {
    const { providerCatalog, storage } = await loadStore({
      [ZOMBIE_PROJECT]: zombieCatalogs,
      [ACTIVE_PROJECT]: staleActiveCatalogs
    })
    invoke.mockImplementation(async (channel: string, projectId: string) => {
      if (channel === 'agent:listProviderSnapshot') {
        return projectId === ACTIVE_PROJECT ? cleanSnapshot : []
      }
      return undefined
    })

    await providerCatalog.init([ACTIVE_PROJECT, INBOX_PROJECT], { refresh: false })

    // The validated active project serves the clean snapshot, not its stale mirror.
    expect(providerCatalog.cached(ACTIVE_PROJECT)?.map((entry) => entry.id)).toEqual([
      'cloudflare-ai-gateway'
    ])
    // The zombie project was pruned: gone from the union...
    const union = providerCatalog.allCached()
    expect(providerIds(union)).toEqual(['cloudflare-ai-gateway'])
    expect(union.some((entry) => entry.harnessId === 'pi' && entry.id === 'amazon-bedrock')).toBe(
      false
    )
    expect(providerCatalog.cached(ZOMBIE_PROJECT)).toBeUndefined()
    // ...and from the persisted mirror, so it cannot resurrect after a restart.
    const persisted = JSON.parse(storage.get(MIRROR_KEY) ?? '{}') as Record<string, unknown>
    expect(Object.keys(persisted)).toEqual([ACTIVE_PROJECT])
  })

  it('a providerCatalog.updated broadcast validates its project into the union', async () => {
    const { providerCatalog, fireAgentEvent } = await loadStore({
      [ZOMBIE_PROJECT]: zombieCatalogs
    })
    invoke.mockImplementation(async (channel: string, projectId: string) => {
      if (channel === 'agent:listProviderSnapshot') {
        return projectId === ACTIVE_PROJECT ? cleanSnapshot : []
      }
      return undefined
    })
    await providerCatalog.init([ACTIVE_PROJECT, INBOX_PROJECT], { refresh: false })

    const broadcastCatalogs = [catalog('openrouter', 'pi', ['or-model-1'])]
    fireAgentEvent({
      type: 'providerCatalog.updated',
      projectId: 'broadcast-project',
      catalogs: broadcastCatalogs
    })

    // The broadcast project is main-process-validated data and joins the union;
    // the zombie project stays excluded.
    expect(providerIds(providerCatalog.allCached()).sort()).toEqual([
      'cloudflare-ai-gateway',
      'openrouter'
    ])
  })

  it('previously validated projects survive a later init for another project', async () => {
    const { providerCatalog } = await loadStore({ [ZOMBIE_PROJECT]: zombieCatalogs })
    invoke.mockImplementation(async (channel: string, projectId: string) => {
      if (channel === 'agent:listProviderSnapshot') {
        if (projectId === ACTIVE_PROJECT) return cleanSnapshot
        if (projectId === 'other-project') return [catalog('opencode', 'opencode', ['oc-model-1'])]
        return []
      }
      return undefined
    })

    await providerCatalog.init([ACTIVE_PROJECT, INBOX_PROJECT], { refresh: false })
    // The user switches projects: the second init must not discard the first
    // project's validated entry (it re-seeds only its own targets).
    await providerCatalog.init(['other-project', INBOX_PROJECT], { refresh: false })

    expect(providerIds(providerCatalog.allCached()).sort()).toEqual([
      'cloudflare-ai-gateway',
      'opencode'
    ])
  })
})
