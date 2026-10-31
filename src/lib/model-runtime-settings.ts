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

/**
 * Harnesses that state a model's properties per account rather than app-wide.
 *
 * Codex answers `debug models` from the account's own `CODEX_HOME`, so the same
 * model slug reports different context windows for different accounts. A
 * catalog merged across accounts therefore cannot describe any one of them, and
 * every surface has to read the account's own answer instead.
 */
export function modelPropertiesAreAccountScoped(harnessId: string, providerId: string): boolean {
  return harnessId === 'codex' && providerId === 'openai'
}

/**
 * Every window a model can run with, its own default first when the harness
 * states one. `contextWindows` is the harness's option list; a model that only
 * reports a single window answers with that one.
 */
export function modelContextWindowOptions(
  model: Pick<ProviderModel, 'contextWindow' | 'contextWindows'> | undefined
): number[] {
  if (!model) return []
  if (model.contextWindows && model.contextWindows.length > 0) return model.contextWindows
  return model.contextWindow === undefined ? [] : [model.contextWindow]
}

/**
 * Whether the model states more than one window, so there is a window to pick.
 *
 * A single window is the model's own metric, not a choice: menus load real
 * limits from model metadata, so almost every model reports one, and offering
 * that lone value as a control is a menu with nothing to decide.
 */
export function modelOffersContextWindowChoice(
  model: Pick<ProviderModel, 'contextWindow' | 'contextWindows'> | undefined
): boolean {
  return modelContextWindowOptions(model).length > 1
}

/**
 * A stored window survives only while the model still offers it. Anything else
 * belongs to a model (or an account) the user has already left.
 */
export function offeredContextWindow(
  model: Pick<ProviderModel, 'contextWindow' | 'contextWindows'> | undefined,
  contextWindow: number | undefined
): number | undefined {
  if (contextWindow === undefined) return undefined
  return modelContextWindowOptions(model).includes(contextWindow) ? contextWindow : undefined
}

/**
 * The window a turn actually runs with: the offered choice, else the model's own
 * default. This is the one rule every reader shares   the meter, the context
 * dropdown, the composer preview, and the send path.
 */
export function effectiveModelContextWindow(
  model: Pick<ProviderModel, 'contextWindow' | 'contextWindows'> | undefined,
  contextWindow: number | undefined
): number | undefined {
  return (
    offeredContextWindow(model, contextWindow) ??
    model?.contextWindow ??
    modelContextWindowOptions(model)[0]
  )
}

/** Whether the selected model can render the shared runtime settings menu. */
export function hasModelRuntimeSettings(
  model: ProviderModel | undefined,
  harnessId: string,
  providerId: string
): boolean {
  return (
    model?.fastSupported === true ||
    (modelPropertiesAreAccountScoped(harnessId, providerId) &&
      model?.ultrafastSupported === true) ||
    modelOffersContextWindowChoice(model)
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
      modelPropertiesAreAccountScoped(harnessId, providerId) &&
      model?.ultrafastSupported === true)
      ? speed
      : 'normal'
  return { inferenceMode, contextWindow: offeredContextWindow(model, defaults.contextWindow) }
}
