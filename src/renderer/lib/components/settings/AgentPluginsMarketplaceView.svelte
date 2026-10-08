<script lang="ts">
  import {
    cachedAgentPluginIcon,
    cachedAgentPluginMarketplaces,
    cachedAgentPluginPage,
    invalidateAgentPluginMarket,
    loadAgentPluginDetail,
    loadAgentPluginIcon,
    preloadAgentPluginIcons,
    refreshAgentPluginMarketplaces,
    refreshAgentPluginPage,
    shouldRefreshSourcesOnOpen,
    type PluginMarketView
  } from '$lib/agent-plugin-cache'
  import { invoke } from '$lib/ipc.svelte'
  import { pluginInitials } from '$lib/plugin-identity'
  import type { AgentPluginMarketEntry, AgentPluginMarketplace } from '$shared/types'
  import {
    Bookmark,
    ChevronDown,
    Download,
    Loader2,
    PackagePlus,
    RefreshCw,
    Search,
    Trash2,
    X
  } from '@lucide/svelte'
  import { Popover } from 'bits-ui'
  import { onMount } from 'svelte'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'

  interface Props {
    onOpenPlugin: (pluginId: string) => void
  }
  let { onOpenPlugin }: Props = $props()

  const VIEWS: Array<{ id: PluginMarketView; label: string }> = [
    { id: 'discover', label: 'Discover' },
    { id: 'bookmarks', label: 'Bookmarks' },
    { id: 'installed', label: 'Installed' }
  ]

  /** The page the user was last on paints from cache before anything is fetched. */
  const firstCachedPage = cachedAgentPluginPage('discover')
  let view = $state<PluginMarketView>('discover')
  let entries = $state.raw<AgentPluginMarketEntry[]>(firstCachedPage?.entries ?? [])
  let hasMore = $state(firstCachedPage?.hasMore ?? false)
  let marketplaces = $state.raw<AgentPluginMarketplace[]>(cachedAgentPluginMarketplaces() ?? [])
  let marketplacesOpen = $state(false)
  let query = $state('')
  let searchQuery = $state('')
  let marketUrl = $state('')
  let platform = $state<'codex' | 'claude'>('codex')
  let loading = $state(firstCachedPage === null)
  let loadingMore = $state(false)
  let busyId = $state('')
  let error = $state('')
  let marketplaceRemoveTarget = $state<AgentPluginMarketplace | null>(null)
  /** Every request carries a sequence so a slow response cannot replace newer results. */
  let requestSequence = 0

  function iconFor(pluginId: string): string | null | undefined {
    return cachedAgentPluginIcon(pluginId)
  }

  /** Warm the logos a page is about to show, in the cache's own small batches. */
  function warmPageIcons(pageEntries: readonly AgentPluginMarketEntry[]): void {
    void preloadAgentPluginIcons(
      pageEntries.filter((entry) => entry.iconUrl).map((entry) => entry.id)
    )
  }

  function warmDetail(pluginId: string): void {
    void loadAgentPluginDetail(pluginId).catch(() => undefined)
    void loadAgentPluginIcon(pluginId).catch(() => undefined)
  }

  function applyPage(pageEntries: AgentPluginMarketEntry[], nextHasMore: boolean): void {
    entries = pageEntries
    hasMore = nextHasMore
    warmPageIcons(pageEntries)
  }

  async function loadView(nextView: PluginMarketView, resetQuery = false): Promise<void> {
    const sequence = ++requestSequence
    view = nextView
    if (resetQuery) {
      query = ''
      searchQuery = ''
    }
    error = ''
    const cached = cachedAgentPluginPage(nextView)
    if (cached) {
      applyPage(cached.entries, cached.hasMore)
      loading = false
    } else {
      entries = []
      hasMore = false
      loading = true
    }
    try {
      const refreshed = await refreshAgentPluginPage(nextView)
      if (sequence !== requestSequence || view !== nextView) return
      applyPage(refreshed.entries, refreshed.hasMore)
    } catch (cause) {
      if (sequence !== requestSequence) return
      error = cause instanceof Error ? cause.message : 'Could not load plugins.'
    } finally {
      if (sequence === requestSequence) loading = false
    }
  }

  async function searchPlugins(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    const nextQuery = query.trim()
    if (nextQuery.length < 2) return
    const sequence = ++requestSequence
    searchQuery = nextQuery
    loading = true
    error = ''
    try {
      const found = await invoke('plugins:list', nextQuery, 0, 40, view)
      if (sequence !== requestSequence) return
      applyPage(found, found.length === 40)
    } catch (cause) {
      if (sequence !== requestSequence) return
      error = cause instanceof Error ? cause.message : 'Plugin search failed.'
    } finally {
      if (sequence === requestSequence) loading = false
    }
  }

  async function clearSearch(): Promise<void> {
    if (!searchQuery) return
    await loadView(view, true)
  }

  async function loadMore(): Promise<void> {
    loadingMore = true
    error = ''
    try {
      const nextPage = await invoke('plugins:list', searchQuery, entries.length, 40, view)
      const combined = [...entries, ...nextPage]
      entries = combined
      hasMore = nextPage.length === 40
      warmPageIcons(nextPage)
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not load more plugins.'
    } finally {
      loadingMore = false
    }
  }

  async function addMarketplace(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    if (!marketUrl.trim()) return
    busyId = 'add-source'
    error = ''
    try {
      await invoke('plugins:addMarketplace', { url: marketUrl.trim(), platform })
      marketUrl = ''
      marketplaces = await refreshAgentPluginMarketplaces()
      await invalidateAgentPluginMarket()
      await loadView(view)
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not add this source.'
    } finally {
      busyId = ''
    }
  }

  async function removeMarketplace(): Promise<void> {
    const marketplace = marketplaceRemoveTarget
    if (!marketplace) return
    busyId = marketplace.id
    error = ''
    try {
      await invoke('plugins:removeMarketplace', marketplace.id)
      marketplaceRemoveTarget = null
      marketplaces = await refreshAgentPluginMarketplaces()
      await invalidateAgentPluginMarket()
      await loadView(view)
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not remove this source.'
    } finally {
      busyId = ''
    }
  }

  async function refreshSources(options: { silent?: boolean } = {}): Promise<void> {
    if (!options.silent) busyId = 'refresh'
    error = ''
    try {
      const sources = await refreshAgentPluginMarketplaces()
      await Promise.allSettled(
        sources.map((source) =>
          invoke('plugins:addMarketplace', { url: source.url, platform: source.platform })
        )
      )
      marketplaces = await refreshAgentPluginMarketplaces()
      await invalidateAgentPluginMarket()
      await loadView(view)
    } catch (cause) {
      // A silent open-time refresh only speaks up when it leaves the page empty.
      if (!options.silent || entries.length === 0) {
        error = cause instanceof Error ? cause.message : 'Could not refresh sources.'
      }
    } finally {
      if (!options.silent) busyId = ''
    }
  }

  async function toggleBookmark(entry: AgentPluginMarketEntry): Promise<void> {
    await invoke('plugins:setBookmarked', entry.id, !entry.bookmarked)
    await invalidateAgentPluginMarket()
    await loadView(view)
  }

  async function install(entry: AgentPluginMarketEntry): Promise<void> {
    busyId = entry.id
    error = ''
    try {
      await invoke('plugins:install', entry.id)
      await invalidateAgentPluginMarket(entry.id)
      await loadView(view)
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not install this plugin.'
    } finally {
      busyId = ''
    }
  }

  function platformLabel(value: AgentPluginMarketEntry['platform']): string {
    return value === 'claude' ? 'Claude Code' : 'Codex'
  }

  function statusLabel(entry: AgentPluginMarketEntry): string {
    if (!entry.supported) return entry.unsupportedReason ?? 'Unsupported source'
    if (entry.updateAvailable) return 'Update available'
    if (entry.installed) return 'Installed'
    return entry.components.length ? entry.components.join(', ') : 'Tools for agents'
  }

  onMount(() => {
    void loadView('discover')
    if (shouldRefreshSourcesOnOpen()) {
      // A source whose catalog was never fetched would list nothing, so the first
      // open of the run re-reads them; the stored catalogs serve every open after.
      void refreshSources({ silent: true })
    } else {
      void refreshAgentPluginMarketplaces()
        .then((sources) => {
          marketplaces = sources
        })
        .catch(() => undefined)
    }
    // A page of the other views is warmed so switching tabs is instant.
    for (const item of VIEWS) {
      if (item.id !== 'discover') void refreshAgentPluginPage(item.id).catch(() => undefined)
    }
  })
</script>

<div class="h-full min-h-0 overflow-hidden">
  <div class="flex h-full min-h-0 flex-col px-6 pt-6">
    <div class="shrink-0 pb-3">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 class="text-xl font-bold tracking-tight">Plugin marketplace</h1>
          <p class="mt-1 text-sm text-muted">
            Installed capabilities join the tool gateway, so every harness you use can reach them.
          </p>
        </div>
        <div class="flex items-center gap-2">
          <Popover.Root bind:open={marketplacesOpen}>
            <Popover.Trigger
              class="flex h-8 items-center gap-1.5 rounded-lg border bg-elevated px-2.5 text-xs font-medium hover:bg-overlay"
              title="Manage plugin sources"
              aria-label="Manage plugin sources"
            >
              Sources
              <span class="tabular-nums text-dimmed">{marketplaces.length}</span>
              <ChevronDown size={13} />
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content
                sideOffset={8}
                collisionPadding={16}
                align="end"
                class="z-50 w-96 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border bg-surface shadow-lg"
                aria-label="Plugin sources"
              >
                <div class="max-h-64 overflow-y-auto px-3 py-2">
                  {#if marketplaces.length === 0}
                    <p class="px-1 py-2 text-xs text-dimmed">No sources added yet.</p>
                  {:else}
                    {#each marketplaces as marketplace (marketplace.id)}
                      <div class="flex items-center justify-between gap-3 py-1.5">
                        <div class="min-w-0">
                          <p class="truncate text-xs font-medium">{marketplace.name}</p>
                          <p class="text-[0.6875rem] text-dimmed">
                            {platformLabel(marketplace.platform)} catalog ·
                            {marketplace.pluginCount} plugins
                          </p>
                        </div>
                        <button
                          type="button"
                          class="flex size-7 shrink-0 items-center justify-center rounded-md text-dimmed hover:bg-elevated hover:text-danger"
                          onclick={() => {
                            marketplacesOpen = false
                            marketplaceRemoveTarget = marketplace
                          }}
                          title={`Remove ${marketplace.name} source`}
                          aria-label={`Remove ${marketplace.name} source`}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    {/each}
                  {/if}
                </div>
                <form class="space-y-2 border-t px-3 py-3" onsubmit={addMarketplace}>
                  <label class="block text-[0.6875rem] font-medium text-muted">
                    Add a GitHub source
                    <input
                      class="mt-1 h-8 w-full rounded-md border bg-app px-2.5 text-xs text-foreground"
                      bind:value={marketUrl}
                      placeholder="owner/repository"
                      autocomplete="off"
                    />
                  </label>
                  <label class="block text-[0.6875rem] font-medium text-muted">
                    Catalog format
                    <select
                      class="mt-1 h-8 w-full rounded-md border bg-app px-2.5 text-xs text-foreground"
                      bind:value={platform}
                    >
                      <option value="codex">Codex catalog</option>
                      <option value="claude">Claude Code catalog</option>
                    </select>
                  </label>
                  <button
                    class="flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-on-primary disabled:opacity-50"
                    type="submit"
                    disabled={busyId === 'add-source' || !marketUrl.trim()}
                  >
                    {#if busyId === 'add-source'}<Loader2
                        size={12}
                        class="animate-spin"
                      />{:else}<PackagePlus size={12} />{/if}
                    Add source
                  </button>
                </form>
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
          <button
            class="flex h-8 items-center gap-1.5 rounded-lg border bg-elevated px-2.5 text-xs font-medium hover:bg-overlay disabled:opacity-50"
            type="button"
            title="Refresh every plugin source"
            aria-label="Refresh every plugin source"
            onclick={() => void refreshSources()}
            disabled={busyId === 'refresh'}
          >
            {#if busyId === 'refresh'}<Loader2 size={13} class="animate-spin" />{:else}<RefreshCw
                size={13}
              />{/if}
            Refresh
          </button>
        </div>
      </div>

      <form class="mt-4 flex gap-2" onsubmit={searchPlugins}>
        <label class="relative min-w-0 flex-1">
          <span class="sr-only">Search plugins</span>
          <Search
            size={15}
            class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-dimmed"
          />
          <input
            class="h-10 w-full rounded-xl border bg-surface pl-9 pr-9 text-sm outline-none transition-colors focus:border-primary"
            type="search"
            minlength="2"
            placeholder="Search by plugin, publisher, or repository"
            bind:value={query}
          />
          {#if searchQuery}
            <button
              type="button"
              class="absolute right-2 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-dimmed hover:bg-elevated hover:text-foreground"
              title="Clear search"
              aria-label="Clear search"
              onclick={() => void clearSearch()}
            >
              <X size={13} />
            </button>
          {/if}
        </label>
        <button
          class="flex h-10 items-center gap-1.5 rounded-xl bg-primary px-4 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
          type="submit"
          disabled={loading || query.trim().length < 2}
        >
          {#if loading && searchQuery}<Loader2 size={13} class="animate-spin" />{/if}
          Search
        </button>
      </form>

      <div class="mt-4 flex flex-wrap items-center justify-between gap-3 border-b pb-3">
        <div class="flex items-center gap-1 rounded-lg bg-elevated p-0.5" role="tablist">
          {#each VIEWS as item (item.id)}
            <button
              class="flex h-8 items-center rounded-md px-3 text-xs font-medium transition-colors {view ===
                item.id && !searchQuery
                ? 'bg-surface text-foreground shadow-sm'
                : 'text-muted hover:text-foreground'}"
              type="button"
              role="tab"
              aria-selected={view === item.id && !searchQuery}
              onclick={() => void loadView(item.id, true)}
            >
              {item.label}
            </button>
          {/each}
        </div>
        <p class="text-xs tabular-nums text-muted">
          {searchQuery
            ? `${entries.length} search ${entries.length === 1 ? 'result' : 'results'}`
            : `${entries.length} ${entries.length === 1 ? 'plugin' : 'plugins'}`}
        </p>
      </div>

      {#if error}
        <p class="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
          {error}
        </p>
      {/if}
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto pb-24">
      {#if loading}
        <div class="mt-2 rounded-xl border border-dashed p-10 text-center">
          <Loader2 size={20} class="mx-auto animate-spin text-dimmed" />
          <p class="mt-2 text-xs text-dimmed">Loading plugins…</p>
        </div>
      {:else if entries.length === 0}
        <div class="mt-2 rounded-xl border border-dashed p-10 text-center">
          <Search size={20} class="mx-auto text-dimmed" />
          <p class="mt-2 text-sm font-medium">
            {view === 'bookmarks'
              ? 'No bookmarked plugins'
              : view === 'installed'
                ? 'No plugins installed'
                : searchQuery
                  ? 'No plugins match this search'
                  : 'No sources to browse'}
          </p>
        </div>
      {:else}
        <ul class="divide-y rounded-xl border bg-surface" aria-label="Plugins">
          {#each entries as entry (entry.id)}
            <li class="flex items-center gap-1 pr-2 transition-colors hover:bg-elevated">
              <button
                class="flex min-w-0 flex-1 items-center gap-3 py-3 pl-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
                type="button"
                title={`Open ${entry.displayName}`}
                onpointerenter={() => warmDetail(entry.id)}
                onfocus={() => warmDetail(entry.id)}
                onclick={() => onOpenPlugin(entry.id)}
              >
                <span
                  class="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-elevated text-[0.6875rem] font-semibold uppercase text-muted"
                >
                  {#if iconFor(entry.id)}<img
                      src={iconFor(entry.id)}
                      alt=""
                      class="size-full object-cover"
                    />{:else}{pluginInitials(entry.displayName)}{/if}
                </span>
                <span class="min-w-0 flex-1">
                  <span class="flex items-center gap-2">
                    <span class="truncate text-sm font-semibold">{entry.displayName}</span>
                    {#if entry.installed}
                      <span
                        class="shrink-0 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[0.5625rem] font-semibold uppercase tracking-wide text-emerald-600"
                      >
                        {entry.updateAvailable ? 'Update' : 'Installed'}
                      </span>
                    {/if}
                  </span>
                  <span class="mt-0.5 block truncate text-xs text-muted">
                    {entry.publisher ?? entry.source.repository}
                  </span>
                  <span class="mt-0.5 block truncate text-xs text-dimmed">
                    {statusLabel(entry)}
                  </span>
                </span>
              </button>
              <button
                type="button"
                class="flex size-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-elevated hover:text-foreground"
                onclick={() => void toggleBookmark(entry)}
                title={entry.bookmarked
                  ? `Remove bookmark for ${entry.displayName}`
                  : `Bookmark ${entry.displayName}`}
                aria-label={entry.bookmarked
                  ? `Remove bookmark for ${entry.displayName}`
                  : `Bookmark ${entry.displayName}`}
                aria-pressed={entry.bookmarked}
              >
                <Bookmark size={15} fill={entry.bookmarked ? 'currentColor' : 'none'} />
              </button>
              {#if entry.installed}
                <button
                  type="button"
                  class="h-8 shrink-0 rounded-md border px-3 text-xs hover:bg-elevated"
                  onclick={() => onOpenPlugin(entry.id)}
                  title={`Open ${entry.displayName}`}
                  aria-label={`Open ${entry.displayName}`}
                >
                  Manage
                </button>
              {:else}
                <button
                  type="button"
                  class="flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-on-primary disabled:opacity-50"
                  onclick={() => void install(entry)}
                  disabled={busyId === entry.id || !entry.supported}
                  title={entry.supported
                    ? `Install ${entry.displayName}`
                    : (entry.unsupportedReason ?? 'This plugin cannot be installed')}
                  aria-label={`Install ${entry.displayName}`}
                >
                  {#if busyId === entry.id}<Loader2
                      size={13}
                      class="animate-spin"
                    />{:else}<Download size={13} />{/if}
                  Install
                </button>
              {/if}
            </li>
          {/each}
        </ul>
        {#if hasMore}
          <div class="flex justify-center py-4">
            <button
              type="button"
              class="flex h-9 items-center gap-2 rounded-lg border bg-elevated px-4 text-sm hover:bg-overlay disabled:opacity-50"
              onclick={() => void loadMore()}
              disabled={loadingMore}
            >
              {#if loadingMore}<Loader2 size={14} class="animate-spin" />{/if} Load more plugins
            </button>
          </div>
        {/if}
      {/if}
    </div>
  </div>
</div>

<ConfirmDialog
  open={marketplaceRemoveTarget !== null}
  title={`Remove ${marketplaceRemoveTarget?.name ?? 'source'}?`}
  confirmLabel="Remove source"
  busy={marketplaceRemoveTarget !== null && busyId === marketplaceRemoveTarget.id}
  onConfirm={() => void removeMarketplace()}
  onCancel={() => (marketplaceRemoveTarget = null)}
>
  <p>Plugins from this source will no longer appear here. Uninstall its installed plugins first.</p>
</ConfirmDialog>
