<script lang="ts">
  import { onMount } from 'svelte'
  import CioChevronDown from '@pdslng/cio-icon/CioChevronDown.svelte'
  import CioRefresh from '@pdslng/cio-icon/CioRefresh.svelte'
  import { api, ApiError } from '#lib/api/client'
  import { formatAge } from '#lib/api/status'
  import type { Assistant } from '#lib/api/types'
  import AppBar from '#lib/components/AppBar.svelte'
  import Mark from '#lib/components/Mark.svelte'

  /**
   * Assistants. A phone lists them and opens one to see what it does; creating,
   * scheduling and editing stay on the desktop, because that is where the work
   * they run on lives.
   *
   * Scheduled assistants fold open with their facts, and a manual one is a plain
   * row because there is no schedule to explain.
   */

  type Filter = 'all' | 'scheduled' | 'manual'

  let assistants = $state<Assistant[]>([])
  let loading = $state(true)
  let error = $state<string | null>(null)
  let filter = $state<Filter>('all')
  let opened = $state<Record<string, boolean>>({})

  async function load(): Promise<void> {
    loading = true
    error = null
    try {
      assistants = await api.assistants()
    } catch (cause) {
      error =
        cause instanceof ApiError
          ? cause.message
          : 'Assistants could not be loaded. Check that the service is running.'
    } finally {
      loading = false
    }
  }

  onMount(() => {
    void load()
  })

  let visible = $derived(
    assistants.filter((assistant) => {
      if (filter === 'all') return true
      return filter === 'scheduled' ? assistant.scheduled : !assistant.scheduled
    })
  )

  let pausedCount = $derived(assistants.filter((assistant) => assistant.paused).length)

  function subtitle(assistant: Assistant): string {
    const origin = assistant.scheduled
      ? (assistant.scheduleName ?? 'Scheduled')
      : 'Starts when you ask'
    const threads = assistant.threadCount === 1 ? '1 thread' : `${assistant.threadCount} threads`
    return `${origin} · ${threads}`
  }

  function toggle(id: string): void {
    opened = { ...opened, [id]: !opened[id] }
  }
</script>

<AppBar title="Assistant" count={assistants.length}>
  {#snippet actions()}
    <button
      class="icon-btn"
      type="button"
      aria-label="Refresh assistants"
      title="Refresh assistants"
      onclick={load}
    >
      <CioRefresh size={20} />
    </button>
  {/snippet}
</AppBar>

<div class="tabs" role="group" aria-label="Filter assistants">
  <button
    class="tab"
    type="button"
    aria-pressed={filter === 'all'}
    onclick={() => (filter = 'all')}
  >
    All
  </button>
  <button
    class="tab"
    type="button"
    aria-pressed={filter === 'scheduled'}
    onclick={() => (filter = 'scheduled')}
  >
    Scheduled
  </button>
  <button
    class="tab"
    type="button"
    aria-pressed={filter === 'manual'}
    onclick={() => (filter = 'manual')}
  >
    Manual
  </button>
</div>

<div class="list flat-sections">
  {#if loading}
    {#each [0, 1, 2] as row (row)}
      <div class="skeleton-row" aria-hidden="true"><span></span></div>
    {/each}
  {:else if error}
    <p class="empty">{error}</p>
    <div class="retry-row"><button class="btn" type="button" onclick={load}>Retry</button></div>
  {:else if visible.length === 0}
    <p class="empty">No assistant matches this filter</p>
  {:else}
    <section class="section">
      {#each visible as assistant (assistant.id)}
        {@const open = opened[assistant.id] === true}
        <div class="assistant-row">
          <button
            class="row flat"
            type="button"
            aria-expanded={assistant.scheduled ? open : undefined}
            onclick={() => (assistant.scheduled ? toggle(assistant.id) : undefined)}
          >
            <Mark project={assistant} size={28} />
            <span class="body-cell">
              <span class="row-title">{assistant.name}</span>
              <span class="row-line">{subtitle(assistant)}</span>
              <span class="row-meta">
                <span
                  class="state"
                  style:color={assistant.paused ? 'var(--color-warning)' : undefined}
                >
                  <i class="dot" data-tone={assistant.paused ? 'needs' : 'done'}></i>
                  {assistant.paused ? 'paused' : 'ready'}
                </span>
                {#if assistant.scheduled && assistant.scheduleName}
                  <span>{assistant.scheduleName}</span>
                {/if}
                {#if assistant.lastRunAt}
                  <span>{formatAge(assistant.lastRunAt)}</span>
                {/if}
              </span>
            </span>
            {#if assistant.scheduled}
              <CioChevronDown class="chev" size={16} />
            {/if}
          </button>

          {#if assistant.scheduled && open}
            <div class="detail" data-open="true">
              <p class="run"><span>{assistant.description}</span></p>
              <p class="run">
                <span>Work produced</span>
                <em>{assistant.threadCount} threads</em>
              </p>
            </div>
          {/if}
        </div>
      {/each}
    </section>
  {/if}
</div>

{#if pausedCount > 0}
  <p class="list-foot">{pausedCount} paused</p>
{/if}

<style>
  .assistant-row .row {
    width: 100%;
    border: 0;
    background: transparent;
    text-align: left;
    font: inherit;
    color: inherit;
    cursor: pointer;
  }

  .assistant-row :global(.chev) {
    flex: none;
    color: var(--color-muted);
    transition: transform 160ms cubic-bezier(0.215, 0.61, 0.355, 1);
  }

  .assistant-row .row[aria-expanded='true'] :global(.chev) {
    transform: rotate(180deg);
  }

  .skeleton-row {
    padding: 0.875rem var(--gutter);
  }

  .skeleton-row span {
    display: block;
    height: 2.25rem;
    background: linear-gradient(
      90deg,
      var(--color-elevated) 0%,
      var(--color-surface) 50%,
      var(--color-elevated) 100%
    );
    background-size: 200% 100%;
    animation: shimmer 1.4s linear infinite;
  }

  .retry-row {
    display: flex;
    justify-content: flex-end;
    padding: 0 var(--gutter) 1rem;
  }

  .list-foot {
    flex: none;
    margin: 0;
    padding: 0.75rem var(--gutter) 1rem;
    color: var(--ink-meta);
    font-size: 0.75rem;
  }

  @keyframes shimmer {
    from {
      background-position: 200% 0;
    }
    to {
      background-position: -200% 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .skeleton-row span,
    .assistant-row :global(.chev) {
      animation: none;
      transition: none;
    }
  }
</style>
