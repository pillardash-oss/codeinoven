/// <reference types="node" />

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser'
import type { BaseUrlProvider, BaseUrlProviderModel, ThinkingLevel } from '../../lib/types'
import { PI_THINKING_PRESETS } from '../../lib/pi-thinking-presets'

const OPENCODE_CONFIG_PATH = join(homedir(), '.config', 'opencode', 'opencode.json')
const PI_MODELS_PATH = join(homedir(), '.pi', 'agent', 'models.json')
const NATIVE_HARNESSES = new Set(['opencode', 'pi'])
const FORMAT_OPTIONS = { tabSize: 2, insertSpaces: true, eol: '\n' }
const THINKING_LEVELS = new Set<ThinkingLevel>([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra'
])

/**
 * A model's default thinking level is a CodeInOven-only picker convenience
 * (pre-selects the thread's thinking level the first time the model is
 * chosen) — neither opencode's nor pi's own schema has a concept for it. This
 * writes/reads it under a clearly CodeInOven-owned key rather than dropping
 * it, so it survives a save/reload round trip like every other model field.
 */
function readDefaultThinkingLevel(value: unknown): ThinkingLevel | undefined {
  return typeof value === 'string' && THINKING_LEVELS.has(value as ThinkingLevel)
    ? (value as ThinkingLevel)
    : undefined
}

/** Native harness files that can round-trip both providers and their model catalogs. */
export function hasNativeProviderCatalog(harnessId: string): boolean {
  return NATIVE_HARNESSES.has(harnessId)
}

/**
 * Provider ids the user configured natively in Pi's `~/.pi/agent/models.json` —
 * explicit connect targets regardless of whether their entry carries an API
 * key (keyless local servers are legitimate).
 */
export async function piNativeProviderIds(): Promise<Set<string>> {
  const config = await readJsoncObject(PI_MODELS_PATH)
  const providers = record(config['providers']) ?? {}
  return new Set(Object.keys(providers))
}

/** Reads and surgically edits harness-owned custom provider catalogs. */
export class NativeProviderConfigService {
  async listProviders(): Promise<BaseUrlProvider[]> {
    const [openCode, pi] = await Promise.all([this.listOpenCodeProviders(), this.listPiProviders()])
    return [...openCode, ...pi]
  }

  async upsertProvider(
    provider: BaseUrlProvider,
    apiKey?: string,
    removeApiKey = false
  ): Promise<void> {
    if (provider.harnessId === 'opencode') {
      await this.upsertOpenCodeProvider(provider, apiKey, removeApiKey)
      return
    }
    if (provider.harnessId === 'pi') {
      await this.upsertPiProvider(provider, apiKey, removeApiKey)
      return
    }
    throw new Error(`${provider.harnessId} does not expose a native provider catalog`)
  }

  async deleteProvider(provider: BaseUrlProvider): Promise<void> {
    if (provider.harnessId === 'opencode') {
      await updateJsonc(OPENCODE_CONFIG_PATH, ['provider', provider.id], undefined)
      return
    }
    if (provider.harnessId === 'pi') {
      await updateJsonc(PI_MODELS_PATH, ['providers', provider.id], undefined)
      return
    }
    throw new Error(`${provider.harnessId} does not expose a native provider catalog`)
  }

  private async listOpenCodeProviders(): Promise<BaseUrlProvider[]> {
    const config = await readJsoncObject(OPENCODE_CONFIG_PATH)
    const providers = record(config['provider']) ?? {}
    const disabled = new Set(stringArray(config['disabled_providers']))
    return Object.entries(providers).flatMap(([id, value]) => {
      const provider = record(value)
      const options = record(provider?.['options'])
      const models = record(provider?.['models'])
      const baseURL = stringValue(options?.['baseURL']) ?? stringValue(options?.['baseUrl'])
      const npm = stringValue(provider?.['npm'])
      if (!provider || !baseURL || !npm || !models) return []
      const parsedModels = Object.entries(models).map(([modelId, model]) =>
        openCodeModel(id, modelId, model)
      )
      if (parsedModels.length === 0) return []
      const name = stringValue(provider['name']) ?? id
      return [
        nativeProvider(
          id,
          'opencode',
          name,
          npm,
          baseURL,
          parsedModels,
          !disabled.has(id),
          options ?? {}
        )
      ]
    })
  }

  private async upsertOpenCodeProvider(
    provider: BaseUrlProvider,
    apiKey?: string,
    removeApiKey = false
  ): Promise<void> {
    const config = await readJsoncObject(OPENCODE_CONFIG_PATH)
    const existing = record(record(config['provider'])?.[provider.id])
    const existingOptions = record(existing?.['options']) ?? {}
    const options: Record<string, unknown> = {
      ...existingOptions,
      baseURL: provider.baseURL,
      ...(provider.headers ? { headers: provider.headers } : {}),
      ...(provider.usagePath ? { usagePath: provider.usagePath } : {}),
      ...(apiKey ? { apiKey } : {})
    }
    if (removeApiKey) delete options['apiKey']
    const models = Object.fromEntries(
      provider.models.map((model) => [model.id, serializeOpenCodeModel(model)])
    )
    let raw = await readJsoncText(OPENCODE_CONFIG_PATH)
    raw = editJsonc(raw, ['provider', provider.id], {
      npm: provider.npm,
      name: provider.name,
      options,
      models
    })
    const disabled = new Set(stringArray(config['disabled_providers']))
    if (provider.enabled) disabled.delete(provider.id)
    else disabled.add(provider.id)
    raw = editJsonc(raw, ['disabled_providers'], [...disabled])
    await writeJsonc(OPENCODE_CONFIG_PATH, raw)
  }

  private async listPiProviders(): Promise<BaseUrlProvider[]> {
    const config = await readJsoncObject(PI_MODELS_PATH)
    const providers = record(config['providers']) ?? {}
    return Object.entries(providers).flatMap(([id, value]) => {
      const provider = record(value)
      const baseURL = stringValue(provider?.['baseUrl']) ?? stringValue(provider?.['baseURL'])
      const models = Array.isArray(provider?.['models']) ? provider['models'] : []
      if (!provider || !baseURL || models.length === 0) return []
      const parsedModels = models.flatMap((model) => {
        const parsed = piModel(id, model)
        return parsed ? [parsed] : []
      })
      if (parsedModels.length === 0) return []
      const api = stringValue(provider['api']) ?? 'openai-completions'
      const npm =
        api === 'openai-responses'
          ? '@ai-sdk/openai'
          : api === 'anthropic-messages'
            ? '@ai-sdk/anthropic'
            : '@ai-sdk/openai-compatible'
      return [
        nativeProvider(
          id,
          'pi',
          stringValue(provider['name']) ?? id,
          npm,
          baseURL,
          parsedModels,
          true,
          provider
        )
      ]
    })
  }

  private async upsertPiProvider(
    provider: BaseUrlProvider,
    apiKey?: string,
    removeApiKey = false
  ): Promise<void> {
    if (!provider.enabled) {
      throw new Error('Pi does not support disabling native custom providers; delete it instead.')
    }
    const config = await readJsoncObject(PI_MODELS_PATH)
    const existing = record(record(config['providers'])?.[provider.id]) ?? {}
    const entry: Record<string, unknown> = {
      ...existing,
      name: provider.name,
      baseUrl: provider.baseURL,
      api:
        provider.npm === '@ai-sdk/openai'
          ? 'openai-responses'
          : provider.npm === '@ai-sdk/anthropic'
            ? 'anthropic-messages'
            : 'openai-completions',
      apiKey: removeApiKey ? 'none' : (apiKey ?? existing['apiKey'] ?? 'none'),
      ...(provider.headers ? { headers: provider.headers } : {}),
      ...(provider.usagePath ? { usagePath: provider.usagePath } : {}),
      models: provider.models.map(serializePiModel)
    }
    await updateJsonc(PI_MODELS_PATH, ['providers', provider.id], entry)
  }
}

function nativeProvider(
  id: string,
  harnessId: string,
  name: string,
  npm: string,
  baseURL: string,
  models: BaseUrlProviderModel[],
  enabled: boolean,
  source: Record<string, unknown>
): BaseUrlProvider {
  const headers = stringRecord(record(source['headers']))
  const apiKey = stringValue(source['apiKey'])
  const apiKeyConfigured = apiKey !== undefined && apiKey.trim() !== '' && apiKey !== 'none'
  const usagePath = stringValue(source['usagePath'])
  return {
    id,
    harnessId,
    npm,
    name,
    baseURL,
    apiKeyConfigured,
    ...(headers ? { headers } : {}),
    ...(usagePath ? { usagePath } : {}),
    models,
    enabled,
    createdAt: 0,
    updatedAt: 0
  }
}

function openCodeModel(providerId: string, id: string, value: unknown): BaseUrlProviderModel {
  const model = record(value) ?? {}
  const limit = record(model['limit'])
  const variants = record(model['variants'])
  const modalities = record(model['modalities'])
  const inputModalities = Array.isArray(modalities?.['input']) ? modalities['input'] : undefined
  return {
    id,
    providerId,
    name: stringValue(model['name']) ?? id,
    ...(positiveInteger(limit?.['context'])
      ? { contextWindow: positiveInteger(limit?.['context']) }
      : {}),
    ...(positiveInteger(limit?.['output'])
      ? { maxOutputTokens: positiveInteger(limit?.['output']) }
      : {}),
    reasoning: model['reasoning'] === true || variants !== undefined,
    ...(variants
      ? {
          thinkingPresets: Object.keys(variants).map((variant) => ({
            id: variant,
            label: variant.charAt(0).toUpperCase() + variant.slice(1),
            description: `${variant} reasoning effort`
          }))
        }
      : {}),
    // `vision` is left unset (treated as capable) unless opencode explicitly
    // declares an input modality list that omits "image".
    ...(inputModalities && !inputModalities.includes('image') ? { vision: false } : {}),
    ...(readDefaultThinkingLevel(model['cioDefaultThinkingLevel'])
      ? { defaultThinkingLevel: readDefaultThinkingLevel(model['cioDefaultThinkingLevel']) }
      : {})
  }
}

function piModel(providerId: string, value: unknown): BaseUrlProviderModel | null {
  const model = record(value)
  const id = stringValue(model?.['id'])
  if (!model || !id) return null
  const reasoning = model['reasoning'] === true
  return {
    id,
    providerId,
    name: stringValue(model['name']) ?? id,
    ...(positiveInteger(model['contextWindow'])
      ? { contextWindow: positiveInteger(model['contextWindow']) }
      : {}),
    ...(positiveInteger(model['maxTokens'])
      ? { maxOutputTokens: positiveInteger(model['maxTokens']) }
      : {}),
    reasoning,
    // Pi's model config has no per-model variant list (unlike opencode's
    // `variants`), so a reasoning model always gets Pi's fixed thinking levels.
    ...(reasoning ? { thinkingPresets: PI_THINKING_PRESETS } : {}),
    ...(readDefaultThinkingLevel(model['cioDefaultThinkingLevel'])
      ? { defaultThinkingLevel: readDefaultThinkingLevel(model['cioDefaultThinkingLevel']) }
      : {})
  }
}

function serializeOpenCodeModel(model: BaseUrlProviderModel): Record<string, unknown> {
  // Either bound is meaningful on its own (e.g. discovery often reports only
  // context_length) — requiring both dropped a known context window whenever
  // the output limit was missing.
  const limit = {
    ...(model.contextWindow ? { context: model.contextWindow } : {}),
    ...(model.maxOutputTokens ? { output: model.maxOutputTokens } : {})
  }
  return {
    name: model.name,
    ...(model.reasoning ? { reasoning: true } : {}),
    ...(Object.keys(limit).length > 0 ? { limit } : {}),
    ...(model.thinkingPresets?.length
      ? {
          variants: Object.fromEntries(
            model.thinkingPresets.map((preset) => [preset.id, { name: preset.label }])
          )
        }
      : {}),
    // Unset `vision` is treated as capable everywhere else in this codebase;
    // mirror that here rather than letting opencode's own default apply.
    modalities: {
      input: model.vision === false ? ['text'] : ['text', 'image'],
      output: ['text']
    },
    ...(model.defaultThinkingLevel ? { cioDefaultThinkingLevel: model.defaultThinkingLevel } : {})
  }
}

function serializePiModel(model: BaseUrlProviderModel): Record<string, unknown> {
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    ...(model.maxOutputTokens ? { maxTokens: model.maxOutputTokens } : {}),
    ...(model.defaultThinkingLevel ? { cioDefaultThinkingLevel: model.defaultThinkingLevel } : {})
  }
}

async function updateJsonc(
  filePath: string,
  path: Array<string | number>,
  value: unknown
): Promise<void> {
  const raw = await readJsoncText(filePath)
  await writeJsonc(filePath, editJsonc(raw, path, value))
}

function editJsonc(raw: string, path: Array<string | number>, value: unknown): string {
  return applyEdits(raw, modify(raw, path, value, { formattingOptions: FORMAT_OPTIONS }))
}

async function readJsoncObject(filePath: string): Promise<Record<string, unknown>> {
  const raw = await readJsoncText(filePath)
  const errors: ParseError[] = []
  const parsed = parse(raw, errors, { allowTrailingComma: true }) as unknown
  if (errors.length > 0) throw new Error(`Cannot parse native provider config: ${filePath}`)
  return record(parsed) ?? {}
}

async function readJsoncText(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return '{}\n'
    throw error
  }
}

async function writeJsonc(filePath: string, raw: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, raw.endsWith('\n') ? raw : `${raw}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    })
    await rename(temporaryPath, filePath)
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function stringRecord(
  value: Record<string, unknown> | undefined
): Record<string, string> | undefined {
  if (!value) return undefined
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string'
  )
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}
