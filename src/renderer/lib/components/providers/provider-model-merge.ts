import type { BaseUrlProviderModel } from '$shared/types'

/** One model as a save request carries it: an id, plus whatever the form set. */
export type ProviderModelDraft = Omit<BaseUrlProviderModel, 'id' | 'providerId'> & { id: string }

/**
 * Keep every model the provider already had, unless the user removed that row.
 *
 * The editor saves the whole model list at once, so a draft seeded before a
 * model was added elsewhere used to write that model away on the next save: two
 * saved models became one, and the one that disappeared was gone from the
 * provider while the picker still offered it. Only pressing a row's remove
 * button is an explicit removal, so everything else the provider holds comes
 * back, with the submitted version winning when both name the same id.
 */
export function mergeSavedProviderModels(
  submitted: readonly ProviderModelDraft[],
  saved: readonly BaseUrlProviderModel[],
  removedIds: ReadonlySet<string>
): ProviderModelDraft[] {
  const submittedIds = new Set(submitted.map((model) => model.id))
  const kept: ProviderModelDraft[] = saved
    .filter((model) => !submittedIds.has(model.id) && !removedIds.has(model.id))
    .map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      ...(model.vision === undefined ? {} : { vision: model.vision }),
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }),
      ...(model.thinkingPresets === undefined ? {} : { thinkingPresets: model.thinkingPresets }),
      ...(model.defaultThinkingLevel === undefined
        ? {}
        : { defaultThinkingLevel: model.defaultThinkingLevel })
    }))
  return [...submitted, ...kept]
}
