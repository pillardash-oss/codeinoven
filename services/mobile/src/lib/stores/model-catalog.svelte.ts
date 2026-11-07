import { api } from '#lib/api/client'
import type { ModelCatalog } from '#lib/api/types'

/**
 * The account's model catalog, read once per app session.
 *
 * The composer needs it before the picker opens: the chip states a model by its
 * name, not by the id the thread stores, and the vendor mark beside it comes from
 * the provider that catalog names. It is a store rather than component state so
 * opening a second conversation costs no second request, and the picker and the
 * chip always read the same list.
 */
class ModelCatalogStore {
  catalog = $state<ModelCatalog | null>(null)
  phase = $state<'idle' | 'loading' | 'ready' | 'error'>('idle')

  /** Read the catalog, or read it again when `force` says the recents changed. */
  async load(force = false): Promise<void> {
    if (!force && this.phase !== 'idle' && this.phase !== 'error') return
    this.phase = 'loading'
    try {
      this.catalog = await api.models()
      this.phase = 'ready'
    } catch {
      this.phase = 'error'
    }
  }
}

export const modelCatalog = new ModelCatalogStore()
