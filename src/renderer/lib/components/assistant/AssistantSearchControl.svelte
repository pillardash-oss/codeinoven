<script lang="ts">
  import AssistantIcon from '$lib/components/icons/cio/AssistantIcon.svelte'
  import CioAttention from '@pdslng/cio-icon/CioAttention.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import { AssistantDefaultIcon, getAssistantIcon } from '$lib/assistant-icons'
  import { assistants as assistantStore } from '$lib/stores/assistants.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import {
    assistantIsScheduled,
    isOrchestrationChildThread,
    type Assistant,
    type Thread,
    type ThreadSearchResult
  } from '$shared/types'
  import { assistantGap } from './assistant-view'

  interface Props {
    assistants: Assistant[]
    /** Assistant tasks. */
    tasks: Thread[]
    /** One run per execution of a task, each its own thread. */
    runs: Thread[]
    /** Open a task or run result. */
    onOpenTask: (task: Thread) => void
    /** Open an assistant result (its knowledge panel / first task). */
    onOpenAssistant: (assistant: Assistant) => void
    /** The query the panel's search field is holding. The field lives at the
     *  panel's foot; the results are this component, drawn in the list. */
    query?: string
  }

  let {
    assistants,
    tasks,
    runs,
    onOpenTask,
    onOpenAssistant,
    query = $bindable('')
  }: Props = $props()

  const trimmed = $derived(query.trim().toLowerCase())

  /** How long typing settles before one full-text read runs. The local name and
   *  title matches paint in the same frame as the keystroke, so this only gates
   *  the database answer, never the list the user is already reading. */
  const SEARCH_DEBOUNCE_MS = 140
  const SEARCH_LIMIT = 30

  /** Threads the main process matched by title, thread id, or conversation
   *  content. A pasted thread id only resolves here. */
  let remoteResults = $state<ThreadSearchResult[]>([])
  let searching = $state(false)
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  let searchRequestId = 0

  function runThreadSearch(raw: string): void {
    clearTimeout(searchTimer)
    const requestId = ++searchRequestId
    const safeQuery = raw.trim()
    if (!safeQuery) {
      searching = false
      remoteResults = []
      return
    }
    searching = true
    searchTimer = setTimeout(() => {
      void invoke('threads:search', safeQuery, { family: 'assistant', limit: SEARCH_LIMIT })
        .then((results) => {
          if (requestId !== searchRequestId) return
          remoteResults = results.filter((result) => !isOrchestrationChildThread(result.thread))
          searching = false
        })
        .catch(() => {
          if (requestId !== searchRequestId) return
          remoteResults = []
          searching = false
        })
    }, SEARCH_DEBOUNCE_MS)
  }

  /**
   * Plane the local list first and append the database matches it does not
   * already hold. The local rows already carry this session's live thread
   * objects, so a matched thread is never swapped for a hydrated copy.
   */
  function mergeMatches(local: Thread[], remote: readonly Thread[]): Thread[] {
    if (remote.length === 0) return local
    const seen: Record<string, true> = {}
    for (const thread of local) seen[thread.id] = true
    const merged = [...local]
    for (const thread of remote) {
      if (seen[thread.id]) continue
      seen[thread.id] = true
      merged.push(thread)
    }
    return merged
  }

  /** The matching conversation excerpt, for a thread whose hit is in its content
   *  rather than its title. The remote answer is bounded, so the lookup walks it
   *  instead of paying for an index on every keystroke. */
  function snippetFor(threadId: string): { role?: 'user' | 'assistant'; snippet: string } | null {
    for (const result of remoteResults) {
      if (result.thread.id !== threadId) continue
      if (result.kind !== 'message' || !result.snippet) return null
      return { role: result.role, snippet: result.snippet }
    }
    return null
  }

  const assistantResults = $derived(
    trimmed.length === 0
      ? []
      : assistants.filter((assistant) => assistant.name.toLowerCase().includes(trimmed))
  )
  const taskResults = $derived(
    trimmed.length === 0
      ? []
      : mergeMatches(
          tasks.filter((task) => task.title.toLowerCase().includes(trimmed)),
          remoteResults
            .filter((result) => !result.thread.assistantTaskId)
            .map((result) => result.thread)
        )
  )
  const runResults = $derived(
    trimmed.length === 0
      ? []
      : mergeMatches(
          runs.filter((run) => run.title.toLowerCase().includes(trimmed)),
          remoteResults
            .filter((result) => result.thread.assistantTaskId)
            .map((result) => result.thread)
        )
  )
  const empty = $derived(
    trimmed.length > 0 &&
      !searching &&
      assistantResults.length === 0 &&
      taskResults.length === 0 &&
      runResults.length === 0
  )

  // The field is elsewhere, so the query is the trigger: every keystroke it
  // holds runs the same debounced search the old inline field ran.
  $effect(() => {
    runThreadSearch(query)
  })

  function closeSearch(): void {
    query = ''
    remoteResults = []
    searching = false
    searchRequestId++
    clearTimeout(searchTimer)
  }

  function selectTask(task: Thread): void {
    closeSearch()
    onOpenTask(task)
  }

  function selectAssistant(assistant: Assistant): void {
    closeSearch()
    onOpenAssistant(assistant)
  }

  /** The assistant's own icon, so an assistant edited in the sidebar reads the same
   *  in the search results: custom image first, then the SVG icon type tinted
   *  with its accent colour. Without either the result draws the assistant
   *  default mark. */
  function assistantIcon(assistant: Assistant): string | null {
    return getAssistantIcon(assistant, assistantStore.iconUrls.get(assistant.id) ?? null)
  }

  function runAssistant(run: Thread): Assistant | null {
    return assistantStore.assistantForTask(run)
  }

  function runIcon(run: Thread): string | null {
    const assistant = runAssistant(run)
    if (!assistant) return null
    return assistantIcon(assistant)
  }
</script>

{#snippet resultsPanel()}
  {#if empty}
    <p class="px-2 py-4 text-center text-[0.6875rem] text-dimmed">
      No matching assistants, tasks or runs
    </p>
  {:else if trimmed.length > 0}
    <!-- The results are the panel's list while they are on screen, so they take
         the panel's own height and scroller instead of a capped, scrolling box. -->
    <div class="space-y-px">
      {#if assistantResults.length > 0}
        <div
          class="border-b border-border px-2 py-1 text-[0.5625rem] font-semibold uppercase tracking-wide text-dimmed"
        >
          Assistants
        </div>
        {#each assistantResults as assistant (assistant.id)}
          {@const icon = assistantIcon(assistant)}
          <button
            type="button"
            class="flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors hover:bg-elevated"
            onclick={() => selectAssistant(assistant)}
          >
            <span class="flex h-4 w-4 shrink-0 items-center justify-center">
              {#if icon}
                <img src={icon} alt="" class="h-4 w-4 object-contain" draggable="false" />
              {:else}
                <AssistantDefaultIcon
                  size={14}
                  style="color: {assistant.color ?? 'var(--color-muted)'}"
                />
              {/if}
            </span>
            <span class="min-w-0 flex-1 truncate text-[0.75rem] text-foreground"
              >{assistant.name}</span
            >
            {#if !assistantIsScheduled(assistant)}
              <span
                class="shrink-0 border border-border bg-elevated px-1.5 py-px text-[0.5rem] tracking-wide text-dimmed uppercase"
                title="This assistant runs only when you ask it to"
              >
                Unscheduled
              </span>
            {/if}
            {#if assistantGap(assistant)}
              <span
                class="flex shrink-0 items-center"
                style="color: var(--color-warning)"
                role="img"
                aria-label={assistantGap(assistant) ?? ''}
                title={assistantGap(assistant) ?? ''}
              >
                <CioAttention size={11} />
              </span>
            {/if}
          </button>
        {/each}
      {/if}
      {#if taskResults.length > 0}
        <div
          class="border-b border-border px-2 py-1 text-[0.5625rem] font-semibold uppercase tracking-wide text-dimmed"
        >
          Tasks
        </div>
        {#each taskResults as task (task.id)}
          {@const snippet = snippetFor(task.id)}
          <button
            type="button"
            class="flex w-full flex-col gap-0.5 px-2 py-1.5 text-left transition-colors hover:bg-elevated"
            title={task.title}
            onclick={() => selectTask(task)}
          >
            <span class="flex w-full items-center gap-2">
              <AssistantIcon
                mark={task.assistantGettingStarted ? 'knowledge' : 'task'}
                size={14}
                class="shrink-0 text-muted"
              />
              <span class="min-w-0 flex-1 truncate text-[0.75rem] text-foreground"
                >{task.title}</span
              >
            </span>
            {#if snippet}
              <span class="line-clamp-2 pl-6 text-[0.6875rem] leading-snug text-dimmed">
                <span class="text-[0.625rem] uppercase tracking-wide text-dimmed/80">
                  {snippet.role === 'assistant' ? 'Agent' : 'You'}
                </span>
                <span aria-hidden="true"> · </span>
                {snippet.snippet}
              </span>
            {/if}
          </button>
        {/each}
      {/if}
      {#if runResults.length > 0}
        <div
          class="border-b border-border px-2 py-1 text-[0.5625rem] font-semibold uppercase tracking-wide text-dimmed"
        >
          Runs
        </div>
        {#each runResults as run (run.id)}
          {@const assistant = runAssistant(run)}
          {@const icon = runIcon(run)}
          {@const snippet = snippetFor(run.id)}
          <button
            type="button"
            class="flex w-full flex-col gap-0.5 px-2 py-1.5 text-left transition-colors hover:bg-elevated"
            title={run.title}
            onclick={() => selectTask(run)}
          >
            <span class="flex w-full items-center gap-2">
              <span class="flex h-4 w-4 shrink-0 items-center justify-center">
                {#if icon}
                  <img src={icon} alt="" class="h-4 w-4 object-contain" draggable="false" />
                {:else if assistant}
                  <AssistantDefaultIcon
                    size={14}
                    style="color: {assistant.color ?? 'var(--color-muted)'}"
                  />
                {:else}
                  <AssistantIcon mark="task" size={14} class="text-muted" />
                {/if}
              </span>
              <span class="min-w-0 flex-1 truncate text-[0.75rem] text-foreground">{run.title}</span
              >
            </span>
            {#if snippet}
              <span class="line-clamp-2 pl-6 text-[0.6875rem] leading-snug text-dimmed">
                <span class="text-[0.625rem] uppercase tracking-wide text-dimmed/80">
                  {snippet.role === 'assistant' ? 'Agent' : 'You'}
                </span>
                <span aria-hidden="true"> · </span>
                {snippet.snippet}
              </span>
            {/if}
          </button>
        {/each}
      {/if}
      {#if searching}
        <p
          class="flex items-center justify-center gap-1.5 px-2 py-3 text-center text-[0.6875rem] text-dimmed"
        >
          <CioSpinner size={12} class="animate-spin" />
          Searching…
        </p>
      {/if}
    </div>
  {/if}
{/snippet}

<div class="px-1 pt-1" role="region" aria-label="Search results">
  {@render resultsPanel()}
</div>
