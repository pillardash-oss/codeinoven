/// <reference types="vite/client" />

import type {
  BaseUrlProvider,
  BaseUrlProviderCreateRequest,
  BaseUrlProviderModel,
  BaseUrlProviderUpdateRequest,
  ThinkingLevel
} from '$shared/types'
import { invoke } from '$lib/ipc.svelte'
import { providerCatalog } from '$lib/stores/provider-catalog.svelte'

/**
 * Reactive store for custom base-URL providers.
 *
 * Mirrors the main-process {@link BaseUrlProviderService} over the typed IPC
 * contract. The renderer never sees plaintext API keys — they are vaulted by
 * main before persistence. CRUD operations optimistically update the local
 * list and roll back on error so the UI stays responsive.
 */
class BaseUrlProviderStore {
  providers = $state<BaseUrlProvider[]>([])
  loading = $state(false)
  saving = $state(false)
  error = $state('')

  /** Fetch every stored provider. Safe to call repeatedly. */
  async load(): Promise<void> {
    this.loading = true
    this.error = ''
    try {
      this.providers = await invoke('baseUrlProviders:list')
      for (const provider of this.providers) providerCatalog.upsertCustomProvider(provider)
    } catch (loadError) {
      this.error = loadError instanceof Error ? loadError.message : 'Failed to load providers.'
    } finally {
      this.loading = false
    }
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
