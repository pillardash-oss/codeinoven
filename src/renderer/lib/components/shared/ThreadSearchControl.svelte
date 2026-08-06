<script lang="ts">
  import { Loader2, Search, X } from '@lucide/svelte'
  import { Popover } from 'bits-ui'
  import type { Thread, ThreadSearchResult } from '$shared/types'
  import { invoke } from '$lib/ipc.svelte'

  export type ThreadSearchResolver = (query: string, threads: Thread[]) => Thread[]

  interface FtsScope {
    /** Scope the search to one project. Omit for a global search. */
    projectId?: string
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
      thread.status === 'awaiting_approval' ||
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
      .filter((thread) => !thread.archived && thread.title.toLowerCase().includes(normalized))
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
        limit: SEARCH_LIMIT
      })
        .then((results) => {
          if (requestId !== searchRequestId) return
          ftsResults = scope.filter ? results.filter((r) => scope.filter?.(r.thread)) : results
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
    class="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-foreground"
    aria-label={title}
    {title}
  >
    <Search size={15} strokeWidth={1.8} />
  </Popover.Trigger>

  <Popover.Portal>
    <Popover.Content
      sideOffset={8}
      collisionPadding={16}
      align="end"
      class="z-50 w-80 overflow-hidden rounded-xl border bg-surface shadow-lg"
      aria-label="Search {contextLabel}"
      onCloseAutoFocus={(e) => e.preventDefault()}
    >
      <div class="flex items-center gap-2 border-b px-3 py-2">
        <Search size={14} class="shrink-0 text-dimmed" />
        <input
          bind:this={searchInput}
          bind:value={query}
          oninput={(e: Event & { currentTarget: HTMLInputElement }) => runFtsSearch(e.currentTarget.value)}
          type="search"
          class="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-dimmed"
          placeholder="Search {contextLabel}..."
          aria-label="Search {contextLabel}"
        />
        {#if query}
          <button
            class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
            aria-label="Clear search"
            title="Clear search"
            onclick={() => {
              query = ''
              ftsResults = []
              searching = false
              searchRequestId++
              searchInput?.focus()
            }}
          >
            <X size={13} />
          </button>
        {/if}
      </div>

      <div class="max-h-80 overflow-y-auto p-1">
        {#if query.trim()}
          {#if searching && results.length === 0}
            <p
              class="flex items-center justify-center gap-1.5 px-3 py-6 text-center text-xs text-dimmed"
            >
              <Loader2 size={12} class="animate-spin" />
              Searching…
            </p>
          {:else if results.length === 0}
            <p class="px-3 py-6 text-center text-xs text-dimmed">No matching threads</p>
          {:else}
            {#each results as result (result.thread.id)}
              {@const thread = result.thread}
              <button
                class="flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-elevated"
                title={thread.title}
                onclick={() => void openThread(thread)}
              >
                <span class="flex min-w-0 items-center gap-2">
                  <span class="min-w-0 flex-1 truncate text-sm text-foreground">
                    {thread.title}
                  </span>
                  <span class="shrink-0 text-[10px] capitalize text-dimmed">
                    {thread.status.replace('_', ' ')}
                  </span>
                </span>
                {#if result.kind === 'message' && result.snippet}
                  <span class="line-clamp-2 text-[11px] leading-snug text-dimmed">
                    <span class="text-[10px] uppercase tracking-wide text-dimmed/80">
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
          <p class="px-3 py-6 text-center text-xs text-dimmed">
            Type to search {contextLabel}
          </p>
        {/if}
      </div>
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>
