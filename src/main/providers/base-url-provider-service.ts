import type {
  BaseUrlProvider,
  BaseUrlProviderCreateRequest,
  BaseUrlProviderModel,
  BaseUrlProviderUpdateRequest
} from '../../lib/types'
import { generateId } from '../../lib/utils'
import {
  hasNativeProviderCatalog,
  NativeProviderConfigService
} from '../agents/native-provider-config-service'
import type { StorageEngine } from '../storage/storage-engine'

const STORE_PATH = 'accounts/base-url-providers.json'
const STORE_VERSION = 1
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u
/** Model IDs routinely include slashes/at-signs (LM Studio: `org/model`, HF: `org/model@precision`, Cloudflare: `@cf/org/model`). */
const SAFE_MODEL_ID = /^[a-zA-Z0-9@][a-zA-Z0-9._:/@+-]*$/u
const SECRET_REF = /^secret_[a-zA-Z0-9._:-]+$/u
const ENV_VAR = /^[A-Za-z_][A-Za-z0-9_]*$/u
const HTTP_HEADERS_MAX = 32
const MODELS_MAX = 128
const THINKING_PRESETS_MAX = 16

interface BaseUrlProviderStore {
  version: number
  providers: BaseUrlProvider[]
}

interface NormalizedBaseUrlProvider {
  harnessId: string
  npm: string
  name: string
  baseURL: string
  apiKeyRef?: string
  apiKeyEnvVar?: string
  headers?: Record<string, string>
  models: BaseUrlProviderModel[]
  enabled: boolean
}

/**
 * Persists custom base-URL provider definitions beneath CodeInOven's config root.
 *
 * API keys are never stored as plaintext. Callers hand a plaintext key to the
 * IPC layer, which vaults it via {@link SecretVault} and passes only the opaque
 * `apiKeyRef` here. The matching `apiKeyEnvVar` is the deterministic name the
 * OpenCode driver sets on the spawned server's environment so OpenCode's
 * `{env:VAR}` config syntax can reference the resolved key.
 */
export class BaseUrlProviderService {
  private mutationQueue: Promise<BaseUrlProvider | boolean> = Promise.resolve(
    undefined as unknown as BaseUrlProvider
  )
  private readonly nativeProviders = new NativeProviderConfigService()

  constructor(private readonly storage: StorageEngine) {}

  async listProviders(): Promise<BaseUrlProvider[]> {
    const [store, native] = await Promise.all([this.load(), this.nativeProviders.listProviders()])
    return structuredClone([
      ...store.providers.filter((provider) => !hasNativeProviderCatalog(provider.harnessId)),
      ...native
    ])
  }

  async getProvider(harnessId: string, id: string): Promise<BaseUrlProvider | null> {
    assertId(harnessId, 'Base URL provider harness ID')
    assertId(id, 'Base URL provider ID')
    const provider = (await this.listProviders()).find(
      (candidate) => candidate.harnessId === harnessId && candidate.id === id
    )
    return provider ? structuredClone(provider) : null
  }

  async listEnabled(harnessId?: string): Promise<BaseUrlProvider[]> {
    const providers = (await this.load()).providers.filter((provider) => provider.enabled)
    return structuredClone(
      harnessId === undefined
        ? providers
        : providers.filter((provider) => provider.harnessId === harnessId)
    )
  }

  async createProvider(
    input: BaseUrlProviderCreateRequest & { apiKeyRef?: string; id?: string }
  ): Promise<BaseUrlProvider> {
    return this.enqueue(async () => {
      const store = await this.load()
      const now = Date.now()
      const id = input.id === undefined ? generateId() : identifier(input.id, 'Base URL provider ID')
      const apiKeyRef = input.apiKeyRef
      const apiKeyEnvVar = apiKeyRef === undefined ? undefined : apiKeyEnvVarFor(id)
      const provider: BaseUrlProvider = {
        ...normalizeCreateInput(input, id),
        ...(apiKeyRef === undefined ? {} : { apiKeyRef }),
        ...(apiKeyEnvVar === undefined ? {} : { apiKeyEnvVar }),
        id,
        createdAt: now,
        updatedAt: now
      }
      if (hasNativeProviderCatalog(provider.harnessId)) {
        await this.nativeProviders.upsertProvider(provider, input.apiKey)
        return structuredClone(provider)
      }
      if (
        input.id !== undefined &&
        store.providers.some((candidate) => candidate.harnessId === provider.harnessId && candidate.id === id)
      ) {
        throw new Error(`Base URL provider already exists: ${provider.harnessId}:${id}`)
      }
      store.providers.push(provider)
      await this.save(store)
      return structuredClone(provider)
    }) as Promise<BaseUrlProvider>
  }

  /**
   * Apply a renderer-safe patch. The caller is responsible for vaulting any
   * plaintext `apiKey` and removing the old `apiKeyRef` before calling this;
   * this method only persists the already-vaulted references.
   */
  async updateProvider(
    harnessId: string,
    id: string,
    patch: BaseUrlProviderUpdateRequest & {
      apiKeyRef?: string
      removeApiKey?: boolean
    }
  ): Promise<BaseUrlProvider> {
    assertId(harnessId, 'Base URL provider harness ID')
    assertId(id, 'Base URL provider ID')
    return this.enqueue(async () => {
      const current = await this.getProvider(harnessId, id)
      if (!current) throw new Error(`Base URL provider not found: ${harnessId}:${id}`)

      const merged: BaseUrlProviderCreateRequest = {
        harnessId: current.harnessId,
        npm: patch.npm ?? current.npm,
        name: patch.name ?? current.name,
        baseURL: patch.baseURL ?? current.baseURL,
        headers: patch.headers === undefined ? current.headers : patch.headers,
        models: patch.models ?? current.models,
        enabled: patch.enabled ?? current.enabled
      }

      const apiKeyRef =
        patch.removeApiKey === true
          ? undefined
          : patch.apiKeyRef !== undefined
            ? patch.apiKeyRef
            : current.apiKeyRef
      const apiKeyEnvVar =
        apiKeyRef === undefined ? undefined : (current.apiKeyEnvVar ?? apiKeyEnvVarFor(id))

      const updated: BaseUrlProvider = {
        ...normalizeCreateInput(merged, id),
        apiKeyRef,
        apiKeyEnvVar,
        id: current.id,
        createdAt: current.createdAt,
        updatedAt: Date.now()
      }
      if (hasNativeProviderCatalog(current.harnessId)) {
        const nativeUpdated = {
          ...updated,
          apiKeyRef: undefined,
          apiKeyEnvVar: undefined
        }
        await this.nativeProviders.upsertProvider(nativeUpdated, patch.apiKey, patch.removeApiKey)
        return structuredClone(nativeUpdated)
      }
      const store = await this.load()
      const index = store.providers.findIndex(
        (candidate) => candidate.harnessId === harnessId && candidate.id === id
      )
      if (index === -1) throw new Error(`Base URL provider not found: ${harnessId}:${id}`)
      store.providers[index] = updated
      await this.save(store)
      return structuredClone(updated)
    }) as Promise<BaseUrlProvider>
  }

  async deleteProvider(harnessId: string, id: string): Promise<boolean> {
    assertId(harnessId, 'Base URL provider harness ID')
    assertId(id, 'Base URL provider ID')
    return this.enqueue(async () => {
      const store = await this.load()
      const index = store.providers.findIndex(
        (candidate) => candidate.harnessId === harnessId && candidate.id === id
      )
      if (index === -1) {
        const native = (await this.nativeProviders.listProviders()).find(
          (provider) => provider.harnessId === harnessId && provider.id === id
        )
        if (!native) return false
        await this.nativeProviders.deleteProvider(native)
        return true
      }
      store.providers.splice(index, 1)
      await this.save(store)
      return true
    }) as Promise<boolean>
  }

  // ─── Internals ──────────────────────────────────────────────────────────────

  private async load(): Promise<BaseUrlProviderStore> {
    const raw = await this.storage.read<BaseUrlProviderStore>(STORE_PATH)
    if (raw === null) return { version: STORE_VERSION, providers: [] }
    return parseStore(raw)
  }

  private async save(store: BaseUrlProviderStore): Promise<void> {
    await this.storage.write(STORE_PATH, store)
  }

  /**
   * Serialize mutations so concurrent create/update/delete calls don't lose
   * writes. Each callback receives the current store and must persist before
   * returning; the resolved value is threaded back to the caller.
   */
  private enqueue<T extends BaseUrlProvider | boolean>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(fn, fn)
    // Keep the chain green so a rejected mutation doesn't poison later writes.
    this.mutationQueue = next.then(
      () => undefined as unknown as BaseUrlProvider,
      () => undefined as unknown as BaseUrlProvider
    )
    return next
  }
}

function apiKeyEnvVarFor(providerId: string): string {
  const suffix = providerId.replace(/[^a-zA-Z0-9]/gu, '_').toUpperCase()
  return `CODEINOVEN_BUP_${suffix}_KEY`
}

function normalizeCreateInput(
  input: BaseUrlProviderCreateRequest,
  id: string
): NormalizedBaseUrlProvider {
  const harnessId = identifier(input.harnessId, 'Base URL provider harness ID')
  const npm = boundedString(input.npm, 'Base URL provider npm package', 1, 256)
  const name = boundedString(input.name, 'Base URL provider name', 1, 256)
  const baseURL = boundedString(input.baseURL, 'Base URL provider base URL', 1, 2_048)
  const headers = normalizeHeaders(input.headers)
  const models = normalizeModels(input.models, id)
  const enabled = typeof input.enabled === 'boolean' ? input.enabled : true
  return { harnessId, npm, name, baseURL, headers, models, enabled }
}

function normalizeHeaders(
  value: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (value === undefined) return undefined
  const entries = Object.entries(value)
  if (entries.length > HTTP_HEADERS_MAX) {
    throw new TypeError(`Base URL provider supports at most ${HTTP_HEADERS_MAX} custom headers`)
  }
  const normalized: Record<string, string> = {}
  for (const [key, val] of entries) {
    const headerName = boundedString(key, 'Header name', 1, 128)
    const headerValue = boundedString(val, `Header "${headerName}"`, 0, 4_096, true)
    normalized[headerName] = headerValue
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined
}

function normalizeModels(
  value: Array<Omit<BaseUrlProviderModel, 'id' | 'providerId'> & { id?: string }>,
  providerId: string
): BaseUrlProviderModel[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('Base URL provider must expose at least one model')
  }
  if (value.length > MODELS_MAX) {
    throw new TypeError(`Base URL provider supports at most ${MODELS_MAX} models`)
  }
  const seen = new Set<string>()
  return value.map((raw, index) => {
    const modelId = boundedString(raw.id ?? raw.name, `Model ${index} ID`, 1, 128)
    if (!SAFE_MODEL_ID.test(modelId)) {
      throw new TypeError(`Model ID "${modelId}" contains unsupported characters`)
    }
    if (seen.has(modelId)) throw new TypeError(`Duplicate model ID: ${modelId}`)
    seen.add(modelId)
    const name = boundedString(raw.name, `Model ${index} name`, 1, 256)
    const contextWindow = optionalPositiveInteger(
      raw.contextWindow,
      `Model ${index} context window`
    )
    const maxOutputTokens = optionalPositiveInteger(
      raw.maxOutputTokens,
      `Model ${index} max output tokens`
    )
    const reasoning = typeof raw.reasoning === 'boolean' ? raw.reasoning : false
    const thinkingPresets = normalizeThinkingPresets(raw.thinkingPresets)
    const defaultThinkingLevel = normalizeThinkingLevel(raw.defaultThinkingLevel)
    const vision =
      raw.vision === undefined ? undefined : typeof raw.vision === 'boolean' ? raw.vision : false
    return {
      id: modelId,
      name,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      reasoning,
      ...(thinkingPresets === undefined ? {} : { thinkingPresets }),
      ...(defaultThinkingLevel === undefined ? {} : { defaultThinkingLevel }),
      ...(vision === undefined ? {} : { vision }),
      providerId
    } satisfies BaseUrlProviderModel
  })
}

function normalizeThinkingPresets(
  value: BaseUrlProviderModel['thinkingPresets']
): BaseUrlProviderModel['thinkingPresets'] {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new TypeError('Thinking presets must be an array')
  if (value.length > THINKING_PRESETS_MAX) {
    throw new TypeError(`A model supports at most ${THINKING_PRESETS_MAX} thinking presets`)
  }
  const seen = new Set<string>()
  return value.map((preset, index) => {
    const id = boundedString(preset.id, `Thinking preset ${index} ID`, 1, 64)
    if (!SAFE_ID.test(id)) {
      throw new TypeError(`Thinking preset ID "${id}" contains unsupported characters`)
    }
    if (seen.has(id)) throw new TypeError(`Duplicate thinking preset ID: ${id}`)
    seen.add(id)
    return {
      id,
      label: boundedString(preset.label, `Thinking preset ${index} label`, 1, 128),
      ...(preset.description === undefined
        ? {}
        : {
            description: boundedString(
              preset.description,
              `Thinking preset ${index} description`,
              0,
              512,
              true
            )
          })
    }
  })
}

const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const
type ThinkingLevelValue = (typeof THINKING_LEVELS)[number]

function normalizeThinkingLevel(
  value: BaseUrlProviderModel['defaultThinkingLevel']
): BaseUrlProviderModel['defaultThinkingLevel'] {
  if (value === undefined) return undefined
  if (!THINKING_LEVELS.includes(value as ThinkingLevelValue)) {
    throw new TypeError(`Default thinking level must be one of: ${THINKING_LEVELS.join(', ')}`)
  }
  return value as BaseUrlProviderModel['defaultThinkingLevel']
}

// ─── Store parsing (defensive reads of persisted JSON) ───────────────────────

function parseStore(raw: unknown): BaseUrlProviderStore {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new TypeError('Base URL provider store must be an object')
  }
  const store = raw as Record<string, unknown>
  const version = typeof store['version'] === 'number' ? store['version'] : STORE_VERSION
  const providers = Array.isArray(store['providers']) ? store['providers'] : []
  const parsed = providers.map((entry) => parseProvider(entry))
  assertUniqueIds(parsed, 'Base URL provider')
  return { version, providers: parsed }
}

function parseProvider(value: unknown): BaseUrlProvider {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Base URL provider must be an object')
  }
  const raw = value as Record<string, unknown>
  const id = identifier(raw['id'], 'Base URL provider ID')
  const harnessId = identifier(raw['harnessId'], 'Base URL provider harness ID')
  const npm = boundedString(raw['npm'], 'Base URL provider npm package', 1, 256)
  const name = boundedString(raw['name'], 'Base URL provider name', 1, 256)
  const baseURL = boundedString(raw['baseURL'], 'Base URL provider base URL', 1, 2_048)
  const enabled = typeof raw['enabled'] === 'boolean' ? raw['enabled'] : true
  const createdAt = timestamp(raw['createdAt'], 'Base URL provider createdAt')
  const updatedAt = timestamp(raw['updatedAt'], 'Base URL provider updatedAt')
  const apiKeyRef = optionalStringMatching(raw['apiKeyRef'], SECRET_REF, 'API key reference')
  const apiKeyEnvVar = optionalStringMatching(raw['apiKeyEnvVar'], ENV_VAR, 'API key env var')
  const headers = parseHeaders(raw['headers'])
  const models = parseModels(raw['models'], id)
  return {
    id,
    harnessId,
    npm,
    name,
    baseURL,
    enabled,
    createdAt,
    updatedAt,
    ...(apiKeyRef === undefined ? {} : { apiKeyRef }),
    ...(apiKeyEnvVar === undefined ? {} : { apiKeyEnvVar }),
    ...(headers === undefined ? {} : { headers }),
    models
  }
}

function parseHeaders(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Base URL provider headers must be an object')
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > HTTP_HEADERS_MAX) {
    throw new TypeError(`Base URL provider supports at most ${HTTP_HEADERS_MAX} custom headers`)
  }
  const normalized: Record<string, string> = {}
  for (const [key, val] of entries) {
    normalized[boundedString(key, 'Header name', 1, 128)] = boundedString(
      val,
      `Header "${key}"`,
      0,
      4_096,
      true
    )
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined
}

function parseModels(value: unknown, providerId: string): BaseUrlProviderModel[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('Base URL provider must expose at least one model')
  }
  if (value.length > MODELS_MAX) {
    throw new TypeError(`Base URL provider supports at most ${MODELS_MAX} models`)
  }
  const seen = new Set<string>()
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new TypeError(`Model ${index} must be an object`)
    }
    const raw = entry as Record<string, unknown>
    const id = boundedString(raw['id'] ?? raw['name'], `Model ${index} ID`, 1, 128)
    if (!SAFE_MODEL_ID.test(id)) {
      throw new TypeError(`Model ID "${id}" contains unsupported characters`)
    }
    if (seen.has(id)) throw new TypeError(`Duplicate model ID: ${id}`)
    seen.add(id)
    const name = boundedString(raw['name'], `Model ${index} name`, 1, 256)
    const reasoning = typeof raw['reasoning'] === 'boolean' ? raw['reasoning'] : false
    const contextWindow = optionalPositiveInteger(
      raw['contextWindow'],
      `Model ${index} context window`
    )
    const maxOutputTokens = optionalPositiveInteger(
      raw['maxOutputTokens'],
      `Model ${index} max output tokens`
    )
    const thinkingPresets = parseThinkingPresets(raw['thinkingPresets'])
    const defaultThinkingLevel = parseDefaultThinkingLevel(raw['defaultThinkingLevel'])
    const vision =
      raw['vision'] === undefined
        ? undefined
        : typeof raw['vision'] === 'boolean'
          ? raw['vision']
          : false
    return {
      id,
      name,
      reasoning,
      providerId,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      ...(thinkingPresets === undefined ? {} : { thinkingPresets }),
      ...(defaultThinkingLevel === undefined ? {} : { defaultThinkingLevel }),
      ...(vision === undefined ? {} : { vision })
    } satisfies BaseUrlProviderModel
  })
}

function parseThinkingPresets(value: unknown): BaseUrlProviderModel['thinkingPresets'] {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new TypeError('Thinking presets must be an array')
  if (value.length > THINKING_PRESETS_MAX) {
    throw new TypeError(`A model supports at most ${THINKING_PRESETS_MAX} thinking presets`)
  }
  const seen = new Set<string>()
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new TypeError(`Thinking preset ${index} must be an object`)
    }
    const raw = entry as Record<string, unknown>
    const id = boundedString(raw['id'], `Thinking preset ${index} ID`, 1, 64)
    if (!SAFE_ID.test(id)) {
      throw new TypeError(`Thinking preset ID "${id}" contains unsupported characters`)
    }
    if (seen.has(id)) throw new TypeError(`Duplicate thinking preset ID: ${id}`)
    seen.add(id)
    return {
      id,
      label: boundedString(raw['label'], `Thinking preset ${index} label`, 1, 128),
      ...(raw['description'] === undefined
        ? {}
        : {
            description: boundedString(
              raw['description'],
              `Thinking preset ${index} description`,
              0,
              512,
              true
            )
          })
    }
  })
}

function parseDefaultThinkingLevel(value: unknown): BaseUrlProviderModel['defaultThinkingLevel'] {
  if (value === undefined) return undefined
  if (!THINKING_LEVELS.includes(value as ThinkingLevelValue)) {
    throw new TypeError(`Default thinking level must be one of: ${THINKING_LEVELS.join(', ')}`)
  }
  return value as BaseUrlProviderModel['defaultThinkingLevel']
}

// ─── Primitives ──────────────────────────────────────────────────────────────

function assertUniqueIds(values: Array<{ id: string }>, label: string): void {
  const ids = new Set<string>()
  for (const value of values) {
    if (ids.has(value.id)) throw new Error(`${label} store contains duplicate ID: ${value.id}`)
    ids.add(value.id)
  }
}

function assertId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) throw new TypeError(`${label} contains unsupported characters`)
}

function identifier(value: unknown, label: string): string {
  const text = boundedString(value, label, 1, 256)
  assertId(text, label)
  return text
}

function boundedString(
  value: unknown,
  label: string,
  minLength: number,
  maxLength: number,
  preserveWhitespace = false
): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`)
  const normalized = preserveWhitespace ? value : value.trim()
  if (
    (minLength > 0 && normalized.length < minLength) ||
    normalized.length > maxLength ||
    normalized.includes('\0')
  ) {
    throw new TypeError(`${label} is invalid`)
  }
  return normalized
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer`)
  }
  return value
}

function optionalStringMatching(
  value: unknown,
  pattern: RegExp,
  label: string
): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`)
  if (!pattern.test(value)) throw new TypeError(`${label} is malformed`)
  return value
}

function timestamp(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer`)
  }
  return value
}
