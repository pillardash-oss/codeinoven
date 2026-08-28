<script lang="ts">
  import { tick } from 'svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import { DropdownMenu, Popover } from 'bits-ui'
  import {
    Brain,
    Check,
    ChevronRight,
    Clock,
    Cpu,
    GripVertical,
    ListFilter,
    RefreshCw,
    Search,
    Star,
    SquareTerminal,
    Zap,
    X
  } from '@lucide/svelte'
  import { resolveDefaultThinkingLevel } from '$shared/thinking-presets'
  import { getAgentIcon } from '$lib/agent-icons/registry'
  import { modelKey, parseModelKey } from '$lib/model-keys'
  import { peakHoursBadgeFor } from '$shared/peak-hours'
  import { baseUrlProviderStore } from '$lib/stores/base-url-providers.svelte'
  import { mergeProviderCatalogEntries, providerCatalog } from '$lib/stores/provider-catalog.svelte'
  import { providerStore } from '$lib/stores/providers.svelte'
  import { getVendorSlug } from '$lib/vendor-icons/registry'
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'
  import type { ProviderCatalog, ProviderModel, ThinkingLevel, ThinkingPreset } from '$shared/types'

  interface Props {
    providers: ProviderCatalog[]
    harnessId: string
    providerId: string
    modelId: string
    favoriteModels?: string[]
    recentModels?: string[]
    /** True while the picker is open — opening it refreshes the catalog. */
    open?: boolean
    /** True while the thinking-level dropdown is open. Lets a parent open the
     *  thinking selector directly (e.g. from the `/thinking` slash action). */
    thinkingMenuOpen?: boolean
    /** Project whose harness catalog this picker displays. When provided, opening
     *  the picker lazily fetches that project's catalog (network only when stale). */
    projectId?: string | null
    side?: 'top' | 'bottom'
    disabled?: boolean
    variant?: 'compact' | 'field' | 'action'
    label?: string
    /** Keep the catalog open while toggling several models. */
    multiSelect?: boolean
    /** Harness-scoped model keys selected by a multi-select caller. */
    selectedModelKeys?: string[]
    /** Shows that the selected model is using its fast inference tier. */
    fast?: boolean
    /** When true, only models that report vision capability are shown. */
    visionOnly?: boolean
    /** Current thinking level. Whenever the selected model declares thinking
     *  presets, the trigger shows the level badge and the popover exposes the
     *  presets — no opt-in beyond passing the current value is needed. */
    thinkingLevel?: ThinkingLevel | null
    /** Thinking presets to display. Defaults to the selected model's declared
     *  presets — when the model declares none, thinking controls stay hidden. */
    thinkingPresets?: ThinkingPreset[]
    onSelect: (providerId: string, modelId: string, harnessId: string) => void
    onSelectMultiple?: (modelKeys: string[]) => void
    /** Fired when the thinking level changes — either from an explicit preset
     *  click, or automatically when a newly selected model no longer supports
     *  the previous level. */
    onSelectThinking?: (level: ThinkingLevel) => void
    onToggleFavorite?: (providerId: string, modelId: string, harnessId: string) => void
    /** Reorders a favorite relative to another favorite; position in display order. */
    onReorderFavorite?: (
      draggedKey: string,
      targetKey: string,
      position: 'before' | 'after'
    ) => void
  }

  let {
    providers,
    harnessId,
    providerId,
    modelId,
    favoriteModels = [],
    recentModels = [],
    open = $bindable(false),
    thinkingMenuOpen = $bindable(false),
    projectId = null,
    side = 'top',
    disabled = false,
    variant = 'compact',
    label,
    multiSelect = false,
    selectedModelKeys = [],
    fast = false,
    visionOnly = false,
    thinkingLevel = null,
    thinkingPresets,
    onSelect,
    onSelectMultiple,
    onSelectThinking,
    onToggleFavorite,
    onReorderFavorite
  }: Props = $props()

  const pickerId = crypto.randomUUID()
  const searchId = `model-search-${pickerId}`
  const listId = `model-list-${pickerId}`
  let search = $state('')
  let searchInput: HTMLInputElement | undefined
  let modelList: HTMLDivElement | undefined
  const collapsedGroups = new SvelteSet<string>()
  let favoriteModelsSet = $derived(new Set(favoriteModels))
  let selectedModelKeysSet = $derived(new Set(selectedModelKeys))
  /** Harness catalogs are app-wide. Keep the union available while a newly
   * opened project's time-budgeted refresh is still returning partial results. */
  let cachedProviders = $derived(providerCatalog.allCached())
  let currentProviders = $derived(
    projectId ? (providerCatalog.cached(projectId) ?? providers) : providers
  )
  /** Current-project entries win when present without dropping harnesses that
   * are still pending from its background catalog enrichment. Harnesses whose
   * installed version is unsupported (e.g. OpenCode V2) are dropped so they
   * behave exactly as if not installed. */
  let displayProviders = $derived(
    mergeProviderCatalogEntries([...cachedProviders, ...providers, ...currentProviders]).filter(
      (provider) => !providerStore.isUnsupported(provider.harnessId)
    )
  )
  const selectedHarnesses = new SvelteSet<string>()
  let showAllHarnesses = $state(true)
  let harnessFilterOpen = $state(false)
  let selectedProvider = $derived(
    displayProviders.find(
      (provider) => provider.id === providerId && provider.harnessId === harnessId
    ) ??
      displayProviders.find((provider) => provider.id === providerId) ??
      displayProviders.find((provider) => provider.models.some((model) => model.id === modelId))
  )
  let selectedModel = $derived(
    selectedProvider?.models.find((model) => model.id === modelId) ??
      displayProviders.flatMap((provider) => provider.models).find((model) => model.id === modelId)
  )
  /**
   * Thinking presets offered by the selected model. Callers may override them
   * (e.g. the composer falls back to the standard presets while the catalog is
   * still cold); otherwise the model's declared presets decide — none declared
   * means the model does not reason and the thinking controls stay hidden.
   */
  let effectiveThinkingPresets = $derived(thinkingPresets ?? selectedModel?.thinkingPresets ?? [])
  /** Thinking controls appear whenever the selected model declares presets —
   *  the thinking level depends on the model, not on the caller's opt-in. */
  let supportsThinking = $derived(effectiveThinkingPresets.length > 0)
  /**
   * Fallback "current" level for the trigger when the caller does not track a
   * thinking level yet: the model's declared default (custom providers) or its
   * lowest preset, mirroring what selecting the model would apply.
   */
  let fallbackThinkingLevel = $derived(
    baseUrlProviderStore.defaultThinkingLevel(
      selectedProvider?.harnessId ?? harnessId,
      providerId,
      modelId
    ) ?? resolveDefaultThinkingLevel(effectiveThinkingPresets, undefined, undefined)
  )
  let currentThinkingLabel = $derived(
    effectiveThinkingPresets.find((preset) => preset.id === thinkingLevel)?.label ??
      thinkingLevel ??
      effectiveThinkingPresets.find((preset) => preset.id === fallbackThinkingLevel)?.label ??
      effectiveThinkingPresets[0]?.label ??
      ''
  )
  /**
   * Snapshot fallback so the trigger renders instantly, before any harness
   * catalog resolves: the thread's stored harness icon is always available, and
   * the label degrades from the catalog's display name to the raw model id.
   * The catalog enriches these optimistically once it lands.
   */
  let selectedHarnessIcon = $derived(getAgentIcon(harnessId))
  let selectedLabel = $derived(
    multiSelect
      ? (label ??
          (selectedModelKeys.length === 0
            ? 'Select models'
            : `${selectedModelKeys.length} model${selectedModelKeys.length === 1 ? '' : 's'} selected`))
      : (label ?? selectedModel?.name ?? (modelId || 'Model'))
  )
  /** Keep the trigger readable — long names (e.g. Claude Code's default-model
   *  description) would otherwise swallow the composer's bottom bar. */
  let selectedLabelDisplay = $derived(truncateLabel(selectedLabel))
  /** Peak/off-peak state of the currently selected model, for the trigger badge. */
  let selectedPeak = $derived(selectedModel ? peakHoursBadgeFor(selectedModel.id) : null)
  let availableModelKeys = $derived(
    new Set(
      [...displayProviders, ...cachedProviders].flatMap((provider) =>
        provider.models.map((model) => modelKey(provider.harnessId, provider.id, model.id))
      )
    )
  )
  /**
   * Harnesses present in the current catalog, ordered by the canonical harness
   * registry (via `providerStore.providers`) so omitting a harness — or a custom
   * provider being appended to the catalog tail — never reshuffles the chips.
   */
  let harnessOptions = $derived(
    Array.from(
      new Map(
        displayProviders
          .map((provider) => provider.harnessId)
          .map((harnessId) => [harnessId, harnessName(harnessId)])
      )
    )
      .map(([id, name]) => ({ id, name }))
      .sort((left, right) => harnessOrder(left.id) - harnessOrder(right.id))
  )
  let effectiveHarnessCount = $derived(showAllHarnesses ? 0 : selectedHarnesses.size || 0)
  let harnessFilterActive = $derived(effectiveHarnessCount > 0)
  let harnessFilterLabel = $derived(
    harnessFilterActive
      ? effectiveHarnessCount === 1
        ? '1 harness'
        : `${effectiveHarnessCount} harnesses`
      : 'All harnesses'
  )
  let unavailableFavoriteModels = $derived(
    favoriteModels
      .filter((key) => !availableModelKeys.has(key))
      .map((key) => {
        const parsed = parseModelKey(key)
        return parsed ? { modelKey: key, ...parsed } : null
      })
      .filter((favorite): favorite is NonNullable<typeof favorite> => favorite !== null)
  )
  let favoriteModelsList = $derived(
    filterEntries(
      dedupeModelEntries(
        favoriteModels
          .slice()
          .reverse()
          .map((key) => {
            const parsed = parseModelKey(key)
            if (!parsed) return null
            const entry = resolveModel(parsed.providerId, parsed.modelId, parsed.harnessId)
            return entry && passesVisionFilter(entry.model) ? entry : null
          })
          .filter((entry): entry is ModelEntry => entry !== null)
      ),
      search
    )
  )
  let recentModelsList = $derived(
    filterEntries(
      dedupeModelEntries(
        recentModels
          .map((key) => {
            const parsed = parseModelKey(key)
            if (!parsed) return null
            const entry = resolveModel(parsed.providerId, parsed.modelId, parsed.harnessId)
            return entry &&
              passesHarnessFilter(entry.provider.harnessId) &&
              passesVisionFilter(entry.model)
              ? entry
              : null
          })
          .filter((entry): entry is ModelEntry => entry !== null)
      ),
      search
    )
  )
  let filteredProviders = $derived.by(() => {
    const words = searchWords(search)
    return displayProviders
      .filter((provider) => passesHarnessFilter(provider.harnessId))
      .map((provider) => ({
        ...provider,
        models:
          words.length === 0
            ? provider.models.filter(passesVisionFilter)
            : provider.models.filter(
                (model) =>
                  passesVisionFilter(model) &&
                  words.every((word) => modelHaystack(provider, model).includes(word))
              )
      }))
      .filter(
        (provider) =>
          provider.models.length > 0 ||
          (words.length === 0 && provider.catalogStatus === 'unavailable')
      )
  })
  /** Visual shell of the trigger — it hosts the model button and, when the
   *  selected model reasons, the thinking-level badge as a split control. */
  let triggerClasses = $derived(
    variant === 'field'
      ? 'flex w-full items-center rounded-lg border bg-elevated transition-colors hover:bg-overlay'
      : variant === 'action'
        ? 'flex items-center rounded-lg border bg-elevated transition-colors hover:bg-overlay'
        : 'flex items-center rounded-lg transition-colors hover:bg-elevated'
  )
  let modelButtonClasses = $derived(
    variant === 'field'
      ? 'flex min-w-0 flex-1 items-center gap-1 px-3 py-2 text-sm text-muted transition-colors hover:text-foreground'
      : variant === 'action'
        ? 'flex min-w-0 flex-1 items-center gap-1 px-3 py-2 text-xs font-semibold text-muted transition-colors hover:text-foreground'
        : 'flex min-w-0 flex-1 items-center gap-1 px-2 py-1.5 text-[11px] text-muted transition-colors hover:text-foreground'
  )

  type ModelEntry = { provider: ProviderCatalog; model: ProviderModel }

  /** Cap the trigger label at this length, suffixing an ellipsis when exceeded. */
  const MODEL_LABEL_MAX_LENGTH = 40

  function truncateLabel(value: string): string {
    if (value.length <= MODEL_LABEL_MAX_LENGTH) return value
    return `${value.slice(0, MODEL_LABEL_MAX_LENGTH - 1).trimEnd()}…`
  }

  /**
   * Whether a row is the currently selected model. The selected model is fully
   * identified by the (harnessId, providerId, modelId) triple — never by modelId
   * alone, since different providers (e.g. DeepSeek vs OpenCode Go) can expose
   * models sharing the same id.
   */
  function isSelectedModel(entry: ModelEntry): boolean {
    if (multiSelect) return selectedModelKeysSet.has(modelEntryKey(entry))
    return (
      entry.model.id === modelId &&
      entry.provider.id === providerId &&
      entry.provider.harnessId === harnessId
    )
  }

  /** Render identity is harness-scoped. */
  function modelEntryKey(entry: ModelEntry): string {
    return modelKey(entry.provider.harnessId, entry.provider.id, entry.model.id)
  }

  function searchWords(value: string): string[] {
    return value.trim().toLowerCase().split(/\s+/).filter(Boolean)
  }

  function harnessName(harnessId: string): string {
    return getAgentIcon(harnessId)?.name ?? harnessId
  }

  /** Canonical registry rank of a harness; unknown ids sort last. */
  function harnessOrder(harnessId: string): number {
    const index = providerStore.providers.findIndex((provider) => provider.id === harnessId)
    return index === -1 ? Number.MAX_SAFE_INTEGER : index
  }

  /** True when the harness's own vendor and the provider are the same vendor
   * (e.g. OpenCode → OpenCode Go/Zen), so only the harness icon is shown. */
  function vendorMatches(harnessId: string, providerName: string): boolean {
    const harnessVendor = getAgentIcon(harnessId)?.vendor
    if (!harnessVendor) return false
    const harnessSlug = getVendorSlug(harnessVendor)
    const providerSlug = getVendorSlug(providerName)
    return Boolean(harnessSlug && providerSlug && harnessSlug === providerSlug)
  }

  function passesHarnessFilter(candidateHarnessId: string): boolean {
    if (showAllHarnesses) return true
    if (selectedHarnesses.size === 0) return true
    return selectedHarnesses.has(candidateHarnessId)
  }

  function isHarnessSelected(candidateHarnessId: string): boolean {
    return !showAllHarnesses && selectedHarnesses.has(candidateHarnessId)
  }

  function toggleHarness(nextHarnessId: string): void {
    if (showAllHarnesses) showAllHarnesses = false
    if (selectedHarnesses.has(nextHarnessId)) {
      if (selectedHarnesses.size > 1) selectedHarnesses.delete(nextHarnessId)
      return
    }
    selectedHarnesses.add(nextHarnessId)
  }

  function clearHarnessFilter(): void {
    selectedHarnesses.clear()
    showAllHarnesses = true
  }

  function modelHaystack(provider: ProviderCatalog, model: ProviderModel): string {
    return `${harnessName(provider.harnessId)} ${provider.name} ${model.name} ${model.id}`.toLowerCase()
  }

  /** Models able to see images. When the catalog does not report the flag,
   *  the model is treated as vision-capable so it is never hidden incorrectly. */
  function passesVisionFilter(model: ProviderModel): boolean {
    if (!visionOnly) return true
    return model.attachment !== false
  }

  function filterEntries(entries: ModelEntry[], value: string): ModelEntry[] {
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
  function dedupeModelEntries(entries: ModelEntry[]): ModelEntry[] {
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

  /** Resolve a model key against the current catalog first, then cached catalogs. */
  function resolveModel(
    providerId: string,
    modelId: string,
    keyHarnessId?: string
  ): ModelEntry | null {
    return (
      findModelEntry(displayProviders, providerId, modelId, keyHarnessId) ??
      findModelEntry(cachedProviders, providerId, modelId, keyHarnessId)
    )
  }

  function findModelEntry(
    catalogs: ProviderCatalog[],
    providerId: string,
    modelId: string,
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
          (candidate) => candidate.id === providerId && candidate.harnessId === harnessId
        ) ?? catalogs.find((candidate) => candidate.id === providerId)
    }
    if (!provider) return null
    const model = provider.models.find((candidate) => candidate.id === modelId)
    return model ? { provider, model } : null
  }

  function close(): void {
    open = false
  }

  function resetPicker(): void {
    search = ''
    harnessFilterOpen = false
    pickerListScrollTop = 0
    keyboardNavActive = false
  }

  function handleOpenChange(nextOpen: boolean): void {
    if (!nextOpen) {
      resetPicker()
      return
    }
    resetPicker()
    void tick().then(() => {
      searchInput?.focus()
      const selectedOffset = pickerOffsetForSelectedModel()
      if (selectedOffset !== undefined) {
        scrollPickerListTo(selectedOffset - 60)
      }
    })
    // Revalidate exactly once per open. Keeping this outside a reactive effect
    // prevents catalog updates from snapping the user's scroll position back
    // to the selected model.
    if (projectId) void providerCatalog.refresh(projectId)
  }

  // ---- Virtualized model list ----------------------------------------------
  // The list can render 500+ model rows on every open; mounting them all
  // synchronously costs ~120ms and delays the picker's first paint. Only the
  // rows intersecting the scroll viewport (plus an overscan) are mounted,
  // positioned by exact per-kind heights so scroll offsets stay accurate.
  const PICKER_OVERSCAN = 8
  const PICKER_ROW_HEIGHT = {
    divider: 9,
    header: 28,
    'provider-header': 28,
    'provider-message': 32,
    'unavailable-model': 40,
    model: 44
  } as const

  type PickerListItem =
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
    | {
        kind: 'unavailable-model'
        key: string
        favorite: { modelKey: string; harnessId?: string; providerId: string; modelId: string }
      }
    | {
        kind: 'model'
        key: string
        entry: ModelEntry
        favoriteKey?: string
        draggable: boolean
      }

  let pickerListScrollTop = $state(0)
  let pickerViewport = $state(240)
  /** True right after an arrow-key press, until the mouse physically moves.
   *  CSS `:hover` is geometric — it re-fires on whatever row ends up under a
   *  stationary cursor once the virtual list auto-scrolls for keyboard nav.
   *  While this is true, rows go pointer-events: none so a parked mouse can't
   *  paint a stale `:hover`; a real `mousemove` clears it and hands control
   *  straight back to the mouse. */
  let keyboardNavActive = $state(false)

  /** Flatten every visible list section into positioned rows. */
  let pickerLayout = $derived.by(() => {
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
            draggable: Boolean(onReorderFavorite)
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
          items.push({ kind: 'model', key: `rec-${modelEntryKey(entry)}`, entry, draggable: false })
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
  })

  /** Flat, ordered keys of every model row, for keyboard navigation. */
  let pickerModelKeys = $derived(
    pickerLayout.items.filter((item) => item.kind === 'model').map((item) => item.key)
  )

  let pickerVisibleItems = $derived.by(() => {
    const { items, offsets, total } = pickerLayout
    if (items.length === 0) return { items: [], total }
    const start = Math.max(0, pickerItemIndexAt(offsets, pickerListScrollTop) - PICKER_OVERSCAN)
    const end = Math.min(
      items.length,
      pickerItemIndexAt(offsets, pickerListScrollTop + pickerViewport) + PICKER_OVERSCAN + 1
    )
    const visible: (PickerListItem & { offset: number })[] = []
    for (let index = start; index < end; index++) {
      visible.push({ ...items[index], offset: offsets[index] })
    }
    return { items: visible, total }
  })

  /** Index of the item whose [offset, offset+height) range contains `target`. */
  function pickerItemIndexAt(offsets: number[], target: number): number {
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

  /** Pixel offset of the currently selected model row, if it is listed. */
  function pickerOffsetForSelectedModel(): number | undefined {
    const index = pickerLayout.items.findIndex(
      (item) =>
        item.kind === 'model' &&
        item.entry.model.id === modelId &&
        item.entry.provider.id === providerId &&
        item.entry.provider.harnessId === harnessId
    )
    return index === -1 ? undefined : pickerLayout.offsets[index]
  }

  /** Scroll the virtual list to a pixel offset (state + DOM stay in sync). */
  function scrollPickerListTo(top: number): void {
    pickerListScrollTop = Math.max(0, top)
    if (modelList) modelList.scrollTop = pickerListScrollTop
  }

  /** True for a plain printable character key (not a modifier/control combo). */
  function isTypeableKey(event: KeyboardEvent): boolean {
    return event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey
  }

  /** Return focus to the search box and place the caret near its end (a negative
   *  `offset` steps the caret back) so the user can keep editing the query while
   *  navigating the list. */
  function focusSearchInput(offset = 0): void {
    if (!searchInput) return
    searchInput.focus()
    const len = searchInput.value.length
    const target = Math.max(0, Math.min(len, len + offset))
    searchInput.setSelectionRange(target, target)
  }

  function attachSearchInput(node: HTMLInputElement): () => void {
    searchInput = node
    return () => {
      if (searchInput === node) searchInput = undefined
    }
  }

  /** Keep the viewport height and scroll position in sync for the virtual list. */
  function measurePickerList(node: HTMLDivElement): () => void {
    pickerViewport = node.clientHeight
    const resizeObserver = new ResizeObserver(() => {
      pickerViewport = node.clientHeight
    })
    resizeObserver.observe(node)
    const onScroll = (): void => {
      pickerListScrollTop = node.scrollTop
    }
    node.addEventListener('scroll', onScroll, { passive: true })
    const onMouseMove = (): void => {
      if (keyboardNavActive) keyboardNavActive = false
    }
    node.addEventListener('mousemove', onMouseMove, { passive: true })
    return () => {
      resizeObserver.disconnect()
      node.removeEventListener('scroll', onScroll)
      node.removeEventListener('mousemove', onMouseMove)
    }
  }

  /** True while the current project's catalog is being re-probed by the store. */
  let refreshing = $derived(projectId ? providerCatalog.refreshing(projectId) : false)

  /** Force a fresh catalog from the harness drivers, bypassing the TTL cache. */
  function refreshCatalog(): void {
    if (!projectId) return
    void providerCatalog.refresh(projectId, true)
  }

  function choose(nextProviderId: string, nextModelId: string, nextHarnessId: string): void {
    if (multiSelect) {
      const nextKey = modelKey(nextHarnessId, nextProviderId, nextModelId)
      const nextKeys = selectedModelKeysSet.has(nextKey)
        ? selectedModelKeys.filter((key) => key !== nextKey)
        : [...selectedModelKeys, nextKey]
      onSelectMultiple?.(nextKeys)
      return
    }
    const entry =
      findModelEntry(displayProviders, nextProviderId, nextModelId, nextHarnessId) ??
      findModelEntry(cachedProviders, nextProviderId, nextModelId, nextHarnessId)
    close()
    onSelect(nextProviderId, nextModelId, nextHarnessId)
    // Thinking level depends on the model: resolve a level the new model
    // actually offers and surface it right after the model change, so parents
    // never keep a stale level the model no longer supports.
    if (thinkingLevel && entry?.model.thinkingPresets?.length) {
      const defaultLevel = baseUrlProviderStore.defaultThinkingLevel(
        nextHarnessId,
        nextProviderId,
        nextModelId
      )
      const resolved = resolveDefaultThinkingLevel(
        entry.model.thinkingPresets,
        defaultLevel,
        thinkingLevel
      )
      if (resolved && resolved !== thinkingLevel) onSelectThinking?.(resolved)
    }
  }

  function toggleGroup(id: string): void {
    if (collapsedGroups.has(id)) collapsedGroups.delete(id)
    else collapsedGroups.add(id)
  }

  /** Key of the favorite currently being dragged, if any. */
  let draggingFavoriteKey = $state<string | null>(null)
  /** Drop target + position for the favorites section, if dragging over a row. */
  let favoriteDropTarget = $state<{ key: string; position: 'before' | 'after' } | null>(null)

  function startFavoriteDrag(event: DragEvent, key: string, name: string): void {
    if (!onReorderFavorite) return
    event.dataTransfer!.setData('text/plain', key)
    event.dataTransfer!.effectAllowed = 'move'
    draggingFavoriteKey = key
    const ghost = document.createElement('div')
    ghost.textContent = name
    ghost.style.cssText =
      'position:absolute;top:-1000px;left:-1000px;padding:3px 8px;background:var(--color-surface);border:1px solid var(--color-border);border-radius:6px;font-size:12px;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.15)'
    document.body.appendChild(ghost)
    event.dataTransfer!.setDragImage(ghost, 0, 0)
    requestAnimationFrame(() => document.body.removeChild(ghost))
  }

  function favoriteDragOver(event: DragEvent, targetKey: string): void {
    if (!onReorderFavorite) return
    event.preventDefault()
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    favoriteDropTarget = {
      key: targetKey,
      position: event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
    }
  }

  function favoriteDrop(event: DragEvent, targetKey: string): void {
    if (!onReorderFavorite) return
    event.preventDefault()
    const draggedKey = event.dataTransfer?.getData('text/plain')
    const position = favoriteDropTarget?.key === targetKey ? favoriteDropTarget.position : 'after'
    favoriteDropTarget = null
    draggingFavoriteKey = null
    if (!draggedKey || draggedKey === targetKey) return
    // Display order is the reverse of storage order (favorites are stored
    // oldest-first), so flip before/after before forwarding to the store.
    onReorderFavorite(draggedKey, targetKey, position === 'before' ? 'after' : 'before')
  }

  function clearFavoriteDrag(): void {
    favoriteDropTarget = null
    draggingFavoriteKey = null
  }
</script>

<div class="min-w-0">
  <Popover.Root bind:open onOpenChange={handleOpenChange}>
    <div
      class="min-w-0 {triggerClasses}"
      class:pointer-events-none={disabled}
      class:opacity-50={disabled}
    >
      <Popover.Trigger
        class={modelButtonClasses}
        aria-label={`${multiSelect ? 'Select models' : 'Select model'}, currently ${selectedLabel}`}
        title={`${multiSelect ? 'Select models' : 'Select model'} — ${selectedLabel}`}
        {disabled}
      >
        {#if selectedProvider}
          <span class="flex shrink-0 items-center gap-0.5">
            {@render modelVendorIcons(selectedProvider.harnessId, selectedProvider.name)}
          </span>
        {:else if selectedHarnessIcon}
          {@render harnessIcon(harnessId)}
        {:else}
          <Cpu size={12} />
        {/if}
        <span class="min-w-0 flex-1 truncate text-left">{selectedLabelDisplay}</span>
        {#if selectedPeak}
          <span
            class={`shrink-0 rounded-sm px-1 py-px text-[7px] font-semibold uppercase leading-none ${
              selectedPeak.state === 'peak'
                ? 'bg-amber-500/15 text-amber-500'
                : 'bg-green-500/15 text-green-500'
            }`}
            title={selectedPeak.tooltip}
            aria-label={selectedPeak.tooltip}
          >
            {selectedPeak.triggerLabel}
          </span>
        {/if}
        {#if fast}
          <Zap
            size={11}
            class="shrink-0 text-accent"
            fill="currentColor"
            aria-label="Fast inference"
          />
        {/if}
      </Popover.Trigger>
      {#if supportsThinking}
        <DropdownMenu.Root bind:open={thinkingMenuOpen}>
          <DropdownMenu.Trigger
            class="ml-0.5 mr-1.5 flex shrink-0 items-center gap-1 rounded-md bg-elevated px-1.5 py-0.5 text-[10px] text-dimmed transition-colors hover:bg-overlay hover:text-foreground disabled:cursor-default disabled:opacity-50"
            aria-label={`Thinking level: ${currentThinkingLabel}`}
            title="Thinking level"
            {disabled}
          >
            <Brain size={10} />
            <span class="capitalize">{currentThinkingLabel}</span>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              side="bottom"
              align="start"
              sideOffset={4}
              collisionPadding={12}
              onCloseAutoFocus={(event) => event.preventDefault()}
              class="z-70 w-52 rounded-xl border border-border bg-surface p-1 shadow-xl"
            >
              {#each effectiveThinkingPresets as preset (preset.id)}
                {@const active = thinkingLevel === preset.id}
                <DropdownMenu.Item
                  class="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated {active
                    ? 'text-primary'
                    : ''}"
                  title={preset.description ?? `Set thinking to ${preset.label}`}
                  onSelect={() => {
                    if (!active) onSelectThinking?.(preset.id as ThinkingLevel)
                  }}
                >
                  {#if active}
                    <Check size={11} class="shrink-0 text-primary" />
                  {:else}
                    <span class="w-[11px] shrink-0" aria-hidden="true"></span>
                  {/if}
                  <span class="flex flex-col">
                    <span class="capitalize">{preset.label}</span>
                    {#if preset.description}
                      <span class="text-[10px] font-normal text-muted">{preset.description}</span>
                    {/if}
                  </span>
                </DropdownMenu.Item>
              {/each}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      {/if}
    </div>

    <Popover.Portal>
      <Popover.Content
        {side}
        align="start"
        sideOffset={4}
        collisionPadding={12}
        class="z-70 flex w-64 flex-col overflow-hidden rounded-xl border bg-surface shadow-lg"
        role="dialog"
        aria-label={multiSelect ? 'Select models' : 'Select model'}
        tabindex={-1}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onkeydown={(event: KeyboardEvent) => {
          if (event.key === 'Escape') close()
        }}
      >
        <div class="flex items-center gap-2 border-b px-2.5 py-2">
          <Search size={12} class="shrink-0 text-dimmed" />
          <input
            id={searchId}
            {@attach attachSearchInput}
            bind:value={search}
            oninput={() => scrollPickerListTo(0)}
            type="text"
            class="w-full bg-transparent text-xs text-foreground outline-none placeholder:text-dimmed"
            placeholder="Search models..."
            aria-label="Search models"
            onkeydown={(event: KeyboardEvent) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                keyboardNavActive = true
                scrollPickerListTo(0)
                const firstBtn = document.querySelector(`#${CSS.escape(listId)} .model-row-btn`)
                if (firstBtn instanceof HTMLElement) firstBtn.focus()
                return
              }
              if (event.key === 'Escape') {
                event.stopPropagation()
                close()
              }
            }}
          />
          {#if search}
            <button
              type="button"
              class="shrink-0 text-dimmed transition-colors hover:text-foreground"
              title="Clear model search"
              aria-label="Clear model search"
              onclick={() => (search = '')}
            >
              <X size={11} />
            </button>
          {/if}
          {#if projectId}
            <button
              type="button"
              class="shrink-0 cursor-pointer text-dimmed transition-colors hover:text-foreground disabled:cursor-default disabled:opacity-60"
              title="Refresh model list"
              aria-label="Refresh model list"
              disabled={refreshing}
              onclick={() => void refreshCatalog()}
            >
              <RefreshCw size={12} class={refreshing ? 'animate-spin text-primary' : ''} />
            </button>
          {/if}
        </div>

        {#if harnessOptions.length > 1}
          <div class="border-b px-2.5 py-1.5">
            <div class="flex items-center gap-1.5">
              <button
                type="button"
                class="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] text-muted transition-colors hover:bg-elevated hover:text-foreground"
                aria-expanded={harnessFilterOpen}
                aria-haspopup="true"
                title={harnessFilterOpen
                  ? 'Hide harness filter options'
                  : 'Filter models by harness'}
                onclick={() => (harnessFilterOpen = !harnessFilterOpen)}
              >
                <ListFilter size={11} class="shrink-0 text-dimmed" />
                <span class="truncate">{harnessFilterLabel}</span>
                {#if harnessFilterActive}
                  <span class="ml-auto shrink-0 text-[9px] text-primary">Filtered</span>
                {/if}
              </button>
              {#if harnessFilterActive}
                <button
                  type="button"
                  class="shrink-0 rounded-lg p-1 text-dimmed transition-colors hover:text-foreground"
                  title="Clear harness filter"
                  aria-label="Clear harness filter"
                  onclick={clearHarnessFilter}
                >
                  <X size={11} />
                </button>
              {/if}
            </div>
            {#if harnessFilterOpen}
              <div
                class="mt-1.5 flex flex-wrap gap-1"
                role="group"
                aria-label="Filter models by harness"
              >
                <button
                  type="button"
                  class="flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-medium transition-colors {!harnessFilterActive
                    ? 'border-primary bg-primary text-on-primary'
                    : 'bg-elevated text-muted hover:bg-overlay hover:text-foreground'}"
                  aria-pressed={!harnessFilterActive}
                  onclick={clearHarnessFilter}
                >
                  <ListFilter size={11} class="shrink-0" />
                  All
                </button>
                {#each harnessOptions as option (option.id)}
                  <button
                    type="button"
                    class="flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-medium transition-colors {isHarnessSelected(
                      option.id
                    )
                      ? 'border-primary bg-primary text-on-primary'
                      : 'bg-elevated text-muted hover:bg-overlay hover:text-foreground'}"
                    aria-pressed={isHarnessSelected(option.id)}
                    onclick={() => toggleHarness(option.id)}
                  >
                    {@render harnessIcon(option.id)}
                    <span class="truncate">{option.name}</span>
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        {/if}

        <div
          id={listId}
          {@attach (node) => {
            modelList = node
            const cleanup = measurePickerList(node)
            return () => {
              cleanup()
              if (modelList === node) modelList = undefined
            }
          }}
          class="max-h-60 overflow-y-auto p-1"
        >
          {#if displayProviders.length === 0 && unavailableFavoriteModels.length === 0}
            <p class="px-2 py-2 text-[11px] text-dimmed">No providers connected</p>
          {:else if filteredProviders.length === 0 && favoriteModelsList.length === 0 && recentModelsList.length === 0 && (unavailableFavoriteModels.length === 0 || Boolean(search))}
            <p class="px-2 py-2 text-[11px] text-dimmed">
              {search
                ? `No models match “${search}”${harnessFilterActive ? ' in the selected harnesses' : ''}`
                : visionOnly
                  ? 'No vision-capable models found'
                  : 'No models in the selected harnesses'}
            </p>
          {:else}
            <div style:height={`${pickerLayout.total}px`} style:position="relative">
              {#each pickerVisibleItems.items as item (item.key)}
                <div
                  style:position="absolute"
                  style:left="0"
                  style:right="0"
                  style:top={`${item.offset}px`}
                  style:height={`${PICKER_ROW_HEIGHT[item.kind]}px`}
                  class="overflow-hidden"
                >
                  {@render renderPickerItem(item)}
                </div>
              {/each}
            </div>
          {/if}
        </div>
        {#if multiSelect}
          <div class="flex items-center justify-between gap-2 border-t px-2.5 py-1.5">
            <span class="text-[10px] text-dimmed">
              {selectedModelKeys.length} selected · choose one or more
            </span>
            <button
              type="button"
              class="rounded-md bg-primary px-2.5 py-1 text-[10px] font-medium text-on-primary transition-colors hover:bg-primary-hover"
              title="Finish selecting models"
              onclick={close}
            >
              Done
            </button>
          </div>
        {/if}
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>
</div>

{#snippet harnessIcon(harnessId: string)}
  {#if getAgentIcon(harnessId)}
    <img src={getAgentIcon(harnessId)?.iconUrl} alt="" class="h-3 w-3 shrink-0 object-contain" />
  {:else}
    <SquareTerminal size={12} class="shrink-0" />
  {/if}
{/snippet}

{#snippet modelVendorIcons(harnessId: string, providerName: string)}
  {@render harnessIcon(harnessId)}
  {#if !vendorMatches(harnessId, providerName)}
    <VendorIcon name={providerName} size={12} />
  {/if}
{/snippet}

{#snippet groupHeader(
  Icon: typeof Star,
  id: string,
  text: string,
  iconClass: string,
  count: number
)}
  {@const collapsed = collapsedGroups.has(id)}
  <button
    type="button"
    class="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-elevated"
    aria-expanded={!collapsed}
    title={collapsed ? `Expand ${text}` : `Collapse ${text}`}
    onclick={() => toggleGroup(id)}
  >
    <ChevronRight
      size={11}
      class={`shrink-0 text-dimmed transition-transform ${collapsed ? '' : 'rotate-90'}`}
    />
    <Icon size={10} class={iconClass} />
    <span class="text-[9px] font-semibold uppercase tracking-wide text-muted">{text}</span>
    <span class="ml-auto text-[9px] text-dimmed">{count}</span>
  </button>
{/snippet}

{#snippet divider()}
  <div class="mx-2 my-1 border-t border-border"></div>
{/snippet}

{#snippet providerHeader(provider: ProviderCatalog)}
  {@const collapsed = collapsedGroups.has(provider.harnessId + ':' + provider.id)}
  <button
    type="button"
    class="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-elevated"
    aria-expanded={!collapsed}
    title={collapsed ? `Expand ${provider.name}` : `Collapse ${provider.name}`}
    onclick={() => toggleGroup(provider.harnessId + ':' + provider.id)}
  >
    <ChevronRight
      size={11}
      class={`shrink-0 text-dimmed transition-transform ${collapsed ? '' : 'rotate-90'}`}
    />
    <VendorIcon name={provider.name} size={14} />
    <span class="text-[10px] font-semibold uppercase tracking-wide text-dimmed">
      {provider.name}
    </span>
    {#if provider.catalogStatus === 'unavailable'}
      <span class="ml-auto text-[9px] font-medium text-dimmed">Unavailable</span>
    {:else}
      <span class="ml-auto text-[9px] text-dimmed">{provider.models.length}</span>
    {/if}
  </button>
{/snippet}

{#snippet renderPickerItem(item: PickerListItem & { offset: number })}
  {#if item.kind === 'divider'}
    {@render divider()}
  {:else if item.kind === 'header'}
    {@render groupHeader(item.icon, item.id, item.text, item.iconClass, item.count)}
  {:else if item.kind === 'provider-header'}
    {@render providerHeader(item.provider)}
  {:else if item.kind === 'provider-message'}
    <p class="px-2 py-1.5 text-[10px] leading-relaxed text-dimmed">
      {item.provider.catalogMessage ?? 'The harness model catalog is unavailable.'}
    </p>
  {:else if item.kind === 'unavailable-model'}
    <div class="flex items-center gap-2 rounded-lg px-2 py-1.5 text-dimmed">
      <span class="min-w-0 flex-1">
        <span class="block truncate text-xs">{item.favorite.modelId}</span>
        {#if item.favorite.providerId}
          <span class="block truncate text-[10px]">{item.favorite.providerId}</span>
        {/if}
      </span>
      {#if onToggleFavorite}
        <button
          type="button"
          class="shrink-0 transition-colors hover:text-foreground"
          title="Remove unavailable favorite"
          aria-label={`Remove ${item.favorite.modelId} from favorites`}
          onclick={() =>
            onToggleFavorite(
              item.favorite.providerId,
              item.favorite.modelId,
              item.favorite.harnessId ?? ''
            )}
        >
          <X size={11} />
        </button>
      {/if}
    </div>
  {:else}
    {#if item.favoriteKey !== undefined}
      {@const key = item.favoriteKey}
      <div
        class="relative"
        role="listitem"
        class:opacity-50={draggingFavoriteKey === key}
        draggable={item.draggable}
        ondragstart={(event: DragEvent) => startFavoriteDrag(event, key, item.entry.model.name)}
        ondragover={(event: DragEvent) => favoriteDragOver(event, key)}
        ondrop={(event: DragEvent) => favoriteDrop(event, key)}
        ondragleave={clearFavoriteDrag}
        ondragend={clearFavoriteDrag}
      >
        {#if item.draggable}
          <span
            class="pointer-events-none absolute left-0.5 top-1/2 -translate-y-1/2 text-dimmed"
            aria-hidden="true"
          >
            <GripVertical size={11} />
          </span>
        {/if}
        {@render modelRow(item.entry, item.key, item.draggable)}
        <div
          class="pointer-events-none absolute inset-x-0 top-0 h-0.5 transition-colors {favoriteDropTarget?.key ===
            key && favoriteDropTarget.position === 'before'
            ? 'bg-primary'
            : 'bg-transparent'}"
        ></div>
        <div
          class="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 transition-colors {favoriteDropTarget?.key ===
            key && favoriteDropTarget.position === 'after'
            ? 'bg-primary'
            : 'bg-transparent'}"
        ></div>
      </div>
    {:else}
      {@render modelRow(item.entry, item.key)}
    {/if}
  {/if}
{/snippet}

{#snippet modelRow(entry: ModelEntry, rowKey: string, indent: boolean = false)}
  {@const key = modelKey(entry.provider.harnessId, entry.provider.id, entry.model.id)}
  {@const peak = peakHoursBadgeFor(entry.model.id)}
  <button
    class={`model-row-btn flex w-full flex-col rounded-lg py-1.5 text-left transition-colors hover:bg-elevated focus:bg-elevated focus:outline-none ${indent ? 'pl-4 pr-2' : 'px-2'} ${isSelectedModel(entry) ? 'bg-elevated' : ''} ${keyboardNavActive ? 'pointer-events-none' : ''}`}
    title={`Use ${entry.model.name}`}
    data-model-id={entry.model.id}
    data-model-key={rowKey}
    onclick={() => choose(entry.provider.id, entry.model.id, entry.provider.harnessId)}
    onkeydown={(event: KeyboardEvent) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const currentIndex = pickerModelKeys.indexOf(rowKey)
        if (currentIndex === -1) return
        const targetIndex =
          event.key === 'ArrowDown'
            ? Math.min(currentIndex + 1, pickerModelKeys.length - 1)
            : Math.max(currentIndex - 1, 0)
        if (targetIndex === currentIndex) return
        keyboardNavActive = true
        const targetKey = pickerModelKeys[targetIndex]
        const targetItemIndex = pickerLayout.items.findIndex((item) => item.key === targetKey)
        if (targetItemIndex !== -1) {
          scrollPickerListTo(pickerLayout.offsets[targetItemIndex] - 60)
        }
        void tick().then(() => {
          modelList
            ?.querySelector<HTMLElement>(`[data-model-key="${CSS.escape(targetKey)}"]`)
            ?.focus()
        })
        return
      }
      if (event.key === 'Escape') {
        event.stopPropagation()
        close()
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        choose(entry.provider.id, entry.model.id, entry.provider.harnessId)
        return
      }
      // Editing intent: left/right moves the caret and characters/backspace edit
      // the query. Return focus to the search box so typing continues naturally.
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        focusSearchInput(event.key === 'ArrowLeft' ? -1 : 0)
        return
      }
      if (event.key === 'Backspace') {
        event.preventDefault()
        focusSearchInput(0)
        if (search) {
          search = search.slice(0, -1)
          scrollPickerListTo(0)
        }
        return
      }
      if (event.key === 'Delete') {
        event.preventDefault()
        focusSearchInput(0)
        return
      }
      if (isTypeableKey(event)) {
        event.preventDefault()
        focusSearchInput(0)
        search += event.key
        scrollPickerListTo(0)
        return
      }
    }}
  >
    <span class="flex w-full items-center gap-2">
      <span
        class={`truncate text-xs ${isSelectedModel(entry) ? 'text-primary' : 'text-foreground'}`}
      >
        {entry.model.name}
      </span>
      {#if peak}
        <span
          class={`shrink-0 rounded-sm px-1 py-px text-[7px] font-semibold uppercase leading-none ${
            peak.state === 'peak'
              ? 'bg-amber-500/15 text-amber-500'
              : 'bg-green-500/15 text-green-500'
          }`}
          title={peak.tooltip}
          aria-label={peak.tooltip}
        >
          {peak.label}
        </span>
      {/if}
      <span class="ml-auto flex shrink-0 items-center gap-1 text-[9px] text-dimmed">
        {#if multiSelect && isSelectedModel(entry)}
          <Check size={11} class="text-primary" aria-label="Selected" />
        {/if}
        {#if onToggleFavorite}
          <span
            role="button"
            tabindex="0"
            class={`shrink-0 cursor-pointer transition-colors ${favoriteModelsSet.has(key) ? 'text-amber-400' : 'text-dimmed hover:text-amber-400'}`}
            title={favoriteModelsSet.has(key) ? 'Remove from favorites' : 'Add to favorites'}
            onclick={(event: MouseEvent) => {
              event.stopPropagation()
              onToggleFavorite(entry.provider.id, entry.model.id, entry.provider.harnessId)
            }}
            onkeydown={(event: KeyboardEvent) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.stopPropagation()
                onToggleFavorite(entry.provider.id, entry.model.id, entry.provider.harnessId)
              }
            }}
          >
            <Star
              size={11}
              class={favoriteModelsSet.has(key) ? 'fill-amber-400 text-amber-400' : ''}
            />
          </span>
        {/if}
      </span>
    </span>
    <span class="flex items-center gap-1 truncate text-[10px] text-dimmed">
      {@render modelVendorIcons(entry.provider.harnessId, entry.provider.name)}
      <span class="truncate">{entry.provider.name}</span>
    </span>
  </button>
{/snippet}
