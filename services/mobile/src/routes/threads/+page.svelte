<script lang="ts">
  import { onMount } from 'svelte'
  import CioInbox from '@pdslng/cio-icon/CioInbox.svelte'
  import CioSearch from '@pdslng/cio-icon/CioSearch.svelte'
  import CioRefresh from '@pdslng/cio-icon/CioRefresh.svelte'
  import { api, ApiError } from '#lib/api/client'
  import {
    INBOX_GROUPS,
    STATUS_WEIGHT,
    statusSkin,
    toneColor,
    type InboxGroup
  } from '#lib/api/status'
  import type { Project, Thread, ThreadStatus } from '#lib/api/types'
  import AppBar from '#lib/components/AppBar.svelte'
  import ThreadRow from '#lib/components/ThreadRow.svelte'
  import { page } from '$app/state'

  /**
   * Threads. The default view is every thread from every project in one run,
   * ordered by what needs the user first and then by recency, with each row
   * carrying its project's mark because no heading above it says which project
   * it belongs to. Inbox turns that one run into the status groups.
   */

  let threads = $state<Thread[]>([])
  let projects = $state<Project[]>([])
  let loading = $state(true)
  let error = $state<string | null>(null)
  let inbox = $state(false)
  let group = $state<InboxGroup | 'all'>('all')
  let searchOpen = $state(false)
  let query = $state('')
  /** Focus the filter as soon as it appears, for the same reason as Projects. */
  function focusOnMount(node: HTMLInputElement): void {
    node.focus()
  }

  let projectFilter = $derived(page.url.searchParams.get('project'))

  async function load(): Promise<void> {
    loading = true
    error = null
    try {
      const [threadPage, projectPage] = await Promise.all([
        api.threads({ limit: 200, project: projectFilter ?? undefined }),
        api.projects({ sort: 'activity', limit: 100 })
      ])
      threads = threadPage.items
      projects = projectPage.items
    } catch (cause) {
      error =
        cause instanceof ApiError
          ? cause.message
          : 'Threads could not be loaded. Check that the service is running.'
    } finally {
      loading = false
    }
  }

  onMount(() => {
    void load()
  })

  function projectOf(id: string): Project | null {
    return projects.find((project) => project.id === id) ?? null
  }

  let visible = $derived.by(() => {
    const needle = query.trim().toLowerCase()
    return threads
      .filter((thread) => {
        if (needle && !thread.title.toLowerCase().includes(needle)) return false
        if (group === 'all') return true
        if (group === 'unread') return !thread.read
        return statusSkin(thread.status).group === group
      })
      .sort((a, b) => {
        const weight = statusWeight(a.status) - statusWeight(b.status)
        if (weight !== 0) return weight
        return b.lastActivity - a.lastActivity
      })
  })

  let scopeName = $derived(
    projectFilter ? (projectOf(projectFilter)?.name ?? 'Project') : 'Threads'
  )

  function statusWeight(status: ThreadStatus): number {
    return STATUS_WEIGHT[status] ?? 99
  }

  function countFor(id: InboxGroup): number {
    if (id === 'unread') return threads.filter((thread) => !thread.read).length
    return threads.filter((thread) => statusSkin(thread.status).group === id).length
  }

  function toggleSearch(): void {
    searchOpen = !searchOpen
    if (!searchOpen) query = ''
  }

  function toggleInbox(): void {
    inbox = !inbox
    if (!inbox) group = 'all'
  }
</script>

<AppBar title={scopeName} count={visible.length}>
  {#snippet actions()}
    <button
      class="icon-btn"
      type="button"
      aria-label="Search threads"
      title="Search threads"
      aria-pressed={searchOpen}
      onclick={toggleSearch}
    >
      <CioSearch size={20} />
    </button>
    <button
      class="icon-btn"
      type="button"
      aria-label="Inbox: group threads by status"
      title="Inbox: group threads by status"
      aria-pressed={inbox}
      onclick={toggleInbox}
    >
      <CioInbox size={20} />
    </button>
    <button
      class="icon-btn"
      type="button"
      aria-label="Refresh threads"
      title="Refresh threads"
      onclick={load}
    >
      <CioRefresh size={20} />
    </button>
  {/snippet}
</AppBar>

{#if searchOpen}
  <div class="search-row">
    <input
      {@attach focusOnMount}
      bind:value={query}
      type="search"
      placeholder="Filter threads"
      aria-label="Filter threads"
      autocomplete="off"
    />
  </div>
{/if}

{#if inbox}
  <div class="tabs inbox" role="group" aria-label="Group threads by status">
    <button
      class="tab"
      type="button"
      aria-pressed={group === 'all'}
      onclick={() => (group = 'all')}
    >
      All
    </button>
    {#each INBOX_GROUPS as entry (entry.id)}
      <button
        class="tab"
        type="button"
        aria-pressed={group === entry.id}
        style:color={entry.tone ? toneColor(entry.tone) : undefined}
        onclick={() => (group = entry.id)}
      >
        {entry.label}
        {#if countFor(entry.id) > 0}<span class="tab-count">{countFor(entry.id)}</span>{/if}
      </button>
    {/each}
  </div>
{/if}

<div class="list">
  {#if loading}
    {#each [0, 1, 2, 3, 4] as row (row)}
      <div class="skeleton-row" aria-hidden="true"><span></span></div>
    {/each}
  {:else if error}
    <p class="empty">{error}</p>
    <div class="retry-row">
      <button class="btn" type="button" onclick={load}>Retry</button>
    </div>
  {:else if visible.length === 0}
    <p class="empty">
      {query || group !== 'all' ? 'No thread matches this filter' : 'No threads yet'}
    </p>
  {:else}
    {#each visible as thread (thread.id)}
      <ThreadRow {thread} project={projectOf(thread.projectId)} showProject />
    {/each}
  {/if}
</div>

<style>
  .search-row {
    flex: none;
    padding: 0 var(--gutter) 0.5rem;
  }

  .search-row input {
    width: 100%;
    padding: 0.625rem 0.75rem;
    border: 1px solid var(--color-border);
    background: var(--color-surface);
    color: var(--color-foreground);
    font: inherit;
    font-size: 0.9375rem;
  }

  .tab-count {
    margin-left: 0.3125rem;
    font-size: 0.75rem;
    color: var(--ink-meta);
  }

  .skeleton-row {
    padding: 0.875rem var(--gutter);
  }

  .skeleton-row span {
    display: block;
    height: 2.25rem;
    background: var(--color-elevated);
  }

  .retry-row {
    display: flex;
    justify-content: flex-end;
    padding: 0 var(--gutter) 1rem;
  }
</style>
