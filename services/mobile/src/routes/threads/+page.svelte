<script lang="ts">
  import { onMount } from 'svelte'
  import CioInbox from '@pdslng/cio-icon/CioInbox.svelte'
  import CioSearch from '@pdslng/cio-icon/CioSearch.svelte'
  import CioRefresh from '@pdslng/cio-icon/CioRefresh.svelte'
  import CioChevronDown from '@pdslng/cio-icon/CioChevronDown.svelte'
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
  import Sheet from '#lib/components/Sheet.svelte'
  import Switch from '#lib/components/Switch.svelte'
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

  /**
   * The inbox's groups. A short press turns grouping on; a long press opens the
   * panel that decides which groups exist and in what order, and the tabs draw
   * exactly what that panel says.
   */
  const INBOX_KEY = 'cio.mobile.inbox.groups'
  interface GroupRow {
    id: InboxGroup
    enabled: boolean
  }

  let groupRows = $state<GroupRow[]>(INBOX_GROUPS.map((entry) => ({ id: entry.id, enabled: true })))
  let drawerOpen = $state(false)
  let press: ReturnType<typeof setTimeout> | undefined
  let longPressed = false
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
    groupRows = readGroups()
    void load()
  })

  function readGroups(): GroupRow[] {
    const fallback = INBOX_GROUPS.map((entry) => ({ id: entry.id, enabled: true }))
    try {
      const raw = globalThis.localStorage?.getItem(INBOX_KEY)
      if (!raw) return fallback
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) return fallback
      const known = new Set(INBOX_GROUPS.map((entry) => entry.id))
      const rows: GroupRow[] = []
      for (const item of parsed) {
        if (typeof item !== 'object' || item === null) continue
        const candidate = item as { id?: unknown; enabled?: unknown }
        if (typeof candidate.id !== 'string' || !known.has(candidate.id as InboxGroup)) continue
        rows.push({ id: candidate.id as InboxGroup, enabled: candidate.enabled !== false })
      }
      for (const entry of INBOX_GROUPS) {
        if (!rows.some((row) => row.id === entry.id)) rows.push({ id: entry.id, enabled: true })
      }
      return rows
    } catch {
      return fallback
    }
  }

  function writeGroups(): void {
    try {
      globalThis.localStorage?.setItem(INBOX_KEY, JSON.stringify(groupRows))
    } catch {
      // A phone with no storage still groups; it just forgets the arrangement.
    }
  }

  function toggleGroup(id: InboxGroup, enabled: boolean): void {
    groupRows = groupRows.map((row) => (row.id === id ? { ...row, enabled } : row))
    if (!enabled && group === id) group = 'all'
    writeGroups()
  }

  function moveGroup(id: InboxGroup, direction: -1 | 1): void {
    const index = groupRows.findIndex((row) => row.id === id)
    const target = index + direction
    if (index < 0 || target < 0 || target >= groupRows.length) return
    const next = [...groupRows]
    const [moved] = next.splice(index, 1)
    if (!moved) return
    next.splice(target, 0, moved)
    groupRows = next
    writeGroups()
  }

  let activeGroups = $derived(
    groupRows
      .filter((row) => row.enabled)
      .map((row) => INBOX_GROUPS.find((entry) => entry.id === row.id))
      .filter((entry): entry is (typeof INBOX_GROUPS)[number] => entry !== undefined)
  )

  function beginPress(): void {
    longPressed = false
    press = setTimeout(() => {
      longPressed = true
      drawerOpen = true
    }, 450)
  }

  function endPress(): void {
    if (press) clearTimeout(press)
    press = undefined
  }

  function pressInbox(): void {
    if (longPressed) {
      longPressed = false
      return
    }
    toggleInbox()
  }

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
      onpointerdown={beginPress}
      onpointerup={endPress}
      onpointerleave={endPress}
      onpointercancel={endPress}
      onclick={pressInbox}
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
    {#each activeGroups as entry (entry.id)}
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

<Sheet open={drawerOpen} onclose={() => (drawerOpen = false)} label="Inbox groups">
  <div class="sheet-grab"></div>
  <div class="sheet-head">
    <h2>Inbox</h2>
    <button type="button" onclick={() => (drawerOpen = false)}>Done</button>
  </div>
  {#each groupRows as row (row.id)}
    {@const entry = INBOX_GROUPS.find((item) => item.id === row.id)}
    <div class="sheet-row">
      <i
        class="dot"
        data-tone={row.id}
        style:color={entry?.tone ? toneColor(entry.tone) : undefined}
      ></i>
      <span class="name">{entry?.label ?? row.id}</span>
      <button
        class="grip"
        type="button"
        aria-label="Move {entry?.label ?? row.id} up"
        title="Move {entry?.label ?? row.id} up"
        disabled={groupRows[0]?.id === row.id}
        onclick={() => moveGroup(row.id, -1)}
      >
        <CioChevronDown size={16} class="flip" />
      </button>
      <button
        class="grip"
        type="button"
        aria-label="Move {entry?.label ?? row.id} down"
        title="Move {entry?.label ?? row.id} down"
        disabled={groupRows[groupRows.length - 1]?.id === row.id}
        onclick={() => moveGroup(row.id, 1)}
      >
        <CioChevronDown size={16} />
      </button>
      <Switch
        checked={row.enabled}
        label="Show {entry?.label ?? row.id} in the inbox"
        onchange={(on) => toggleGroup(row.id, on)}
      />
    </div>
  {/each}
</Sheet>

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

  /* The reorder controls are the same glyph twice, one of them turned over, so
     the panel has one drawing per direction instead of two. */
  :global(.flip) {
    transform: rotate(180deg);
  }

  .sheet-row .dot {
    flex: none;
    width: 0.5rem;
    height: 0.5rem;
    background: currentColor;
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
