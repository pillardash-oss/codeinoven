<script lang="ts">
  import { onMount } from 'svelte'
  import { goto } from '$app/navigation'
  import { page } from '$app/state'
  import CioPlus from '@pdslng/cio-icon/CioPlus.svelte'
  import { api, ApiError } from '#lib/api/client'
  import type { Project } from '#lib/api/types'
  import Mark from './Mark.svelte'
  import Sheet from './Sheet.svelte'

  /**
   * A new thread, started from the phone. It needs two things and nothing else:
   * which project it belongs to, and what it is called. The desktop picks the
   * work up from there, which is why this sheet is a title and a project rather
   * than a second composer.
   */
  interface Props {
    open: boolean
    onclose: () => void
  }

  let { open, onclose }: Props = $props()

  let projects = $state<Project[]>([])
  let loading = $state(true)
  let error = $state<string | null>(null)
  let title = $state('')
  let projectId = $state('')
  let saving = $state(false)

  let scoped = $derived(page.url.searchParams.get('project') ?? '')
  let chosen = $derived(projectId || scoped || projects[0]?.id || '')
  let canCreate = $derived(title.trim().length > 0 && chosen.length > 0 && !saving)

  function focusOnMount(node: HTMLInputElement): void {
    node.focus()
  }

  async function load(): Promise<void> {
    loading = true
    error = null
    try {
      const result = await api.projects({ sort: 'activity', limit: 100 })
      projects = result.items
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : 'Projects could not be loaded right now.'
    } finally {
      loading = false
    }
  }

  async function create(): Promise<void> {
    const body = title.trim()
    if (body.length === 0 || chosen.length === 0 || saving) return
    saving = true
    error = null
    try {
      const thread = await api.createThread({ projectId: chosen, title: body })
      title = ''
      onclose()
      await goto(`/threads/${thread.id}`)
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : 'The thread could not be started.'
    } finally {
      saving = false
    }
  }

  function onSubmit(event: SubmitEvent): void {
    event.preventDefault()
    void create()
  }

  onMount(() => {
    void load()
  })
</script>

<Sheet {open} {onclose} label="New thread">
  <form class="sheet-form" onsubmit={onSubmit}>
    <div class="sheet-grab"></div>
    <div class="sheet-head">
      <h2>New thread</h2>
      <button type="button" onclick={onclose}>Cancel</button>
    </div>

    <label class="sheet-field">
      <span>What is the thread called?</span>
      <input
        {@attach focusOnMount}
        bind:value={title}
        type="text"
        placeholder="A short name for the work"
        autocomplete="off"
        maxlength="200"
      />
    </label>

    <p class="sheet-label">Project</p>
    <div class="sheet-scroll">
      {#if loading}
        <p class="empty">Reading your projects</p>
      {:else}
        {#each projects as project (project.id)}
          <button
            class="project-option"
            type="button"
            data-current={chosen === project.id}
            onclick={() => (projectId = project.id)}
          >
            <Mark {project} size={28} />
            <span>
              <span class="name">{project.name}</span>
              <span class="sub">{project.threadCount} threads</span>
            </span>
            {#if chosen === project.id}<span class="count">✓</span>{/if}
          </button>
        {/each}
      {/if}
    </div>

    {#if error}
      <p class="sheet-error" role="status">{error}</p>
    {/if}

    <div class="sheet-foot">
      <button class="btn quiet" type="button" onclick={onclose}>Cancel</button>
      <button class="btn primary with-icon" type="submit" disabled={!canCreate}>
        <CioPlus size={14} />
        {saving ? 'Starting' : 'Start thread'}
      </button>
    </div>
  </form>
</Sheet>
