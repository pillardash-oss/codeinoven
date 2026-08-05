<script lang="ts">
  import { tick } from 'svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import {
    ChevronRight,
    Clock,
    Cpu,
    ListFilter,
    Search,
    Star,
    SquareTerminal,
    Zap,
    X
  } from '@lucide/svelte'
  import { getAgentIcon } from '$lib/agent-icons/registry'
  import { providerCatalog } from '$lib/stores/provider-catalog.svelte'
  import { providerStore } from '$lib/stores/providers.svelte'
  import { getVendorSlug } from '$lib/vendor-icons/registry'
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'
  import type { ProviderCatalog, ProviderModel } from '$shared/types'

  interface Props {
    providers: ProviderCatalog[]
    harnessId: string
    providerId: string
    modelId: string
    favoriteModels?: string[]
    recentModels?: string[]
    /** True while the picker is open — opening it refreshes the catalog. */
    open?: boolean
    /** Project whose harness catalog this picker displays. When provided, opening
     *  the picker lazily fetches that project's catalog (network only when stale). */
    projectId?: string | null
    side?: 'top' | 'bottom'
    disabled?: boolean
    variant?: 'compact' | 'field' | 'action'
    label?: string
    responsiveLabel?: boolean
    /** Shows that the selected model is using its fast inference tier. */
    fast?: boolean
    onSelect: (providerId: string, modelId: string, harnessId: string) => void
    onToggleFavorite?: (providerId: string, modelId: string) => void
  }

  let {
    providers,
    harnessId,
    providerId,
    modelId,
    favoriteModels = [],
    recentModels = [],
    open = $bindable(false),
    projectId = null,
    side = 'top',
    disabled = false,
    variant = 'compact',
    label,
    responsiveLabel = false,
    fast = false,
    onSelect,
    onToggleFavorite
  }: Props = $props()

  const pickerId = crypto.randomUUID()
  const searchId = `model-search-${pickerId}`
  const listId = `model-list-${pickerId}`
  let search = $state('')
  const collapsedGroups = new SvelteSet<string>()
  let favoriteModelsSet = $derived(new Set(favoriteModels))
  /**
   * Catalogs displayed by this picker. When a project is known, the reactive
   * store cache is preferred so a lazy refresh on open lands immediately;
   * otherwise the caller-supplied `providers` prop is used as-is.
   */
  let displayProviders = $derived(
    projectId ? (providerCatalog.cached(projectId) ?? providers) : providers
  )
  /** Catalogs cached for other projects — lets global favorites/recent models
   * resolve even when the current thread's project catalog is cold or differs. */
  let cachedProviders = $derived(providerCatalog.allCached())
  const selectedHarnesses = new SvelteSet<string>()
  let showAllHarnesses = $state(false)
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
   * Snapshot fallback so the trigger renders instantly, before any harness
   * catalog resolves: the thread's stored harness icon is always available, and
   * the label degrades from the catalog's display name to the raw model id.
   * The catalog enriches these optimistically once it lands.
   */
  let selectedHarnessIcon = $derived(getAgentIcon(harnessId))
  let selectedLabel = $derived(label ?? selectedModel?.name ?? (modelId || 'Model'))
  let availableModelKeys = $derived(
    new Set(
      [...displayProviders, ...cachedProviders].flatMap((provider) =>
        provider.models.map((model) => modelKey(provider.id, model.id))
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
  let effectiveHarnessCount = $derived(
    showAllHarnesses ? 0 : selectedHarnesses.size || (harnessId ? 1 : 0)
  )
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
        return { modelKey: key, ...parsed }
      })
  )
  let favoriteModelsList = $derived(
    filterEntries(
      favoriteModels
        .slice()
        .reverse()
        .map((key) => {
          const parsed = parseModelKey(key)
          if (!parsed.providerId) return null
          const entry = resolveModel(parsed.providerId, parsed.modelId)
          return entry && passesHarnessFilter(entry.provider.harnessId) ? entry : null
        })
        .filter((entry): entry is ModelEntry => entry !== null),
      search
    )
  )
  let recentModelsList = $derived(
    filterEntries(
      recentModels
        .map((key) => {
          const parsed = parseModelKey(key)
          if (!parsed.providerId) return null
          const entry = resolveModel(parsed.providerId, parsed.modelId)
          return entry && passesHarnessFilter(entry.provider.harnessId) ? entry : null
        })
        .filter((entry): entry is ModelEntry => entry !== null),
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
            ? provider.models
            : provider.models.filter((model) =>
                words.every((word) => modelHaystack(provider, model).includes(word))
              )
      }))
      .filter(
        (provider) =>
          provider.models.length > 0 ||
          (words.length === 0 && provider.catalogStatus === 'unavailable')
      )
  })
  let triggerClasses = $derived(
    variant === 'field'
      ? 'flex w-full items-center justify-between gap-1 rounded-lg border bg-elevated px-3 py-2 text-sm text-muted transition-colors hover:bg-overlay hover:text-foreground disabled:opacity-50'
      : variant === 'action'
        ? 'flex items-center gap-1 rounded-lg border bg-elevated px-3 py-2 text-xs font-semibold text-muted transition-colors hover:bg-overlay hover:text-foreground disabled:opacity-50'
        : 'flex items-center gap-1 rounded-lg px-2 py-1.5 text-[11px] text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50'
  )

  type ModelEntry = { provider: ProviderCatalog; model: ProviderModel }

  function modelKey(nextProviderId: string, nextModelId: string): string {
    return `${nextProviderId}:${nextModelId}`
  }

  /**
   * Whether a row is the currently selected model. The selected model is fully
   * identified by the (harnessId, providerId, modelId) triple — never by modelId
   * alone, since different providers (e.g. DeepSeek vs OpenCode Go) can expose
   * models sharing the same id.
   */
  function isSelectedModel(entry: ModelEntry): boolean {
    return (
      entry.model.id === modelId &&
      entry.provider.id === providerId &&
      entry.provider.harnessId === harnessId
    )
  }

  /** Render identity is harness-scoped even though legacy favorite keys are not. */
  function modelEntryKey(entry: ModelEntry): string {
    return `${entry.provider.harnessId}:${entry.provider.id}:${entry.model.id}`
  }

  function parseModelKey(key: string): { providerId: string; modelId: string } {
    const separator = key.indexOf(':')
    return separator === -1
      ? { providerId: '', modelId: key }
      : { providerId: key.slice(0, separator), modelId: key.slice(separator + 1) }
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
    if (selectedHarnesses.size === 0) return candidateHarnessId === harnessId
    return selectedHarnesses.has(candidateHarnessId)
  }

  function isHarnessSelected(candidateHarnessId: string): boolean {
    return !showAllHarnesses && passesHarnessFilter(candidateHarnessId)
  }

  function toggleHarness(nextHarnessId: string): void {
    if (showAllHarnesses) showAllHarnesses = false
    if (selectedHarnesses.size === 0 && harnessId) selectedHarnesses.add(harnessId)
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

  function filterEntries(entries: ModelEntry[], value: string): ModelEntry[] {
    const words = searchWords(value)
    return words.length === 0
      ? entries
      : entries.filter(({ provider, model }) =>
          words.every((word) => modelHaystack(provider, model).includes(word))
        )
  }

  /** Resolve a model key against the current catalog first, then cached catalogs. */
  function resolveModel(providerId: string, modelId: string): ModelEntry | null {
    return (
      findModelEntry(displayProviders, providerId, modelId) ??
      findModelEntry(cachedProviders, providerId, modelId)
    )
  }

  function findModelEntry(
    catalogs: ProviderCatalog[],
    providerId: string,
    modelId: string
  ): ModelEntry | null {
    const provider =
      catalogs.find(
        (candidate) => candidate.id === providerId && candidate.harnessId === harnessId
      ) ?? catalogs.find((candidate) => candidate.id === providerId)
    if (!provider) return null
    const model = provider.models.find((candidate) => candidate.id === modelId)
    return model ? { provider, model } : null
  }

  $effect(() => {
    if (open) {
      void tick().then(() => {
        document.getElementById(searchId)?.focus()
        document
          .getElementById(listId)
          ?.querySelector(`[data-model-id="${CSS.escape(modelId)}"]`)
          ?.scrollIntoView({ block: 'nearest' })
      })
      // Opening the picker revalidates the catalog in the background. The store
      // is warmed eagerly at app start for every project, so this almost always
      // resolves from the fresh cache instantly; a stale or failed hydration is
      // the only case where it actually contacts the harness drivers.
      if (projectId) {
        void providerCatalog.refresh(projectId)
      }
    }
  })

  function close(): void {
    open = false
    search = ''
    harnessFilterOpen = false
    selectedHarnesses.clear()
    showAllHarnesses = false
  }

  function show(): void {
    if (disabled) return
    selectedHarnesses.clear()
    showAllHarnesses = false
    open = true
    search = ''
  }

  function toggle(): void {
    if (open) close()
    else show()
  }

  function choose(nextProviderId: string, nextModelId: string, nextHarnessId: string): void {
    close()
    onSelect(nextProviderId, nextModelId, nextHarnessId)
  }

  function toggleGroup(id: string): void {
    if (collapsedGroups.has(id)) collapsedGroups.delete(id)
    else collapsedGroups.add(id)
  }
</script>

<div class="relative">
  <button
    type="button"
    class={triggerClasses}
    aria-label={`Select model, currently ${selectedLabel}`}
    title={`Select model — ${selectedLabel}`}
    {disabled}
    onclick={toggle}
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
    <span class="min-w-0 flex-1 truncate text-left" class:responsive-model-label={responsiveLabel}
      >{selectedLabel}</span
    >
    {#if fast}
      <Zap size={11} class="shrink-0 text-accent" fill="currentColor" aria-label="Fast inference" />
    {/if}
  </button>

  {#if open}
    <button
      class="fixed inset-0 z-30 cursor-default"
      aria-label="Close model picker"
      title="Close model picker"
      onclick={close}
    ></button>
    <div
      class={`absolute left-0 z-40 flex w-64 flex-col overflow-hidden rounded-xl border bg-surface shadow-lg ${side === 'top' ? 'bottom-full mb-1' : 'top-full mt-1'}`}
      role="dialog"
      aria-label="Select model"
      tabindex="-1"
      onkeydown={(event: KeyboardEvent) => {
        if (event.key === 'Escape') close()
      }}
    >
      <div class="flex items-center gap-2 border-b px-2.5 py-2">
        <Search size={12} class="shrink-0 text-dimmed" />
        <input
          id={searchId}
          bind:value={search}
          type="text"
          class="w-full bg-transparent text-xs text-foreground outline-none placeholder:text-dimmed"
          placeholder="Search models..."
          aria-label="Search models"
          onkeydown={(event: KeyboardEvent) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
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
      </div>

      {#if harnessOptions.length > 1}
        <div class="border-b px-2.5 py-1.5">
          <div class="flex items-center gap-1.5">
            <button
              type="button"
              class="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] text-muted transition-colors hover:bg-elevated hover:text-foreground"
              aria-expanded={harnessFilterOpen}
              aria-haspopup="true"
              title={harnessFilterOpen ? 'Hide harness filter options' : 'Filter models by harness'}
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

      <div id={listId} class="max-h-60 overflow-y-auto p-1">
        {#if displayProviders.length === 0 && unavailableFavoriteModels.length === 0}
          <p class="px-2 py-2 text-[11px] text-dimmed">No providers connected</p>
        {:else if filteredProviders.length === 0 && favoriteModelsList.length === 0 && recentModelsList.length === 0 && (unavailableFavoriteModels.length === 0 || Boolean(search))}
          <p class="px-2 py-2 text-[11px] text-dimmed">
            {search
              ? `No models match “${search}”${harnessFilterActive ? ' in the selected harnesses' : ''}`
              : 'No models in the selected harnesses'}
          </p>
        {:else}
          {#if favoriteModelsList.length > 0}
            {@render groupLabel(Star, 'Favorites', 'text-amber-400')}
            {#each favoriteModelsList as entry (modelEntryKey(entry))}
              {@render modelRow(entry)}
            {/each}
            {@render divider()}
          {/if}

          {#if recentModelsList.length > 0}
            {@render groupLabel(Clock, 'Recently used', 'text-muted')}
            {#each recentModelsList as entry (modelEntryKey(entry))}
              {@render modelRow(entry)}
            {/each}
            {@render divider()}
          {/if}

          {#if unavailableFavoriteModels.length > 0 && !search}
            {@render groupLabel(Star, 'Unavailable favorites', 'text-dimmed')}
            {#each unavailableFavoriteModels as favorite (favorite.modelKey)}
              <div class="flex items-center gap-2 rounded-lg px-2 py-1.5 text-dimmed">
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-xs">{favorite.modelId}</span>
                  {#if favorite.providerId}
                    <span class="block truncate text-[10px]">{favorite.providerId}</span>
                  {/if}
                </span>
                {#if onToggleFavorite}
                  <button
                    type="button"
                    class="shrink-0 transition-colors hover:text-foreground"
                    title="Remove unavailable favorite"
                    aria-label={`Remove ${favorite.modelId} from favorites`}
                    onclick={() => onToggleFavorite(favorite.providerId, favorite.modelId)}
                  >
                    <X size={11} />
                  </button>
                {/if}
              </div>
            {/each}
            {@render divider()}
          {/if}

          {#each filteredProviders as provider (provider.harnessId + ':' + provider.id)}
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
            {#if !collapsed}
              {#if provider.catalogStatus === 'unavailable'}
                <p class="px-2 py-1.5 text-[10px] leading-relaxed text-dimmed">
                  {provider.catalogMessage ?? 'The harness model catalog is unavailable.'}
                </p>
              {:else}
                {#each provider.models as model (model.id)}
                  {@render modelRow({ provider, model })}
                {/each}
              {/if}
            {/if}
          {/each}
        {/if}
      </div>
    </div>
  {/if}
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

{#snippet groupLabel(Icon: typeof Star, text: string, iconClass: string)}
  <div class="flex items-center gap-1.5 px-2 pb-1 pt-1.5">
    <Icon size={10} class={iconClass} />
    <span class="text-[9px] font-semibold uppercase tracking-wide text-muted">{text}</span>
  </div>
{/snippet}

{#snippet divider()}
  <div class="mx-2 my-1 border-t border-border"></div>
{/snippet}

{#snippet modelRow(entry: ModelEntry)}
  {@const key = modelKey(entry.provider.id, entry.model.id)}
  <button
    class={`model-row-btn flex w-full flex-col rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-elevated ${isSelectedModel(entry) ? 'bg-elevated' : ''}`}
    title={`Use ${entry.model.name}`}
    data-model-id={entry.model.id}
    onclick={() => choose(entry.provider.id, entry.model.id, entry.provider.harnessId)}
    onkeydown={(event: KeyboardEvent) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const buttons = document.querySelectorAll(`#${CSS.escape(listId)} .model-row-btn`)
        const currentIndex = Array.from(buttons).indexOf(event.currentTarget as HTMLElement)
        const nextIndex =
          event.key === 'ArrowDown'
            ? Math.min(currentIndex + 1, buttons.length - 1)
            : Math.max(currentIndex - 1, 0)
        const next = buttons[nextIndex] as HTMLElement
        if (next) next.focus()
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
    }}
  >
    <span class="flex w-full items-center gap-2">
      <span
        class={`truncate text-xs ${isSelectedModel(entry) ? 'text-primary' : 'text-foreground'}`}
      >
        {entry.model.name}
      </span>
      <span class="ml-auto flex shrink-0 items-center gap-1 text-[9px] text-dimmed">
        {#if onToggleFavorite}
          <span
            role="button"
            tabindex="0"
            class={`shrink-0 cursor-pointer transition-colors ${favoriteModelsSet.has(key) ? 'text-amber-400' : 'text-dimmed hover:text-amber-400'}`}
            title={favoriteModelsSet.has(key) ? 'Remove from favorites' : 'Add to favorites'}
            onclick={(event: MouseEvent) => {
              event.stopPropagation()
              onToggleFavorite(entry.provider.id, entry.model.id)
            }}
            onkeydown={(event: KeyboardEvent) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.stopPropagation()
                onToggleFavorite(entry.provider.id, entry.model.id)
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

<style>
  @container (max-width: 520px) {
    .responsive-model-label {
      display: none;
    }
  }
</style>
