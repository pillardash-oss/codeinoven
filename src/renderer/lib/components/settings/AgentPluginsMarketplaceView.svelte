<script lang="ts">
  import { invoke } from '$lib/ipc.svelte'
  import {
    Bookmark,
    Download,
    Loader2,
    PackagePlus,
    RefreshCw,
    Search,
    Trash2
  } from '@lucide/svelte'
  import type {
    AgentPluginMarketEntry,
    AgentPluginMarketplace,
    InstalledAgentPlugin
  } from '$shared/types'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'
  import { onMount } from 'svelte'

  interface Props {
    onBack: () => void
  }
  let { onBack }: Props = $props()
  type View = 'discover' | 'bookmarks' | 'installed'
  let view = $state<View>('discover')
  let entries = $state.raw<AgentPluginMarketEntry[]>([])
  let marketplaces = $state.raw<AgentPluginMarketplace[]>([])
  let installed = $state.raw<InstalledAgentPlugin[]>([])
  let icons = $state.raw<Record<string, string>>({})
  let query = $state('')
  let marketUrl = $state('')
  let platform = $state<'codex' | 'claude'>('codex')
  let busy = $state(false)
  let busyId = $state('')
  let error = $state('')
  let success = $state('')
  let removeTarget = $state<InstalledAgentPlugin | null>(null)
  let marketplaceRemoveTarget = $state<AgentPluginMarketplace | null>(null)
  let hasMore = $state(false)

  const visibleEntries = $derived(entries)

  async function loadEntries(reset: boolean): Promise<void> {
    const offset = reset ? 0 : entries.length
    const nextEntries = await invoke('plugins:list', query.trim(), offset, 40, view)
    entries = reset ? nextEntries : [...entries, ...nextEntries]
    hasMore = nextEntries.length === 40
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

  async function refresh(): Promise<void> {
    busy = true
    error = ''
    try {
      const existingMarkets = await invoke('plugins:listMarketplaces')
      await Promise.allSettled(
        existingMarkets.map((marketplace) =>
          invoke('plugins:addMarketplace', {
            url: marketplace.url,
            platform: marketplace.platform
          })
        )
      )
      const [nextMarkets, nextInstalled] = await Promise.all([
        invoke('plugins:listMarketplaces'),
        invoke('plugins:listInstalled')
      ])
      marketplaces = nextMarkets
      installed = nextInstalled
      await loadEntries(true)
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not load agent plugins.'
    } finally {
      busy = false
    }
  }

  async function addMarketplace(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    if (!marketUrl.trim()) return
    busy = true
    error = ''
    try {
      await invoke('plugins:addMarketplace', { url: marketUrl.trim(), platform })
      marketUrl = ''
      await refresh()
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not add this marketplace.'
    } finally {
      busy = false
    }
  }

  async function toggleBookmark(entry: AgentPluginMarketEntry): Promise<void> {
    await invoke('plugins:setBookmarked', entry.id, !entry.bookmarked)
    await loadEntries(true)
  }

  async function selectView(nextView: View): Promise<void> {
    view = nextView
    busy = true
    error = ''
    try {
      await loadEntries(true)
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not load plugins.'
    } finally {
      busy = false
    }
  }

  async function search(): Promise<void> {
    busy = true
    error = ''
    try {
      await loadEntries(true)
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Plugin search failed.'
    } finally {
      busy = false
    }
  }

  async function loadMore(): Promise<void> {
    busy = true
    try {
      await loadEntries(false)
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not load more plugins.'
    } finally {
      busy = false
    }
  }

  async function install(entry: AgentPluginMarketEntry, update = false): Promise<void> {
    busyId = entry.id
    error = ''
    success = ''
    try {
      const result = update
        ? await invoke('plugins:update', entry.id)
        : await invoke('plugins:install', entry.id)
      success = `${result.displayName} ${update ? 'updated' : 'installed'} and its supported tools are available to agents.`
      await refresh()
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not install this plugin.'
    } finally {
      busyId = ''
    }
  }

  async function uninstall(): Promise<void> {
    if (!removeTarget) return
    busyId = removeTarget.id
    error = ''
    try {
      await invoke('plugins:uninstall', removeTarget.id)
      success = `${removeTarget.displayName} was uninstalled.`
      removeTarget = null
      await refresh()
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not uninstall this plugin.'
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
      success = `${marketplace.name} was removed.`
      marketplaceRemoveTarget = null
      await refresh()
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not remove marketplace.'
    } finally {
      busyId = ''
    }
  }

  onMount(() => {
    void refresh()
  })
</script>

<div class="flex h-full min-h-0 flex-col bg-app">
  <header class="flex shrink-0 items-center justify-between border-b px-6 py-4">
    <div class="flex items-center gap-3">
      <button
        type="button"
        class="rounded-md px-2 py-1 text-sm text-muted hover:bg-elevated"
        onclick={onBack}
        title="Back to utilities"
        aria-label="Back to utilities">Back</button
      >
      <div>
        <h1 class="text-lg font-semibold">Agent plugin marketplace</h1>
        <p class="mt-0.5 text-sm text-muted">
          Install tools and workflows for Codex and Claude Code.
        </p>
      </div>
    </div>
    <button
      type="button"
      class="flex h-9 items-center gap-2 rounded-lg border bg-elevated px-3 text-sm hover:bg-overlay"
      onclick={() => void refresh()}
      disabled={busy}
      title="Refresh plugin marketplace"
      aria-label="Refresh plugin marketplace"><RefreshCw size={15} /> Refresh</button
    >
  </header>

  <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5">
    <form
      class="flex flex-wrap items-end gap-2 rounded-xl border bg-surface p-4"
      onsubmit={addMarketplace}
    >
      <label class="min-w-32 flex-1 text-xs font-medium text-muted"
        >Marketplace GitHub URL
        <input
          class="mt-1 h-9 w-full rounded-md border bg-app px-3 text-sm text-foreground"
          bind:value={marketUrl}
          placeholder="owner/repository"
          autocomplete="url"
        />
      </label>
      <label class="text-xs font-medium text-muted"
        >Format
        <select
          class="mt-1 h-9 rounded-md border bg-app px-3 text-sm text-foreground"
          bind:value={platform}
        >
          <option value="codex">Codex</option><option value="claude">Claude Code</option>
        </select>
      </label>
      <button
        class="flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-on-primary disabled:opacity-50"
        type="submit"
        disabled={busy || !marketUrl.trim()}><PackagePlus size={15} /> Add marketplace</button
      >
    </form>

    {#if marketplaces.length > 0}
      <section aria-label="Added marketplaces" class="flex flex-wrap gap-2">
        {#each marketplaces as marketplace (marketplace.id)}
          <div class="flex items-center gap-2 rounded-full border bg-surface px-3 py-1.5 text-xs">
            <span>{marketplace.name}</span><span class="text-muted"
              >{marketplace.platform === 'claude' ? 'Claude Code' : 'Codex'} · {marketplace.pluginCount}</span
            >
            <button
              type="button"
              class="rounded p-1 text-muted hover:text-foreground"
              onclick={() => (marketplaceRemoveTarget = marketplace)}
              title={`Remove ${marketplace.name} marketplace`}
              aria-label={`Remove ${marketplace.name} marketplace`}><Trash2 size={13} /></button
            >
          </div>
        {/each}
      </section>
    {/if}

    <div class="flex flex-wrap items-center gap-2">
      <div class="flex rounded-lg border bg-surface p-1" aria-label="Plugin marketplace views">
        {#each [{ id: 'discover', label: 'Discover' }, { id: 'bookmarks', label: 'Bookmarks' }, { id: 'installed', label: 'Installed' }] as item (item.id)}
          <button
            type="button"
            class="rounded-md px-3 py-1.5 text-sm {view === item.id
              ? 'bg-elevated text-foreground'
              : 'text-muted hover:text-foreground'}"
            aria-pressed={view === item.id}
            onclick={() => void selectView(item.id as View)}>{item.label}</button
          >
        {/each}
      </div>
      <form
        class="ml-auto flex h-9 min-w-48 items-center gap-2 rounded-lg border bg-surface px-3"
        onsubmit={(event) => {
          event.preventDefault()
          void search()
        }}
      >
        <Search size={15} class="text-muted" /><input
          class="min-w-0 flex-1 bg-transparent text-sm outline-none"
          bind:value={query}
          placeholder="Search plugins"
          aria-label="Search plugins"
        />
      </form>
    </div>

    {#if error}<p
        class="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-500"
        role="alert"
      >
        {error}
      </p>{/if}
    {#if success}<p
        class="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-600"
        role="status"
      >
        {success}
      </p>{/if}

    {#if busy && entries.length === 0}
      <div class="flex items-center justify-center gap-2 py-16 text-sm text-muted">
        <Loader2 size={17} class="animate-spin" /> Loading plugins
      </div>
    {:else if visibleEntries.length === 0}
      <div class="rounded-xl border border-dashed px-6 py-12 text-center">
        <p class="font-medium">
          {view === 'bookmarks'
            ? 'No bookmarked plugins'
            : view === 'installed'
              ? 'No plugins installed'
              : marketplaces.length
                ? 'No plugins match this search'
                : 'Add a plugin marketplace to get started'}
        </p>
        <p class="mt-1 text-sm text-muted">
          Marketplace entries stay linked to their source for updates.
        </p>
      </div>
    {:else}
      <div class="grid grid-cols-1 gap-3 xl:grid-cols-2">
        {#each visibleEntries as entry (entry.id)}
          {@const unsupportedComponents = entry.components.filter((component) =>
            ['hooks', 'agents', 'commands', 'apps', 'lspServers'].includes(component)
          )}
          <article class="flex min-w-0 gap-4 rounded-xl border bg-surface p-4">
            <div
              class="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-xl border bg-elevated text-base font-semibold text-muted"
            >
              {#if icons[entry.id]}<img
                  src={icons[entry.id]}
                  alt=""
                  class="size-full object-cover"
                />{:else}{entry.displayName.slice(0, 1).toUpperCase()}{/if}
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex items-start justify-between gap-2">
                <div class="min-w-0">
                  <h2 class="truncate font-semibold">{entry.displayName}</h2>
                  <p class="mt-0.5 text-xs text-muted">
                    {entry.platform === 'claude' ? 'Claude Code' : 'Codex'} · {entry.publisher ??
                      entry.source.repository}
                  </p>
                </div>
                <button
                  type="button"
                  class="rounded-md p-2 text-muted hover:bg-elevated hover:text-foreground"
                  onclick={() => void toggleBookmark(entry)}
                  title={entry.bookmarked
                    ? `Remove bookmark for ${entry.displayName}`
                    : `Bookmark ${entry.displayName}`}
                  aria-label={entry.bookmarked
                    ? `Remove bookmark for ${entry.displayName}`
                    : `Bookmark ${entry.displayName}`}
                  aria-pressed={entry.bookmarked}
                  ><Bookmark size={16} fill={entry.bookmarked ? 'currentColor' : 'none'} /></button
                >
              </div>
              <p class="mt-2 line-clamp-2 text-sm text-muted">{entry.description}</p>
              {#if entry.unsupportedReason}
                <p class="mt-2 text-xs text-amber-600">{entry.unsupportedReason}</p>
              {/if}
              {#if unsupportedComponents.length > 0}
                <p class="mt-2 text-xs text-amber-600">
                  Requires unsupported features: {unsupportedComponents.join(', ')}
                </p>
              {/if}
              {#if entry.installed}
                {@const installedPlugin = installed.find((plugin) => plugin.id === entry.id)}
                {#if installedPlugin?.unsupportedComponents.length}
                  <p class="mt-2 text-xs text-amber-600">
                    Requires native support: {installedPlugin.unsupportedComponents.join(', ')}
                  </p>
                {/if}
                {#if installedPlugin?.requiredCredentialVariables.length}
                  <p class="mt-2 text-xs text-muted">
                    Configure {installedPlugin.requiredCredentialVariables.join(', ')} in the plugin's
                    MCP utilities before connecting.
                  </p>
                {/if}
              {/if}
              <div class="mt-3 flex flex-wrap gap-1.5">
                {#each entry.components as component (component)}<span
                    class="rounded-full border px-2 py-0.5 text-[0.6875rem] text-muted"
                    >{component}</span
                  >{/each}<span class="rounded-full border px-2 py-0.5 text-[0.6875rem] text-muted"
                  >{entry.version ?? entry.source.ref}</span
                >
              </div>
              <div class="mt-4 flex items-center justify-between gap-2">
                <p class="truncate text-xs text-muted">
                  {entry.description.includes('Agent plugin')
                    ? 'Tools become available through the app gateway'
                    : entry.source.repository}
                </p>
                {#if entry.installed}
                  <div class="flex shrink-0 gap-2">
                    <button
                      type="button"
                      class="flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs hover:bg-elevated"
                      onclick={() => void install(entry, true)}
                      disabled={busyId === entry.id}
                      title={`Update ${entry.displayName}`}
                      aria-label={`Update ${entry.displayName}`}
                      >{#if busyId === entry.id}<Loader2
                          size={13}
                          class="animate-spin"
                        />{:else}<RefreshCw size={13} />{/if}{entry.updateAvailable
                        ? 'Update'
                        : 'Check update'}</button
                    ><button
                      type="button"
                      class="flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs text-red-500 hover:bg-red-500/5"
                      onclick={() =>
                        (removeTarget = installed.find((plugin) => plugin.id === entry.id) ?? null)}
                      title={`Uninstall ${entry.displayName}`}
                      aria-label={`Uninstall ${entry.displayName}`}
                      ><Trash2 size={13} /> Uninstall</button
                    >
                  </div>
                {:else}
                  <button
                    type="button"
                    class="flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-on-primary disabled:opacity-50"
                    onclick={() => void install(entry)}
                    disabled={busyId === entry.id || !entry.supported}
                    title={`Install ${entry.displayName}`}
                    aria-label={`Install ${entry.displayName}`}
                    >{#if busyId === entry.id}<Loader2
                        size={13}
                        class="animate-spin"
                      />{:else}<Download size={13} />{/if} Install</button
                  >
                {/if}
              </div>
            </div>
          </article>
        {/each}
      </div>
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
  open={removeTarget !== null}
  title={`Uninstall ${removeTarget?.displayName ?? 'plugin'}?`}
  confirmLabel="Uninstall"
  busy={busyId === removeTarget?.id}
  onConfirm={() => void uninstall()}
  onCancel={() => (removeTarget = null)}
>
  <p>Agents will no longer be able to use this plugin's capabilities.</p>
</ConfirmDialog>

<ConfirmDialog
  open={marketplaceRemoveTarget !== null}
  title={`Remove ${marketplaceRemoveTarget?.name ?? 'marketplace'}?`}
  confirmLabel="Remove marketplace"
  busy={marketplaceRemoveTarget !== null && busyId === marketplaceRemoveTarget.id}
  onConfirm={() => void removeMarketplace()}
  onCancel={() => (marketplaceRemoveTarget = null)}
>
  <p>Saved bookmarks from this source will no longer appear in search results.</p>
</ConfirmDialog>
