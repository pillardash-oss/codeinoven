<script lang="ts">
  import CioCheck from '@pdslng/cio-icon/CioCheck.svelte'
  import CioChevronDown from '@pdslng/cio-icon/CioChevronDown.svelte'
  import CioProjects from '@pdslng/cio-icon/CioProjects.svelte'
  import CioThreads from '@pdslng/cio-icon/CioThreads.svelte'
  import { arrive } from '#lib/motion'

  /**
   * Projects and Threads are one destination read two ways, so the screen's
   * title is the switch between them: the title carries the count, the caret
   * says it opens, and the menu marks the list you are already reading. A phone
   * has no second axis for two lists, so the title spends the one it has.
   */
  interface Props {
    current: 'projects' | 'threads'
    count: number
    projects: number
    threads: number
  }

  let { current, count, projects, threads }: Props = $props()

  let open = $state(false)
  let wrap: HTMLDivElement | null = null

  let title = $derived(current === 'projects' ? 'Projects' : 'Threads')

  function attach(node: HTMLDivElement): () => void {
    wrap = node
    return () => {
      wrap = null
    }
  }

  function outside(event: PointerEvent): void {
    if (!open) return
    const target = event.target
    if (target instanceof Node && wrap?.contains(target)) return
    open = false
  }

  function escape(event: KeyboardEvent): void {
    if (event.key === 'Escape' && open) open = false
  }

  function choose(): void {
    open = false
  }
</script>

<svelte:window onpointerdown={outside} onkeydown={escape} />

<div class="title-wrap" {@attach attach}>
  <button
    class="title-btn"
    type="button"
    aria-expanded={open}
    aria-haspopup="menu"
    aria-label="{title}, switch between projects and threads"
    title="{title}: switch between projects and threads"
    onclick={() => (open = !open)}
  >
    <h1>
      {title}
      <span class="count">{count}</span>
    </h1>
    <CioChevronDown class="caret" size={16} />
  </button>

  {#if open}
    <div class="menu" role="menu" aria-label="Lists" in:arrive>
      <a
        class="menu-item"
        role="menuitem"
        href="/"
        aria-current={current === 'projects' ? 'page' : undefined}
        onclick={choose}
      >
        <CioProjects size={16} />
        <span>Projects</span>
        <span class="n">{projects}</span>
        {#if current === 'projects'}<CioCheck class="tick" size={16} />{/if}
      </a>
      <a
        class="menu-item"
        role="menuitem"
        href="/threads"
        aria-current={current === 'threads' ? 'page' : undefined}
        onclick={choose}
      >
        <CioThreads size={16} />
        <span>Threads</span>
        <span class="n">{threads}</span>
        {#if current === 'threads'}<CioCheck class="tick" size={16} />{/if}
      </a>
    </div>
  {/if}
</div>

<style>
  .title-wrap {
    min-width: 0;
  }

  .count {
    margin-left: 0.5rem;
    font-size: 1rem;
    font-weight: 200;
    color: var(--ink-meta);
  }
</style>
