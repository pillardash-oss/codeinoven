import { clipboard, ipcMain } from 'electron'
import type {
  BaseUrlProviderCreateRequest,
  BaseUrlProviderModel,
  BaseUrlProviderUpdateRequest,
  ThinkingLevel,
  ThinkingPreset
} from '../lib/types'
import { validateEntityId, validateBoundedString } from './ipc-validation'
import { BaseUrlProviderService } from './base-url-provider-service'
import { hasNativeProviderCatalog } from './native-provider-config-service'
import { SecretVault } from './secret-vault'
import type { StorageEngine } from './storage-engine'
import { serializeProviderClipboard } from '../lib/provider-clipboard'

const CREATE_FIELDS = new Set([
  'harnessId',
  'npm',
  'name',
  'baseURL',
  'apiKey',
  'headers',
  'models',
  'enabled'
])
const UPDATE_FIELDS = new Set([
  'npm',
  'name',
  'baseURL',
  'apiKey',
  'removeApiKey',
  'headers',
  'models',
  'enabled'
])
const SAFE_MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]*$/u
/** Thinking presets map to OpenCode variant IDs — keep them conservative. */
const SAFE_PRESET_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u
const THINKING_LEVELS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
const MAX_HEADERS = 32
const MAX_MODELS = 128
const MAX_THINKING_PRESETS = 16

/** Register the validated, vault-backed base-URL-provider renderer boundary. */
export function registerBaseUrlProviderIpc(
  storage: StorageEngine,
  providers = new BaseUrlProviderService(storage),
  vault = new SecretVault(storage)
): void {
  ipcMain.handle('baseUrlProviders:list', () => providers.listProviders())

  ipcMain.handle('baseUrlProviders:create', async (_, rawInput: unknown) => {
    const input = parseCreateRequest(rawInput)
    const native = hasNativeProviderCatalog(input.harnessId)
    const apiKeyRef = input.apiKey && !native ? await vault.save(input.apiKey) : undefined
    try {
      return await providers.createProvider({
        harnessId: input.harnessId,
        npm: input.npm,
        name: input.name,
        baseURL: input.baseURL,
        ...(native && input.apiKey ? { apiKey: input.apiKey } : {}),
        ...(apiKeyRef === undefined ? {} : { apiKeyRef }),
        headers: input.headers,
        models: input.models,
        ...(input.enabled === undefined ? {} : { enabled: input.enabled })
      } satisfies BaseUrlProviderCreateRequest)
    } catch (error) {
      if (apiKeyRef) await vault.remove(apiKeyRef)
      throw error
    }
  })

  ipcMain.handle(
    'baseUrlProviders:update',
    async (_, rawHarnessId: unknown, rawId: unknown, rawPatch: unknown) => {
      const harnessId = validateEntityId(rawHarnessId, 'Base URL provider harness ID', 256)
      const id = validateEntityId(rawId, 'Base URL provider ID', 256)
      const current = await providers.getProvider(harnessId, id)
      if (!current) throw new Error(`Base URL provider not found: ${harnessId}:${id}`)
      const patch = parseUpdateRequest(rawPatch)
      const native = hasNativeProviderCatalog(current.harnessId)
      let nextApiKeyRef: string | undefined
      const createdRef: string[] = []
      const refsToRemove: string[] = []
      try {
        if (native) {
          nextApiKeyRef = undefined
        } else if (patch.removeApiKey === true) {
          if (current.apiKeyRef) refsToRemove.push(current.apiKeyRef)
          nextApiKeyRef = undefined
        } else if (patch.apiKey !== undefined) {
          if (current.apiKeyRef) refsToRemove.push(current.apiKeyRef)
          nextApiKeyRef = await vault.save(patch.apiKey)
          createdRef.push(nextApiKeyRef)
        } else {
          nextApiKeyRef = current.apiKeyRef
        }

        const updated = await providers.updateProvider(harnessId, id, {
          ...(patch.npm === undefined ? {} : { npm: patch.npm }),
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.baseURL === undefined ? {} : { baseURL: patch.baseURL }),
          ...(native && patch.apiKey !== undefined ? { apiKey: patch.apiKey } : {}),
          ...(patch.headers === undefined ? {} : { headers: patch.headers }),
          ...(patch.models === undefined ? {} : { models: patch.models }),
          ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
          ...(patch.removeApiKey === true ? { removeApiKey: true } : {}),
          ...(nextApiKeyRef !== undefined ? { apiKeyRef: nextApiKeyRef } : {})
        } satisfies BaseUrlProviderUpdateRequest & {
          apiKeyRef?: string
          removeApiKey?: boolean
        })

        await removeSecrets(vault, refsToRemove)
        return updated
      } catch (error) {
        await removeSecrets(vault, createdRef)
        throw error
      }
    }
  )

  ipcMain.handle('baseUrlProviders:delete', async (_, rawHarnessId: unknown, rawId: unknown) => {
    const harnessId = validateEntityId(rawHarnessId, 'Base URL provider harness ID', 256)
    const id = validateEntityId(rawId, 'Base URL provider ID', 256)
    const provider = await providers.getProvider(harnessId, id)
    if (!provider) return false
    const deleted = await providers.deleteProvider(harnessId, id)
    if (deleted && provider.apiKeyRef) await vault.remove(provider.apiKeyRef)
    return deleted
  })

  ipcMain.handle('baseUrlProviders:copyProviderToClipboard', async (_, rawInput: unknown) => {
    const input = parseCopyClipboardRequest(rawInput)
    let apiKey = input.apiKey ?? ''
    if (!apiKey && input.id) {
      const provider = await providers.getProvider(input.harnessId, input.id)
      if (provider?.apiKeyRef) apiKey = await vault.resolve(provider.apiKeyRef)
    }
    clipboard.writeText(
      serializeProviderClipboard({
        harnessId: input.harnessId,
        npm: input.npm,
        name: input.name,
        baseURL: input.baseURL,
        apiKey,
        headers: input.headers ?? '',
        models: input.models,
        enabled: input.enabled
      })
    )
  })
}

// ─── Request parsing & validation ────────────────────────────────────────────

interface ParsedCreateRequest {
  harnessId: string
  npm: string
  name: string
  baseURL: string
  apiKey?: string
  headers?: Record<string, string>
  models: Array<Omit<BaseUrlProviderModel, 'id' | 'providerId'> & { id?: string }>
  enabled?: boolean
}

interface ParsedUpdateRequest {
  npm?: string
  name?: string
  baseURL?: string
  apiKey?: string
  removeApiKey?: boolean
  headers?: Record<string, string>
  models?: Array<Omit<BaseUrlProviderModel, 'id' | 'providerId'> & { id?: string }>
  enabled?: boolean
}

function parseCreateRequest(value: unknown): ParsedCreateRequest {
  const raw = record(value, 'Base URL provider create request')
  rejectUnknownFields(raw, CREATE_FIELDS, 'Base URL provider create request')
  return {
    harnessId: validateEntityId(raw['harnessId'], 'Base URL provider harness ID', 256),
    npm: boundedStr(raw['npm'], 'Base URL provider npm package', 1, 256),
    name: boundedStr(raw['name'], 'Base URL provider name', 1, 256),
    baseURL: boundedStr(raw['baseURL'], 'Base URL provider base URL', 1, 2_048),
    ...(raw['apiKey'] === undefined
      ? {}
      : { apiKey: boundedStr(raw['apiKey'], 'API key', 1, 8_192) }),
    headers: parseHeaders(raw['headers']),
    models: parseModels(raw['models']),
    ...(raw['enabled'] === undefined ? {} : { enabled: asBoolean(raw['enabled'], 'enabled') })
  }
}

function parseCopyClipboardRequest(value: unknown): {
  harnessId: string
  id?: string
  npm: string
  name: string
  baseURL: string
  apiKey?: string
  headers?: string
  models: Array<{
    id: string
    name: string
    contextWindow: string
    maxOutputTokens: string
    reasoning: boolean
    defaultThinkingLevel: ThinkingLevel | ''
  }>
  enabled: boolean
} {
  const raw = record(value, 'Base URL provider clipboard copy request')
  return {
    harnessId: validateEntityId(raw['harnessId'], 'Base URL provider harness ID', 256),
    ...(raw['id'] === undefined
      ? {}
      : { id: validateEntityId(raw['id'], 'Base URL provider ID', 256) }),
    npm: boundedStr(raw['npm'], 'Base URL provider npm package', 1, 256),
    name: boundedStr(raw['name'], 'Base URL provider name', 1, 256),
    baseURL: boundedStr(raw['baseURL'], 'Base URL provider base URL', 1, 2_048),
    ...(raw['apiKey'] === undefined
      ? {}
      : { apiKey: boundedStr(raw['apiKey'], 'API key', 1, 8_192) }),
    ...(raw['headers'] === undefined
      ? {}
      : { headers: preserveStr(raw['headers'], 'Headers', 0, 16_384) }),
    models: parseClipboardModels(raw['models']),
    enabled: raw['enabled'] === undefined ? true : asBoolean(raw['enabled'], 'enabled')
  }
}

function parseClipboardModels(value: unknown): Array<{
  id: string
  name: string
  contextWindow: string
  maxOutputTokens: string
  reasoning: boolean
  defaultThinkingLevel: ThinkingLevel | ''
}> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('Base URL provider must expose at least one model')
  }
  if (value.length > MAX_MODELS) {
    throw new TypeError(`Base URL provider supports at most ${MAX_MODELS} models`)
  }
  const seen = new Set<string>()
  return value.map((entry, index) => {
    const raw = record(entry, `Model ${index}`)
    const id = boundedStr(raw['id'] ?? raw['name'], `Model ${index} ID`, 1, 128)
    if (seen.has(id)) throw new TypeError(`Duplicate model ID: ${id}`)
    seen.add(id)
    return {
      id,
      name: boundedStr(raw['name'], `Model ${index} name`, 1, 256),
      contextWindow: preserveStr(
        raw['contextWindow'] ?? '',
        `Model ${index} context window`,
        0,
        32
      ),
      maxOutputTokens: preserveStr(
        raw['maxOutputTokens'] ?? '',
        `Model ${index} max output tokens`,
        0,
        32
      ),
      reasoning: raw['reasoning'] === true,
      defaultThinkingLevel: parseThinkingLevel(raw['defaultThinkingLevel']) ?? ''
    }
  })
}

function parseUpdateRequest(value: unknown): ParsedUpdateRequest {
  const raw = record(value, 'Base URL provider update request')
  rejectUnknownFields(raw, UPDATE_FIELDS, 'Base URL provider update request')
  return {
    ...(raw['npm'] === undefined
      ? {}
      : { npm: boundedStr(raw['npm'], 'Base URL provider npm package', 1, 256) }),
    ...(raw['name'] === undefined
      ? {}
      : { name: boundedStr(raw['name'], 'Base URL provider name', 1, 256) }),
    ...(raw['baseURL'] === undefined
      ? {}
      : { baseURL: boundedStr(raw['baseURL'], 'Base URL provider base URL', 1, 2_048) }),
    ...(raw['apiKey'] === undefined
      ? {}
      : { apiKey: boundedStr(raw['apiKey'], 'API key', 1, 8_192) }),
    ...(raw['removeApiKey'] === undefined
      ? {}
      : { removeApiKey: asBoolean(raw['removeApiKey'], 'removeApiKey') }),
    headers: raw['headers'] === undefined ? undefined : parseHeaders(raw['headers']),
    models: raw['models'] === undefined ? undefined : parseModels(raw['models']),
    ...(raw['enabled'] === undefined ? {} : { enabled: asBoolean(raw['enabled'], 'enabled') })
  }
}

function parseHeaders(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined
  const raw = record(value, 'Base URL provider headers')
  const entries = Object.entries(raw)
  if (entries.length > MAX_HEADERS) {
    throw new TypeError(`Base URL provider supports at most ${MAX_HEADERS} custom headers`)
  }
  const normalized: Record<string, string> = {}
  for (const [key, val] of entries) {
    const headerName = boundedStr(key, 'Header name', 1, 128)
    normalized[headerName] = preserveStr(val, `Header "${headerName}"`, 0, 4_096)
  }
  return normalized
}

function parseModels(
  value: unknown
): Array<Omit<BaseUrlProviderModel, 'id' | 'providerId'> & { id?: string }> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('Base URL provider must expose at least one model')
  }
  if (value.length > MAX_MODELS) {
    throw new TypeError(`Base URL provider supports at most ${MAX_MODELS} models`)
  }
  const seen = new Set<string>()
  return value.map((entry, index) => {
    const raw = record(entry, `Model ${index}`)
    const id = boundedStr(raw['id'] ?? raw['name'], `Model ${index} ID`, 1, 128)
    if (!SAFE_MODEL_ID.test(id)) {
      throw new TypeError(`Model ID "${id}" contains unsupported characters`)
    }
    if (seen.has(id)) throw new TypeError(`Duplicate model ID: ${id}`)
    seen.add(id)
    const name = boundedStr(raw['name'], `Model ${index} name`, 1, 256)
    const reasoning = raw['reasoning'] === true
    const contextWindow = optionalPositiveInteger(
      raw['contextWindow'],
      `Model ${index} context window`
    )
    const maxOutputTokens = optionalPositiveInteger(
      raw['maxOutputTokens'],
      `Model ${index} max output tokens`
    )
    const thinkingPresets = parseThinkingPresets(raw['thinkingPresets'])
    const defaultThinkingLevel = parseThinkingLevel(raw['defaultThinkingLevel'])
    return {
      id,
      name,
      reasoning,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      ...(thinkingPresets === undefined ? {} : { thinkingPresets }),
      ...(defaultThinkingLevel === undefined ? {} : { defaultThinkingLevel })
    }
  })
}

function parseThinkingPresets(value: unknown): ThinkingPreset[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new TypeError('Thinking presets must be an array')
  if (value.length > MAX_THINKING_PRESETS) {
    throw new TypeError(`A model supports at most ${MAX_THINKING_PRESETS} thinking presets`)
  }
  const seen = new Set<string>()
  return value.map((entry, index) => {
    const raw = record(entry, `Thinking preset ${index}`)
    const id = boundedStr(raw['id'], `Thinking preset ${index} ID`, 1, 64)
    if (!SAFE_PRESET_ID.test(id)) {
      throw new TypeError(`Thinking preset ID "${id}" contains unsupported characters`)
    }
    if (seen.has(id)) throw new TypeError(`Duplicate thinking preset ID: ${id}`)
    seen.add(id)
    const preset: ThinkingPreset = {
      id,
      label: boundedStr(raw['label'], `Thinking preset ${index} label`, 1, 128)
    }
    if (raw['description'] !== undefined) {
      preset.description = preserveStr(
        raw['description'],
        `Thinking preset ${index} description`,
        0,
        512
      )
    }
    return preset
  })
}

function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !THINKING_LEVELS.has(value as ThinkingLevel)) {
    throw new TypeError(`Default thinking level must be one of: ${[...THINKING_LEVELS].join(', ')}`)
  }
  return value as ThinkingLevel
}

// ─── Primitives ────────────────────────────────────────────────────────────────

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string
): void {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) throw new TypeError(`Unsupported ${label} field: ${field}`)
  }
}

function asBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean`)
  return value
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer`)
  }
  return value
}

/** Validate a string with trim — delegates to the shared bounded-string validator. */
function boundedStr(
  value: unknown,
  label: string,
  minimumLength: number,
  maximumLength: number
): string {
  return validateBoundedString(value, label, minimumLength, maximumLength)
}

/** Validate a string without trimming — preserves leading/trailing whitespace. */
function preserveStr(
  value: unknown,
  label: string,
  minimumLength: number,
  maximumLength: number
): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`)
  if (minimumLength < 0 || maximumLength < minimumLength) {
    throw new TypeError(`${label} length constraints are invalid`)
  }
  if (value.length < minimumLength || value.length > maximumLength || value.includes('\0')) {
    throw new TypeError(
      `${label} must be a string between ${minimumLength} and ${maximumLength} characters`
    )
  }
  return value
}

async function removeSecrets(vault: SecretVault, refs: string[]): Promise<void> {
  for (const ref of refs) await vault.remove(ref)
}
