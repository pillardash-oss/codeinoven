import { APP_SLUG } from '$shared/brand'

const STORAGE_KEY = `${APP_SLUG}.assistantTabOrder.v1`

/** The two halves of the assistant header strip: the pinned tabs the user chose,
 *  and the rest of the assistant's threads. They never mix, so each keeps its
 *  own arrangement. */
export type AssistantTabGroup = 'pinned' | 'open'

type StoredOrder = Record<AssistantTabGroup, string[]>

const EMPTY: readonly string[] = []

function emptyOrder(): StoredOrder {
  return { pinned: [], open: [] }
}

/** Keep only the ids a previous arrangement can still name, so a corrupt or
 *  half-written entry can never reorder the strip. */
function readIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const ids: string[] = []
  for (const entry of value) if (typeof entry === 'string') ids.push(entry)
  return ids
}

function loadOrders(): Record<string, StoredOrder> {
  const orders: Record<string, StoredOrder> = {}
  if (typeof window === 'undefined') return orders
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return orders
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return orders
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === null || typeof value !== 'object') continue
      const record = value as Record<string, unknown>
      orders[key] = { pinned: readIds(record.pinned), open: readIds(record.open) }
    }
    return orders
  } catch {
    return orders
  }
}

/**
 * The order the user dragged the assistant header's tabs into.
 *
 * A drag is a choice, so it outlives the recency sort the strip falls back to:
 * the arrangement is stored per assistant and per group in localStorage, and a
 * thread the arrangement has never seen (a new task, a fresh pin) is shown ahead
 * of it rather than buried at the end. The strip narrows this to the tabs it
 * draws; nothing else in the app reads a thread's position from here.
 */
class AssistantTabOrderState {
  #orders = $state<Record<string, StoredOrder>>(loadOrders())

  /** The stored arrangement of one group, oldest choice first. */
  orderFor(key: string, group: AssistantTabGroup): readonly string[] {
    return this.#orders[key]?.[group] ?? EMPTY
  }

  /**
   * Record the whole arrangement of one group after a drop.
   *
   * The caller hands over every thread the group holds, not only the tabs on
   * screen, so a drop never loses the threads behind the count: they keep their
   * relative order after the ones the user just placed.
   */
  place(key: string, group: AssistantTabGroup, orderedIds: readonly string[]): void {
    const current = this.#orders[key] ?? emptyOrder()
    if (
      current[group].length === orderedIds.length &&
      current[group].every((id, index) => id === orderedIds[index])
    ) {
      return
    }
    this.#orders = {
      ...this.#orders,
      [key]: { ...current, [group]: [...orderedIds] }
    }
    this.persist()
  }

  private persist(): void {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.#orders))
    } catch {
      // The arrangement is a preference; unavailable storage must not break the UI.
    }
  }
}

export const assistantTabOrder = new AssistantTabOrderState()
