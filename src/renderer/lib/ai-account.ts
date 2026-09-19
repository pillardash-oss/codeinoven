import type { ProviderCatalog, ThreadSettings } from '$shared/types'

/**
 * First-run AI account state.
 *
 * Pi and OpenCode publish only the providers the user holds credentials for, so
 * an empty catalog for those harnesses means "no AI account connected". The
 * send-time setup card and the model picker's empty state both ask the same
 * question here instead of re-deriving it.
 */

/** The thread settings a runnability check needs. */
type RunnableSettings = Pick<ThreadSettings, 'harnessId' | 'providerId' | 'modelId'>

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

/**
 * True when a thread has nothing to run a turn with, so the send guard shows
 * the setup card instead of handing the driver a turn it can only reject. The
 * card then asks for an account, or for a model, depending on whether the
 * harness reports a provider at all.
 *
 * Only a missing provider or a missing model counts. What the catalogs say
 * about a thread that has both is deliberately not consulted: catalog snapshots
 * lag the harnesses. A Pi thread can run an account whose provider the catalog
 * publishes under another harness, and a CLI accepts model ids its catalog no
 * longer lists, so reading an unresolved id as "nothing connected" blocks sends
 * that work. A turn that truly cannot run reports its own reason through the
 * provider status card, which explains it better than this check can.
 */
export function threadNeedsAiAccount(settings: RunnableSettings): boolean {
  return !settings.providerId || !settings.modelId
}
