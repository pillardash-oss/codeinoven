/// <reference types="node" />

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser'
import type { BaseUrlProvider, BaseUrlProviderModel, ThinkingLevel } from '../../lib/types'
import { PI_THINKING_PRESETS } from '../../lib/pi-thinking-presets'
import { Logger } from '../system/logger'
import type { StorageEngine } from '../storage/storage-engine'

const OPENCODE_CONFIG_PATH = join(homedir(), '.config', 'opencode', 'opencode.json')
const PI_AGENT_DIR = join(homedir(), '.pi', 'agent')
const PI_MODELS_PATH = join(PI_AGENT_DIR, 'models.json')
const NATIVE_HARNESSES = new Set(['opencode', 'pi'])
const DISABLED_PROVIDERS_DIRECTORY = 'disabled-providers'
const DISABLED_PROVIDER_SUFFIX = '.json'
const DISABLED_PROVIDER_VERSION = 1
/** Parked provider ids double as file names, so reject anything path-shaped. */
const SAFE_DISABLED_PROVIDER_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u
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
 * chosen)   neither opencode's nor pi's own schema has a concept for it. This
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
 * Provider ids the user configured natively in Pi's `models.json`   explicit
 * connect targets regardless of whether their entry carries an API key (keyless
 * local servers are legitimate).
 *
 * `modelsPath` names the file to read. A managed account container runs Pi
 * against its own agent directory, so it must pass its own `models.json` path;
 * the default (`~/.pi/agent/models.json`) belongs to the harness-global account
 * alone. A missing file is an empty set   a container is provisioned without
 * one, and that is "no native providers configured", not "unknown". Returns
 * `null` only when the file exists but cannot be read or repaired; callers must
 * then treat the connected set as undeterminable rather than as empty.
 */
export async function piNativeProviderIds(
  modelsPath = PI_MODELS_PATH
): Promise<Set<string> | null> {
  const config = await tryReadJsoncObject(modelsPath)
  if (!config) return null
  const providers = record(config['providers']) ?? {}
  return new Set(Object.keys(providers))
}

/**
 * Provider ids the user configured natively in opencode's
 * `~/.config/opencode/opencode.json` (`provider` entries   explicit connect
 * targets regardless of whether their entry carries an API key), minus ids the
 * user disabled via `disabled_providers`. Returns `null` when the config exists
 * but cannot be parsed   callers then keep their catalog unfiltered rather
 * than wrongly hiding every provider behind a read failure.
 */
export async function opencodeNativeProviderIds(): Promise<Set<string> | null> {
  const config = await tryReadJsoncObject(OPENCODE_CONFIG_PATH)
  if (!config) return null
  const providers = record(config['provider']) ?? {}
  const disabled = new Set(stringArray(config['disabled_providers']))
  return new Set(Object.keys(providers).filter((id) => !disabled.has(id)))
}

/** Reads and surgically edits harness-owned custom provider catalogs. */
export class NativeProviderConfigService {
  private readonly disabledProviders: DisabledProviderStore

  constructor(storage: StorageEngine) {
    this.disabledProviders = new DisabledProviderStore(storage)
  }

  /** Read a native Pi provider key for main-process usage probes only. */
  async readApiKey(harnessId: string, providerId: string): Promise<string | undefined> {
    if (harnessId !== 'pi') return undefined
    const config = await tryReadJsoncObject(PI_MODELS_PATH)
    if (!config) return undefined
    const provider = record(record(config['providers'])?.[providerId])
    const apiKey = stringValue(provider?.['apiKey'])
    return apiKey && apiKey !== 'none' ? apiKey : undefined
  }

  async listProviders(): Promise<BaseUrlProvider[]> {
    const [openCode, pi] = await Promise.all([this.listOpenCodeProviders(), this.listPiProviders()])
    return [...openCode, ...pi]
  }

  /**
   * Harness-global native Pi providers from `~/.pi/agent/models.json`.
   * Managed account containers get their own agent dir with no models.json, so
   * custom providers (keyless local servers like llama.cpp) must be re-read
   * from the global file and mirrored into the container via the driver's
   * overlay extension.
   */
  async listGlobalPiProviders(): Promise<BaseUrlProvider[]> {
    return this.listPiProviders()
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
      // A parked provider is already gone from models.json; only touch the file
      // when its entry is really there, so deleting one never creates an empty
      // harness config.
      const config = await tryReadJsoncObject(PI_MODELS_PATH)
      const liveEntry = record(record(config?.['providers'])?.[provider.id])
      if (liveEntry !== undefined) {
        await updateJsonc(PI_MODELS_PATH, ['providers', provider.id], undefined)
      }
      await this.disabledProviders.remove('pi', provider.id)
      return
    }
    throw new Error(`${provider.harnessId} does not expose a native provider catalog`)
  }

  private async listOpenCodeProviders(): Promise<BaseUrlProvider[]> {
    const config = await tryReadJsoncObject(OPENCODE_CONFIG_PATH)
    if (!config) return []
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

  private async listPiProviders(modelsPath: string = PI_MODELS_PATH): Promise<BaseUrlProvider[]> {
    const [config, parked] = await Promise.all([
      tryReadJsoncObject(modelsPath),
      this.disabledProviders.list('pi')
    ])
    const providers = record(config?.['providers']) ?? {}
    const live = Object.entries(providers).flatMap(([id, value]) => {
      const parsed = piProvider(id, record(value), true)
      return parsed ? [parsed] : []
    })
    // Parked providers stay listed   badged disabled   so turning one off is as
    // reversible in the UI as opencode's own `disabled_providers`. An id that is
    // live again (re-enabled outside CodeInOven) wins, and its parked copy is
    // not listed a second time.
    const liveIds = new Set(live.map((provider) => provider.id))
    const disabled = parked.flatMap((parkedProvider) => {
      if (liveIds.has(parkedProvider.providerId)) return []
      const parsed = piProvider(
        parkedProvider.providerId,
        parkedProvider.entry,
        false,
        parkedProvider.disabledAt
      )
      return parsed ? [parsed] : []
    })
    return [...live, ...disabled]
  }

  /**
   * Pi's `models.json` cannot express "configured, but off"   an entry's
   * presence is its only switch   so a disable is emulated rather than
   * rejected: the entry is parked in CodeInOven's own disabled-provider store
   * and deleted from `models.json`. Pi stops offering the provider while the
   * user still sees it listed as disabled and can re-enable it, which is the
   * same behavior opencode's native `disabled_providers` gives them.
   */
  private async upsertPiProvider(
    provider: BaseUrlProvider,
    apiKey?: string,
    removeApiKey = false
  ): Promise<void> {
    const config = await readJsoncObject(PI_MODELS_PATH)
    const live = record(record(config['providers'])?.[provider.id])
    // A parked provider is no longer in models.json, so its own parked entry
    // the one carrying the stored API key and any field CodeInOven does not
    // model   is what an edit starts from.
    const parked = await this.disabledProviders.read('pi', provider.id)
    const existing = { ...(parked?.entry ?? {}), ...(live ?? {}) }
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
    if (!provider.enabled) {
      // Park first, delete second: a failure in between leaves the provider
      // enabled and usable rather than gone.
      await this.disabledProviders.save({
        harnessId: 'pi',
        providerId: provider.id,
        name: provider.name,
        entry
      })
      if (live !== undefined)
        await updateJsonc(PI_MODELS_PATH, ['providers', provider.id], undefined)
      return
    }
    await updateJsonc(PI_MODELS_PATH, ['providers', provider.id], entry)
    await this.disabledProviders.remove('pi', provider.id)
  }
}

/** A native provider CodeInOven parked out of a harness config that cannot disable natively. */
interface DisabledProviderRecord {
  version: number
  harnessId: string
  providerId: string
  /** Display name at the time of the disable, so the record reads on its own. */
  name: string
  disabledAt: number
  /** The provider's native config entry, restored verbatim on re-enable. */
  entry: Record<string, unknown>
}

/**
 * CodeInOven-owned store for native providers whose harness cannot express
 * "configured, but disabled" itself.
 *
 * opencode has `disabled_providers`, so it disables natively and never reaches
 * this store. Pi's `models.json` has no equivalent   the only way to stop Pi
 * offering a custom provider is to delete its entry   so CodeInOven parks that
 * entry beneath its own config root and deletes it from `models.json`: Pi stops
 * offering the provider, CodeInOven keeps listing it as disabled, and
 * re-enabling restores it byte-for-byte.
 *
 * One file per provider: `disabled-providers/<harness>/<provider-id>.json`.
 */
class DisabledProviderStore {
  constructor(private readonly storage: StorageEngine) {}

  /** Every provider parked for one harness; a malformed record is skipped. */
  async list(harnessId: string): Promise<DisabledProviderRecord[]> {
    const directory = disabledProviderDirectory(harnessId)
    const files = (await this.storage.list(directory)).filter(isDisabledProviderFile)
    const records = await Promise.all(
      files.map((file) => {
        const providerId = file.slice(0, -DISABLED_PROVIDER_SUFFIX.length)
        return this.readRecord(directory, file, harnessId, providerId)
      })
    )
    return records.filter((record): record is DisabledProviderRecord => record !== null)
  }

  /** The record parked for one provider, or null when it is not parked. */
  async read(harnessId: string, providerId: string): Promise<DisabledProviderRecord | null> {
    assertDisabledProviderId(providerId)
    return this.readRecord(
      disabledProviderDirectory(harnessId),
      `${providerId}${DISABLED_PROVIDER_SUFFIX}`,
      harnessId,
      providerId
    )
  }

  /** Park `entry` as the disabled state of one provider, replacing any earlier record. */
  async save(input: {
    harnessId: string
    providerId: string
    name: string
    entry: Record<string, unknown>
  }): Promise<void> {
    await this.storage.write(disabledProviderPath(input.harnessId, input.providerId), {
      version: DISABLED_PROVIDER_VERSION,
      harnessId: input.harnessId,
      providerId: input.providerId,
      name: input.name,
      disabledAt: Date.now(),
      entry: input.entry
    } satisfies DisabledProviderRecord)
  }

  /** Drop a provider's parked record   it is live again, or deleted. */
  async remove(harnessId: string, providerId: string): Promise<void> {
    await this.storage.removeRaw(disabledProviderPath(harnessId, providerId))
  }

  private async readRecord(
    directory: string,
    file: string,
    harnessId: string,
    providerId: string
  ): Promise<DisabledProviderRecord | null> {
    const path = join(directory, file)
    let raw: unknown
    try {
      raw = await this.storage.read<unknown>(path)
    } catch (error) {
      Logger.error('Disabled provider record could not be read; ignoring it', {
        path,
        cause: error instanceof Error ? error.message : String(error)
      })
      return null
    }
    // No file at all is simply "not parked".
    if (raw === null) return null
    const parsed = parseDisabledProviderRecord(raw, harnessId, providerId)
    if (!parsed) Logger.error('Disabled provider record is malformed; ignoring it', { path })
    return parsed
  }
}

/**
 * Defensive read of a parked record: a file we cannot trust is dropped instead
 * of breaking the whole provider list. The worst case is a provider the user
 * has to disable again.
 */
function parseDisabledProviderRecord(
  value: unknown,
  harnessId: string,
  providerId: string
): DisabledProviderRecord | null {
  const raw = record(value)
  if (!raw || raw['harnessId'] !== harnessId || raw['providerId'] !== providerId) return null
  const entry = record(raw['entry'])
  if (!entry) return null
  const disabledAt = raw['disabledAt']
  return {
    version: typeof raw['version'] === 'number' ? raw['version'] : DISABLED_PROVIDER_VERSION,
    harnessId,
    providerId,
    name: stringValue(raw['name']) ?? providerId,
    disabledAt: typeof disabledAt === 'number' && Number.isFinite(disabledAt) ? disabledAt : 0,
    entry
  }
}

function isDisabledProviderFile(file: string): boolean {
  return (
    file.endsWith(DISABLED_PROVIDER_SUFFIX) &&
    SAFE_DISABLED_PROVIDER_ID.test(file.slice(0, -DISABLED_PROVIDER_SUFFIX.length))
  )
}

function disabledProviderDirectory(harnessId: string): string {
  assertDisabledProviderId(harnessId)
  return join(DISABLED_PROVIDERS_DIRECTORY, harnessId)
}

function disabledProviderPath(harnessId: string, providerId: string): string {
  assertDisabledProviderId(providerId)
  return join(disabledProviderDirectory(harnessId), `${providerId}${DISABLED_PROVIDER_SUFFIX}`)
}

function assertDisabledProviderId(value: string): void {
  if (!SAFE_DISABLED_PROVIDER_ID.test(value)) {
    throw new TypeError(`Unsupported disabled provider id: ${value}`)
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
    // opencode's variant *key* is a free-form label   the level it actually
    // dispatches with is `thinkingLevel` inside the value (falls back to the
    // key for older/hand-written configs that don't set it).
    ...(variants
      ? {
          thinkingPresets: Object.entries(variants).map(([variant, value]) => {
            const level = stringValue(record(value)?.['thinkingLevel']) ?? variant
            return {
              id: level,
              label: level.charAt(0).toUpperCase() + level.slice(1),
              description: `${level} reasoning effort`
            }
          })
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

/**
 * One harness-native Pi provider entry in the UI's provider shape, shared by
 * live `models.json` entries and parked (disabled) copies so a provider looks
 * the same on either side of a disable.
 */
function piProvider(
  id: string,
  provider: Record<string, unknown> | undefined,
  enabled: boolean,
  updatedAt = 0
): BaseUrlProvider | null {
  const baseURL = stringValue(provider?.['baseUrl']) ?? stringValue(provider?.['baseURL'])
  const models = Array.isArray(provider?.['models']) ? provider['models'] : []
  if (!provider || !baseURL || models.length === 0) return null
  const parsedModels = models.flatMap((model) => {
    const parsed = piModel(id, model)
    return parsed ? [parsed] : []
  })
  if (parsedModels.length === 0) return null
  const api = stringValue(provider['api']) ?? 'openai-completions'
  const npm =
    api === 'openai-responses'
      ? '@ai-sdk/openai'
      : api === 'anthropic-messages'
        ? '@ai-sdk/anthropic'
        : '@ai-sdk/openai-compatible'
  return {
    ...nativeProvider(
      id,
      'pi',
      stringValue(provider['name']) ?? id,
      npm,
      baseURL,
      parsedModels,
      enabled,
      provider
    ),
    // A parked provider is as freshly touched as its disable, so it resurfaces
    // in the most-recently-updated-first list like any other edit.
    ...(updatedAt > 0 ? { updatedAt } : {})
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
  // context_length)   requiring both dropped a known context window whenever
  // the output limit was missing.
  const limit = {
    ...(model.contextWindow ? { context: model.contextWindow } : {}),
    ...(model.maxOutputTokens ? { output: model.maxOutputTokens } : {})
  }
  return {
    name: model.name,
    ...(model.reasoning ? { reasoning: true } : {}),
    ...(Object.keys(limit).length > 0 ? { limit } : {}),
    // opencode dispatches by passing the thread's thinking level straight
    // through as the variant key (see opencode-driver's `variant:` field), so
    // the key must equal the level it selects   the value's `thinkingLevel`
    // is what opencode itself reads to know which effort to actually request.
    ...(model.thinkingPresets?.length
      ? {
          variants: Object.fromEntries(
            model.thinkingPresets.map((preset) => [preset.id, { thinkingLevel: preset.id }])
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

/**
 * Read-only callers (provider listings, usage probes) must not fail wholesale
 * when a user hand-edited a native config into invalid JSONC   they degrade to
 * "no native providers" instead, with auto-repair attempted first (see
 * `repairJsoncFile`). Write paths use the throwing `readJsoncObject` so a
 * broken file is never silently overwritten.
 */
async function tryReadJsoncObject(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    return await readJsoncObject(filePath)
  } catch (error) {
    return repairJsoncFile(filePath, error)
  }
}

/**
 * Auto-repair for a corrupt native config: back up the original, sanitize the
 * structural comma corruption jsonc editing can leave behind, and only rewrite
 * the file atomically once the repaired text verifiably parses. When repair is
 * impossible the original is left untouched and callers degrade as before.
 */
async function repairJsoncFile(
  filePath: string,
  cause: unknown
): Promise<Record<string, unknown> | null> {
  const raw = await readJsoncText(filePath)
  const repaired = sanitizeJsoncCommas(raw)
  const errors: ParseError[] = []
  const parsed = parse(repaired, errors, { allowTrailingComma: true }) as unknown
  if (repaired === raw || errors.length > 0) {
    Logger.error('Native provider config could not be auto-repaired; leaving it untouched', {
      filePath,
      cause: cause instanceof Error ? cause.message : String(cause)
    })
    return null
  }
  const backupPath = `${filePath}.broken-${new Date().toISOString().replace(/[:.]/g, '-')}`
  await writeFile(backupPath, raw, { encoding: 'utf8', mode: 0o600 })
  await writeJsonc(filePath, repaired)
  Logger.info('Native provider config was corrupt and has been auto-repaired', {
    filePath,
    backupPath
  })
  return record(parsed) ?? {}
}

/**
 * Repair stray comma corruption while leaving every other byte in place:
 * string literals are copied verbatim (their contents are data, not structure),
 * and only commas outside strings are normalized. Repairs doubled commas,
 * leading commas after `{`/`[`, and trailing commas before `}`/`]`.
 */
function sanitizeJsoncCommas(raw: string): string {
  let result = ''
  let code = ''
  let i = 0
  while (i < raw.length) {
    if (raw[i] === '"') {
      let end = i + 1
      while (end < raw.length && raw[end] !== '"') {
        if (raw[end] === '\\') end++
        end++
      }
      end = Math.min(end + 1, raw.length)
      result += fixCommaRuns(code) + raw.slice(i, end)
      code = ''
      i = end
    } else {
      code += raw[i]
      i++
    }
  }
  return result + fixCommaRuns(code)
}

function fixCommaRuns(code: string): string {
  return code
    .replace(/,\s*,+/g, ',')
    .replace(/:(\s*),/g, ':$1null,')
    .replace(/([{[])\s*,+/g, '$1')
    .replace(/,\s*([}\]])/g, '$1')
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
  // Our own jsonc edits can occasionally leave stray commas behind   never
  // persist output that does not parse: sanitize it, refuse otherwise.
  const validated = validatedJsoncText(raw)
  if (validated === null) throw new Error(`Refusing to write invalid JSONC to: ${filePath}`)
  await mkdir(dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, validated.endsWith('\n') ? validated : `${validated}\n`, {
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

/** Returns the text as-is when it parses; sanitized when repair fixes it; null otherwise. */
function validatedJsoncText(raw: string): string | null {
  const errors: ParseError[] = []
  parse(raw, errors, { allowTrailingComma: true })
  if (errors.length === 0) return raw
  const sanitized = sanitizeJsoncCommas(raw)
  const sanitizedErrors: ParseError[] = []
  parse(sanitized, sanitizedErrors, { allowTrailingComma: true })
  return sanitizedErrors.length === 0 ? sanitized : null
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
