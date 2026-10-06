import type { ModelRuntimeSettings, ProviderModel } from './types'

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
  if (
    contextWindow !== undefined &&
    contextWindow !== 200_000 &&
    contextWindow !== 272_000 &&
    contextWindow !== 1_000_000
  ) {
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
  const harnessDefaultWindow =
    harnessId === 'codex' && providerId === 'openai'
      ? model?.contextWindows?.[0]
      : (model?.contextWindow ?? model?.contextWindows?.[0])
  const contextWindow =
    defaults.contextWindow !== undefined &&
    model?.contextWindows?.includes(defaults.contextWindow) &&
    defaults.contextWindow !== harnessDefaultWindow
      ? defaults.contextWindow
      : undefined
  return { inferenceMode, contextWindow }
}
