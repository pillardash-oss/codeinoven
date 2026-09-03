<script lang="ts">
  import { onMount } from 'svelte'
  import { BookOpen, Flame, Loader2, Search, Sparkles, TrendingUp } from '@lucide/svelte'
  import { invoke } from '$lib/ipc.svelte'
  import {
    cachedSkillMarketLeaderboard,
    loadSkillMarketDetail,
    preloadSkillMarketDetails,
    refreshSkillMarketLeaderboard
  } from '$lib/skill-market-cache'
  import type { SkillMarketEntry, SkillMarketView } from '$shared/types'

  interface Props {
    onOpenSkill: (entry: SkillMarketEntry) => void
  }

  let { onOpenSkill }: Props = $props()

  const views: Array<{ id: SkillMarketView; label: string; icon: typeof BookOpen }> = [
    { id: 'all-time', label: 'All Time', icon: BookOpen },
    { id: 'trending', label: 'Trending', icon: TrendingUp },
    { id: 'hot', label: 'Hot', icon: Flame }
  ]

  const initialLeaderboard = cachedSkillMarketLeaderboard('all-time')
  let activeView = $state<SkillMarketView>('all-time')
  let entries = $state<SkillMarketEntry[]>(initialLeaderboard?.entries ?? [])
  let query = $state('')
  let loading = $state(initialLeaderboard === null)
  let error = $state('')
  let searchMode = $state(false)
  let requestSequence = 0

  function warmDetails(nextEntries: readonly SkillMarketEntry[]): void {
    void preloadSkillMarketDetails(nextEntries.slice(0, 6).map((entry) => entry.id))
  }

  function warmDetail(id: string): void {
    void loadSkillMarketDetail(id).catch(() => undefined)
  }

  async function loadLeaderboard(view: SkillMarketView): Promise<void> {
    const sequence = ++requestSequence
    activeView = view
    searchMode = false
    error = ''
    const cached = cachedSkillMarketLeaderboard(view)
    if (cached) {
      entries = cached.entries
      loading = false
      warmDetails(entries)
    } else {
      entries = []
      loading = true
    }
    try {
      const refreshed = await refreshSkillMarketLeaderboard(view)
      if (sequence !== requestSequence || searchMode || activeView !== view) return
      entries = refreshed.entries
      warmDetails(entries)
    } catch (loadError) {
      if (sequence !== requestSequence) return
      error =
        loadError instanceof Error ? loadError.message : 'The skills leaderboard could not load.'
    } finally {
      if (sequence === requestSequence) loading = false
    }
  }

  async function searchMarketplace(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    const searchQuery = query.trim()
    if (searchQuery.length < 2) {
      if (searchMode) await loadLeaderboard(activeView)
      return
    }
    const sequence = ++requestSequence
    searchMode = true
    loading = true
    error = ''
    try {
      const searchEntries = (
        await invoke('utilities:searchSkillMarket', searchQuery)
      ).entries.slice(0, 100)
      if (sequence !== requestSequence) return
      entries = searchEntries
      warmDetails(entries)
    } catch (searchError) {
      if (sequence !== requestSequence) return
      error =
        searchError instanceof Error ? searchError.message : 'The skills marketplace search failed.'
    } finally {
      if (sequence === requestSequence) loading = false
    }
  }

  onMount(() => {
    void loadLeaderboard('all-time')
    for (const view of views) {
      if (view.id !== 'all-time') {
        void refreshSkillMarketLeaderboard(view.id).catch(() => undefined)
      }
    }
  })
</script>

<div class="h-full min-h-0 overflow-hidden">
  <div class="mx-auto flex h-full min-h-0 max-w-5xl flex-col px-6 pt-6">
    <div class="shrink-0 bg-app pb-3">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div class="flex items-center gap-2">
            <Sparkles size={18} class="text-accent" />
            <h1 class="text-xl font-bold tracking-tight">Skills marketplace</h1>
          </div>
          <p class="mt-1 text-sm text-muted">
            Browse the open skills ecosystem, inspect every source, and install without leaving the
            app.
          </p>
        </div>
        <span
          class="rounded-lg border bg-elevated px-2.5 py-1.5 text-[0.6875rem] font-medium text-muted"
        >
          Top 100
        </span>
      </div>

      <p class="mt-3 rounded-lg bg-raised px-3 py-2 text-[0.625rem] leading-relaxed text-muted">
        Marketplace skills are third-party instructions and code. Review the repository and security
        signals before installing. CodeInOven disables anonymous Skills CLI telemetry.
      </p>

      <form class="mt-4 flex gap-2" onsubmit={searchMarketplace}>
        <label class="relative min-w-0 flex-1">
          <span class="sr-only">Search skills marketplace</span>
          <Search
            size={15}
            class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-dimmed"
          />
          <input
            class="h-10 w-full rounded-xl border bg-surface pl-9 pr-3 text-sm outline-none transition-colors focus:border-primary"
            type="search"
            minlength="2"
            placeholder="Search by skill, repository, or use case"
            bind:value={query}
          />
        </label>
        <button
          class="flex h-10 items-center gap-1.5 rounded-xl bg-primary px-4 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
          type="submit"
          disabled={loading || (query.trim().length > 0 && query.trim().length < 2)}
        >
          {#if loading && searchMode}<Loader2 size={13} class="animate-spin" />{/if}
          Search
        </button>
      </form>

      <div class="mt-4 flex flex-wrap items-center justify-between gap-3 border-b pb-3">
        <div class="flex items-center gap-1 rounded-lg bg-elevated p-0.5" role="tablist">
          {#each views as view (view.id)}
            {@const Icon = view.icon}
            <button
              class="flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors {activeView ===
                view.id && !searchMode
                ? 'bg-surface text-foreground shadow-sm'
                : 'text-muted hover:text-foreground'}"
              type="button"
              role="tab"
              aria-selected={activeView === view.id && !searchMode}
              onclick={() => void loadLeaderboard(view.id)}
            >
              <Icon size={13} />
              {view.label}
              {#if view.id === 'trending'}<span class="text-[0.625rem] text-dimmed">24h</span>{/if}
            </button>
          {/each}
        </div>
        <p class="text-xs tabular-nums text-muted">
          {searchMode ? `${entries.length} search results` : `${entries.length} ranked skills`}
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
          <p class="mt-2 text-xs text-dimmed">Loading skills…</p>
        </div>
      {:else if entries.length === 0}
        <div class="mt-2 rounded-xl border border-dashed p-10 text-center">
          <Search size={20} class="mx-auto text-dimmed" />
          <p class="mt-2 text-sm font-medium">No skills found</p>
          <p class="mt-1 text-xs text-dimmed">Try a broader search.</p>
        </div>
      {:else}
        <div class="divide-y rounded-xl border bg-surface">
          {#each entries as entry, index (entry.id)}
            <button
              class="grid w-full grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
              type="button"
              title="Open {entry.name}"
              onpointerenter={() => warmDetail(entry.id)}
              onfocus={() => warmDetail(entry.id)}
              onclick={() => onOpenSkill(entry)}
            >
              <span class="text-center font-mono text-xs tabular-nums text-dimmed">
                {searchMode ? '—' : index + 1}
              </span>
              <span class="min-w-0">
                <span class="flex items-center gap-2">
                  <span class="truncate font-mono text-sm font-semibold">{entry.name}</span>
                  {#if entry.isOfficial}
                    <span
                      class="rounded-md border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[0.5625rem] font-semibold uppercase tracking-wide text-primary"
                    >
                      Official
                    </span>
                  {/if}
                </span>
                <span class="mt-0.5 block truncate text-xs text-muted">{entry.source}</span>
              </span>
              <span class="text-right">
                <span class="block font-mono text-xs font-semibold tabular-nums">
                  {entry.installs.toLocaleString()}
                </span>
                <span class="block text-[0.625rem] text-dimmed">
                  {activeView === 'hot' && entry.change !== undefined
                    ? `+${entry.change} now`
                    : 'installs'}
                </span>
              </span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </div>
</div>
