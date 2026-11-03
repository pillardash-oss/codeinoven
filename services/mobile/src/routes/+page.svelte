<script lang="ts">
  import { onMount } from 'svelte'
  import CioSearch from '@pdslng/cio-icon/CioSearch.svelte'
  import CioRefresh from '@pdslng/cio-icon/CioRefresh.svelte'
  import CioChevronDown from '@pdslng/cio-icon/CioChevronDown.svelte'
  import { api, ApiError } from '#lib/api/client'
  import { STATUS_WEIGHT } from '#lib/api/status'
  import type { ThreadStatus } from '#lib/api/types'
  import type { Project, Thread } from '#lib/api/types'
  import AppBar from '#lib/components/AppBar.svelte'
  import Mark from '#lib/components/Mark.svelte'
  import ThreadRow from '#lib/components/ThreadRow.svelte'

  /**
   * Projects. The desktop's project panel, folded down to what a thumb can do:
   * one strip per project, its threads inside it, and the activity cluster that
   * says what needs attention without opening anything. The whole list is two
   * requests, because every thread arrives once and is grouped here.
   */

  const FOLD_KEY = 'cio.mobile.projects.folded'
  const ROWS_PER_STRIP = 4

  let projects = $state<Project[]>([])
  let threads = $state<Thread[]>([])
  let loading = $state(true)
  let error = $state<string | null>(null)
  let searchOpen = $state(false)
  let query = $state('')
  let folded = $state<Record<string, boolean>>({})

  /** Focus the filter as soon as it appears, because a search control that opens
   *  without the caret is a second tap the user did not ask for. */
  function focusOnMount(node: HTMLInputElement): void {
    node.focus()
  }

  function readFolded(): Record<string, boolean> {
    try {
      const raw = globalThis.localStorage?.getItem(FOLD_KEY)
      if (!raw) return {}
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null) return {}
      const result: Record<string, boolean> = {}
      for (const [key, value] of Object.entries(parsed)) {
        if (value === true) result[key] = true
      }
      return result
    } catch {
      return {}
    }
  }

  function writeFolded(): void {
    try {
      globalThis.localStorage?.setItem(FOLD_KEY, JSON.stringify(folded))
    } catch {
      // A phone with no storage still folds; it just forgets between launches.
    }
  }

  function toggle(id: string): void {
    folded = { ...folded, [id]: !folded[id] }
    writeFolded()
  }

  async function load(): Promise<void> {
    loading = true
    error = null
    try {
      const [projectPage, threadPage] = await Promise.all([
        api.projects({ sort: 'activity', limit: 100 }),
        api.threads({ limit: 200 })
      ])
      projects = projectPage.items
      threads = threadPage.items
    } catch (cause) {
      error =
        cause instanceof ApiError
          ? cause.message
          : 'Projects could not be loaded. Check that the service is running.'
    } finally {
      loading = false
    }
  }

  onMount(() => {
    folded = readFolded()
    void load()
  })

  let filteredProjects = $derived(
    query.trim()
      ? projects.filter((project) =>
          project.name.toLowerCase().includes(query.trim().toLowerCase())
        )
      : projects
  )

  /** One strip per visible project, with its threads already in reading order. */
  let strips = $derived(
    filteredProjects.map((project) => ({
      project,
      rows: threads
        .filter((thread) => thread.projectId === project.id)
        .sort((a, b) => {
          const weight = statusWeight(a.status) - statusWeight(b.status)
          return weight !== 0 ? weight : b.lastActivity - a.lastActivity
        })
    }))
  )

  function statusWeight(status: ThreadStatus): number {
    return STATUS_WEIGHT[status] ?? 99
  }

  function totalThreads(): number {
    return projects.reduce((sum, project) => sum + project.threadCount, 0)
  }

  function toggleSearch(): void {
    searchOpen = !searchOpen
    if (!searchOpen) query = ''
  }

  function clusterLabel(project: Project): string {
    const parts: string[] = []
    const counts = project.statusCounts
    if (counts.attention > 0) parts.push(`${counts.attention} need attention`)
    if (counts.spec > 0) parts.push(`${counts.spec} have a spec ready`)
    if (counts.working > 0) parts.push(`${counts.working} working`)
    if (counts.failed > 0) parts.push(`${counts.failed} failed`)
    return parts.length > 0 ? parts.join(', ') : 'Nothing running'
  }
</script>

<AppBar title="Projects" count={projects.length}>
  {#snippet actions()}
    <button
      class="icon-btn"
      type="button"
      aria-label="Search projects"
      title="Search projects"
      aria-pressed={searchOpen}
      onclick={toggleSearch}
    >
      <CioSearch size={20} />
    </button>
    <button
      class="icon-btn"
      type="button"
      aria-label="Refresh projects"
      title="Refresh projects"
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
      placeholder="Filter projects"
      aria-label="Filter projects"
      autocomplete="off"
    />
  </div>
{/if}

<div class="list" data-list>
  {#if loading}
    {#each [0, 1, 2] as row (row)}
      <div class="skeleton-strip" aria-hidden="true">
        <span class="skeleton-line"></span>
      </div>
    {/each}
  {:else if error}
    <p class="empty">{error}</p>
    <div class="retry-row">
      <button class="btn" type="button" onclick={load}>Retry</button>
    </div>
  {:else if filteredProjects.length === 0}
    <p class="empty">
      {query ? 'No project matches that name' : 'No projects yet. Add one on the desktop.'}
    </p>
  {:else}
    {#each strips as { project, rows } (project.id)}
      {@const open = !folded[project.id]}
      <section class="strip" data-open={open}>
        <div class="strip-head">
          <button
            class="strip-toggle"
            type="button"
            aria-expanded={open}
            aria-label="{open ? 'Fold' : 'Unfold'} {project.name}"
            onclick={() => toggle(project.id)}
          >
            <CioChevronDown class="strip-caret" size={14} />
            <Mark {project} size={28} />
            <span class="strip-name">{project.name}</span>
            <span class="strip-count">{project.threadCount}</span>
          </button>
          <span class="cluster" role="img" aria-label={clusterLabel(project)}>
            {#if project.statusCounts.attention > 0}
              <span style:color="var(--color-warning)">
                <i class="dot" data-tone="needs"></i>{project.statusCounts.attention}
              </span>
            {/if}
            {#if project.statusCounts.spec > 0}
              <span style:color="var(--color-thread-spec)">
                <i class="dot" data-tone="spec"></i>{project.statusCounts.spec}
              </span>
            {/if}
            {#if project.statusCounts.working > 0}
              <span style:color="var(--color-info)">
                <i class="dot" data-tone="working"></i>{project.statusCounts.working}
              </span>
            {/if}
          </span>
        </div>
        <div class="strip-body">
          {#each rows.slice(0, ROWS_PER_STRIP) as thread (thread.id)}
            <ThreadRow {thread} compact />
          {:else}
            <p class="strip-empty">No threads in this project yet</p>
          {/each}
          {#if rows.length > ROWS_PER_STRIP}
            <a class="strip-more" href="/threads?project={project.id}">
              All {project.threadCount} threads
            </a>
          {/if}
        </div>
      </section>
    {/each}
    <p class="list-foot">{totalThreads()} threads across {projects.length} projects</p>
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

  .skeleton-strip {
    padding: 0.875rem var(--gutter);
  }

  .skeleton-line {
    display: block;
    height: 1.25rem;
    background: var(--color-elevated);
  }

  .retry-row {
    display: flex;
    justify-content: flex-end;
    padding: 0 var(--gutter) 1rem;
  }

  .strip-empty {
    margin: 0;
    padding: 0.75rem var(--row-inset);
    color: var(--ink-meta);
    font-size: 0.875rem;
  }

  .strip-more {
    display: block;
    padding: 0.75rem var(--row-inset);
    color: var(--ink-meta);
    font-size: 0.8125rem;
    text-decoration: none;
  }

  .strip-more:hover {
    color: var(--color-foreground);
  }

  .list-foot {
    margin: 0;
    padding: 1.25rem var(--gutter) 1.5rem;
    color: var(--ink-meta);
    font-size: 0.75rem;
  }
</style>
