import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import type {
  ProviderCatalog,
  ProviderModel,
  ThinkingLevel,
  ThinkingPreset
} from '../../../lib/types'
import { THINKING_LEVEL_ORDER } from '../../../lib/thinking-presets'
import { buildProcessEnvironment } from '../cli-environment'
import { runHarnessCommand } from '../harness-runtime'
import { numberValue, record, stringValue } from './muse-values'

export const MUSE_PROBE_TIMEOUT_MS = 15_000
/** Provider id under which every Muse-cloud model is catalogued. */
export const MUSE_PROVIDER_ID = 'meta'

interface MuseCliCapabilities {
  reasoningEfforts: ThinkingLevel[]
  thinkingPresets: ThinkingPreset[]
  attachments: boolean
  toolCalls: boolean
}

let museCliCapabilitiesProbe: Promise<MuseCliCapabilities> | undefined

function thinkingPresetLabel(effort: ThinkingLevel): string {
  if (effort === 'xhigh') return 'Extra high'
  return `${effort.charAt(0).toUpperCase()}${effort.slice(1)}`
}

/** Parse the installed Muse CLI's advertised headless capability surface. */
export function parseMuseCliCapabilities(help: string): MuseCliCapabilities {
  const effortLine = help.match(/Meta reasoning effort:\s*([^\n]+)/iu)?.[1] ?? ''
  const supportedThinkingLevels = new Set<ThinkingLevel>(THINKING_LEVEL_ORDER)
  const reasoningEfforts = effortLine
    .split('|')
    .map((value) => value.trim())
    .filter((value): value is ThinkingLevel => supportedThinkingLevels.has(value as ThinkingLevel))
  return {
    reasoningEfforts,
    thinkingPresets: reasoningEfforts.map((effort) => ({
      id: effort,
      label: thinkingPresetLabel(effort)
    })),
    attachments: /^\s*--image\s+<PATH>/mu.test(help),
    toolCalls: /^\s*--disable-(?:shell|write)\b/mu.test(help)
  }
}

/** Probe once per app process; a failed probe is retryable instead of becoming stale state. */
export async function readMuseCliCapabilities(): Promise<MuseCliCapabilities> {
  if (!museCliCapabilitiesProbe) {
    museCliCapabilitiesProbe = runMuse(['exec', '--help'], MUSE_PROBE_TIMEOUT_MS)
      .then((result) => {
        if (!result.succeeded) {
          throw new Error(result.stderr.trim() || result.stdout.trim() || 'Muse help probe failed')
        }
        return parseMuseCliCapabilities(`${result.stdout}\n${result.stderr}`)
      })
      .catch((error: unknown) => {
        museCliCapabilitiesProbe = undefined
        throw error
      })
  }
  return museCliCapabilitiesProbe
}

function museModel(
  id: string,
  providerId: string,
  name: string,
  capabilities: MuseCliCapabilities,
  contextWindow?: number
): ProviderModel {
  return {
    id,
    providerId,
    name,
    reasoning: capabilities.reasoningEfforts.length > 0,
    ...(capabilities.thinkingPresets.length > 0
      ? { thinkingPresets: capabilities.thinkingPresets }
      : {}),
    attachment: capabilities.attachments,
    toolcall: capabilities.toolCalls,
    ...(contextWindow === undefined ? {} : { contextWindow })
  }
}

/**
 * Fallback catalog for the Meta provider. Muse exposes no model-list
 * subcommand, so use its default selection without fabricating an account-tier
 * model id. Capabilities still come from the installed CLI probe.
 */
export function museFallbackCatalog(capabilities: MuseCliCapabilities): ProviderCatalog[] {
  return [
    {
      id: MUSE_PROVIDER_ID,
      name: 'Meta',
      harnessId: 'muse',
      models: [museModel('default', MUSE_PROVIDER_ID, 'Muse default', capabilities)]
    }
  ]
}

/**
 * Muse caches the provider's model catalog locally at
 * `~/.local/share/muse/model-catalog/*.json`, keyed by provider/profile. Read it
 * so the picker reflects the account's real models (id, display label, context
 * limit) instead of the default placeholder. Returns no discovered providers
 * when the cache is missing or unreadable (e.g. before the first logged-in run).
 */
export async function readMuseModelCatalog(
  capabilities: MuseCliCapabilities
): Promise<ProviderCatalog[]> {
  const directory = join(homedir(), '.local', 'share', 'muse', 'model-catalog')
  let files: string[]
  try {
    files = (await readdir(directory)).filter((file) => file.endsWith('.json'))
  } catch {
    return []
  }
  const catalogs = new Map<string, ProviderCatalog>()
  for (const file of files) {
    let raw: string
    try {
      raw = await readFile(join(directory, file), 'utf8')
    } catch {
      continue
    }
    let catalog: unknown
    try {
      catalog = JSON.parse(raw) as unknown
    } catch {
      continue
    }
    const root = record(catalog)
    if (!root) continue
    const providerId = stringValue(root['provider_id']) ?? MUSE_PROVIDER_ID
    const rows = Array.isArray(root['rows']) ? root['rows'] : []
    interface CatalogRow {
      model: ProviderModel
      current: boolean
      default: boolean
      order: number
    }
    const catalogRows: CatalogRow[] = []
    for (const rawRow of rows) {
      const row = record(rawRow)
      if (!row) continue
      const modelId = stringValue(row['model_id'])
      if (!modelId) continue
      const contextLimit = numberValue(row['context_limit'])
      catalogRows.push({
        model: museModel(
          modelId,
          providerId,
          stringValue(row['display_label']) ?? modelId,
          capabilities,
          contextLimit
        ),
        current: row['is_current'] === true,
        default: row['is_default'] === true,
        order: numberValue(row['display_order']) ?? 0
      })
    }
    if (catalogRows.length === 0) continue
    // Advertise the account's default model first so a fresh thread picks the
    // discounted default rather than the standard tier. `is_default` is stable;
    // `is_current` reflects the last-used model and is only a secondary hint.
    const models = catalogRows
      .sort(
        (left, right) =>
          Number(right.default) - Number(left.default) ||
          Number(right.current) - Number(left.current) ||
          left.order - right.order
      )
      .map((catalogRow) => catalogRow.model)
    const existing = catalogs.get(providerId)
    if (existing) {
      existing.models.push(...models)
    } else {
      catalogs.set(providerId, {
        id: providerId,
        name: providerId === MUSE_PROVIDER_ID ? 'Meta' : providerId,
        harnessId: 'muse',
        models
      })
    }
  }
  return catalogs.size > 0 ? [...catalogs.values()] : []
}

/**
 * Muse CLI reads its stdin and hangs when that pipe stays open without EOF or a
 * terminal. Every short-lived probe (version) must spawn with stdin ignored so
 * it exits promptly in a desktop context.
 */
export async function runMuse(
  args: string[],
  timeoutMs: number
): Promise<{ succeeded: boolean; stdout: string; stderr: string }> {
  try {
    const result = await runHarnessCommand('muse', args, {
      env: buildProcessEnvironment(),
      timeoutMs
    })
    return { succeeded: true, ...result }
  } catch (error) {
    return {
      succeeded: false,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error)
    }
  }
}

export type { MuseCliCapabilities }
