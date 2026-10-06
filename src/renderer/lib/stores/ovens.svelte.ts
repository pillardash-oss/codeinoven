import { invoke } from '$lib/ipc.svelte'
import { getIconSvgDataUrl } from '$lib/project-svg-icons'
import { getCustomSvgDataUrl } from '$shared/custom-svg'
import {
  LOCAL_OVEN_ID,
  type Oven,
  type OvenHarnessInventoryItem,
  type OvenState
} from '$shared/ovens'

/** One Oven resolved for display: its name plus the mark a row or card shows. */
export interface OvenIdentity {
  id: string
  name: string
  local: boolean
  color: string
  /** Data URL of the Oven's own mark, or null for the Local placeholder. */
  iconUrl: string | null
}

/**
 * The renderer's one answer to "which Oven is this thread on?".
 *
 * The Oven registry is read once and shared by every surface that names an
 * Oven: thread rows, the hover card, and the spotlight results. Callers ask for
 * an identity by id; the store owns resolving an id to the Oven's own name and
 * mark, so the three surfaces can never disagree about it.
 */
class OvenIdentityStore {
  #state = $state.raw<OvenState | null>(null)
  #pending: Promise<OvenState> | null = null
  #inventories = $state.raw<Record<string, OvenHarnessInventoryItem[] | null>>({})
  #inventoryPending = new Map<string, Promise<void>>()

  /** Read the Oven registry once; later callers share the same answer. */
  ensure(): Promise<OvenState> {
    if (this.#state) return Promise.resolve(this.#state)
    this.#pending ??= invoke('oven:state')
      .then((state) => {
        this.#state = state
        return state
      })
      .finally(() => {
        this.#pending = null
      })
    return this.#pending
  }

  /** Re-read the registry, e.g. after an Oven was added, renamed, or removed. */
  async refresh(): Promise<OvenState> {
    this.#state = null
    return this.ensure()
  }

  identity(ovenId: string | undefined | null): OvenIdentity | null {
    if (!ovenId) return null
    if (ovenId === LOCAL_OVEN_ID)
      return { id: LOCAL_OVEN_ID, name: 'Local', local: true, color: '', iconUrl: null }
    const oven = this.#state?.ovens.find((candidate) => candidate.id === ovenId)
    if (!oven) return null
    return {
      id: oven.id,
      name: oven.name,
      local: false,
      color: oven.color,
      iconUrl: ovenMark(oven)
    }
  }

  /**
   * Read one Oven's harness inventory once.
   *
   * Main keeps a persisted copy per Oven and refreshes it on every probe, so
   * this answers even while the Oven is unreachable and still picks up a
   * harness the user installed on the Oven themselves.
   */
  ensureInventory(ovenId: string): Promise<void> {
    const pending = this.#inventoryPending.get(ovenId)
    if (pending) return pending
    const task = invoke('oven:harness:inventory', ovenId)
      .then((items) => {
        this.#inventories = { ...this.#inventories, [ovenId]: items }
      })
      .catch(() => {
        this.#inventories = { ...this.#inventories, [ovenId]: null }
      })
      .finally(() => this.#inventoryPending.delete(ovenId))
    this.#inventoryPending.set(ovenId, task)
    return task
  }

  /** One Oven's already-read harness rows, or null before the first read. */
  inventory(ovenId: string): OvenHarnessInventoryItem[] | null {
    return this.#inventories[ovenId] ?? null
  }

  /**
   * Harness ids this Oven does not have installed, or null while the inventory
   * is unknown. `unknown` health is never treated as missing: a harness the
   * probe could not read stays selectable rather than being disabled silently.
   */
  unavailableHarnesses(ovenId: string): ReadonlySet<string> | null {
    const items = this.#inventories[ovenId]
    if (!items) return null
    return new Set(
      items
        .filter((item) => item.health === 'missing' || item.health === 'unsupported')
        .map((item) => item.harnessId)
    )
  }
}

/** The Oven's own icon as a data URL, preferring an uploaded image. */
function ovenMark(oven: Oven): string | null {
  if (oven.imageDataUrl) return oven.imageDataUrl
  if (oven.customSvg) return getCustomSvgDataUrl(oven.customSvg, oven.color)
  return getIconSvgDataUrl(oven.icon, oven.color)
}

export const ovens = new OvenIdentityStore()
