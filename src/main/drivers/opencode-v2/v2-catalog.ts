import type { ProviderCatalog, ProviderModel, ThinkingPreset } from '../../../lib/types'
import { arrayValue, booleanValue, numberValue, recordValue, stringValue } from './v2-values'

/** The harness id every V2 catalog entry is attributed to. */
const HARNESS_ID = 'opencode2'

/** Unwrap the `{location, data}` envelope every location-scoped list uses. */
function listData(value: unknown): unknown[] {
  return arrayValue(recordValue(value)?.['data'])
}

/**
 * Thinking presets for one V2 model.
 *
 * V2 expresses reasoning effort as model `variants`, which are also what a
 * `Model.Ref.variant` selects at prompt time, so the variant ids are exactly
 * the thinking levels the picker may offer.
 */
function thinkingPresets(record: Record<string, unknown>): ThinkingPreset[] | undefined {
  const variants = arrayValue(record['variants']).flatMap((entry) => {
    const variant = recordValue(entry)
    const id = stringValue(variant?.['id'])
    if (!id) return []
    return [
      { id, label: id.charAt(0).toUpperCase() + id.slice(1), description: `${id} reasoning effort` }
    ]
  })
  return variants.length > 0 ? variants : undefined
}

/** Map one `Model.Info` into the shared model shape. */
export function mapOpenCodeV2Model(value: unknown): ProviderModel | null {
  const record = recordValue(value)
  if (!record) return null
  const providerId = stringValue(record['providerID'])
  const modelId = stringValue(record['modelID']) ?? stringValue(record['id'])
  if (!providerId || !modelId) return null
  const capabilities = recordValue(record['capabilities'])
  const limit = recordValue(record['limit'])
  const inputs = arrayValue(capabilities?.['input']).filter(
    (entry): entry is string => typeof entry === 'string'
  )
  const presets = thinkingPresets(record)
  const contextWindow = numberValue(limit?.['context'])
  return {
    id: modelId,
    providerId,
    name: stringValue(record['name']) ?? modelId,
    reasoning: booleanValue(capabilities?.['reasoning']) ?? presets !== undefined,
    ...(presets ? { thinkingPresets: presets } : {}),
    // An unknown capability set stays vision-capable so a model is never hidden
    // or gated by a missing field.
    attachment: inputs.length === 0 ? true : inputs.includes('image'),
    toolcall: booleanValue(capabilities?.['tools']) ?? false,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    // V2 has no separate fast tier; the fast-inference toggle is app-side only.
    fastSupported: false
  }
}

/**
 * Build the provider catalogs from the models a V2 server reports.
 *
 * `GET /api/model` is authoritative and already carries the provider id, name
 * and every capability the picker needs, so the catalog is grouped from the
 * models themselves; `GET /api/provider` only contributes display names and the
 * enabled/disabled state, which decides whether a provider is listed at all.
 */
export function mapOpenCodeV2Catalogs(
  modelsPayload: unknown,
  providersPayload?: unknown
): ProviderCatalog[] {
  const providerNames = new Map<string, string>()
  const disabledProviders = new Set<string>()
  for (const entry of listData(providersPayload)) {
    const record = recordValue(entry)
    const id = stringValue(record?.['id'])
    if (!id) continue
    providerNames.set(id, stringValue(record?.['name']) ?? id)
    if (stringValue(record?.['activation']) === 'disabled') disabledProviders.add(id)
  }
  const byProvider = new Map<string, ProviderModel[]>()
  for (const entry of listData(modelsPayload)) {
    const model = mapOpenCodeV2Model(entry)
    if (!model) continue
    if (disabledProviders.has(model.providerId)) continue
    const models = byProvider.get(model.providerId) ?? []
    models.push(model)
    byProvider.set(model.providerId, models)
  }
  return [...byProvider.entries()]
    .map(([providerId, models]) => ({
      id: providerId,
      name: providerNames.get(providerId) ?? providerId,
      harnessId: HARNESS_ID,
      models: models.sort((left, right) => left.name.localeCompare(right.name)),
      supportsAttachments: true
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

/** Provider ids the V2 server reports the user is connected to. */
export function openCodeV2ConnectedProviderIds(providersPayload: unknown): Set<string> {
  const connected = new Set<string>()
  for (const entry of listData(providersPayload)) {
    const record = recordValue(entry)
    const id = stringValue(record?.['id'])
    if (!id || stringValue(record?.['activation']) === 'disabled') continue
    connected.add(id)
  }
  return connected
}

/** Agent ids the V2 server exposes, used to validate a lean-agent selection. */
export function openCodeV2AgentIds(agentsPayload: unknown): Set<string> {
  const ids = new Set<string>()
  for (const entry of listData(agentsPayload)) {
    const id = stringValue(recordValue(entry)?.['id'])
    if (id) ids.add(id)
  }
  return ids
}

/** Slash commands the server exposes, in the shared command shape. */
export function mapOpenCodeV2Commands(
  payload: unknown
): Array<{ name: string; description?: string }> {
  return listData(payload).flatMap((entry) => {
    const record = recordValue(entry)
    const name = stringValue(record?.['name'])
    if (!name) return []
    const description = stringValue(record?.['description'])
    return [{ name, ...(description ? { description } : {}) }]
  })
}

/**
 * Variant ids declared by each model, keyed `providerID/modelID`.
 *
 * V2 selects a model variant by id, but `POST /api/session/{id}/model` accepts
 * an unknown variant without complaint and only fails at the next turn, so a
 * requested thinking level must be validated against this map before it is sent.
 */
export function openCodeV2ModelVariants(payload: unknown): Map<string, Set<string>> {
  const variants = new Map<string, Set<string>>()
  for (const entry of listData(payload)) {
    const record = recordValue(entry)
    const providerId = stringValue(record?.['providerID'])
    const modelId = stringValue(record?.['modelID']) ?? stringValue(record?.['id'])
    if (!providerId || !modelId) continue
    const ids = arrayValue(record?.['variants'])
      .map((variant) => stringValue(recordValue(variant)?.['id']))
      .filter((id): id is string => id !== undefined)
    variants.set(`${providerId}/${modelId}`, new Set(ids))
  }
  return variants
}

/** Whether the model id appears in a catalog payload; used to validate a switch. */
export function openCodeV2HasModel(
  modelsPayload: unknown,
  providerId: string,
  modelId: string
): boolean {
  return listData(modelsPayload).some((entry) => {
    const record = recordValue(entry)
    if (!record) return false
    return (
      stringValue(record['providerID']) === providerId &&
      (stringValue(record['modelID']) ?? stringValue(record['id'])) === modelId
    )
  })
}
