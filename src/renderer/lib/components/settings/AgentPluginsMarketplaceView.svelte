<script lang="ts">
  import { invoke } from '$lib/ipc.svelte'
  import {
    ArrowLeft,
    Bookmark,
    ChevronDown,
    Download,
    Loader2,
    PackagePlus,
    RefreshCw,
    Search,
    Trash2
  } from '@lucide/svelte'
  import type { AgentPluginMarketEntry, AgentPluginMarketplace } from '$shared/types'
  import { onMount } from 'svelte'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'

  interface Props {
    onBack: () => void
    /** Names the back control after the page it returns to. */
    backLabel: string
    onOpenPlugin: (pluginId: string) => void
  }
  let { onBack, backLabel, onOpenPlugin }: Props = $props()

  type View = 'discover' | 'bookmarks' | 'installed'
  const VIEWS: Array<{ id: View; label: string }> = [
    { id: 'discover', label: 'Discover' },
    { id: 'bookmarks', label: 'Bookmarks' },
    { id: 'installed', label: 'Installed' }
  ]
  const PAGE_SIZE = 40

  let view = $state<View>('discover')
  let entries = $state.raw<AgentPluginMarketEntry[]>([])
  let marketplaces = $state.raw<AgentPluginMarketplace[]>([])
  let icons = $state.raw<Record<string, string>>({})
  let query = $state('')
  let sourcesOpen = $state(false)
  let marketUrl = $state('')
  let platform = $state<'codex' | 'claude'>('codex')
  let busy = $state(false)
  let busyId = $state('')
  let error = $state('')
  let marketplaceRemoveTarget = $state<AgentPluginMarketplace | null>(null)
  let hasMore = $state(false)

  async function loadEntries(reset: boolean): Promise<void> {
    const offset = reset ? 0 : entries.length
    const nextEntries = await invoke('plugins:list', query.trim(), offset, PAGE_SIZE, view)
    entries = reset ? nextEntries : [...entries, ...nextEntries]
    hasMore = nextEntries.length === PAGE_SIZE
    const iconsToLoad = nextEntries.filter((entry) => entry.iconUrl && !icons[entry.id]).slice(0, 8)
    const pairs = await Promise.all(
      iconsToLoad.map(async (entry) => {
        try {
          return [entry.id, await invoke('plugins:getIcon', entry.id)] as const
        } catch {
          return [entry.id, null] as const
        }
      })
    )
    icons = {
      ...icons,
      ...Object.fromEntries(
        pairs.filter((pair): pair is readonly [string, string] => typeof pair[1] === 'string')
      )
    }
  }

  /** Runs one catalog read, keeping the busy and error state in one place. */
  async function run(action: () => Promise<void>, failure: string): Promise<void> {
    busy = true
    error = ''
    try {
      await action()
    } catch (cause) {
      error = cause instanceof Error ? cause.message : failure
    } finally {
      busy = false
    }
  }

  async function refresh(): Promise<void> {
    await run(async () => {
      const existingMarkets = await invoke('plugins:listMarketplaces')
      await Promise.allSettled(
        existingMarkets.map((marketplace) =>
          invoke('plugins:addMarketplace', { url: marketplace.url, platform: marketplace.platform })
        )
      )
      marketplaces = await invoke('plugins:listMarketplaces')
      await loadEntries(true)
    }, 'Could not load agent plugins.')
  }

  async function addMarketplace(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    if (!marketUrl.trim()) return
    await run(async () => {
      await invoke('plugins:addMarketplace', { url: marketUrl.trim(), platform })
      marketUrl = ''
      marketplaces = await invoke('plugins:listMarketplaces')
      await loadEntries(true)
    }, 'Could not add this source.')
  }

  async function removeMarketplace(): Promise<void> {
    const marketplace = marketplaceRemoveTarget
    if (!marketplace) return
    busyId = marketplace.id
    error = ''
    try {
      await invoke('plugins:removeMarketplace', marketplace.id)
      marketplaceRemoveTarget = null
      marketplaces = await invoke('plugins:listMarketplaces')
      await loadEntries(true)
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not remove this source.'
    } finally {
      busyId = ''
    }
  }

  async function toggleBookmark(entry: AgentPluginMarketEntry): Promise<void> {
    await invoke('plugins:setBookmarked', entry.id, !entry.bookmarked)
    await loadEntries(true)
  }

  async function selectView(nextView: View): Promise<void> {
    view = nextView
    await run(() => loadEntries(true), 'Could not load plugins.')
  }

  async function search(): Promise<void> {
    await run(() => loadEntries(true), 'Plugin search failed.')
  }

  async function loadMore(): Promise<void> {
    await run(() => loadEntries(false), 'Could not load more plugins.')
  }

  async function install(entry: AgentPluginMarketEntry): Promise<void> {
    busyId = entry.id
    error = ''
    try {
      await invoke('plugins:install', entry.id)
      await loadEntries(true)
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not install this plugin.'
    } finally {
      busyId = ''
    }
  }

  function platformLabel(value: AgentPluginMarketEntry['platform']): string {
    return value === 'claude' ? 'Claude Code' : 'Codex'
  }

  onMount(() => {
    void refresh()
  })
</script>

<div class="flex h-full min-h-0 flex-col bg-app">
  <header class="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-6 py-4">
    <div class="flex min-w-0 items-center gap-3">
      <button
        type="button"
        class="flex h-8 items-center gap-1.5 rounded-lg border bg-elevated px-2.5 text-xs font-medium hover:bg-overlay"
        onclick={onBack}
        title={backLabel}
        aria-label={backLabel}
      >
        <ArrowLeft size={13} />
        {backLabel}
      </button>
      <div class="min-w-0">
        <h1 class="text-lg font-semibold">Plugin marketplace</h1>
        <p class="text-sm text-muted">
          Give agents tools and workflows from Codex and Claude Code plugins.
        </p>
      </div>
    </div>
    <button
      type="button"
      class="flex h-8 items-center gap-1.5 rounded-lg border bg-elevated px-2.5 text-xs hover:bg-overlay disabled:opacity-50"
      onclick={() => void refresh()}
      disabled={busy}
      title="Refresh plugin marketplace"
      aria-label="Refresh plugin marketplace"
    >
      {#if busy}<Loader2 size={13} class="animate-spin" />{:else}<RefreshCw size={13} />{/if}
      Refresh
    </button>
  </header>

  <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5">
    <div class="flex flex-wrap items-center gap-2">
      <div class="flex rounded-lg border bg-surface p-1" role="group" aria-label="Plugin views">
        {#each VIEWS as item (item.id)}
          <button
            type="button"
            class="rounded-md px-3 py-1.5 text-sm {view === item.id
              ? 'bg-elevated text-foreground'
              : 'text-muted hover:text-foreground'}"
            aria-pressed={view === item.id}
            onclick={() => void selectView(item.id)}>{item.label}</button
          >
        {/each}
      </div>
      <form
        class="ml-auto flex h-9 min-w-56 flex-1 items-center gap-2 rounded-lg border bg-surface px-3 sm:flex-none"
        role="search"
        onsubmit={(event) => {
          event.preventDefault()
          void search()
        }}
      >
        <Search size={15} class="shrink-0 text-muted" />
        <input
          class="min-w-0 flex-1 bg-transparent text-sm outline-none"
          bind:value={query}
          placeholder="Search plugins"
          aria-label="Search plugins"
        />
      </form>
    </div>

    <section class="rounded-xl border bg-surface">
      <button
        type="button"
        class="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm"
        aria-expanded={sourcesOpen}
        aria-controls="plugin-sources-panel"
        onclick={() => (sourcesOpen = !sourcesOpen)}
      >
        <span class="text-muted">
          Sources:
          {marketplaces.length === 0
            ? 'none added'
            : marketplaces.map((marketplace) => marketplace.name).join(', ')}
        </span>
        <span class="flex items-center gap-1 text-xs font-medium text-muted">
          {sourcesOpen ? 'Hide' : 'Manage'}
          <ChevronDown size={14} class={sourcesOpen ? 'rotate-180' : ''} />
        </span>
      </button>
      {#if sourcesOpen}
        <div id="plugin-sources-panel" class="space-y-3 border-t px-4 py-3">
          {#each marketplaces as marketplace (marketplace.id)}
            <div class="flex items-center justify-between gap-3 text-sm">
              <div class="min-w-0">
                <p class="truncate">{marketplace.name}</p>
                <p class="text-xs text-muted">
                  {platformLabel(marketplace.platform)} · {marketplace.pluginCount} plugins
                </p>
              </div>
              <button
                type="button"
                class="flex size-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-elevated hover:text-red-500"
                onclick={() => (marketplaceRemoveTarget = marketplace)}
                title={`Remove ${marketplace.name} source`}
                aria-label={`Remove ${marketplace.name} source`}
              >
                <Trash2 size={14} />
              </button>
            </div>
          {/each}
          <form class="flex flex-wrap items-end gap-2 pt-1" onsubmit={addMarketplace}>
            <label class="min-w-40 flex-1 text-xs font-medium text-muted">
              Add a GitHub source
              <input
                class="mt-1 h-9 w-full rounded-md border bg-app px-3 text-sm text-foreground"
                bind:value={marketUrl}
                placeholder="owner/repository"
                autocomplete="off"
              />
            </label>
            <label class="text-xs font-medium text-muted">
              Format
              <select
                class="mt-1 h-9 rounded-md border bg-app px-3 text-sm text-foreground"
                bind:value={platform}
              >
                <option value="codex">Codex</option>
                <option value="claude">Claude Code</option>
              </select>
            </label>
            <button
              class="flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-on-primary disabled:opacity-50"
              type="submit"
              disabled={busy || !marketUrl.trim()}
            >
              <PackagePlus size={15} /> Add source
            </button>
          </form>
        </div>
      {/if}
    </section>

    {#if error}
      <p
        class="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-500"
        role="alert"
      >
        {error}
      </p>
    {/if}

    {#if busy && entries.length === 0}
      <div class="flex items-center justify-center gap-2 py-16 text-sm text-muted">
        <Loader2 size={17} class="animate-spin" /> Loading plugins
      </div>
    {:else if entries.length === 0}
      <div class="rounded-xl border border-dashed px-6 py-12 text-center">
        <p class="font-medium">
          {view === 'bookmarks'
            ? 'No bookmarked plugins'
            : view === 'installed'
              ? 'No plugins installed'
              : marketplaces.length
                ? 'No plugins match this search'
                : 'Add a source to browse plugins'}
        </p>
      </div>
    {:else}
      <ul class="grid grid-cols-1 gap-3 xl:grid-cols-2" aria-label="Plugins">
        {#each entries as entry (entry.id)}
          <li class="flex min-w-0 flex-col rounded-xl border bg-surface p-4">
            <div class="flex min-w-0 gap-3">
              <div
                class="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-xl border bg-elevated text-sm font-semibold text-muted"
              >
                {#if icons[entry.id]}<img
                    src={icons[entry.id]}
                    alt=""
                    class="size-full object-cover"
                  />{:else}{entry.displayName.slice(0, 1).toUpperCase()}{/if}
              </div>
              <div class="min-w-0 flex-1">
                <button
                  type="button"
                  class="block max-w-full truncate text-left font-semibold hover:underline"
                  onclick={() => onOpenPlugin(entry.id)}
                  title={`Open ${entry.displayName}`}
                  aria-label={`Open ${entry.displayName}`}
                >
                  {entry.displayName}
                </button>
                <p class="truncate text-xs text-muted">
                  {entry.publisher ?? entry.source.repository} · {platformLabel(entry.platform)}
                </p>
              </div>
              <button
                type="button"
                class="size-8 shrink-0 rounded-md text-muted hover:bg-elevated hover:text-foreground"
                onclick={() => void toggleBookmark(entry)}
                title={entry.bookmarked
                  ? `Remove bookmark for ${entry.displayName}`
                  : `Bookmark ${entry.displayName}`}
                aria-label={entry.bookmarked
                  ? `Remove bookmark for ${entry.displayName}`
                  : `Bookmark ${entry.displayName}`}
                aria-pressed={entry.bookmarked}
              >
                <Bookmark
                  size={15}
                  class="mx-auto"
                  fill={entry.bookmarked ? 'currentColor' : 'none'}
                />
              </button>
            </div>

            <p class="mt-3 line-clamp-2 text-sm text-muted">{entry.description}</p>

            <div class="mt-auto flex items-center justify-between gap-3 pt-4">
              <p class="min-w-0 truncate text-xs text-muted">
                {#if !entry.supported}
                  <span class="text-amber-600"
                    >{entry.unsupportedReason ?? 'Unsupported source'}</span
                  >
                {:else if entry.installed}
                  <span class="text-success"
                    >{entry.updateAvailable ? 'Update available' : 'Installed'}</span
                  >
                {:else}
                  {entry.components.join(', ')}
                {/if}
              </p>
              {#if entry.installed}
                <button
                  type="button"
                  class="h-8 shrink-0 rounded-md border px-3 text-xs hover:bg-elevated"
                  onclick={() => onOpenPlugin(entry.id)}
                  aria-label={`View ${entry.displayName}`}
                >
                  View
                </button>
              {:else}
                <button
                  type="button"
                  class="flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-on-primary disabled:opacity-50"
                  onclick={() => void install(entry)}
                  disabled={busyId === entry.id || !entry.supported}
                  title={`Install ${entry.displayName}`}
                  aria-label={`Install ${entry.displayName}`}
                >
                  {#if busyId === entry.id}<Loader2
                      size={13}
                      class="animate-spin"
                    />{:else}<Download size={13} />{/if}
                  Install
                </button>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}

    {#if hasMore}
      <div class="flex justify-center py-2">
        <button
          type="button"
          class="flex h-9 items-center gap-2 rounded-lg border bg-elevated px-4 text-sm hover:bg-overlay disabled:opacity-50"
          onclick={() => void loadMore()}
          disabled={busy}
        >
          {#if busy}<Loader2 size={14} class="animate-spin" />{/if} Load more plugins
        </button>
      </div>
    {/if}
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
