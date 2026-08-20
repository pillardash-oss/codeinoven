<script lang="ts">
  import { onMount } from 'svelte'
  import { BookOpen, Flame, Loader2, Search, Sparkles, TrendingUp } from '@lucide/svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { loadSkillMarketDetail, preloadSkillMarketDetails } from '$lib/skill-market-cache'
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

  let activeView = $state<SkillMarketView>('all-time')
  let entries = $state<SkillMarketEntry[]>([])
  let query = $state('')
  let loading = $state(true)
  let error = $state('')
  let searchMode = $state(false)

  function warmDetails(nextEntries: readonly SkillMarketEntry[]): void {
    void preloadSkillMarketDetails(nextEntries.slice(0, 6).map((entry) => entry.id))
  }

  function warmDetail(id: string): void {
    void loadSkillMarketDetail(id).catch(() => undefined)
  }

  async function loadLeaderboard(view: SkillMarketView): Promise<void> {
    activeView = view
    searchMode = false
    loading = true
    error = ''
    try {
      entries = (await invoke('utilities:listSkillMarket', view)).entries
      warmDetails(entries)
    } catch (loadError) {
      error =
        loadError instanceof Error ? loadError.message : 'The skills leaderboard could not load.'
    } finally {
      loading = false
    }
  }

  async function searchMarketplace(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    const searchQuery = query.trim()
    if (searchQuery.length < 2) {
      if (searchMode) await loadLeaderboard(activeView)
      return
    }
    searchMode = true
    loading = true
    error = ''
    try {
      entries = (await invoke('utilities:searchSkillMarket', searchQuery)).entries.slice(0, 100)
      warmDetails(entries)
    } catch (searchError) {
      error =
        searchError instanceof Error ? searchError.message : 'The skills marketplace search failed.'
    } finally {
      loading = false
    }
  }

  onMount(() => {
    void loadLeaderboard('all-time')
  })
</script>

<div class="mx-auto max-w-5xl p-6 pb-24">
  <div class="flex flex-wrap items-start justify-between gap-4">
    <div>
      <div class="flex items-center gap-2">
        <Sparkles size={18} class="text-accent" />
        <h1 class="text-xl font-bold tracking-tight">Skills marketplace</h1>
      </div>
      <p class="mt-1 text-sm text-muted">
        Browse the open skills ecosystem, inspect every source, and install without leaving the app.
      </p>
    </div>
    <span class="rounded-lg border bg-elevated px-2.5 py-1.5 text-[11px] font-medium text-muted">
      Top 100
    </span>
  </div>

  <form class="mt-6 flex gap-2" onsubmit={searchMarketplace}>
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

  <div class="mt-5 flex flex-wrap items-center justify-between gap-3 border-b pb-3">
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
          {#if view.id === 'trending'}<span class="text-[10px] text-dimmed">24h</span>{/if}
        </button>
      {/each}
    </div>
    <p class="text-xs tabular-nums text-muted">
      {searchMode ? `${entries.length} search results` : `${entries.length} ranked skills`}
    </p>
  </div>

  {#if error}
    <p class="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
      {error}
    </p>
  {/if}

  {#if loading}
    <div class="mt-4 rounded-xl border border-dashed p-10 text-center">
      <Loader2 size={20} class="mx-auto animate-spin text-dimmed" />
      <p class="mt-2 text-xs text-dimmed">Loading skills…</p>
    </div>
  {:else if entries.length === 0}
    <div class="mt-4 rounded-xl border border-dashed p-10 text-center">
      <Search size={20} class="mx-auto text-dimmed" />
      <p class="mt-2 text-sm font-medium">No skills found</p>
      <p class="mt-1 text-xs text-dimmed">Try a broader search.</p>
    </div>
  {:else}
    <div class="mt-2 divide-y rounded-xl border bg-surface">
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
                  class="rounded-md border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-primary"
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
            <span class="block text-[10px] text-dimmed">
              {activeView === 'hot' && entry.change !== undefined
                ? `+${entry.change} now`
                : 'installs'}
            </span>
          </span>
        </button>
      {/each}
    </div>
  {/if}

  <p class="mt-4 text-[10px] leading-relaxed text-dimmed">
    Marketplace skills are third-party instructions and code. Review the repository and security
    signals before installing. CodeInOven disables anonymous Skills CLI telemetry.
  </p>
</div>
