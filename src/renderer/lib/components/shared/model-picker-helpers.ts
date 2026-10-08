import { Clock, Star } from '@lucide/svelte'
import { getAgentIcon } from '$lib/agent-icons/registry'
import { modelKey } from '$lib/model-keys'
import { providerStore } from '$lib/stores/providers.svelte'
import { visionModels } from '$lib/stores/vision-models.svelte'
import { getVendorSlug } from '$lib/vendor-icons/registry'
import type { ModelProfileSettings } from '$shared/model-profiles'
import type { ModelProfile, ProviderCatalog, ProviderModel } from '$shared/types'

export type ModelEntry = { provider: ProviderCatalog; model: ProviderModel }

/** A favorite key that no longer resolves to a catalog model. */
export interface UnavailableFavorite {
  modelKey: string
  harnessId?: string
  providerId: string
  modelId: string
}

/** One harness the picker can narrow the model list to. */
export interface PickerHarnessOption {
  id: string
  name: string
  /**
   * True when the current execution target (a remote Oven) does not have this
   * harness installed, so its models cannot run there.
   */
  unavailable?: boolean
  /** Why the harness is unavailable, used as the chip's and row's title. */
  reason?: string
}

/**
 * The harness filter a picker's side panel renders.
 *
 * The selection itself stays owned by the model list, because the list is what
 * the filter narrows; the panel only draws the controls and reports intent. It
 * travels as one object so the row at the top of the picker and the chips inside
 * the panel can never disagree about what is selected.
 */
export interface PickerHarnessFilterControls {
  /** Harness choices, in the registry's canonical order. */
  options: readonly PickerHarnessOption[]
  /** Row label: `All harnesses`, or how many harnesses are selected. */
  label: string
  /** True while the selection is narrowing the model list. */
  active: boolean
  /** Selected harness ids; always empty while everything is shown. */
  selected: ReadonlySet<string>
  onToggle: (harnessId: string) => void
  onClear: () => void
}

/**
 * The profiles a picker's side panel lists.
 *
 * One object rather than eight props: the panel forwards it whole to the profiles
 * section, so a picker that cannot apply a profile simply passes `null` and the
 * panel lists the harness filter alone. The model picker builds this from its own
 * props, because profiles are the picker's surface rather than one caller's.
 */
export interface ModelPickerProfilesGroup {
  /** Saved profiles, in the order the user listed them. */
  profiles: ModelProfile[]
  /** Settings in force, used to tick the profile that is currently live. */
  settings: ModelProfileSettings
  /** Catalogs, so a row shows the model name rather than a raw id. */
  catalogs: ProviderCatalog[]
  /** True when the user has saved as many profiles as the app allows. */
  atCapacity: boolean
  /** Name a new profile starts from, derived from the current settings. */
  draftName: string
  onApply: (profile: ModelProfile) => void
  onSave: (name: string) => void
  onRename: (profile: ModelProfile, name: string) => void
  onRequestDelete: (profile: ModelProfile) => void
}

/**
 * The icon rail's selected section inside the model picker.
 *
 * `all` is the picker as it reads today, `favorites` narrows the list to
 * favorited models, `profiles` swaps the list for the saved profiles surface,
 * and `harness` narrows the list to one harness's models (the replacement for
 * the old harness filter chips).
 */
export type PickerRailView =
  | { kind: 'all' }
  | { kind: 'favorites' }
  | { kind: 'profiles' }
  | { kind: 'harness'; harnessId: string }

/** Cap the trigger label at this length, suffixing an ellipsis when exceeded. */
export const MODEL_LABEL_MAX_LENGTH = 40

/**
 * Marks a control a picker's side panel walks between with the arrow keys.
 *
 * One marker per row, on the control that takes focus when the row is stepped
 * to, rather than one per focusable control: a profile row owns its rename and
 * delete buttons as well, and marking those too would stop the arrows three
 * times on the same row. They are reached with Tab instead.
 */
export const PICKER_ENTRY_SELECTOR = '[data-picker-entry]'

/**
 * `Node.DOCUMENT_POSITION_FOLLOWING`.
 *
 * Spelled out rather than read off `Node` so this module stays importable where
 * the DOM globals are not defined.
 */
const DOCUMENT_POSITION_FOLLOWING = 4

/**
 * The entry the arrows should move to from wherever focus currently is.
 *
 * `focused` is rarely an entry itself: a row hands focus to its rename and delete
 * buttons too, and those sit beside the row's entry in the document rather than
 * inside it. So the walk is measured in document order: the entry focus stands on
 * is the one it is, or the last one that precedes it, which is the row that owns
 * whatever control was reached with Tab. From there the step lands on the
 * neighbour, and `null` at either end of the panel means the key is left to the
 * browser and focus stays where it is.
 */
export function pickerEntryTarget(
  entries: readonly HTMLElement[],
  focused: Element | null,
  step: 1 | -1
): HTMLElement | null {
  if (!focused || entries.length === 0) return null
  let owner = -1
  for (const [index, entry] of entries.entries()) {
    if (
      entry === focused ||
      (entry.compareDocumentPosition(focused) & DOCUMENT_POSITION_FOLLOWING) !== 0
    ) {
      owner = index
    }
  }
  if (owner === -1) return null
  return entries[owner + step] ?? null
}

export const PICKER_OVERSCAN = 8

export const PICKER_ROW_HEIGHT = {
  divider: 9,
  header: 28,
  'provider-header': 28,
  'provider-message': 32,
  'unavailable-model': 40,
  model: 44
} as const

export type PickerListItem =
  | { kind: 'divider'; key: string }
  | {
      kind: 'header'
      key: string
      id: string
      text: string
      icon: typeof Star
      iconClass: string
      count: number
    }
  | { kind: 'provider-header'; key: string; provider: ProviderCatalog }
  | { kind: 'provider-message'; key: string; provider: ProviderCatalog }
  | { kind: 'unavailable-model'; key: string; favorite: UnavailableFavorite }
  | {
      kind: 'model'
      key: string
      entry: ModelEntry
      favoriteKey?: string
      /** Stored recently-used key of the row, when the row comes from the
       *  "Recently used" section   enables the remove-from-history "x". */
      recentKey?: string
      draggable: boolean
    }

export interface PickerLayout {
  items: PickerListItem[]
  offsets: number[]
  total: number
}

export function truncateLabel(value: string): string {
  if (value.length <= MODEL_LABEL_MAX_LENGTH) return value
  return `${value.slice(0, MODEL_LABEL_MAX_LENGTH - 1).trimEnd()}…`
}

/** Render identity is harness-scoped. */
export function modelEntryKey(entry: ModelEntry): string {
  return modelKey(entry.provider.harnessId, entry.provider.id, entry.model.id)
}

export function searchWords(value: string): string[] {
  return value.trim().toLowerCase().split(/\s+/).filter(Boolean)
}

export function harnessName(harnessId: string): string {
  return getAgentIcon(harnessId)?.name ?? harnessId
}

/** Canonical registry rank of a harness; unknown ids sort last. */
export function harnessOrder(harnessId: string): number {
  const index = providerStore.providers.findIndex((provider) => provider.id === harnessId)
  return index === -1 ? Number.MAX_SAFE_INTEGER : index
}

/** True when the harness's own vendor and the provider are the same vendor
 * (e.g. OpenCode → OpenCode Go/Zen), so only the harness icon is shown. */
export function vendorMatches(harnessId: string, providerName: string): boolean {
  const harnessVendor = getAgentIcon(harnessId)?.vendor
  if (!harnessVendor) return false
  const harnessSlug = getVendorSlug(harnessVendor)
  const providerSlug = getVendorSlug(providerName)
  return Boolean(harnessSlug && providerSlug && harnessSlug === providerSlug)
}

export function modelHaystack(provider: ProviderCatalog, model: ProviderModel): string {
  return `${harnessName(provider.harnessId)} ${provider.name} ${model.name} ${model.id}`.toLowerCase()
}

/** Models able to see images. When the catalog does not report the flag,
 *  the model is treated as vision-capable so it is never hidden incorrectly;
 *  a model recorded in the app's own vision report also passes even when the
 *  catalog claims text-only. */
export function passesVisionFilter(model: ProviderModel, visionOnly: boolean): boolean {
  if (!visionOnly) return true
  return model.attachment !== false || visionModels.has(model.id)
}

export function filterEntries(entries: ModelEntry[], value: string): ModelEntry[] {
  const words = searchWords(value)
  return words.length === 0
    ? entries
    : entries.filter(({ provider, model }) =>
        words.every((word) => modelHaystack(provider, model).includes(word))
      )
}

/**
 * Collapse duplicate resolved model entries so duplicate catalog entries do
 * not render duplicate `each` keys. Keeps the first occurrence, preserving
 * display order.
 */
export function dedupeModelEntries(entries: ModelEntry[]): ModelEntry[] {
  const seen: Record<string, true> = {}
  const deduped: ModelEntry[] = []
  for (const entry of entries) {
    const identity = modelEntryKey(entry)
    if (seen[identity]) continue
    seen[identity] = true
    deduped.push(entry)
  }
  return deduped
}

export function findModelEntry(
  catalogs: ProviderCatalog[],
  providerId: string,
  modelId: string,
  currentHarnessId: string,
  keyHarnessId?: string
): ModelEntry | null {
  let provider: ProviderCatalog | undefined
  if (keyHarnessId) {
    provider = catalogs.find(
      (candidate) => candidate.harnessId === keyHarnessId && candidate.id === providerId
    )
  } else {
    provider =
      catalogs.find(
        (candidate) => candidate.id === providerId && candidate.harnessId === currentHarnessId
      ) ?? catalogs.find((candidate) => candidate.id === providerId)
  }
  if (!provider) return null
  const model = provider.models.find((candidate) => candidate.id === modelId)
  return model ? { provider, model } : null
}

/** Resolve a model key against the current catalog first, then cached catalogs. */
export function resolveModel(
  displayProviders: ProviderCatalog[],
  cachedProviders: ProviderCatalog[],
  providerId: string,
  modelId: string,
  currentHarnessId: string,
  keyHarnessId?: string
): ModelEntry | null {
  return (
    findModelEntry(displayProviders, providerId, modelId, currentHarnessId, keyHarnessId) ??
    findModelEntry(cachedProviders, providerId, modelId, currentHarnessId, keyHarnessId)
  )
}

/** Index of the item whose [offset, offset+height) range contains `target`. */
export function pickerItemIndexAt(offsets: number[], target: number): number {
  let low = 0
  let high = offsets.length - 2
  if (target <= offsets[low]) return low
  if (target >= offsets[high + 1]) return high
  while (low < high) {
    const mid = (low + high) >> 1
    if (offsets[mid + 1] <= target) low = mid + 1
    else high = mid
  }
  return low
}

/** True for a plain printable character key (not a modifier/control combo). */
export function isTypeableKey(event: KeyboardEvent): boolean {
  return event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey
}

/** Flatten every visible list section into positioned rows. */
export function buildPickerLayout(input: {
  favoriteModelsList: ModelEntry[]
  recentModelsList: ModelEntry[]
  unavailableFavoriteModels: UnavailableFavorite[]
  filteredProviders: ProviderCatalog[]
  collapsedGroups: ReadonlySet<string>
  search: string
  canReorderFavorites: boolean
}): PickerLayout {
  const {
    favoriteModelsList,
    recentModelsList,
    unavailableFavoriteModels,
    filteredProviders,
    collapsedGroups,
    search,
    canReorderFavorites
  } = input
  const items: PickerListItem[] = []

  if (favoriteModelsList.length > 0) {
    items.push({
      kind: 'header',
      key: 'header-favorites',
      id: 'favorites',
      text: 'Favorites',
      icon: Star,
      iconClass: 'text-amber-400',
      count: favoriteModelsList.length
    })
    if (!collapsedGroups.has('favorites')) {
      for (const entry of favoriteModelsList) {
        items.push({
          kind: 'model',
          key: `fav-${modelEntryKey(entry)}`,
          entry,
          favoriteKey: modelKey(entry.provider.harnessId, entry.provider.id, entry.model.id),
          draggable: canReorderFavorites
        })
      }
    }
    items.push({ kind: 'divider', key: 'div-favorites' })
  }

  if (recentModelsList.length > 0) {
    items.push({
      kind: 'header',
      key: 'header-recent',
      id: 'recent',
      text: 'Recently used',
      icon: Clock,
      iconClass: 'text-muted',
      count: recentModelsList.length
    })
    if (!collapsedGroups.has('recent')) {
      for (const entry of recentModelsList) {
        items.push({
          kind: 'model',
          key: `rec-${modelEntryKey(entry)}`,
          entry,
          recentKey: modelEntryKey(entry),
          draggable: false
        })
      }
    }
    items.push({ kind: 'divider', key: 'div-recent' })
  }

  if (unavailableFavoriteModels.length > 0 && !search) {
    items.push({
      kind: 'header',
      key: 'header-unavailable',
      id: 'unavailable-favorites',
      text: 'Unavailable favorites',
      icon: Star,
      iconClass: 'text-dimmed',
      count: unavailableFavoriteModels.length
    })
    if (!collapsedGroups.has('unavailable-favorites')) {
      for (const favorite of unavailableFavoriteModels) {
        items.push({ kind: 'unavailable-model', key: `unav-${favorite.modelKey}`, favorite })
      }
    }
    items.push({ kind: 'divider', key: 'div-unavailable' })
  }

  for (const provider of filteredProviders) {
    const providerKey = provider.harnessId + ':' + provider.id
    items.push({ kind: 'provider-header', key: `ph-${providerKey}`, provider })
    if (!collapsedGroups.has(providerKey)) {
      if (provider.catalogStatus === 'unavailable') {
        items.push({ kind: 'provider-message', key: `pm-${providerKey}`, provider })
      } else {
        for (const model of provider.models) {
          items.push({
            kind: 'model',
            key: `m-${modelEntryKey({ provider, model })}`,
            entry: { provider, model },
            draggable: false
          })
        }
      }
    }
  }

  let total = 0
  const offsets: number[] = []
  for (const item of items) {
    offsets.push(total)
    total += PICKER_ROW_HEIGHT[item.kind]
  }
  offsets.push(total)
  return { items, offsets, total }
}

/** Flat, ordered keys of every model row, for keyboard navigation. */
export function pickerModelKeysOf(items: PickerListItem[]): string[] {
  return items.filter((item) => item.kind === 'model').map((item) => item.key)
}

/** Index of the currently selected model's row within the flattened list. */
export function pickerIndexForSelectedModel(
  items: PickerListItem[],
  modelId: string,
  providerId: string,
  harnessId: string
): number | undefined {
  const index = items.findIndex(
    (item) =>
      item.kind === 'model' &&
      item.entry.model.id === modelId &&
      item.entry.provider.id === providerId &&
      item.entry.provider.harnessId === harnessId
  )
  return index === -1 ? undefined : index
}

export function visiblePickerItems(
  layout: PickerLayout,
  scrollTop: number,
  viewport: number
): { items: Array<PickerListItem & { offset: number }>; total: number } {
  const { items, offsets, total } = layout
  if (items.length === 0) return { items: [], total }
  const start = Math.max(0, pickerItemIndexAt(offsets, scrollTop) - PICKER_OVERSCAN)
  const end = Math.min(
    items.length,
    pickerItemIndexAt(offsets, scrollTop + viewport) + PICKER_OVERSCAN + 1
  )
  const visible: Array<PickerListItem & { offset: number }> = []
  for (let index = start; index < end; index++) {
    visible.push({ ...items[index], offset: offsets[index] })
  }
  return { items: visible, total }
}
