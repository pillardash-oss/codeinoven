<script lang="ts">
  import { onMount } from 'svelte'
  import { goto } from '$app/navigation'
  import { page } from '$app/state'
  import CioThreads from '@pdslng/cio-icon/CioThreads.svelte'
  import { api, ApiError } from '#lib/api/client'
  import type { Project } from '#lib/api/types'
  import Mark from './Mark.svelte'
  import Sheet from './Sheet.svelte'

  /**
   * The project switcher. A phone has one column, so choosing a project scopes
   * the thread list you are already reading rather than opening a second list,
   * and the chosen project is filled rather than ticked because that is the same
   * reading as the dock's current item.
   */
  interface Props {
    open: boolean
    onclose: () => void
  }

  let { open, onclose }: Props = $props()

  let projects = $state<Project[]>([])
  let loading = $state(false)
  let error = $state<string | null>(null)
  let loaded = $state(false)

  let current = $derived(page.url.searchParams.get('project') ?? '')

  async function load(): Promise<void> {
    loading = true
    error = null
    try {
      const pageOfProjects = await api.projects({ sort: 'activity', limit: 100 })
      projects = pageOfProjects.items
      loaded = true
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : 'Projects could not be loaded right now.'
    } finally {
      loading = false
    }
  }

  onMount(() => {
    void load()
  })

  function choose(id: string): void {
    onclose()
    void goto(id ? `/threads?project=${id}` : '/threads')
  }

  function summary(project: Project): string {
    const counts = project.statusCounts
    const threads = project.threadCount === 1 ? '1 thread' : `${project.threadCount} threads`
    const working = counts.working > 0 ? ` · ${counts.working} working` : ''
    return `${threads}${working}`
  }
</script>

<Sheet {open} {onclose} label="Projects">
  <div class="sheet-grab"></div>
  <div class="sheet-head">
    <h2>Projects</h2>
    <button type="button" onclick={onclose}>Done</button>
  </div>

  <div class="sheet-scroll">
    <button
      class="project-option"
      type="button"
      data-current={current === ''}
      onclick={() => choose('')}
    >
      <span class="glyph"><CioThreads size={16} /></span>
      <span>
        <span class="name">All threads</span>
        <span class="sub"
          >{projects.reduce((sum, project) => sum + project.threadCount, 0)} threads</span
        >
      </span>
      <span class="count">{projects.reduce((sum, project) => sum + project.threadCount, 0)}</span>
    </button>

    {#if loading && !loaded}
      <p class="empty">Reading your projects</p>
    {:else if error}
      <p class="empty">{error}</p>
      <div class="retry-row"><button class="btn" type="button" onclick={load}>Retry</button></div>
    {:else}
      {#each projects as project (project.id)}
        <button
          class="project-option"
          type="button"
          data-current={current === project.id}
          onclick={() => choose(project.id)}
        >
          <Mark {project} size={28} />
          <span>
            <span class="name">{project.name}</span>
            <span class="sub">{summary(project)}</span>
          </span>
          <span class="count">{project.threadCount}</span>
        </button>
      {/each}
    {/if}
  </div>
</Sheet>
