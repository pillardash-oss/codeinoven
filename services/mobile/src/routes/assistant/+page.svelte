<script lang="ts">
  import { onMount } from 'svelte'
  import CioChevronDown from '@pdslng/cio-icon/CioChevronDown.svelte'
  import { api, ApiError } from '#lib/api/client'
  import { formatAge } from '#lib/api/status'
  import type { Assistant } from '#lib/api/types'
  import AssistantMark from '#lib/components/AssistantMark.svelte'
  import PanelBar from '#lib/components/PanelBar.svelte'
  import { fold } from '#lib/motion'

  /**
   * Assistants, drawn the way the design draws them: each one carries its own
   * mark, the schedule and the work it produced on the line under its name, and
   * the state it last ran in below that. Creating, scheduling and editing stay on
   * the desktop, because that is where the work they run on lives.
   *
   * A scheduled assistant folds open to what it does, and a manual one is a row
   * because it has no schedule to explain.
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
      rows: visible
        .filter((assistant) => assistant.scheduled)
        .sort((a, b) => (b.lastRunAt ?? 0) - (a.lastRunAt ?? 0))
    },
    {
      id: 'manual',
      rows: visible
        .filter((assistant) => !assistant.scheduled)
        .sort((a, b) => (b.lastRunAt ?? 0) - (a.lastRunAt ?? 0))
    }
  ])

  function line(assistant: Assistant): string {
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

<PanelBar title="Assistant" />

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
        <section class="section">
          {#each group.rows as assistant (assistant.id)}
            {@const open = opened[assistant.id] === true}
            {#if assistant.scheduled}
              <button
                class="row"
                type="button"
                aria-expanded={open}
                onclick={() => toggle(assistant.id)}
              >
                <AssistantMark {assistant} size={36} />
                <span class="body-cell">
                  <span class="row-title">{assistant.name}</span>
                  <span class="row-line">{line(assistant)}</span>
                  <span class="row-meta">
                    <span class="state">
                      <i class="dot" data-tone={assistant.paused ? 'needs' : 'done'}></i>
                      {assistant.paused ? 'paused' : 'done'}
                    </span>
                    <span class="age">
                      {assistant.lastRunAt ? formatAge(assistant.lastRunAt) : 'never'}
                    </span>
                  </span>
                </span>
                <CioChevronDown class="chev" size={16} />
              </button>

              {#if open}
                <div class="detail" transition:fold>
                  <p class="run"><span>{assistant.description}</span></p>
                  <p class="run">
                    <span>Work produced</span>
                    <em>
                      {assistant.threadCount === 1
                        ? '1 thread'
                        : `${assistant.threadCount} threads`}
                    </em>
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
            {:else}
              <div class="row">
                <AssistantMark {assistant} size={36} />
                <span class="body-cell">
                  <span class="row-title">{assistant.name}</span>
                  <span class="row-line">{line(assistant)}</span>
                  <span class="row-meta">
                    <span class="state">
                      <i class="dot" data-tone={assistant.paused ? 'needs' : 'done'}></i>
                      {assistant.paused ? 'paused' : 'done'}
                    </span>
                    <span class="age">
                      {assistant.lastRunAt ? formatAge(assistant.lastRunAt) : 'never'}
                    </span>
                  </span>
                </span>
              </div>
            {/if}
          {/each}
        </section>
      {/if}
    {/each}
  {/if}
</div>
