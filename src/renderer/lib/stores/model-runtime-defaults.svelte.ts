import { APP_SLUG } from '$shared/brand'
import { validateModelRuntimeSettings } from '$shared/model-runtime-settings'
import type { InferenceMode, ModelRuntimeSettings } from '$shared/types'

const STORAGE_KEY = `${APP_SLUG}.modelRuntimeDefaults.v1`

function loadDefaults(): ModelRuntimeSettings {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const value: unknown = raw ? JSON.parse(raw) : undefined
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
    return validateModelRuntimeSettings(value as Record<string, unknown>)
  } catch {
    return {}
  }
}

class ModelRuntimeDefaultsStore {
  settings = $state<ModelRuntimeSettings>(loadDefaults())

  private save(settings: ModelRuntimeSettings): void {
    this.settings = settings
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    } catch {
      // Preference storage availability must not interrupt model selection.
    }
  }

  toggleSpeed(inferenceMode: InferenceMode): void {
    this.save({
      ...this.settings,
      inferenceMode: this.settings.inferenceMode === inferenceMode ? undefined : inferenceMode
    })
  }

  toggleContext(contextWindow: number): void {
    this.save({
      ...this.settings,
      contextWindow: this.settings.contextWindow === contextWindow ? undefined : contextWindow
    })
  }
}

export const modelRuntimeDefaults = new ModelRuntimeDefaultsStore()
