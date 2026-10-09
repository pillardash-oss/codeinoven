<script lang="ts">
  import { tick } from 'svelte'
  import { on } from 'svelte/events'
  import { SvelteSet } from 'svelte/reactivity'
  import {
    Check,
    ChevronRight,
    GripVertical,
    Plug,
    RefreshCw,
    Search,
    Star,
    X
  } from '@lucide/svelte'
  import { modelKey, parseModelKey } from '$lib/model-keys'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'
  import { peakHoursBadgeFor } from '$shared/peak-hours'
  import type { ProviderCatalog } from '$shared/types'
  import ModelPickerRail from './ModelPickerRail.svelte'
  import ModelPickerProfiles from './ModelPickerProfiles.svelte'
  import ModelPickerVendorIcons from './ModelPickerVendorIcons.svelte'
  import {
    buildPickerLayout,
    dedupeModelEntries,
    filterEntries,
    harnessName,
    harnessOrder,
    isTypeableKey,
    modelEntryKey,
    modelHaystack,
    passesVisionFilter,
    pickerIndexForSelectedModel,
    PICKER_ROW_HEIGHT,
    resolveModel,
    searchWords,
    visiblePickerItems,
    type ModelEntry,
    type ModelPickerProfilesGroup,
    type PickerListItem,
    type PickerRailView
  } from './model-picker-helpers'

  interface Props {
    displayProviders: ProviderCatalog[]
    cachedProviders: ProviderCatalog[]
    /**
     * Profiles the side panel lists, built by the model picker from its own props.
     *
     * The list only draws the panel; it does not own the profiles, so a picker that
     * cannot apply one passes `null` and the panel falls back to the harness filter
     * it already owns.
     */
    profiles?: ModelPickerProfilesGroup | null
    /** Restricts the list to one harness. Unset shows every harness as today. */
    harnessFilter?: string | null
    /**
     * Harnesses the current execution target does not have installed (a remote
     * Oven without them). A model can only run where its harness exists, so
     * those harnesses are omitted from the picker entirely: no chip, no model
     * row, and no favorite or recent entry pointing at one.
     */
    unavailableHarnessIds?: ReadonlySet<string> | null
    /** Why those harnesses are unavailable, shown as the chip's and row's title. */
    unavailableHarnessReason?: string | null
    favoriteModels: string[]
    recentModels: string[]
    visionOnly: boolean
    multiSelect: boolean
    selectedModelKeys: string[]
    modelId: string
    providerId: string
    harnessId: string
    canRefresh: boolean
    refreshing: boolean
    onRefresh: () => void
    onChoose: (entry: ModelEntry) => void
    onClose: () => void
    onOpenConnectFlow: () => void
    onToggleFavorite?: (providerId: string, modelId: string, harnessId: string) => void
    onRemoveRecent?: (modelKey: string) => void
    onReorderFavorite?: (
      draggedKey: string,
      targetKey: string,
      position: 'before' | 'after'
    ) => void
  }

  let {
    displayProviders,
    cachedProviders,
    profiles = null,
    harnessFilter = null,
    unavailableHarnessIds = null,
    unavailableHarnessReason = null,
    favoriteModels,
    recentModels,
    visionOnly,
    multiSelect,
    selectedModelKeys,
    modelId,
    providerId,
    harnessId,
    canRefresh,
    refreshing,
    onRefresh,
    onChoose,
    onClose,
    onOpenConnectFlow,
    onToggleFavorite,
    onRemoveRecent,
    onReorderFavorite
  }: Props = $props()

  const pickerId = crypto.randomUUID()
  const searchId = `model-search-${pickerId}`
  const listId = `model-list-${pickerId}`

  let search = $state('')
  let lastFocusedModelKey: string | undefined
  let pickerRoot: HTMLDivElement | undefined
  let searchInput: HTMLInputElement | undefined
  let modelList: HTMLDivElement | undefined
  const collapsedGroups = new SvelteSet<string>()
  /**
   * The rail's selected section. `all` is the picker as it reads today,
   * `favorites` narrows to favorited models, `profiles` swaps the list for the
   * saved profiles surface, and `harness` narrows to one harness's models (the
   * replacement for the old harness filter chips).
   */
  let railView = $state<PickerRailView>({ kind: 'all' })
  let pickerListScrollTop = $state(0)
  let pickerViewport = $state(240)
  /** True right after an arrow-key press, until the mouse physically moves.
   *  CSS `:hover` is geometric   it re-fires on whatever row ends up under a
   *  stationary cursor once the virtual list auto-scrolls for keyboard nav.
   *  While this is true, rows go pointer-events: none so a parked mouse can't
   *  paint a stale `:hover`; a real `mousemove` clears it and hands control
   *  straight back to the mouse. */
  let keyboardNavActive = $state(false)
  /** Key of the favorite currently being dragged, if any. */
  let draggingFavoriteKey = $state<string | null>(null)
  /** Drop target + position for the favorites section, if dragging over a row. */
  let favoriteDropTarget = $state<{ key: string; position: 'before' | 'after' } | null>(null)

  const favoriteModelsSet = $derived(new Set(favoriteModels))
  const selectedModelKeysSet = $derived(new Set(selectedModelKeys))
  const availableModelKeys = $derived(
    new Set(
      [...displayProviders, ...cachedProviders]
        .filter((provider) => passesPropHarnessFilter(provider.harnessId))
        .filter((provider) => !isUnavailableHarness(provider.harnessId))
        .flatMap((provider) =>
          provider.models.map((model) => modelKey(provider.harnessId, provider.id, model.id))
        )
    )
  )
  const unavailableFavoriteModels = $derived(
    favoriteModels
      .filter((key) => !availableModelKeys.has(key))
      .map((key) => {
        const parsed = parseModelKey(key)
        if (!parsed || !passesPropHarnessFilter(parsed.harnessId)) return null
        return { modelKey: key, ...parsed }
      })
      .filter((favorite): favorite is NonNullable<typeof favorite> => favorite !== null)
      .filter((favorite) => !isUnavailableHarness(favorite.harnessId))
  )
  const favoriteModelsList = $derived(
    filterEntries(
      dedupeModelEntries(
        favoriteModels
          .slice()
          .reverse()
          .map((key) => {
            const parsed = parseModelKey(key)
            if (!parsed) return null
            const entry = resolveModel(
              displayProviders,
              cachedProviders,
              parsed.providerId,
              parsed.modelId,
              harnessId,
              parsed.harnessId
            )
            return entry &&
              passesPropHarnessFilter(entry.provider.harnessId) &&
              !isUnavailableHarness(entry.provider.harnessId) &&
              passesVisionFilter(entry.model, visionOnly)
              ? entry
              : null
          })
          .filter((entry): entry is ModelEntry => entry !== null)
      ),
      search
    )
  )
  const recentModelsList = $derived(
    filterEntries(
      dedupeModelEntries(
        recentModels
          .map((key) => {
            const parsed = parseModelKey(key)
            if (!parsed) return null
            const entry = resolveModel(
              displayProviders,
              cachedProviders,
              parsed.providerId,
              parsed.modelId,
              harnessId,
              parsed.harnessId
            )
            return entry &&
              passesPropHarnessFilter(entry.provider.harnessId) &&
              !isUnavailableHarness(entry.provider.harnessId) &&
              passesVisionFilter(entry.model, visionOnly)
              ? entry
              : null
          })
          .filter((entry): entry is ModelEntry => entry !== null)
      ),
      search
    )
  )
  const filteredProviders = $derived.by(() => {
    const words = searchWords(search)
    return displayProviders
      .filter((provider) => passesPropHarnessFilter(provider.harnessId))
      .filter((provider) => !isUnavailableHarness(provider.harnessId))
      .filter((provider) => passesRailHarness(provider.harnessId))
      .map((provider) => ({
        ...provider,
        models:
          words.length === 0
            ? provider.models.filter((model) => passesVisionFilter(model, visionOnly))
            : provider.models.filter(
                (model) =>
                  passesVisionFilter(model, visionOnly) &&
                  words.every((word) => modelHaystack(provider, model).includes(word))
              )
      }))
      .filter(
        (provider) =>
          provider.models.length > 0 ||
          (words.length === 0 && provider.catalogStatus === 'unavailable')
      )
  })
  /**
   * Harnesses present in the current catalog, ordered by the canonical harness
   * registry (via `providerStore.providers`) so omitting a harness   or a custom
   * provider being appended to the catalog tail   never reshuffles the chips.
   */
  const harnessOptions = $derived(
    Array.from(
      new Map(
        displayProviders
          .filter((provider) => passesPropHarnessFilter(provider.harnessId))
          .filter((provider) => !isUnavailableHarness(provider.harnessId))
          .map((provider) => provider.harnessId)
          .map((entryHarnessId) => [entryHarnessId, harnessName(entryHarnessId)])
      )
    )
      .map(([id, name]) => ({
        id,
        name,
        ...(isUnavailableHarness(id)
          ? {
              unavailable: true,
              ...(unavailableHarnessReason ? { reason: unavailableHarnessReason } : {})
            }
          : {})
      }))
      .sort((left, right) => harnessOrder(left.id) - harnessOrder(right.id))
  )
  /** True while the user has favorited models, which decides the star rail item. */
  const hasFavorites = $derived(favoriteModels.length > 0)
  /** True while this picker can apply profiles, which decides the profiles rail item. */
  const showProfilesRail = $derived(profiles !== null)
  /** Harness icons are worth a rail section only when there is a choice to make. */
  const showHarnessesRail = $derived(harnessOptions.length > 1)
  // Match the rail's buttons, gaps, padding, and separator; the model list
  // fills this height instead of forcing the dropdown to its maximum.
  const railHeight = $derived.by(() => {
    const fixed = 1 + Number(hasFavorites) + Number(showProfilesRail)
    const harnesses = showHarnessesRail ? Math.min(harnessOptions.length, 7) : 0
    const outerGaps = harnesses ? fixed + 1 : fixed - 1
    const harnessGaps = Math.max(0, harnesses - 1)
    const rem =
      (fixed + harnesses) * 2 + (outerGaps + harnessGaps) * 0.125 + 1 + (harnesses ? 0.5 : 0)
    return `calc(${rem}rem + ${harnesses ? 1 : 0}px)`
  })
  /**
   * The rail section actually driving the list. A view whose content vanished
   * (last favorite removed, profiles hidden, harness gone from the catalog)
   * falls back to `all` rather than stranding the list on an empty section.
   */
  const effectiveView = $derived.by<PickerRailView>(() => {
    const current: PickerRailView = railView
    if (current.kind === 'favorites' && !hasFavorites) return { kind: 'all' }
    if (current.kind === 'profiles' && !showProfilesRail) return { kind: 'all' }
    if (
      current.kind === 'harness' &&
      !harnessOptions.some((option) => option.id === current.harnessId)
    ) {
      return { kind: 'all' }
    }
    return current
  })
  const isProfilesView = $derived(effectiveView.kind === 'profiles')
  const pickerLayout = $derived(
    buildPickerLayout({
      favoriteModelsList:
        effectiveView.kind === 'favorites'
          ? favoriteModelsList
          : effectiveView.kind === 'all'
            ? favoriteModelsList
            : [],
      recentModelsList: effectiveView.kind === 'all' ? recentModelsList : [],
      unavailableFavoriteModels:
        effectiveView.kind === 'favorites' || effectiveView.kind === 'all'
          ? unavailableFavoriteModels
          : [],
      filteredProviders:
        effectiveView.kind === 'all' || effectiveView.kind === 'harness' ? filteredProviders : [],
      collapsedGroups,
      search,
      canReorderFavorites: Boolean(onReorderFavorite)
    })
  )
  /** Flat, ordered keys of every selectable model row, for keyboard navigation. */
  const pickerModelKeys = $derived(
    pickerLayout.items
      .filter((item): item is Extract<PickerListItem, { kind: 'model' }> => item.kind === 'model')
      .filter((item) => !isUnavailableHarness(item.entry.provider.harnessId))
      .map((item) => item.key)
  )
  const pickerVisibleItems = $derived(
    visiblePickerItems(pickerLayout, pickerListScrollTop, pickerViewport)
  )

  /** The rail's harness section narrows the list to one harness; every other
   *  section shows every harness the caller allows. */
  function passesRailHarness(candidateHarnessId: string): boolean {
    if (effectiveView.kind !== 'harness') return true
    return candidateHarnessId === effectiveView.harnessId
  }

  /** Restrict to the caller-supplied harness. Unset/null is a no-op. */
  function passesPropHarnessFilter(candidateHarnessId: string): boolean {
    return !harnessFilter || candidateHarnessId === harnessFilter
  }

  /** True when the current target cannot run this harness's models. */
  function isUnavailableHarness(candidateHarnessId: string): boolean {
    return unavailableHarnessIds?.has(candidateHarnessId) === true
  }

  function unavailableHarnessTitle(candidateHarnessId: string): string {
    return unavailableHarnessReason ?? `${harnessName(candidateHarnessId)} is not available here`
  }

  /** Select a rail section without stealing focus from its button. */
  function selectRailView(next: PickerRailView): void {
    railView = next
    lastFocusedModelKey = undefined
    scrollPickerListTo(0)
  }

  /**
   * Whether a row is the currently selected model. The selected model is fully
   * identified by the (harnessId, providerId, modelId) triple   never by modelId
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

  function toggleGroup(id: string): void {
    if (collapsedGroups.has(id)) collapsedGroups.delete(id)
    else collapsedGroups.add(id)
  }

  /** Scroll the virtual list to a pixel offset (state + DOM stay in sync). */
  function scrollPickerListTo(top: number): void {
    pickerListScrollTop = Math.max(0, top)
    if (modelList) modelList.scrollTop = pickerListScrollTop
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

  /** Row key of the currently selected model, if it is listed. */
  function pickerKeyForSelectedModel(): string | undefined {
    const index = pickerIndexForSelectedModel(pickerLayout.items, modelId, providerId, harnessId)
    return index === undefined ? undefined : pickerLayout.items[index]?.key
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

  /** Open the profiles rail section, for a caller that asked for profiles directly. */
  export function openProfilesPanel(): void {
    if (!profiles) return
    railView = { kind: 'profiles' }
    scrollPickerListTo(0)
  }

  /** Reset the list surface when the popover opens or closes. */
  export function resetPicker(): void {
    search = ''
    lastFocusedModelKey = undefined
    railView = { kind: 'all' }
    pickerListScrollTop = 0
    keyboardNavActive = false
  }

  /** Focus the search box once the popover has rendered. */
  export function focusPickerSearch(): void {
    searchInput?.focus()
  }

  /** Focus the selected row after virtualized entries have rendered. */
  export async function focusPickerEntries(): Promise<void> {
    if (isProfilesView) {
      const active = pickerRoot?.querySelector<HTMLElement>(
        '[data-picker-entry][aria-pressed="true"]'
      )
      const first = pickerRoot?.querySelector<HTMLElement>('ul [data-picker-entry]:not(:disabled)')
      const fallback = pickerRoot?.querySelector<HTMLElement>('[data-picker-entry]:not(:disabled)')
      ;(active ?? first ?? fallback)?.focus()
      return
    }
    const selectedKey = lastFocusedModelKey ?? (search ? undefined : pickerKeyForSelectedModel())
    const targetKey =
      selectedKey && pickerModelKeys.includes(selectedKey) ? selectedKey : pickerModelKeys[0]
    if (targetKey) {
      const index = pickerLayout.items.findIndex((item) => item.key === targetKey)
      if (index >= 0) scrollPickerListTo(pickerLayout.offsets[index] - 60)
      await tick()
      keyboardNavActive = true
      modelList?.querySelector<HTMLElement>(`[data-model-key="${CSS.escape(targetKey)}"]`)?.focus()
    } else {
      searchInput?.focus()
    }
  }

  function onPickerKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.isComposing) return
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    if (target.closest('input, textarea, [contenteditable="true"]')) return
    const inRail = Boolean(target.closest('nav'))
    if (keymapState.matches('palette-model-rail', event) && !inRail) {
      event.preventDefault()
      pickerRoot?.querySelector<HTMLElement>('nav button[aria-current="true"]')?.focus()
      return
    }
    if (keymapState.matches('palette-model-entries', event) && inRail) {
      event.preventDefault()
      void focusPickerEntries()
      return
    }
    if (keymapState.matches('palette-model-nav', event)) {
      event.preventDefault()
      const entries = Array.from(
        pickerRoot?.querySelectorAll<HTMLButtonElement>(
          inRail ? 'nav button:not(:disabled)' : '[data-picker-entry]:not(:disabled)'
        ) ?? []
      )
      const index = entries.indexOf(target as HTMLButtonElement)
      const next =
        entries[
          Math.max(0, Math.min(entries.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
        ]
      if (next) {
        next.focus()
        next.scrollIntoView({ block: 'nearest' })
        if (inRail) next.click()
      }
      return
    }
    if (isTypeableKey(event)) {
      event.preventDefault()
      if (isProfilesView) railView = { kind: 'all' }
      search += event.key
      scrollPickerListTo(0)
      void tick().then(() => focusSearchInput())
    }
  }

  /** Scroll the selected model into view, if it is listed. */
  export function revealSelectedModel(): void {
    const index = pickerIndexForSelectedModel(pickerLayout.items, modelId, providerId, harnessId)
    if (index === undefined) return
    const offset = pickerLayout.offsets[index]
    if (offset !== undefined) scrollPickerListTo(offset - 60)
  }

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

<div
  role="group"
  aria-label="Model picker"
  {@attach (node) => {
    pickerRoot = node
    const cleanup = on(node, 'keydown', onPickerKeydown)
    return () => {
      cleanup()
      if (pickerRoot === node) pickerRoot = undefined
    }
  }}
  class="flex min-h-0 items-stretch"
  style:height={railHeight}
>
  <ModelPickerRail
    view={effectiveView}
    showFavorites={hasFavorites}
    showProfiles={showProfilesRail}
    {harnessOptions}
    showHarnesses={showHarnessesRail}
    onSelect={selectRailView}
  />

  <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
    {#if isProfilesView}
      {#if profiles}
        <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
          <ModelPickerProfiles {...profiles} />
        </div>
      {/if}
    {:else}
      <div class="flex shrink-0 items-center gap-2 border-b px-2.5 py-2">
        <Search size={12} class="shrink-0 text-dimmed" />
        <input
          id={searchId}
          {@attach attachSearchInput}
          bind:value={search}
          oninput={() => scrollPickerListTo(0)}
          type="text"
          class="w-full bg-transparent text-xs text-foreground outline-none placeholder:text-dimmed"
          placeholder={effectiveView.kind === 'favorites'
            ? 'Search favorites...'
            : effectiveView.kind === 'harness'
              ? `Search ${harnessName(effectiveView.harnessId)} models...`
              : 'Search models...'}
          aria-label={effectiveView.kind === 'favorites'
            ? 'Search favorite models'
            : effectiveView.kind === 'harness'
              ? `Search ${harnessName(effectiveView.harnessId)} models`
              : 'Search models'}
          onkeydown={(event: KeyboardEvent) => {
            if (keymapState.matches('palette-model-nav', event)) {
              event.preventDefault()
              keyboardNavActive = true
              // Anchor the first arrow-key press on the active model so nav
              // starts from what's selected, not the top of the list   but
              // once the user has typed a search, "top of the results" is
              // the more useful anchor.
              const targetKey = search ? undefined : pickerKeyForSelectedModel()
              if (targetKey) {
                const targetIndex = pickerLayout.items.findIndex((item) => item.key === targetKey)
                if (targetIndex !== -1) scrollPickerListTo(pickerLayout.offsets[targetIndex] - 60)
                void tick().then(() => {
                  modelList
                    ?.querySelector<HTMLElement>(`[data-model-key="${CSS.escape(targetKey)}"]`)
                    ?.focus()
                })
                return
              }
              scrollPickerListTo(0)
              void tick().then(() => {
                const firstBtn = document.querySelector(`#${CSS.escape(listId)} .model-row-btn`)
                if (firstBtn instanceof HTMLElement) firstBtn.focus()
              })
              return
            }
            if (keymapState.matches('palette-close', event)) {
              event.stopPropagation()
              onClose()
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
        {#if canRefresh}
          <button
            type="button"
            class="shrink-0 cursor-pointer text-dimmed transition-colors hover:text-foreground disabled:cursor-default disabled:opacity-60"
            title="Refresh model list"
            aria-label="Refresh model list"
            disabled={refreshing}
            onclick={onRefresh}
          >
            <RefreshCw size={12} class={refreshing ? 'animate-spin text-primary' : ''} />
          </button>
        {/if}
      </div>

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
        class="min-h-0 flex-1 overflow-y-auto p-1"
        role="group"
        aria-label="Model entries"
      >
        {#if displayProviders.length === 0 && unavailableFavoriteModels.length === 0}
          <div class="px-2 py-2">
            <p class="text-[0.6875rem] text-dimmed">No providers connected</p>
            <button
              type="button"
              class="mt-1.5 inline-flex h-7 items-center gap-1.5 rounded-lg bg-primary px-2.5 text-[0.6875rem] font-semibold text-on-primary transition-colors hover:bg-primary-hover"
              onclick={onOpenConnectFlow}
            >
              <Plug size={12} />
              Connect your AI account
            </button>
          </div>
        {:else if filteredProviders.length === 0 && favoriteModelsList.length === 0 && recentModelsList.length === 0 && (unavailableFavoriteModels.length === 0 || Boolean(search))}
          <p class="px-2 py-2 text-[0.6875rem] text-dimmed">
            {#if effectiveView.kind === 'favorites'}
              {search ? `No favorite models match “${search}”` : 'No favorite models yet'}
            {:else if effectiveView.kind === 'harness'}
              {search
                ? `No ${harnessName(effectiveView.harnessId)} models match “${search}”`
                : visionOnly
                  ? `No vision-capable ${harnessName(effectiveView.harnessId)} models found`
                  : `No ${harnessName(effectiveView.harnessId)} models found`}
            {:else}
              {search
                ? `No models match “${search}”`
                : visionOnly
                  ? 'No vision-capable models found'
                  : 'No models found'}
            {/if}
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
        <div class="flex shrink-0 items-center justify-between gap-2 border-t px-2.5 py-1.5">
          <span class="text-[0.625rem] text-dimmed">
            {selectedModelKeys.length} selected · choose one or more
          </span>
          <button
            type="button"
            class="rounded-md bg-primary px-2.5 py-1 text-[0.625rem] font-medium text-on-primary transition-colors hover:bg-primary-hover"
            title="Finish selecting models"
            onclick={onClose}
          >
            Done
          </button>
        </div>
      {/if}
    {/if}
  </div>
</div>

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
    <span class="text-[0.5625rem] font-semibold uppercase tracking-wide text-muted">{text}</span>
    <span class="ml-auto text-[0.5625rem] text-dimmed">{count}</span>
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
    <VendorIcon name={provider.name} id={provider.id} size={14} />
    <span class="text-[0.625rem] font-semibold uppercase tracking-wide text-dimmed">
      {provider.name}
    </span>
    {#if provider.catalogStatus === 'unavailable'}
      <span class="ml-auto text-[0.5625rem] font-medium text-dimmed">Unavailable</span>
    {:else}
      <span class="ml-auto text-[0.5625rem] text-dimmed">{provider.models.length}</span>
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
    <p class="px-2 py-1.5 text-[0.625rem] leading-relaxed text-dimmed">
      {item.provider.catalogMessage ?? 'The harness model catalog is unavailable.'}
    </p>
  {:else if item.kind === 'unavailable-model'}
    <div class="flex h-full items-center gap-2 rounded-lg px-2 py-1.5 text-dimmed">
      <span class="min-w-0 flex-1">
        <span class="block truncate text-xs">{item.favorite.modelId}</span>
        {#if item.favorite.providerId}
          <span class="block truncate text-[0.625rem]">{item.favorite.providerId}</span>
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
        class="relative h-full"
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
        {@render modelRow(item.entry, item.key)}
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
      {@render modelRow(item.entry, item.key, item.recentKey)}
    {/if}
  {/if}
{/snippet}

{#snippet modelRow(entry: ModelEntry, rowKey: string, recentKey?: string)}
  {@const key = modelKey(entry.provider.harnessId, entry.provider.id, entry.model.id)}
  {@const peak = peakHoursBadgeFor(entry.model.id, entry.provider.id)}
  {@const unavailable = isUnavailableHarness(entry.provider.harnessId)}
  <button
    class={`model-row-btn group/row ml-4 flex h-full w-[calc(100%-1rem)] flex-col justify-center rounded-lg px-2 py-1.5 text-left transition-colors ${unavailable ? 'cursor-not-allowed opacity-50' : 'hover:bg-elevated focus:bg-elevated focus:outline-none'} ${isSelectedModel(entry) ? 'bg-elevated' : ''} ${keyboardNavActive ? 'pointer-events-none' : ''}`}
    title={unavailable
      ? unavailableHarnessTitle(entry.provider.harnessId)
      : `Use ${entry.model.name}`}
    data-model-id={entry.model.id}
    data-model-key={rowKey}
    onfocus={() => (lastFocusedModelKey = rowKey)}
    disabled={unavailable}
    onclick={() => {
      if (!unavailable) onChoose(entry)
    }}
    onkeydown={(event: KeyboardEvent) => {
      if (keymapState.matches('palette-model-nav', event)) {
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
      if (keymapState.matches('palette-close', event)) {
        event.stopPropagation()
        onClose()
        return
      }
      if (keymapState.matches('palette-model-select', event)) {
        event.preventDefault()
        if (!unavailable) onChoose(entry)
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
          class={`shrink-0 rounded-sm px-1 py-px text-[0.4375rem] font-semibold uppercase leading-none ${
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
      <span class="ml-auto flex shrink-0 items-center gap-1 text-[0.5625rem] text-dimmed">
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
              if (keymapState.matches('palette-model-favorite', event)) {
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
        {#if onRemoveRecent && recentKey !== undefined}
          <span
            role="button"
            tabindex="0"
            class="shrink-0 cursor-pointer rounded-sm text-dimmed opacity-0 transition-colors group-hover/row:opacity-100 focus-visible:opacity-100 hover:text-foreground"
            title="Remove from recently used"
            aria-label={`Remove ${entry.model.name} from recently used`}
            onclick={(event: MouseEvent) => {
              event.stopPropagation()
              onRemoveRecent(recentKey)
            }}
            onkeydown={(event: KeyboardEvent) => {
              if (keymapState.matches('palette-model-remove-recent', event)) {
                event.stopPropagation()
                event.preventDefault()
                onRemoveRecent(recentKey)
              }
            }}
          >
            <X size={11} />
          </span>
        {/if}
      </span>
    </span>
    <span class="flex items-center gap-1 truncate text-[0.625rem] text-dimmed">
      <ModelPickerVendorIcons
        harnessId={entry.provider.harnessId}
        providerName={entry.provider.name}
        providerId={entry.provider.id}
      />
      <span class="truncate">{entry.provider.name}</span>
    </span>
  </button>
{/snippet}
