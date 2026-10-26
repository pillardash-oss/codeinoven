import type { ProviderCatalog, ProviderModel } from '$shared/types'
import {
  effectiveModelContextWindow,
  modelContextWindowOptions,
  modelPropertiesAreAccountScoped,
  offeredContextWindow
} from '$shared/model-runtime-settings'
import { providerCatalog } from './provider-catalog.svelte'

/**
 * How old an account's own model properties may be before a thread re-reads
 * them. They change only when the harness ships a new catalog, so the answer is
 * reused across mounts instead of spawning the CLI for every thread open.
 */
const MODEL_CONTEXT_MAX_AGE_MS = 5 * 60 * 1000

/** Which model, on which account, a surface is asking about. */
export interface ModelRuntimeSelection {
  projectId?: string | null
  harnessId: string
  providerId: string
  modelId: string
  accountId?: string
}

/**
 * One reading of a model's own properties, shared by every surface that shows
 * or applies them.
 *
 * Context windows are stated by the harness, not by the app, and Codex states
 * them per account: the same model slug can offer 500k on one account and 272k
 * on another. Reading the account-agnostic catalog therefore produced a window
 * from whichever account was probed last   the battery showed 100% over a 272k
 * window on a thread whose account states 500k. Every consumer resolves through
 * this reading instead, so the meter, the dropdown, the selected value, and the
 * send path describe the same model.
 */
export interface ModelRuntime {
  /** Catalog entry: name, thinking presets, vision, and speed support. */
  model?: ProviderModel
  /** Windows the selected account's model offers. Empty until that read lands. */
  contextWindows: number[]
  /** The model's own default window, as the selected account states it. */
  defaultContextWindow?: number
  /** The stored choice, kept only while the model offers it. */
  contextWindowOverride?: number
  /** The window this thread's turns run with. */
  contextWindow?: number
}

/** The catalog entry for a selection, preferring the exact harness provider. */
function findModel(
  catalogs: readonly ProviderCatalog[],
  selection: ModelRuntimeSelection
): ProviderModel | undefined {
  const provider =
    catalogs.find(
      (catalog) => catalog.harnessId === selection.harnessId && catalog.id === selection.providerId
    ) ?? catalogs.find((catalog) => catalog.id === selection.providerId)
  return (
    provider?.models.find((model) => model.id === selection.modelId) ??
    catalogs.flatMap((catalog) => catalog.models).find((model) => model.id === selection.modelId)
  )
}

class ModelRuntimeStore {
  /**
   * Resolve a selection into the single reading every surface consumes.
   *
   * `storedContextWindow` is the thread's own choice. It is reported back only
   * while the model offers it, so a value left over from another model or
   * account can never drive the meter or the turn.
   */
  resolve(
    selection: ModelRuntimeSelection,
    catalogs: readonly ProviderCatalog[],
    storedContextWindow?: number
  ): ModelRuntime {
    const model = findModel(catalogs, selection)
    const live =
      selection.projectId && selection.modelId
        ? providerCatalog.modelContext(
            selection.projectId,
            selection.harnessId,
            selection.providerId,
            selection.modelId,
            selection.accountId
          )
        : undefined
    const accountScoped = modelPropertiesAreAccountScoped(selection.harnessId, selection.providerId)
    // An account-scoped harness answers per account, so a model whose properties
    // have not been read yet states no window at all instead of inheriting
    // another account's.
    const properties = accountScoped ? live : (live ?? model)
    const contextWindows = modelContextWindowOptions(properties)
    const defaultContextWindow = properties?.contextWindow ?? contextWindows[0]
    const contextWindowOverride = offeredContextWindow(
      { contextWindow: defaultContextWindow, contextWindows },
      storedContextWindow
    )
    return {
      model,
      contextWindows,
      defaultContextWindow,
      contextWindowOverride,
      contextWindow: effectiveModelContextWindow(
        { contextWindow: defaultContextWindow, contextWindows },
        storedContextWindow
      )
    }
  }

  /**
   * Read the selected account's properties the moment a selection lands, so no
   * surface keeps showing a value the model no longer states. Deduplicated by
   * the catalog store, and skipped for harnesses whose properties are app-wide.
   */
  ensure(selection: ModelRuntimeSelection): void {
    const projectId = selection.projectId
    if (!projectId || !selection.modelId) return
    if (!modelPropertiesAreAccountScoped(selection.harnessId, selection.providerId)) return
    void providerCatalog.refreshModelContext(
      projectId,
      selection.harnessId,
      selection.providerId,
      selection.modelId,
      selection.accountId,
      MODEL_CONTEXT_MAX_AGE_MS
    )
  }
}

export const modelRuntime = new ModelRuntimeStore()
