<script lang="ts">
  import CioClose from '@pdslng/cio-icon/CioClose.svelte'
  import CioSearch from '@pdslng/cio-icon/CioSearch.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import { Popover } from 'bits-ui'
  import { isOrchestrationChildThread, type Thread, type ThreadSearchResult } from '$shared/types'
  import { invoke } from '$lib/ipc.svelte'

  export type ThreadSearchResolver = (query: string, threads: Thread[]) => Thread[]

  interface FtsScope {
    /** Scope the search to one project. Omit for a global search. */
    projectId?: string
    /** Scope the search to one thread family: the project threads, the chats, or
     *  one assistant's tasks. Omitted, a search spans every family except the
     *  hidden browser-chat container. */
    family?: 'projects' | 'chats' | 'assistant'
    /** Optional client-side filter applied to results (e.g. exclude the inbox). */
    filter?: (thread: Thread) => boolean
  }

  interface Props {
    threads: Thread[]
    contextLabel: string
    title: string
    onOpen: (thread: Thread) => void | Promise<void>
    resolve?: ThreadSearchResolver
    /** Enable full-text search over titles, user messages and agent output. */
    fts?: FtsScope
  }

  function threadSortKey(thread: Thread): number {
    if (thread.status === 'created') return 0
    if (
      thread.status === 'planning' ||
      thread.status === 'executing' ||
      thread.status === 'working-paused' ||
      thread.status === 'awaiting_approval' ||
      thread.status === 'spec' ||
      thread.status === 'failed' ||
      thread.status === 'interrupted' ||
      !thread.read
    ) {
      return 1
    }
    return 2
  }

  function defaultResolve(query: string, threads: Thread[]): Thread[] {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return []
    return threads
      .filter(
        (thread) =>
          !thread.archived &&
          !isOrchestrationChildThread(thread) &&
          thread.title.toLowerCase().includes(normalized)
      )
      .sort((left, right) => {
        const stageDifference = threadSortKey(left) - threadSortKey(right)
        if (stageDifference !== 0) return stageDifference
        const leftOrder = left.sortOrder ?? -1
        const rightOrder = right.sortOrder ?? -1
        if (leftOrder !== rightOrder) return leftOrder - rightOrder
        return right.lastActivity - left.lastActivity
      })
  }

  let { threads, contextLabel, title, onOpen, resolve = defaultResolve, fts }: Props = $props()

  let open = $state(false)
  let query = $state('')
  let searchInput = $state<HTMLInputElement | undefined>()

  let syncResults = $derived(
    fts ? [] : resolve(query, threads).map((thread) => ({ thread, kind: 'title' as const }))
  )

  const SEARCH_DEBOUNCE_MS = 140
  const SEARCH_LIMIT = 30

  let ftsResults = $state<ThreadSearchResult[]>([])
  let searching = $state(false)
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  let searchRequestId = 0

  function runFtsSearch(raw: string): void {
    clearTimeout(searchTimer)
    const requestId = ++searchRequestId
    const scope = fts
    if (!scope) return
    const safeQuery = raw.trim()
    if (!safeQuery) {
      searching = false
      ftsResults = []
      return
    }
    searching = true
    searchTimer = setTimeout(() => {
      void invoke('threads:search', safeQuery, {
        projectId: scope.projectId,
        family: scope.family,
        limit: SEARCH_LIMIT
      })
        .then((results) => {
          if (requestId !== searchRequestId) return
          ftsResults = (
            scope.filter ? results.filter((r) => scope.filter?.(r.thread)) : results
          ).filter((r) => !isOrchestrationChildThread(r.thread))
          searching = false
        })
        .catch(() => {
          if (requestId !== searchRequestId) return
          ftsResults = []
          searching = false
        })
    }, SEARCH_DEBOUNCE_MS)
  }

  let results = $derived(fts ? ftsResults : syncResults)

  // Opening the panel is a request to type: the field takes the focus, and the
  // query that is already there is selected so the next keystroke replaces it.
  $effect(() => {
    if (!open) return
    const field = searchInput
    if (!field) return
    field.focus()
    field.select()
  })

  function closeSearch(): void {
    open = false
    query = ''
    ftsResults = []
    searching = false
    searchRequestId++
    clearTimeout(searchTimer)
  }

  async function openThread(thread: Thread): Promise<void> {
    closeSearch()
    await onOpen(thread)
  }
</script>

<Popover.Root
  bind:open
  onOpenChange={(next) => {
    if (!next) closeSearch()
  }}
>
  <Popover.Trigger
    class="titlebar-no-drag flex h-7 w-7 items-center justify-center text-muted transition-colors hover:bg-elevated hover:text-foreground"
    aria-label={title}
    {title}
  >
    <CioSearch size={15} strokeWidth={1.8} />
  </Popover.Trigger>

  <Popover.Portal>
    <Popover.Content
      sideOffset={8}
      collisionPadding={16}
      align="end"
      class="titlebar-no-drag z-50 w-80 overflow-hidden border bg-surface shadow-lg"
      aria-label="Search {contextLabel}"
      onCloseAutoFocus={(e) => e.preventDefault()}
    >
      <!-- One field, one dismiss. A `type="search"` input draws Chromium's own
           clear glyph next to this one, so the panel carried two X's and only
           the right one meant anything: the field is a plain text input now. -->
      <div class="flex items-center gap-2 border-b px-2.5 py-1.5">
        <CioSearch size={12} class="shrink-0 text-dimmed" />
        <input
          bind:this={searchInput}
          bind:value={query}
          oninput={(e: Event & { currentTarget: HTMLInputElement }) =>
            runFtsSearch(e.currentTarget.value)}
          type="text"
          class="min-w-0 flex-1 bg-transparent text-[0.75rem] text-foreground outline-none placeholder:text-dimmed"
          placeholder="Search {contextLabel}…"
          aria-label="Search {contextLabel}"
        />
        <button
          class="flex h-5 w-5 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
          aria-label="Dismiss search"
          title="Dismiss search"
          onclick={() => {
            // Dismissal already empties the query and its results, so this is
            // the one control the panel needs, and it always means the same
            // thing whether something is typed or not.
            closeSearch()
          }}
        >
          <CioClose size={12} />
        </button>
      </div>

      <div class="max-h-72 overflow-y-auto">
        {#if query.trim()}
          {#if searching && results.length === 0}
            <p
              class="flex items-center justify-center gap-1.5 px-3 py-3 text-[0.6875rem] text-dimmed"
            >
              <CioSpinner size={11} class="animate-spin" />
              Searching…
            </p>
          {:else if results.length === 0}
            <p class="px-3 py-3 text-[0.6875rem] text-dimmed">No matching threads</p>
          {:else}
            {#each results as result (result.thread.id)}
              {@const thread = result.thread}
              <button
                class="flex w-full flex-col gap-0.5 px-2 py-1.5 text-left transition-colors hover:bg-elevated"
                title={thread.title}
                onclick={() => void openThread(thread)}
              >
                <span class="flex min-w-0 items-center gap-2">
                  <span class="min-w-0 flex-1 truncate text-[0.75rem] text-foreground">
                    {thread.title}
                  </span>
                  <span class="shrink-0 text-[0.625rem] capitalize text-dimmed">
                    {thread.status.replace('_', ' ')}
                  </span>
                </span>
                {#if result.kind === 'message' && result.snippet}
                  <span class="line-clamp-2 text-[0.6875rem] leading-snug text-dimmed">
                    <span class="text-[0.625rem] uppercase tracking-wide text-dimmed/80">
                      {result.role === 'assistant' ? 'Agent' : 'You'}
                    </span>
                    <span aria-hidden="true"> · </span>
                    {result.snippet}
                  </span>
                {/if}
              </button>
            {/each}
          {/if}
        {:else}
          <p class="px-3 py-3 text-[0.6875rem] text-dimmed">Type to search {contextLabel}</p>
        {/if}
      </div>
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>
