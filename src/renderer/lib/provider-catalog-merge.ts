import type { ProviderCatalog } from '$shared/types'

/**
 * Merge catalog snapshots without allowing a partial/stale model record to
 * erase optional capability metadata discovered by another snapshot.
 *
 * Provider catalogs arrive from several places during startup: the local
 * mirror, the main-process snapshot, the component prop, and a live driver
 * refresh. Thinking presets are optional, so an older record that omits them
 * must not hide presets already reported by another record.
 *
 * The last merge this window computed, so the same inputs are not merged twice.
 *
 * Both model pickers and the composer merge catalogs inside derived values, which
 * re-evaluate whenever anything they touch changes - and a thread switch touches
 * everything. The merge clones every provider and every model into fresh maps,
 * and on a real account it measured 18-54 ms per click, again and again, over
 * inputs that had not moved: the catalogs are replaced, never mutated, so the
 * same object references mean the same catalog.
 *
 * The cache holds the merged result and hands out a copy of the outer array,
 * because callers push their custom providers onto what comes back and a shared
 * array would collect them again on every call.
 */
let lastMergeInputs: readonly ProviderCatalog[] | null = null
let lastMergeOutput: readonly ProviderCatalog[] | null = null

function sameInputs(
  previous: readonly ProviderCatalog[],
  next: readonly ProviderCatalog[]
): boolean {
  if (previous.length !== next.length) return false
  for (let index = 0; index < next.length; index++) {
    if (previous[index] !== next[index]) return false
  }
  return true
}

export function mergeProviderCatalogEntries(catalogs: ProviderCatalog[]): ProviderCatalog[] {
  if (
    lastMergeInputs !== null &&
    lastMergeOutput !== null &&
    sameInputs(lastMergeInputs, catalogs)
  ) {
    return [...lastMergeOutput]
  }
  const merged = mergeCatalogSnapshots(catalogs)
  lastMergeInputs = [...catalogs]
  lastMergeOutput = merged
  return [...merged]
}

function mergeCatalogSnapshots(catalogs: ProviderCatalog[]): ProviderCatalog[] {
  // This is a local computation, not application state. Using SvelteMap here
  // makes every merge write reactive signals while ModelPicker/ChatComposer
  // are evaluating their derived values, which can cascade into a long flush.
  const merged = new Map<string, ProviderCatalog>()
  for (const catalog of catalogs) {
    const key = `${catalog.harnessId}:${catalog.id}`
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, { ...catalog, models: [...catalog.models] })
      continue
    }

    const models = new Map(
      existing.models.map((model) => [`${model.providerId}:${model.id}`, model])
    )
    for (const model of catalog.models) {
      const modelKey = `${model.providerId}:${model.id}`
      const prior = models.get(modelKey)
      const mergedModel = { ...prior, ...model }
      if (model.thinkingPresets === undefined && prior?.thinkingPresets !== undefined) {
        mergedModel.thinkingPresets = prior.thinkingPresets
      }
      models.set(modelKey, mergedModel)
    }
    existing.models = [...models.values()]
  }
  return [...merged.values()]
}
