<script lang="ts">
  import { invalidateAll } from '$app/navigation'
  import CioSearch from '@pdslng/cio-icon/CioSearch.svelte'
  import PanelBar from '#lib/components/PanelBar.svelte'
  import ThreadRow from '#lib/components/ThreadRow.svelte'
  import TitleMenu from '#lib/components/TitleMenu.svelte'
  import type { PageData } from './$types'

  /**
   * The work list read as threads: every thread across every project, pinned
   * first and then newest and most urgent, each row carrying its project's mark
   * because no heading above it names the project. Projects is the other reading
   * of this same list, and the header's title switches between them, so this
   * screen never grows a second list.
   *
   * A long list is drawn as it is scrolled, because a hundred and twenty rows
   * laid out at once is a stall on a phone, not a list.
   */

  const PAGE = 40

  let { data }: { data: PageData } = $props()

  let searchOpen = $state(false)
  let query = $state('')
  let shown = $state(PAGE)

  let filtered = $derived(
    query.trim()
      ? data.threads.filter((thread) => {
          const needle = query.trim().toLowerCase()
          const project = data.projects.find((candidate) => candidate.id === thread.projectId)
          return (
            thread.title.toLowerCase().includes(needle) ||
            (project?.name ?? '').toLowerCase().includes(needle)
          )
        })
      : data.threads
  )

  function projectOf(id: string) {
    return data.projects.find((project) => project.id === id) ?? null
  }

  function focusOnMount(node: HTMLInputElement): void {
    node.focus()
  }

  function toggleSearch(): void {
    searchOpen = !searchOpen
    if (!searchOpen) query = ''
  }

  function search(event: Event): void {
    const target = event.currentTarget
    if (!(target instanceof HTMLInputElement)) return
    query = target.value
    shown = PAGE
  }

  /** The list grows as it is read rather than all at once. */
  function grow(node: HTMLElement): () => void {
    const listen = (): void => {
      if (node.scrollTop + node.clientHeight < node.scrollHeight - 320) return
      if (shown >= filtered.length) return
      shown = Math.min(filtered.length, shown + PAGE)
    }
    node.addEventListener('scroll', listen, { passive: true })
    return () => node.removeEventListener('scroll', listen)
  }

  function reload(): void {
    void invalidateAll()
  }
</script>

<PanelBar title="Threads">
  {#snippet titleControl()}
    <TitleMenu view="threads" title="Threads" />
  {/snippet}
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
  {/snippet}
</PanelBar>

{#if searchOpen}
  <div class="search-row">
    <input
      {@attach focusOnMount}
      value={query}
      oninput={search}
      type="search"
      placeholder="Filter threads"
      aria-label="Filter threads"
      autocomplete="off"
    />
  </div>
{/if}

<div class="list" {@attach grow}>
  {#if data.error}
    <p class="empty">{data.error}</p>
    <div class="retry-row">
      <button class="btn" type="button" onclick={reload}>Retry</button>
    </div>
  {:else if filtered.length === 0}
    <p class="empty">{query ? 'No thread matches that name' : 'No threads yet.'}</p>
  {:else}
    {#each filtered.slice(0, shown) as thread (thread.id)}
      <ThreadRow {thread} project={projectOf(thread.projectId)} />
    {/each}
  {/if}
</div>
