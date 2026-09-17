import { createHash } from 'crypto'
import { readFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import type { ProviderCatalog, ProviderModel, ThinkingPreset } from '../../../lib/types'
import { resolveHarnessRuntime } from '../harness-runtime'
import { record, stringValue } from './cline-values'

export const CLINE_THINKING_LEVELS: Record<string, string> = {
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'xhigh',
  ultra: 'xhigh'
}

const CLINE_CATALOG_URL = 'https://api.cline.bot/api/v1/ai/cline/recommended-models'
const CLINE_CATALOG_CACHE_TTL_MS = 60 * 60 * 1000
export const CLINE_PASS_PROVIDER_ID = 'cline-pass'

export const CLINE_THINKING_PRESETS: ThinkingPreset[] = [
  { id: 'minimal', label: 'Minimal', description: 'Minimum reasoning effort' },
  { id: 'low', label: 'Low', description: 'Low reasoning effort' },
  { id: 'medium', label: 'Medium', description: 'Moderate reasoning effort' },
  { id: 'high', label: 'High', description: 'High reasoning effort' },
  { id: 'xhigh', label: 'Extra high', description: 'Extra-high reasoning effort' }
]

/** Stable Cline gateway models used when the remote catalog is unavailable. */
export const CLINE_FALLBACK_CATALOG: ProviderCatalog[] = [
  {
    id: 'cline',
    name: 'Cline',
    harnessId: 'cline',
    models: [
      {
        id: 'anthropic/claude-sonnet-4-6',
        providerId: 'cline',
        name: 'Claude Sonnet 4.6',
        reasoning: true,
        thinkingPresets: CLINE_THINKING_PRESETS,
        attachment: true,
        toolcall: true
      },
      {
        id: 'google/gemini-2.5-pro',
        providerId: 'cline',
        name: 'Gemini 2.5 Pro',
        reasoning: true,
        thinkingPresets: CLINE_THINKING_PRESETS,
        attachment: true,
        toolcall: true
      },
      {
        id: 'openai/gpt-4o',
        providerId: 'cline',
        name: 'GPT-4o',
        reasoning: false,
        attachment: true,
        toolcall: true
      },
      {
        id: 'deepseek/deepseek-chat',
        providerId: 'cline',
        name: 'DeepSeek Chat',
        reasoning: false,
        attachment: false,
        toolcall: true
      },
      {
        id: 'minimax/minimax-m2.5',
        providerId: 'cline',
        name: 'MiniMax M2.5',
        reasoning: true,
        thinkingPresets: CLINE_THINKING_PRESETS,
        attachment: true,
        toolcall: true
      }
    ]
  },
  {
    id: CLINE_PASS_PROVIDER_ID,
    name: 'ClinePass',
    harnessId: 'cline',
    models: [
      {
        id: 'cline-pass/qwen3.8-max',
        providerId: CLINE_PASS_PROVIDER_ID,
        name: 'Qwen 3.8 Max',
        reasoning: true,
        thinkingPresets: CLINE_THINKING_PRESETS,
        attachment: true,
        toolcall: true
      },
      {
        id: 'cline-pass/deepseek-v4-flash',
        providerId: CLINE_PASS_PROVIDER_ID,
        name: 'DeepSeek V4 Flash',
        reasoning: true,
        thinkingPresets: CLINE_THINKING_PRESETS,
        attachment: false,
        toolcall: true
      }
    ]
  }
]

let clineCatalogCache: { cachedAt: number; catalogs: ProviderCatalog[] } | null = null
/** Free model ids discovered from the remote catalog, consumed by the driver. */
export let clineFreeModelIds: string[] = []
let clinePassEntitlementCache: {
  checkedAt: number
  tokenFingerprint: string
  subscribed: boolean
} | null = null

export function cloneCatalogs(catalogs: ProviderCatalog[]): ProviderCatalog[] {
  return catalogs.map((catalog) => ({ ...catalog, models: [...catalog.models] }))
}

function mapRemoteClineModel(value: unknown, providerId: string): ProviderModel | null {
  const raw = record(value)
  const id = stringValue(raw?.['id'])
  if (!id) return null
  const name = stringValue(raw?.['name']) ?? id
  const reasoning = /reason|opus|sonnet|gemini|qwen|deepseek|kimi|mimo|laguna/iu.test(
    `${id} ${name}`
  )
  // Prefer a structured vision capability when the catalog reports one;
  // otherwise default to vision-capable except for known text-only families.
  const capabilities = record(raw?.['capabilities'])
  const explicitVision = capabilities?.['vision'] ?? capabilities?.['attachment']
  const attachment = explicitVision === undefined ? !isTextOnlyModel(id) : explicitVision !== false
  return {
    id,
    providerId,
    name,
    reasoning,
    ...(reasoning ? { thinkingPresets: CLINE_THINKING_PRESETS } : {}),
    attachment,
    toolcall: true
  }
}

/** Known text-only model families that cannot see images. */
function isTextOnlyModel(modelId: string): boolean {
  return /deepseek/iu.test(modelId)
}

export function uniqueModels(models: ProviderModel[]): ProviderModel[] {
  return [...new Map(models.map((model) => [model.id, model])).values()]
}

function mapRemoteClineCatalog(value: unknown): ProviderCatalog[] {
  const payload = record(value)
  if (!payload) return []

  const mapModels = (key: string, providerId: string): ProviderModel[] => {
    const values = payload[key]
    return Array.isArray(values)
      ? uniqueModels(
          values
            .map((model) => mapRemoteClineModel(model, providerId))
            .filter((model): model is ProviderModel => model !== null)
        )
      : []
  }

  const catalogs: ProviderCatalog[] = []
  const freeModels = mapModels('free', 'cline')
  clineFreeModelIds = freeModels.map((model) => model.id)
  const clineModels = uniqueModels([...mapModels('recommended', 'cline'), ...freeModels])
  if (clineModels.length > 0) {
    catalogs.push({ id: 'cline', name: 'Cline', harnessId: 'cline', models: clineModels })
  }

  const clinePassModels = mapModels('clinePass', CLINE_PASS_PROVIDER_ID)
  if (clinePassModels.length > 0) {
    catalogs.push({
      id: CLINE_PASS_PROVIDER_ID,
      name: 'ClinePass',
      harnessId: 'cline',
      models: clinePassModels
    })
  }
  return catalogs
}

/** Read the OAuth access token Cline itself owns without copying or mutating it. */
async function readClineAccessToken(): Promise<string | undefined> {
  try {
    const content = await readFile(
      join(homedir(), '.cline', 'data', 'settings', 'providers.json'),
      'utf8'
    )
    const store = record(JSON.parse(content) as unknown)
    const providers = record(store?.['providers'])
    const cline = record(providers?.['cline'])
    const settings = record(cline?.['settings'])
    const auth = record(settings?.['auth'])
    return stringValue(auth?.['accessToken'])
  } catch {
    return undefined
  }
}

/** Only expose subscription-gated models when Cline confirms an active plan. */
export async function hasClinePassSubscription(): Promise<boolean> {
  const accessToken = await readClineAccessToken()
  if (!accessToken) return false
  const tokenFingerprint = createHash('sha256').update(accessToken).digest('hex')
  if (
    clinePassEntitlementCache?.tokenFingerprint === tokenFingerprint &&
    Date.now() - clinePassEntitlementCache.checkedAt < 5 * 60 * 1000
  ) {
    return clinePassEntitlementCache.subscribed
  }
  let subscribed = false
  try {
    const response = await fetch('https://api.cline.bot/api/v1/users/me/plan', {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(5_000)
    })
    if (response.ok) {
      const envelope = record(await response.json())
      const currentPlan = record(envelope?.['data'])
      subscribed = record(currentPlan?.['plan']) !== null
    }
  } catch {
    // A plan that cannot be confirmed must not expose subscription-only models.
  }
  clinePassEntitlementCache = { checkedAt: Date.now(), tokenFingerprint, subscribed }
  return subscribed
}

/**
 * Cline allows its free models through both the Cline and ClinePass providers.
 * Keep those visible for every signed-in account, while filtering the paid
 * ClinePass set unless the account API confirms an active subscription.
 */
export function filterClineCatalogForAccount(
  catalogs: ProviderCatalog[],
  hasClinePass: boolean
): ProviderCatalog[] {
  const cline = catalogs.find((catalog) => catalog.id === 'cline')
  const clinePass = catalogs.find((catalog) => catalog.id === CLINE_PASS_PROVIDER_ID)
  const freeIds = new Set(clineFreeModelIds)
  const freeModels = (cline?.models ?? [])
    .filter((model) => freeIds.has(model.id))
    .map((model) => ({ ...model, providerId: CLINE_PASS_PROVIDER_ID }))
  const subscriptionModels = hasClinePass ? (clinePass?.models ?? []) : []
  const availableClinePassModels = uniqueModels([...freeModels, ...subscriptionModels])
  const available = catalogs.filter((catalog) => catalog.id !== CLINE_PASS_PROVIDER_ID)
  if (availableClinePassModels.length > 0) {
    available.push({
      id: CLINE_PASS_PROVIDER_ID,
      name: 'ClinePass',
      harnessId: 'cline',
      models: availableClinePassModels
    })
  }
  return available
}

export async function fetchClineCatalog(): Promise<ProviderCatalog[]> {
  if (clineCatalogCache && Date.now() - clineCatalogCache.cachedAt < CLINE_CATALOG_CACHE_TTL_MS) {
    return cloneCatalogs(clineCatalogCache.catalogs)
  }

  try {
    const response = await fetch(CLINE_CATALOG_URL, {
      signal: AbortSignal.timeout(8_000)
    })
    if (!response.ok) return []
    const catalogs = mapRemoteClineCatalog(await response.json())
    if (catalogs.length === 0) return []
    clineCatalogCache = { cachedAt: Date.now(), catalogs }
    return cloneCatalogs(catalogs)
  } catch {
    return []
  }
}

/** Dedupes concurrent remote-catalog refreshes (e.g. several pickers open at once). */
let clineRemoteInflight: Promise<ProviderCatalog[]> | null = null

export function refreshClineCatalogOnce(): Promise<ProviderCatalog[]> {
  clineRemoteInflight ??= fetchClineCatalog().finally(() => {
    clineRemoteInflight = null
  })
  return clineRemoteInflight
}

const CLINE_AVAILABILITY_CACHE_TTL_MS = 60_000
let clineAvailabilityCache: { checkedAt: number; available: boolean } | null = null

/**
 * Whether the `cline` binary is present on the harness PATH. Fetching the
 * remote model catalog costs a network round-trip for every provider-catalog
 * refresh, so it is pointless when Cline is not installed   gate on the binary
 * instead and fall back to the static catalog. The probe result is cached for
 * a short window so rapid refreshes do not repeat filesystem resolution.
 */
export async function isClineAvailable(): Promise<boolean> {
  if (
    clineAvailabilityCache &&
    Date.now() - clineAvailabilityCache.checkedAt < CLINE_AVAILABILITY_CACHE_TTL_MS
  ) {
    return clineAvailabilityCache.available
  }
  const available = (await resolveHarnessRuntime('cline')) !== null
  clineAvailabilityCache = { checkedAt: Date.now(), available }
  return available
}
