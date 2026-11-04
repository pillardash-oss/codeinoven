<script lang="ts">
  import { onMount } from 'svelte'
  import CioChevronDown from '@pdslng/cio-icon/CioChevronDown.svelte'
  import { api, ApiError } from '#lib/api/client'
  import { formatAge } from '#lib/api/status'
  import type { Assistant } from '#lib/api/types'
  import Mark from '#lib/components/Mark.svelte'
  import PanelBar from '#lib/components/PanelBar.svelte'
  import { fold } from '#lib/motion'

  /**
   * Assistants. A phone lists them and opens one to see what it does; creating,
   * scheduling and editing stay on the desktop, because that is where the work
   * they run on lives.
   *
   * Scheduled ones come first, because a run that starts itself is the one that
   * matters, and a scheduled assistant folds open to what it does and how much it
   * has produced.
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

  let groups = $derived([
    {
      id: 'scheduled',
      label: 'Scheduled',
      rows: visible
        .filter((assistant) => assistant.scheduled)
        .sort((a, b) => (b.lastRunAt ?? 0) - (a.lastRunAt ?? 0))
    },
    {
      id: 'manual',
      label: 'On demand',
      rows: visible
        .filter((assistant) => !assistant.scheduled)
        .sort((a, b) => (b.lastRunAt ?? 0) - (a.lastRunAt ?? 0))
    }
  ])

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

<PanelBar title="Assistant" count={assistants.length} />

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
    On demand
  </button>
</div>

<div class="list">
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
    {#each groups as group (group.id)}
      {#if group.rows.length > 0}
        <p class="section-label">{group.label}</p>
        {#each group.rows as assistant (assistant.id)}
          {@const open = opened[assistant.id] === true}
          <div class="assistant-row">
            <button
              class="thread-row"
              type="button"
              aria-expanded={assistant.scheduled ? open : undefined}
              onclick={() => (assistant.scheduled ? toggle(assistant.id) : undefined)}
            >
              <span class="thread-mark">
                <Mark project={assistant} size={24} />
              </span>
              <span class="thread-cell">
                <span class="thread-name">{assistant.name}</span>
                <span class="thread-meta">{subtitle(assistant)}</span>
              </span>
              <span class="thread-age">
                {assistant.lastRunAt ? formatAge(assistant.lastRunAt) : ''}
              </span>
              {#if assistant.scheduled}
                <CioChevronDown class="chev" size={16} />
              {/if}
            </button>

            {#if assistant.scheduled && open}
              <div class="detail" transition:fold>
                <p class="run"><span>{assistant.description}</span></p>
                <p class="run">
                  <span>Work produced</span>
                  <em
                    >{assistant.threadCount === 1
                      ? '1 thread'
                      : `${assistant.threadCount} threads`}</em
                  >
                </p>
                <p class="run">
                  <span>Last run</span>
                  <em>{assistant.lastRunAt ? formatAge(assistant.lastRunAt) : 'never'}</em>
                </p>
                <p class="run">
                  <span>State</span>
                  <em>{assistant.paused ? 'paused' : 'ready'}</em>
                </p>
              </div>
            {/if}
          </div>
        {/each}
      {/if}
    {/each}
  {/if}
</div>
