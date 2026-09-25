import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { listHarnesses } from '../../../src/main/agents/harness-registry'
import {
  NativeProviderConfigService,
  hasNativeProviderCatalog
} from '../../../src/main/agents/native-provider-config-service'
import { BaseUrlProviderService } from '../../../src/main/providers/base-url-provider-service'
import { StorageEngine } from '../../../src/main/storage/storage-engine'
import type { BaseUrlProvider, BaseUrlProviderCreateRequest } from '../../../src/lib/types'

/**
 * `NativeProviderConfigService` resolves `~/.pi/agent/models.json` and
 * `~/.config/opencode/opencode.json` from `os.homedir()` once, when the module
 * is first loaded. The sandbox home below is installed before those
 * module-level constants are computed   `vi.mock` is hoisted above the imports
 * and its factory completes before the mocked module body runs   so this suite
 * reads and writes a temporary home instead of the real config files of
 * whoever runs it.
 */
const sandbox = vi.hoisted(() => ({ home: '' }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  const { mkdtemp: createDirectory } = await import('node:fs/promises')
  const { join: joinPath } = await import('node:path')
  sandbox.home = await createDirectory(joinPath(actual.tmpdir(), 'cio-native-provider-'))
  return { ...actual, homedir: () => sandbox.home }
})

const PI_MODELS_PATH = join(sandbox.home, '.pi', 'agent', 'models.json')
const OPENCODE_CONFIG_PATH = join(sandbox.home, '.config', 'opencode', 'opencode.json')
const PARKED_DIRECTORY = 'disabled-providers'

/**
 * The config file each native harness keeps its own provider catalog in.
 *
 * A harness is only really covered while it is listed here, so the guard test
 * below refuses to pass when one is added to `NATIVE_HARNESSES` without being
 * wired into this suite: the round trip and the per-harness proof of where the
 * disabled state lives both key off this map.
 */
const HARNESS_CONFIG_PATH: Record<string, string> = {
  pi: PI_MODELS_PATH,
  opencode: OPENCODE_CONFIG_PATH
}

const HARNESSES = listHarnesses()
const CUSTOM_PROVIDER_HARNESSES = HARNESSES.filter((harness) => harness.supportsCustomProviders)
const NATIVE_HARNESSES = HARNESSES.filter((harness) => hasNativeProviderCatalog(harness.id))
const STORE_HARNESSES = CUSTOM_PROVIDER_HARNESSES.filter(
  (harness) => !hasNativeProviderCatalog(harness.id)
)

let configRoot = ''
let storage: StorageEngine
let providers: BaseUrlProviderService
let native: NativeProviderConfigService

beforeEach(async () => {
  // A fresh sandbox home and config root per test. The harness config paths are
  // fixed at module load, so without clearing the home a test would inherit the
  // models.json or opencode.json a previous one wrote.
  await rm(join(sandbox.home, '.pi'), { recursive: true, force: true })
  await rm(join(sandbox.home, '.config'), { recursive: true, force: true })
  configRoot = await mkdtemp(join(sandbox.home, 'config-'))
  storage = new StorageEngine(configRoot)
  providers = new BaseUrlProviderService(storage)
  native = new NativeProviderConfigService(storage)
})

afterAll(async () => {
  await rm(sandbox.home, { recursive: true, force: true })
})

function providerInput(
  harnessId: string,
  name: string,
  overrides: Partial<BaseUrlProviderCreateRequest> = {}
): BaseUrlProviderCreateRequest {
  return {
    harnessId,
    npm: '@ai-sdk/openai-compatible',
    name,
    baseURL: 'http://127.0.0.1:9931/v1',
    models: [
      { id: 'compliance-model', name: 'Compliance Model', reasoning: true, contextWindow: 8192 }
    ],
    ...overrides
  }
}

/** Full provider, for the internal API paths that take a resolved provider. */
function piFixture(id: string): BaseUrlProvider {
  return {
    id,
    harnessId: 'pi',
    npm: '@ai-sdk/openai-compatible',
    name: id,
    baseURL: 'http://127.0.0.1:9931/v1',
    models: [{ id: 'fixture-model', providerId: id, name: 'Fixture Model', reasoning: false }],
    enabled: true,
    createdAt: 0,
    updatedAt: 0
  }
}

async function listedProvider(
  service: BaseUrlProviderService,
  harnessId: string,
  id: string
): Promise<BaseUrlProvider | undefined> {
  return (await service.listProviders()).find(
    (provider) => provider.harnessId === harnessId && provider.id === id
  )
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

async function readJsonFile(path: string): Promise<Record<string, unknown>> {
  return recordOf(JSON.parse(await readFile(path, 'utf8'))) ?? {}
}

async function writePiModels(piProviders: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(PI_MODELS_PATH), { recursive: true })
  await writeFile(PI_MODELS_PATH, JSON.stringify({ providers: piProviders }, null, 2))
}

describe('native provider catalog compliance', () => {
  describe('the disable contract every custom-provider harness must honour', () => {
    for (const harness of CUSTOM_PROVIDER_HARNESSES) {
      it(`${harness.id}: a disable round trips instead of throwing`, async () => {
        const created = await providers.createProvider(
          providerInput(harness.id, 'Disable Contract')
        )
        expect(created.enabled).toBe(true)
        expect((await listedProvider(providers, harness.id, created.id))?.enabled).toBe(true)

        const disabled = await providers.updateProvider(harness.id, created.id, { enabled: false })
        expect(disabled.enabled).toBe(false)
        expect((await listedProvider(providers, harness.id, created.id))?.enabled).toBe(false)

        const reenabled = await providers.updateProvider(harness.id, created.id, { enabled: true })
        expect(reenabled.enabled).toBe(true)
        expect((await listedProvider(providers, harness.id, created.id))?.enabled).toBe(true)

        expect(await providers.deleteProvider(harness.id, created.id)).toBe(true)
        expect(await listedProvider(providers, harness.id, created.id)).toBeUndefined()
      })

      it(`${harness.id}: a disabled provider is never handed to the harness`, async () => {
        const created = await providers.createProvider(
          providerInput(harness.id, 'Hidden When Disabled')
        )
        await providers.updateProvider(harness.id, created.id, { enabled: false })
        expect(
          (await providers.listEnabled(harness.id)).map((provider) => provider.id)
        ).not.toContain(created.id)
        if (hasNativeProviderCatalog(harness.id)) {
          // A native harness reads its own catalog, so the file-level proof that
          // the provider is off lives in the harness suites below. Keep that
          // proof possible: the harness must have a config path on record.
          expect(HARNESS_CONFIG_PATH[harness.id]).toBeDefined()
          return
        }
        await providers.updateProvider(harness.id, created.id, { enabled: true })
        expect((await providers.listEnabled(harness.id)).map((provider) => provider.id)).toContain(
          created.id
        )
      })
    }

    for (const harness of STORE_HARNESSES) {
      it(`${harness.id}: keeps the disabled flag in CodeInOven's own store`, async () => {
        const created = await providers.createProvider(
          providerInput(harness.id, 'Stored Disabled Flag')
        )
        await providers.updateProvider(harness.id, created.id, { enabled: false })

        const store = recordOf(await storage.read<unknown>('accounts/base-url-providers.json'))
        const stored = Array.isArray(store?.['providers']) ? store['providers'] : []
        expect(stored).toEqual([
          expect.objectContaining({ harnessId: harness.id, id: created.id, enabled: false })
        ])
      })
    }
  })

  describe('native catalog invariants', () => {
    it('knows the config file of every harness whose catalog CodeInOven writes', () => {
      // Add the path (and a suite proving where its disabled state lives) when a
      // harness joins the native catalog; otherwise this fails on purpose.
      expect(NATIVE_HARNESSES.map((harness) => harness.id).sort()).toEqual(
        Object.keys(HARNESS_CONFIG_PATH).sort()
      )
    })

    it('never claims a native catalog for a harness that cannot take custom providers', () => {
      const withoutSupport = HARNESSES.filter((harness) => !harness.supportsCustomProviders)
      expect(withoutSupport.filter((harness) => hasNativeProviderCatalog(harness.id))).toEqual([])
    })

    it('treats a harness it has no native catalog for as store-backed, not an error', async () => {
      // The registered harnesses already cover every supported product; this
      // keeps the disable path safe for a harness detected before its registry
      // entry and catalog exist.
      expect(hasNativeProviderCatalog('unregistered-harness')).toBe(false)
      const created = await providers.createProvider(
        providerInput('unregistered-harness', 'Store Fallback')
      )
      const disabled = await providers.updateProvider('unregistered-harness', created.id, {
        enabled: false
      })
      expect(disabled.enabled).toBe(false)
      expect((await listedProvider(providers, 'unregistered-harness', created.id))?.enabled).toBe(
        false
      )
    })

    it('keeps native-catalog providers out of the CodeInOven store', async () => {
      // `listProviders` merges the store and the native catalogs, which only
      // works while a native provider is never also persisted in the store.
      for (const harness of NATIVE_HARNESSES) {
        await providers.createProvider(providerInput(harness.id, 'Native Kept Out Of Store'))
      }
      const store = recordOf(await storage.read<unknown>('accounts/base-url-providers.json'))
      const stored = Array.isArray(store?.['providers']) ? store['providers'] : []
      expect(stored).toEqual([])
    })
  })
})

describe('pi: a disable is emulated in the CodeInOven parked store', () => {
  const providerId = 'cio-pi-edge'

  beforeEach(async () => {
    await writePiModels({
      [providerId]: {
        baseUrl: 'http://127.0.0.1:9931/v1',
        api: 'openai-completions',
        apiKey: 'sk-pi-secret',
        headers: { 'X-Custom': 'kept' },
        usagePath: '/status',
        name: 'Pi Edge Provider',
        models: [
          { id: 'pi-edge-model', name: 'Pi Edge Model', reasoning: true, contextWindow: 8192 }
        ]
      },
      'other-native': {
        baseUrl: 'http://127.0.0.1:9941/v1',
        api: 'openai-completions',
        apiKey: 'none',
        name: 'Other Native',
        models: [{ id: 'other-model', name: 'Other Model', reasoning: false }]
      }
    })
  })

  it('parks the entry verbatim and removes it from models.json', async () => {
    const before = await listedProvider(providers, 'pi', providerId)
    expect(before).toMatchObject({
      enabled: true,
      name: 'Pi Edge Provider',
      apiKeyConfigured: true,
      headers: { 'X-Custom': 'kept' },
      usagePath: '/status'
    })
    expect(before?.models.map((model) => model.id)).toEqual(['pi-edge-model'])

    const disabled = await providers.updateProvider('pi', providerId, { enabled: false })
    expect(disabled.enabled).toBe(false)

    const live = recordOf((await readJsonFile(PI_MODELS_PATH))['providers'])
    expect(live?.[providerId]).toBeUndefined()
    expect(recordOf(live?.['other-native'])).toMatchObject({ name: 'Other Native' })

    const parked = await readJsonFile(storage.resolve(`${PARKED_DIRECTORY}/pi/${providerId}.json`))
    expect(parked).toMatchObject({
      version: 1,
      harnessId: 'pi',
      providerId,
      name: 'Pi Edge Provider',
      entry: {
        apiKey: 'sk-pi-secret',
        headers: { 'X-Custom': 'kept' },
        usagePath: '/status'
      }
    })
    expect(typeof parked['disabledAt']).toBe('number')

    const stillListed = await listedProvider(providers, 'pi', providerId)
    expect(stillListed).toMatchObject({
      enabled: false,
      name: 'Pi Edge Provider',
      apiKeyConfigured: true
    })
    expect(stillListed?.models.map((model) => model.id)).toEqual(['pi-edge-model'])
  })

  it('edits a disabled provider without restoring it to models.json', async () => {
    await providers.updateProvider('pi', providerId, { enabled: false })
    const edited = await providers.updateProvider('pi', providerId, { name: 'Renamed While Off' })
    expect(edited).toMatchObject({
      enabled: false,
      name: 'Renamed While Off',
      apiKeyConfigured: true
    })

    const live = recordOf((await readJsonFile(PI_MODELS_PATH))['providers'])
    expect(live?.[providerId]).toBeUndefined()

    const parked = await readJsonFile(storage.resolve(`${PARKED_DIRECTORY}/pi/${providerId}.json`))
    expect(recordOf(parked['entry'])).toMatchObject({
      name: 'Renamed While Off',
      apiKey: 'sk-pi-secret'
    })
  })

  it('restores the entry and drops the parked record on re-enable', async () => {
    await providers.updateProvider('pi', providerId, { enabled: false })
    const restored = await providers.updateProvider('pi', providerId, { enabled: true })
    expect(restored).toMatchObject({ enabled: true, apiKeyConfigured: true })

    expect(existsSync(storage.resolve(`${PARKED_DIRECTORY}/pi/${providerId}.json`))).toBe(false)
    const live = recordOf((await readJsonFile(PI_MODELS_PATH))['providers'])
    expect(recordOf(live?.[providerId])).toMatchObject({
      name: 'Pi Edge Provider',
      apiKey: 'sk-pi-secret',
      headers: { 'X-Custom': 'kept' },
      usagePath: '/status'
    })
    expect(
      (await providers.listProviders()).filter(
        (provider) => provider.harnessId === 'pi' && provider.id === providerId
      )
    ).toHaveLength(1)
  })

  it('deletes a parked provider without creating an empty models.json', async () => {
    await providers.updateProvider('pi', providerId, { enabled: false })
    await rm(PI_MODELS_PATH, { force: true })

    expect(await providers.deleteProvider('pi', providerId)).toBe(true)
    expect(existsSync(PI_MODELS_PATH)).toBe(false)
    expect(existsSync(storage.resolve(`${PARKED_DIRECTORY}/pi/${providerId}.json`))).toBe(false)
  })

  it('ignores a malformed parked record instead of failing the whole listing', async () => {
    await storage.write(`${PARKED_DIRECTORY}/pi/cio-broken.json`, { hello: 'world' })
    await storage.write(`${PARKED_DIRECTORY}/pi/not a valid id.json`, { harnessId: 'pi' })
    await writePiModels({
      'live-native': {
        baseUrl: 'http://127.0.0.1:9941/v1',
        api: 'openai-completions',
        apiKey: 'none',
        name: 'Live Native',
        models: [{ id: 'live-model', name: 'Live Model', reasoning: false }]
      }
    })

    const listed = await providers.listProviders()
    expect(listed.map((provider) => `${provider.harnessId}:${provider.id}`)).toEqual([
      'pi:live-native'
    ])
  })

  it('rejects a provider id that could escape the parked directory', async () => {
    await expect(native.deleteProvider(piFixture('../escape'))).rejects.toThrow(TypeError)
    await expect(native.deleteProvider(piFixture('../../etc/passwd'))).rejects.toThrow(TypeError)
  })
})

describe('opencode: a disable stays native', () => {
  it('records the disable in disabled_providers and keeps the catalog entry', async () => {
    const created = await providers.createProvider(providerInput('opencode', 'OC Disable'))
    await providers.updateProvider('opencode', created.id, { enabled: false })

    const config = await readJsonFile(OPENCODE_CONFIG_PATH)
    expect(config['disabled_providers']).toContain(created.id)
    expect(recordOf(recordOf(config['provider'])?.[created.id])).toBeDefined()
    expect((await listedProvider(providers, 'opencode', created.id))?.enabled).toBe(false)
    expect(existsSync(storage.resolve(PARKED_DIRECTORY))).toBe(false)
  })

  it('clears disabled_providers on re-enable', async () => {
    const created = await providers.createProvider(providerInput('opencode', 'OC Re-enable'))
    await providers.updateProvider('opencode', created.id, { enabled: false })
    await providers.updateProvider('opencode', created.id, { enabled: true })

    const config = await readJsonFile(OPENCODE_CONFIG_PATH)
    expect(config['disabled_providers']).toEqual([])
    expect((await listedProvider(providers, 'opencode', created.id))?.enabled).toBe(true)
  })
})
