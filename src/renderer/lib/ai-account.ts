import { normalizeFastInference, supportsFastInference } from '$shared/fast-inference'
import type { ProviderCatalog, ThreadSettings } from '$shared/types'

/**
 * First-run AI account state.
 *
 * Pi and OpenCode publish only the providers the user holds credentials for, so
 * an empty catalog for those harnesses means "no AI account connected". The
 * send-time setup card, the model picker's empty state, and the send guard all
 * ask the same question here instead of re-deriving it.
 */

/** True when a catalog can actually run a turn. */
function catalogRuns(provider: ProviderCatalog): boolean {
  // `unavailable` means the harness could not report its models, not that the
  // user has no account, so it must never read as "nothing connected".
  return provider.models.length > 0 || provider.catalogStatus === 'unavailable'
}

/** Catalogs the harness reports for this project. */
export function harnessCatalogs(
  providers: ProviderCatalog[],
  harnessId: string
): ProviderCatalog[] {
  return providers.filter((provider) => provider.harnessId === harnessId)
}

/** True when the harness has at least one provider it can run a turn on. */
export function harnessHasProvider(providers: ProviderCatalog[], harnessId: string): boolean {
  return harnessCatalogs(providers, harnessId).some(catalogRuns)
}

/** True when the selected model still exists in the harness's own catalogs. */
export function selectedModelExists(
  providers: ProviderCatalog[],
  settings: Pick<ThreadSettings, 'harnessId' | 'providerId' | 'modelId'>
): boolean {
  if (!settings.modelId) return false
  return harnessCatalogs(providers, settings.harnessId).some((provider) =>
    provider.models.some((model) => model.id === settings.modelId)
  )
}

/** Which model a picker selection points the thread at. */
export interface ModelSelection {
  harnessId: string
  providerId: string
  modelId: string
  accountId?: string
}

/**
 * Apply a model-picker selection to thread settings. Fast inference survives
 * the switch only when the newly selected model exposes a fast tier.
 */
export function withModelSelection(
  settings: ThreadSettings,
  providers: ProviderCatalog[],
  selection: ModelSelection
): ThreadSettings {
  const harnessId = selection.harnessId || settings.harnessId
  const selected = providers
    .find((provider) => provider.harnessId === harnessId && provider.id === selection.providerId)
    ?.models.find((model) => model.id === selection.modelId)
  return normalizeFastInference(
    {
      ...settings,
      harnessId,
      accountId: selection.accountId,
      providerId: selection.providerId,
      modelId: selection.modelId
    },
    harnessId,
    selection.providerId,
    selection.modelId,
    supportsFastInference(harnessId, selection.providerId, selected?.fastSupported)
  )
}
