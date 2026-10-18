import type { ModelRuntimeSettings, ProviderModel } from './types'

/**
 * Sanity bounds for a stored context window. Which windows a model can actually
 * run with is the harness's own catalog's business (Codex states its windows
 * through `codex debug models`), so these bounds only reject values no harness
 * could mean: a picked window is never re-derived, rounded, or replaced here.
 */
export const MIN_CONTEXT_WINDOW = 100_000
export const MAX_CONTEXT_WINDOW = 4_000_000

export function isPlausibleContextWindow(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_CONTEXT_WINDOW &&
    value <= MAX_CONTEXT_WINDOW
  )
}

/** Shared validation for persisted role selections and thread overrides. */
export function validateModelRuntimeSettings(
  input: { inferenceMode?: unknown; contextWindow?: unknown },
  label = 'Model'
): ModelRuntimeSettings {
  const inferenceMode = input.inferenceMode
  const contextWindow = input.contextWindow
  if (
    inferenceMode !== undefined &&
    inferenceMode !== 'normal' &&
    inferenceMode !== 'fast' &&
    inferenceMode !== 'ultrafast'
  ) {
    throw new TypeError(`${label} speed is invalid`)
  }
  if (contextWindow !== undefined && !isPlausibleContextWindow(contextWindow)) {
    throw new TypeError(`${label} context window is invalid`)
  }
  return {
    ...(inferenceMode === undefined ? {} : { inferenceMode }),
    ...(contextWindow === undefined ? {} : { contextWindow })
  }
}

/** Whether the selected model can render the shared runtime settings menu. */
export function hasModelRuntimeSettings(
  model: ProviderModel | undefined,
  harnessId: string,
  providerId: string
): boolean {
  return (
    model?.fastSupported === true ||
    (harnessId === 'codex' && providerId === 'openai' && model?.ultrafastSupported === true) ||
    (model?.contextWindows?.length ?? 0) > 0
  )
}

/** Apply saved defaults only where the chosen model advertises support. */
export function resolveModelRuntimeDefaults(
  defaults: ModelRuntimeSettings,
  model: ProviderModel | undefined,
  harnessId: string,
  providerId: string
): ModelRuntimeSettings {
  const speed = defaults.inferenceMode
  const inferenceMode =
    speed === 'normal' ||
    (speed === 'fast' && model?.fastSupported === true) ||
    (speed === 'ultrafast' &&
      harnessId === 'codex' &&
      providerId === 'openai' &&
      model?.ultrafastSupported === true)
      ? speed
      : 'normal'
  const contextWindow =
    defaults.contextWindow !== undefined && model?.contextWindows?.includes(defaults.contextWindow)
      ? defaults.contextWindow
      : undefined
  return { inferenceMode, contextWindow }
}
