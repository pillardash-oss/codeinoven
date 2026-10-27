import { APP_SLUG } from '$shared/brand'
import type { ProviderCatalog } from '$shared/types'

const STORAGE_KEY = `${APP_SLUG}.modelPickerProviderOrder.v1`

/**
 * Provider groups arranged by the user, keyed by harness.
 *
 * The order is per harness rather than one flat list across every provider: a
 * harness owns its own catalog, and a user who moves OpenCode Go above Anthropic
 * in the Pi picker has said nothing about where Anthropic goes in the Claude
 * Code picker. Each value is the complete set of provider ids that harness had
 * when the user last dragged one, in display order.
 */
type StoredOrders = Record<string, string[]>

/** Where a provider sits in a stored order; providers the order has never seen
 *  rank last, so they keep their catalog position after the ones it names. */
function rankIn(order: readonly string[], providerId: string): number {
  const index = order.indexOf(providerId)
  return index === -1 ? Number.MAX_SAFE_INTEGER : index
}

function parseOrders(raw: string | null): StoredOrders {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const orders: StoredOrders = {}
    for (const [harnessId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (harnessId.length === 0 || !Array.isArray(value)) continue
      const ids = value.filter((id): id is string => typeof id === 'string' && id.length > 0)
      if (ids.length > 0) orders[harnessId] = ids
    }
    return orders
  } catch {
    // A corrupt or unavailable preference must never break the picker.
    return {}
  }
}

function loadOrders(): StoredOrders {
  if (typeof window === 'undefined') return {}
  try {
    return parseOrders(window.localStorage.getItem(STORAGE_KEY))
  } catch {
    return {}
  }
}

/**
 * The order the model picker draws provider groups in.
 *
 * Favorites and Recently used sit above these groups and are never affected: this
 * only changes the order of the provider sections themselves, so a user can put
 * the providers they actually use for the harness they picked at the top.
 *
 * Orders persist app-wide in localStorage, so an arrangement survives closing the
 * picker and restarting the app, and it applies in every picker (the composer, the
 * chats tab, auxiliary agents, and so on) because they all draw the same list.
 */
class ModelPickerProviderOrderState {
  #orders = $state.raw<StoredOrders>(loadOrders())

  /**
   * Apply the stored arrangement to a provider list, leaving untouched providers
   * in the order the catalog reported them.
   *
   * Providers are reordered inside their own harness only: their slots in the flat
   * list are kept, so a list that mixes harnesses still shows each harness as one
   * run. A provider the saved order has never seen (a new connection, or one the
   * catalog only just reported) keeps its catalog position at the end of its
   * harness run rather than being dropped.
   */
  orderProviders(providers: ProviderCatalog[]): ProviderCatalog[] {
    const orders = this.#orders
    if (providers.length < 2) return providers
    const harnesses: string[] = []
    for (const provider of providers) {
      if (!harnesses.includes(provider.harnessId)) harnesses.push(provider.harnessId)
    }
    if (!harnesses.some((harnessId) => (orders[harnessId]?.length ?? 0) > 0)) return providers
    const queues: Record<string, ProviderCatalog[]> = {}
    for (const harnessId of harnesses) {
      const group = providers.filter((provider) => provider.harnessId === harnessId)
      const stored = orders[harnessId] ?? []
      queues[harnessId] =
        stored.length === 0
          ? group
          : [...group].sort((left, right) => rankIn(stored, left.id) - rankIn(stored, right.id))
    }
    const cursors: Record<string, number> = {}
    const ordered: ProviderCatalog[] = []
    for (const provider of providers) {
      const cursor = cursors[provider.harnessId] ?? 0
      cursors[provider.harnessId] = cursor + 1
      ordered.push(queues[provider.harnessId][cursor] ?? provider)
    }
    return ordered
  }

  /**
   * Move one provider group beside another, the arrangement a drag produces.
   *
   * `catalogIds` is every provider id that harness has, not just the ones a search
   * is currently showing, so a drag made while searching still records a complete
   * order instead of silently losing the groups the query filtered out. A move
   * that changes nothing writes nothing.
   */
  moveProvider(
    harnessId: string,
    catalogIds: readonly string[],
    draggedId: string,
    targetId: string,
    position: 'before' | 'after'
  ): void {
    if (draggedId === targetId) return
    const stored = this.#orders[harnessId] ?? []
    const known = stored.filter((id) => catalogIds.includes(id))
    const unseen = catalogIds.filter((id) => !known.includes(id))
    const current = [...known, ...unseen]
    if (!current.includes(draggedId) || !current.includes(targetId)) return
    const next = current.filter((id) => id !== draggedId)
    const at = next.indexOf(targetId)
    if (at === -1) return
    next.splice(position === 'before' ? at : at + 1, 0, draggedId)
    if (next.every((id, index) => id === current[index])) return
    this.#orders = { ...this.#orders, [harnessId]: next }
    this.persist()
  }

  private persist(): void {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.#orders))
    } catch {
      // The arrangement is optional; unavailable storage must not break the picker.
    }
  }
}

export const modelPickerProviderOrder = new ModelPickerProviderOrderState()
