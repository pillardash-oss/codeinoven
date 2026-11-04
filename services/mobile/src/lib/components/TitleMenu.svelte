<script lang="ts">
  import { goto } from '$app/navigation'
  import CioCheck from '@pdslng/cio-icon/CioCheck.svelte'
  import CioChevronDown from '@pdslng/cio-icon/CioChevronDown.svelte'
  import CioProjects from '@pdslng/cio-icon/CioProjects.svelte'
  import CioThreads from '@pdslng/cio-icon/CioThreads.svelte'
  import { rememberWorkView, workViewHref, type WorkView } from '#lib/work-view'

  /**
   * The list's own title, and the only control that switches the list between
   * threads and projects. It is the title rather than a separate picker: the
   * design draws the count, the caret and the menu here, and a phone has no room
   * for a second row that says the same thing.
   */
  interface Props {
    view: WorkView
    title: string
    count: number | null
    threads: number | null
    projects: number | null
  }

  let { view, title, count, threads, projects }: Props = $props()

  let open = $state(false)

  let items = $derived([
    { view: 'projects' as const, label: 'Projects', total: projects },
    { view: 'threads' as const, label: 'Threads', total: threads }
  ])

  function choose(next: WorkView): void {
    open = false
    if (next === view) return
    void rememberWorkView(next)
    void goto(workViewHref(next))
  }
</script>

<svelte:window
  onpointerdown={(event) => {
    const target = event.target
    if (target instanceof Element && target.closest('.title-btn, .title-menu')) return
    open = false
  }}
  onkeydown={(event) => {
    if (event.key === 'Escape') open = false
  }}
/>

<div class="title-switch">
  <button
    class="title-btn"
    type="button"
    aria-expanded={open}
    aria-haspopup="menu"
    title="Switch between threads and projects"
    onclick={() => (open = !open)}
  >
    <h1>
      {title}
      {#if count !== null}<span class="count">{count}</span>{/if}
    </h1>
    <CioChevronDown size={16} />
  </button>

  {#if open}
    <div class="title-menu" role="menu" aria-label="Threads or projects">
      {#each items as item (item.view)}
        <button
          class="title-menu-item"
          type="button"
          role="menuitem"
          aria-current={item.view === view ? 'page' : undefined}
          onclick={() => choose(item.view)}
        >
          {#if item.view === 'projects'}
            <CioProjects size={17} />
          {:else}
            <CioThreads size={17} />
          {/if}
          <span>{item.label}</span>
          {#if item.total !== null}<span class="n">{item.total}</span>{/if}
          {#if item.view === view}<CioCheck size={14} class="tick" />{/if}
        </button>
      {/each}
    </div>
  {/if}
</div>
