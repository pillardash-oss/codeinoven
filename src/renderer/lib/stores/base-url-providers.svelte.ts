/// <reference types="vite/client" />

import type {
  BaseUrlProvider,
  BaseUrlProviderCreateRequest,
  BaseUrlProviderFetchModelsRequest,
  BaseUrlProviderModel,
  BaseUrlProviderUpdateRequest,
  BaseUrlProviderUsagePreview,
  BaseUrlProviderUsagePreviewRequest,
  CustomProviderUsage,
  DiscoveredBaseUrlModel,
  ThinkingLevel
} from '$shared/types'
import { invoke } from '$lib/ipc.svelte'
import { providerCatalog } from '$lib/stores/provider-catalog.svelte'
import { registerAppControlRevalidation } from '$lib/app-control/app-control-revalidation'

/** Keep a large custom-provider catalog from monopolizing a renderer turn. */
const CATALOG_SYNC_BATCH_SIZE = 8

/**
 * Reactive store for custom base-URL providers.
 *
 * Mirrors the main-process {@link BaseUrlProviderService} over the typed IPC
 * contract. The renderer never sees plaintext API keys — they are vaulted by
 * main before persistence. CRUD operations optimistically update the local
 * list and roll back on error so the UI stays responsive.
 */
class BaseUrlProviderStore {
  providers = $state.raw<BaseUrlProvider[]>([])
  loading = $state(false)
  saving = $state(false)
  error = $state('')
  /** Whether a full list read has completed in this window, so a revalidation
   *  knows these records are actually on screen somewhere. */
  private loaded = false

  /** Fetch every stored provider. Safe to call repeatedly. */
  async load(): Promise<void> {
    this.loading = true
    this.error = ''
    try {
      this.providers = await invoke('baseUrlProviders:list')
      this.loaded = true
      for (const [index, provider] of this.providers.entries()) {
        providerCatalog.upsertCustomProvider(provider)
        if ((index + 1) % CATALOG_SYNC_BATCH_SIZE === 0 && index < this.providers.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 0))
        }
      }
    } catch (loadError) {
      this.error = loadError instanceof Error ? loadError.message : 'Failed to load providers.'
    } finally {
      this.loading = false
    }
  }

  /** Re-read the providers only if this window already holds them. */
  async reloadIfLoaded(): Promise<void> {
    if (!this.loaded) return
    await this.load()
  }

  /** Create a new provider. Returns the persisted provider on success. */
  async create(input: BaseUrlProviderCreateRequest): Promise<BaseUrlProvider> {
    this.saving = true
    try {
      const created = await invoke('baseUrlProviders:create', input)
      this.providers = [...this.providers, created]
      providerCatalog.upsertCustomProvider(created)
      return created
    } finally {
      this.saving = false
    }
  }

  /** Update an existing provider by id. */
  async update(
    harnessId: string,
    id: string,
    patch: BaseUrlProviderUpdateRequest
  ): Promise<BaseUrlProvider> {
    this.saving = true
    try {
      const updated = await invoke('baseUrlProviders:update', harnessId, id, patch)
      this.providers = this.providers.map((provider) =>
        provider.harnessId === updated.harnessId && provider.id === updated.id ? updated : provider
      )
      providerCatalog.upsertCustomProvider(updated)
      return updated
    } finally {
      this.saving = false
    }
  }

  /** Delete a provider by id. Silently clears the list entry on success. */
  async remove(harnessId: string, id: string): Promise<void> {
    this.saving = true
    try {
      const removed = this.providers.find(
        (provider) => provider.harnessId === harnessId && provider.id === id
      )
      await invoke('baseUrlProviders:delete', harnessId, id)
      this.providers = this.providers.filter(
        (provider) => provider.harnessId !== harnessId || provider.id !== id
      )
      if (removed) providerCatalog.removeCustomProvider(removed.harnessId, removed.id)
    } finally {
      this.saving = false
    }
  }

  /** Discover models from `${baseURL}/models`, cached in main for 24 hours.
   *  Pass `force: true` (the picker's refresh button) to bypass the cache. */
  async fetchModels(request: BaseUrlProviderFetchModelsRequest): Promise<DiscoveredBaseUrlModel[]> {
    return invoke('baseUrlProviders:fetchModels', request)
  }

  /** Read a saved provider's account status/usage route. Null when the
   *  provider declares no route or the route yields nothing usable. */
  async fetchUsage(harnessId: string, id: string): Promise<CustomProviderUsage | null> {
    return invoke('baseUrlProviders:fetchUsage', harnessId, id)
  }

  /** Read a usage route for the provider being edited, before it is saved. */
  async previewUsage(
    request: BaseUrlProviderUsagePreviewRequest
  ): Promise<BaseUrlProviderUsagePreview> {
    return invoke('baseUrlProviders:previewUsage', request)
  }

  /** The stored custom model backing a harness catalog entry, if any. */
  modelFor(
    harnessId: string,
    providerId: string,
    modelId: string
  ): BaseUrlProviderModel | undefined {
    return this.providers
      .find((provider) => provider.harnessId === harnessId && provider.id === providerId)
      ?.models.find((model) => model.id === modelId)
  }

  /** Default thinking level a custom model declares, when it does. */
  defaultThinkingLevel(
    harnessId: string,
    providerId: string,
    modelId: string
  ): ThinkingLevel | undefined {
    return this.modelFor(harnessId, providerId, modelId)?.defaultThinkingLevel
  }
}

export const baseUrlProviderStore = new BaseUrlProviderStore()

// A provider added, edited or deleted through app control wrote the record in
// main without going through this store, so the Providers panel keeps the list
// it read on mount and its models stay out of the catalog.
registerAppControlRevalidation({
  channels: ['baseUrlProviders:'],
  refresh: () => baseUrlProviderStore.reloadIfLoaded()
})
