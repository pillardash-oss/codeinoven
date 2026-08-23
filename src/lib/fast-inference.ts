import type { InferenceMode, ThreadSettings } from './types'

/**
 * Display metadata for a fast-inference variant.
 *
 * Availability is NOT decided here — it comes from the harness catalog
 * (`ProviderModel.fastSupported`), so opencode shows the picker for any model
 * whose catalog lists a `*-fast` sibling and auto-hides it when the vendor
 * deprecates the fast tier. This module only resolves the display label and
 * the approximate usage multiplier, plus the opencode `*-fast` model-id swap.
 */
export interface FastInferenceVariant {
  /** Human label for the fast variant, e.g. "Claude Opus 4.8 Fast". */
  label: string
  /** Approximate usage multiplier relative to the base model. */
  multiplier: number
}

const FAST_SUFFIX = '-fast'

/**
 * Known usage multipliers, keyed by base model id. Values are approximate and
 * only used for display; unknown base models fall back to a default. Add an
 * entry when a vendor ships a new fast tier so the picker shows its cost.
 */
const FAST_MULTIPLIERS: Record<string, number> = {
  'claude-opus-4-8': 2.5,
  'claude-opus-5': 2.5,
  'gpt-5.4': 1.5,
  'gpt-5.6-sol': 2.5,
  'gpt-5.6-codex': 2.5,
  'gpt-5.5-codex': 2.5
}

const DEFAULT_MULTIPLIER = 2

/** Native provider behind each CLI's harness-level fast inference switch. */
const FAST_HARNESS_PROVIDERS: Record<string, string> = {
  codex: 'openai',
  'claude-code': 'anthropic'
}

/** Whether the composer can offer fast inference for this harness/model pair. */
export function supportsFastInference(
  harnessId: string,
  providerId: string,
  modelFastSupported?: boolean
): boolean {
  if (modelFastSupported !== undefined) return modelFastSupported
  return FAST_HARNESS_PROVIDERS[harnessId] === providerId
}

/** Claude Code preserves a supported pinned Opus model; aliases select its current fast Opus. */
export function fastSelectionModelId(harnessId: string, modelId: string): string {
  if (harnessId !== 'claude-code') return modelId
  return modelId === 'opus' || modelId.startsWith('claude-opus-') ? modelId : 'opus'
}

/** True when the given model id is a fast variant (ends in `-fast`). */
export function isFastModel(modelId: string): boolean {
  return modelId.endsWith(FAST_SUFFIX)
}

/** Base model id behind a fast variant id (strips the `-fast` suffix). */
export function fastBaseModelId(modelId: string): string {
  return isFastModel(modelId) ? modelId.slice(0, -FAST_SUFFIX.length) : modelId
}

/** Approximate usage multiplier for a model id (base or fast variant). */
export function fastMultiplierFor(modelId: string): number {
  return FAST_MULTIPLIERS[fastBaseModelId(modelId)] ?? DEFAULT_MULTIPLIER
}

/** Display metadata for a fast model id, when it is a known fast variant. */
export function fastVariantForModelId(modelId: string): FastInferenceVariant | null {
  if (!isFastModel(modelId)) return null
  return {
    label: `${humanizeModelId(fastBaseModelId(modelId))} Fast`,
    multiplier: fastMultiplierFor(modelId)
  }
}

/**
 * Force `inferenceMode` back to `normal` whenever the newly selected model
 * cannot run fast inference. Model switches across operators (composer picker,
 * provider-error card, audit/spec cards, worker settings) all commit settings
 * independently, so a harness-safe fast mode for one model must never leak
 * into a subsequent model that has no fast tier — otherwise the resolved
 * `*-fast` model id targets a model that does not exist.
 */
export function normalizeFastInference(
  settings: ThreadSettings,
  harnessId: string,
  providerId: string,
  modelId: string,
  modelFastSupported?: boolean
): ThreadSettings {
  if (settings.inferenceMode !== 'fast') return settings
  if (supportsFastInference(harnessId, providerId, modelFastSupported)) return settings
  return { ...settings, inferenceMode: 'normal' }
}

/**
 * Model id actually sent to the harness for the given inference mode. Fast
 * inference appends the opencode `*-fast` suffix; anything else (including a
 * model that is already a fast variant) passes through unchanged.
 */
export function resolveFastModelId(
  modelId: string,
  inferenceMode: InferenceMode | undefined
): string {
  if (inferenceMode !== 'fast') return modelId
  return isFastModel(modelId) ? modelId : `${modelId}${FAST_SUFFIX}`
}

function humanizeModelId(id: string): string {
  return id.replace(/[-_]+/gu, ' ').replace(/\b\w/gu, (char) => char.toUpperCase())
}
