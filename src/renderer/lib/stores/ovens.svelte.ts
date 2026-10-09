import { invoke } from '$lib/ipc.svelte'
import { providerStore } from '$lib/stores/providers.svelte'
import { getIconSvgDataUrl } from '$lib/project-svg-icons'
import { getCustomSvgDataUrl } from '$shared/custom-svg'
import type { ProviderConnectionInfo } from '$shared/types'
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

  /**
   * The Local Oven's own harnesses.
   *
   * Local has no oven service to ask, so its inventory is the app's own provider
   * probes: the same source the model picker and Providers settings already use.
   */
  #local = $derived.by(() => localHarnessInventory(providerStore.providers))

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

  /**
   * Adopt a registry a caller already read.
   *
   * Every surface that names an Oven (thread rows, the hover card, the Oven
   * picker) reads this store, so publishing the answer that Settings already
   * fetched is what makes an icon or colour edit show up everywhere at once
   * instead of waiting for the next app start.
   */
  adopt(state: OvenState): void {
    this.#state = state
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
      iconUrl: ovenMarkUrl(oven)
    }
  }

  /**
   * Read one Oven's harness inventory once.
   *
   * Main keeps a persisted copy per Oven and refreshes it on every probe, so
   * this answers even while the Oven is unreachable and still picks up a
   * harness the user installed on the Oven themselves. `refresh` forces a live
   * oven-side scan instead, which a surface uses when it needs the current
   * answer (the model picker opening); a refresh that fails keeps the last known
   * inventory rather than blanking the picker.
   */
  ensureInventory(ovenId: string, refresh = false): Promise<void> {
    if (ovenId === LOCAL_OVEN_ID) return providerStore.init().then(() => providerStore.checkAll())
    const key = `${ovenId}:${refresh ? 'refresh' : 'read'}`
    const pending = this.#inventoryPending.get(key)
    if (pending) return pending
    const task = invoke('oven:harness:inventory', ovenId, refresh)
      .then((items) => {
        this.#inventories = { ...this.#inventories, [ovenId]: items }
      })
      .catch(() => {
        if (!refresh) this.#inventories = { ...this.#inventories, [ovenId]: null }
      })
      .finally(() => this.#inventoryPending.delete(key))
    this.#inventoryPending.set(key, task)
    return task
  }

  /** One Oven's already-read harness rows, or null before the first read. */
  inventory(ovenId: string): OvenHarnessInventoryItem[] | null {
    if (ovenId === LOCAL_OVEN_ID) return this.#local
    return this.#inventories[ovenId] ?? null
  }

  /**
   * Harness ids this Oven does not have installed, or null while the inventory
   * is unknown. `unknown` health is never treated as missing: a harness the
   * probe could not read stays selectable rather than being disabled silently.
   */
  unavailableHarnesses(ovenId: string): ReadonlySet<string> | null {
    const items = this.inventory(ovenId)
    if (!items) return null
    return new Set(
      items
        .filter((item) => item.health === 'missing' || item.health === 'unsupported')
        .map((item) => item.harnessId)
    )
  }
}

/**
 * Turn the app's local provider probes into the same rows an Oven reports.
 *
 * `available` is the only status that means a usable binary answered, so it is
 * the only `healthy`; a probe still running stays `unknown` rather than being
 * reported missing and disabling the harness in the picker.
 */
function localHarnessInventory(
  providers: readonly ProviderConnectionInfo[]
): OvenHarnessInventoryItem[] {
  return providers.map((provider) => ({
    harnessId: provider.id,
    command: provider.activeCommand ?? provider.command,
    executablePath: provider.resolvedPath ?? null,
    installedVersion: provider.version ?? null,
    health:
      provider.status === 'available'
        ? 'healthy'
        : provider.status === 'checking' || provider.status === 'idle'
          ? 'unknown'
          : 'missing',
    updateAvailable: false,
    checkedAt: Date.now()
  }))
}

/** The Oven's own icon as a data URL, preferring an uploaded image. */
export function ovenMarkUrl(oven: Oven): string | null {
  if (oven.imageDataUrl) return oven.imageDataUrl
  if (oven.customSvg) return getCustomSvgDataUrl(oven.customSvg, oven.color)
  return getIconSvgDataUrl(oven.icon, oven.color)
}

export const ovens = new OvenIdentityStore()
