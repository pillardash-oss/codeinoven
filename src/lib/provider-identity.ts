import type { ProviderCatalog, ProviderModel } from './types'

/**
 * Which catalog provider a model ran through, as pure functions.
 *
 * Provider ids are only unique inside a harness: `anthropic` is a provider under
 * `claude-code` and again under `pi`, `openai` under `codex` and again under
 * `opencode`, and every harness also carries the same custom base-URL provider
 * ids. Model ids are not unique either, because one model is routinely offered
 * by several providers (`minimax/minimax-m2.7-free` through two gateways).
 *
 * So a lookup that matches a provider id alone, or worse a model id alone, can
 * answer with another harness's or another vendor's provider. Every surface that
 * draws a provider's name or brand therefore resolves through here, which asks
 * for the harness first and refuses to guess when only the model is known and
 * more than one provider offers it.
 */

/** What a surface knows about the model it has to attribute to a provider. */
export interface ProviderLookup {
  /** Provider id recorded with the selection or message, when recorded. */
  providerId?: string | null
  /** Harness the selection or message ran through, when known. */
  harnessId?: string | null
  /** Model id, used only to disambiguate providers that share an id. */
  modelId?: string | null
}

function ownsModel(provider: ProviderCatalog, modelId: string, providerId?: string): boolean {
  return provider.models.some(
    (model) => model.id === modelId && (providerId === undefined || model.providerId === providerId)
  )
}

/**
 * The provider a selection ran through.
 *
 * `undefined` means the catalog cannot say which provider it was, which callers
 * render as no brand at all: showing another provider's mark is the bug this
 * exists to prevent, and a missing mark is the honest answer.
 */
export function resolveModelProvider(
  providers: readonly ProviderCatalog[],
  lookup: ProviderLookup
): ProviderCatalog | undefined {
  const providerId = lookup.providerId?.trim() || undefined
  const harnessId = lookup.harnessId?.trim() || undefined
  const modelId = lookup.modelId?.trim() || undefined

  if (providerId) {
    const sameId = providers.filter((provider) => provider.id === providerId)
    if (sameId.length > 0) {
      // Same id across harnesses carries the same brand, so it only narrows when
      // the harness is known; the model then picks between accounts of that id.
      const scoped = harnessId
        ? sameId.filter((provider) => provider.harnessId === harnessId)
        : sameId
      const candidates = scoped.length > 0 ? scoped : sameId
      if (modelId) {
        const owning = candidates.find((provider) => ownsModel(provider, modelId, providerId))
        if (owning) return owning
      }
      return candidates[0]
    }
    if (!modelId) return undefined
    // The provider left the catalog. A model entry naming this provider is the
    // only evidence binding the two, so nothing else may stand in for it.
    return providers.find((provider) => ownsModel(provider, modelId, providerId))
  }

  if (!modelId) return undefined
  const owners = providers.filter((provider) => ownsModel(provider, modelId))
  // One provider, one brand. Several providers offering the same model means the
  // record lost which one it used, and any pick would borrow another's mark.
  return owners.length === 1 ? owners[0] : undefined
}

/** The catalog entry for a model of a resolved provider, when it still lists it. */
export function providerModel(
  provider: ProviderCatalog | undefined,
  modelId: string | null | undefined
): ProviderModel | undefined {
  if (!provider || !modelId) return undefined
  return provider.models.find((model) => model.id === modelId)
}

/**
 * The catalog entry that describes a model of a known provider.
 *
 * A model id alone does not identify an entry, because several providers list
 * the same model under their own name. The provider decides, and when it is
 * unknown the entry is only used if every provider listing the model calls it
 * the same thing, so a display name is never borrowed from another provider.
 */
export function catalogModelEntry(
  models: readonly ProviderModel[],
  lookup: ProviderLookup
): ProviderModel | undefined {
  const modelId = lookup.modelId?.trim()
  if (!modelId) return undefined
  const providerId = lookup.providerId?.trim() || undefined
  if (providerId) return models.find((m) => m.id === modelId && m.providerId === providerId)
  const candidates = models.filter((m) => m.id === modelId)
  return new Set(candidates.map((m) => m.name)).size === 1 ? candidates[0] : undefined
}
