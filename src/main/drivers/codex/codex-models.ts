import type { ProviderModel, ThinkingPreset } from '../../../lib/types'
import {
  codexContextWindowOptions,
  type CodexWindowCatalog,
  emptyCodexWindowCatalog
} from './codex-catalog'
import { record, stringValue } from './codex-values'

/** Codex provider catalog discovery, model mapping, and thinking presets. */

export const THINKING_PRESETS: ThinkingPreset[] = [
  { id: 'minimal', label: 'Minimal', description: 'Minimum reasoning effort' },
  { id: 'low', label: 'Low', description: 'Low reasoning effort' },
  { id: 'medium', label: 'Medium', description: 'Moderate reasoning effort' },
  { id: 'high', label: 'High', description: 'High reasoning effort' },
  {
    id: 'xhigh',
    label: 'Extra high',
    description: 'Extra-high effort; uses significantly more quota'
  },
  {
    id: 'max',
    label: 'Max · high usage',
    description: 'Maximum effort; uses significantly more quota'
  },
  { id: 'ultra', label: 'Ultra · highest usage', description: 'Ultra effort; uses the most quota' }
]

/** Last-resort catalog for older Codex versions without the app-server model API. */
const CODEX_FALLBACK_MODELS = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']

export function codexThinkingPresets(value: unknown): ThinkingPreset[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const presets: ThinkingPreset[] = []
  for (const option of value) {
    const entry = record(option)
    const effort =
      stringValue(entry?.['reasoningEffort']) ?? stringValue(entry?.['reasoning_effort'])
    if (!effort) continue
    const knownPreset = THINKING_PRESETS.find((preset) => preset.id === effort)
    presets.push({
      id: effort,
      label: knownPreset?.label ?? humanizeCodexLabel(effort),
      ...((stringValue(entry?.['description']) ?? knownPreset?.description)
        ? { description: stringValue(entry?.['description']) ?? knownPreset?.description }
        : {})
    })
  }
  return presets.length > 0 ? presets : undefined
}

function humanizeCodexLabel(value: string): string {
  return value.replace(/[-_]+/gu, ' ').replace(/\b\w/gu, (character) => character.toUpperCase())
}

export function codexInputModalities(model: Record<string, unknown>): string[] | undefined {
  const raw = model['inputModalities'] ?? model['input_modalities']
  if (!Array.isArray(raw)) return undefined
  return raw.filter((value): value is string => typeof value === 'string')
}

export function codexModelSupportsAttachments(model: Record<string, unknown>): boolean {
  const inputModalities = codexInputModalities(model)
  if (inputModalities !== undefined) {
    return inputModalities.some((modality) => modality.toLowerCase() === 'image')
  }
  const capabilities = record(model['capabilities'])
  const explicitVision = capabilities?.['vision'] ?? capabilities?.['attachment']
  return typeof explicitVision === 'boolean' ? explicitVision : true
}

export function mapCodexModel(
  value: unknown,
  windows: CodexWindowCatalog = emptyCodexWindowCatalog()
): ProviderModel | null {
  const model = record(value)
  if (!model) return null
  const id = stringValue(model?.['id']) ?? stringValue(model?.['model'])
  if (!id || model?.['hidden'] === true) return null
  const serviceTiers = Array.isArray(model?.['serviceTiers']) ? model['serviceTiers'] : []
  const additionalSpeedTiers = Array.isArray(model?.['additionalSpeedTiers'])
    ? model['additionalSpeedTiers']
    : []
  const thinkingPresets = codexThinkingPresets(model?.['supportedReasoningEfforts'])
  // The context window is Codex's own: app-server model/list carries none, so it
  // comes from Codex's catalog and never from a guessed or pricing-derived
  // figure. A model Codex does not describe gets no window to choose from.
  const window = windows.get(id)
  const options = codexContextWindowOptions(window)
  return {
    id,
    providerId: 'openai',
    name: stringValue(model?.['displayName']) ?? stringValue(model?.['model']) ?? id,
    reasoning: thinkingPresets !== undefined,
    thinkingPresets,
    attachment: codexModelSupportsAttachments(model),
    toolcall: true,
    ...(window === undefined ? {} : { contextWindow: window.defaultWindow }),
    ...(options.length === 0 ? {} : { contextWindows: options }),
    ultrafastSupported:
      additionalSpeedTiers.includes('ultrafast') ||
      serviceTiers.some((tier) => stringValue(record(tier)?.['id']) === 'ultrafast'),
    fastSupported:
      additionalSpeedTiers.includes('fast') ||
      serviceTiers.some((tier) => stringValue(record(tier)?.['id']) === 'priority')
  }
}

export function fallbackCodexModels(
  windows: CodexWindowCatalog = emptyCodexWindowCatalog()
): ProviderModel[] {
  return CODEX_FALLBACK_MODELS.map((id) => {
    const window = windows.get(id)
    const options = codexContextWindowOptions(window)
    return {
      id,
      providerId: 'openai',
      name: id,
      reasoning: true,
      thinkingPresets: THINKING_PRESETS,
      attachment: true,
      toolcall: true,
      fastSupported: false,
      ...(window === undefined ? {} : { contextWindow: window.defaultWindow }),
      ...(options.length === 0 ? {} : { contextWindows: options })
    }
  })
}
