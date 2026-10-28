import { APP_SLUG } from '$shared/brand'
import type { ProviderCatalog } from '$shared/types'

const STORAGE_KEY = `${APP_SLUG}.modelPickerProviderOrder.v2`

/**
 * Stable identity of a provider group across catalogs, harnesses and restarts.
 *
 * The harness travels with the provider id because the same provider id can exist
 * under two harnesses (an OpenCode provider and a Pi provider named alike), and a
 * saved arrangement must never move the wrong one.
 */
export function providerOrderKey(provider: ProviderCatalog): string {
  return `${provider.harnessId}:${provider.id}`
}

/**
 * The two arrangements the picker keeps.
 *
 * `all` is the flat order of the picker's All section, where every provider of
 * every harness sits in one list and the user may move a provider above one from
 * another harness. `harnesses` holds an order per harness for when the rail has
 * narrowed the list to a single harness, so arranging that harness's providers
 * leaves the All order alone and vice versa.
 */
interface StoredOrders {
  all: string[]
  harnesses: Record<string, string[]>
}

function parseKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const keys: string[] = []
  for (const candidate of value) {
    if (typeof candidate !== 'string' || !candidate.includes(':')) continue
    if (!keys.includes(candidate)) keys.push(candidate)
  }
  return keys
}

function parseOrders(raw: string | null): StoredOrders {
  if (!raw) return { all: [], harnesses: {} }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { all: [], harnesses: {} }
    }
    const record = parsed as Record<string, unknown>
    const harnesses: Record<string, string[]> = {}
    const storedHarnesses = record['harnesses']
    if (storedHarnesses !== null && typeof storedHarnesses === 'object') {
      for (const [harnessId, value] of Object.entries(storedHarnesses as Record<string, unknown>)) {
        if (harnessId.length === 0) continue
        const keys = parseKeys(value)
        if (keys.length > 0) harnesses[harnessId] = keys
      }
    }
    return { all: parseKeys(record['all']), harnesses }
  } catch {
    // A corrupt or unavailable preference must never break the picker.
    return { all: [], harnesses: {} }
  }
}

function loadOrders(): StoredOrders {
  if (typeof window === 'undefined') return { all: [], harnesses: {} }
  try {
    return parseOrders(window.localStorage.getItem(STORAGE_KEY))
  } catch {
    return { all: [], harnesses: {} }
  }
}

/**
 * Where a provider the saved order has never seen ranks.
 *
 * Providers are ranked by position in the stored order, and one it does not name
 * (a new connection, or a provider the catalog only just reported) keeps its
 * catalog position after the ones it does.
 */
function rankIn(ranks: Record<string, number>, key: string): number {
  return ranks[key] ?? Number.MAX_SAFE_INTEGER
}

/**
 * The order the model picker draws provider groups in.
 *
 * Favorites and Recently used sit above the provider groups and are never part of
 * this: the arrangement only changes where a provider section sits. Two orders are
 * kept because the picker has two shapes: the All section, where every provider of
 * every harness is listed together and any provider may be dragged above any
 * other, and a single-harness section, where only that harness's providers are
 * listed and the user can arrange them for the harness they picked.
 *
 * Orders persist app-wide in localStorage, so an arrangement survives closing the
 * picker and restarting the app, and it applies in every picker (the composer, the
 * chats tab, auxiliary agents, and so on) because they all draw the same list.
 */
class ModelPickerProviderOrderState {
  #all = $state.raw<string[]>(loadOrders().all)
  #harnesses = $state.raw<Record<string, string[]>>(loadOrders().harnesses)

  /**
   * The order in force for one shape of the picker.
   *
   * A harness section with no arrangement of its own falls back to the harness's
   * relative order inside the All section, so the two views agree until the user
   * deliberately gives that harness an order of its own.
   */
  #orderFor(harnessId: string | null): string[] {
    if (harnessId === null) return this.#all
    const stored = this.#harnesses[harnessId]
    if (stored && stored.length > 0) return stored
    const prefix = `${harnessId}:`
    return this.#all.filter((key) => key.startsWith(prefix))
  }

  /**
   * Apply the saved arrangement to a provider list, leaving untouched providers in
   * the order the catalog reported them.
   *
   * `harnessId` selects which arrangement applies: `null` for the All section,
   * the harness id for that harness's own section.
   */
  orderProviders(providers: ProviderCatalog[], harnessId: string | null): ProviderCatalog[] {
    if (providers.length < 2) return providers
    const order = this.#orderFor(harnessId)
    if (order.length === 0) return providers
    const ranks: Record<string, number> = {}
    for (const [index, key] of order.entries()) ranks[key] = index
    return [...providers].sort(
      (left, right) =>
        rankIn(ranks, providerOrderKey(left)) - rankIn(ranks, providerOrderKey(right))
    )
  }

  /**
   * Move one provider group beside another, the arrangement a drag produces.
   *
   * `catalog` is every provider the active section can move, not just the ones a
   * search is currently showing, so a drag made while searching still records a
   * complete arrangement instead of silently losing the groups the query filtered
   * out. A move that changes nothing writes nothing.
   */
  moveProvider(
    harnessId: string | null,
    catalog: readonly ProviderCatalog[],
    draggedKey: string,
    targetKey: string,
    position: 'before' | 'after'
  ): void {
    if (draggedKey === targetKey) return
    const ids = catalog.map(providerOrderKey)
    const stored = this.#orderFor(harnessId)
    const known = stored.filter((key) => ids.includes(key))
    const unseen = ids.filter((key) => !known.includes(key))
    const current = [...known, ...unseen]
    if (!current.includes(draggedKey) || !current.includes(targetKey)) return
    const next = current.filter((key) => key !== draggedKey)
    const at = next.indexOf(targetKey)
    if (at === -1) return
    next.splice(position === 'before' ? at : at + 1, 0, draggedKey)
    if (next.every((key, index) => key === current[index])) return
    if (harnessId === null) this.#all = next
    else this.#harnesses = { ...this.#harnesses, [harnessId]: next }
    this.persist()
  }

  private persist(): void {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ all: this.#all, harnesses: this.#harnesses })
      )
    } catch {
      // The arrangement is optional; unavailable storage must not break the picker.
    }
  }
}

export const modelPickerProviderOrder = new ModelPickerProviderOrderState()
