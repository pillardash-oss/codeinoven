<script lang="ts">
  import CioSearch from '@pdslng/cio-icon/CioSearch.svelte'
  import CollapsibleSidebar from '$lib/components/layout/CollapsibleSidebar.svelte'
  import DonTile from './DonTile.svelte'
  import AssistantRow from './AssistantRow.svelte'
  import AssistantSearchControl from './AssistantSearchControl.svelte'
  import AssistantCreateControl from './AssistantCreateControl.svelte'
  import type { NewAssistantDraft } from './assistant-create'
  import { SvelteMap, SvelteSet } from 'svelte/reactivity'
  import { assistants as assistantStore } from '$lib/stores/assistants.svelte'
  import { lastViewedAssistantThreadId } from '$lib/stores/assistant-last-viewed.svelte'
  import { sortAssistants } from '$shared/assistant-order'
  import { DON_ASSISTANT_ID, assistantIsBuiltin, assistantReady } from '$shared/types'
  import type { Assistant, Thread } from '$shared/types'
  import { assistantThreadCount } from './assistant-view'
  import {
    countThreadStates,
    emptyThreadStateCounts,
    type ThreadStateCounts
  } from '$lib/thread-state-counts'

  /**
   * The assistant view's sidebar.
   *
   * It is a list of assistants and nothing else: an assistant's icon, its name,
   * the last line of its most recent conversation, and how long ago that was. The
   * threads themselves are the app header's tabs, so opening an assistant here
   * hands the reader to its latest thread instead of unfolding a tree.
   */
  interface Props {
    assistants: Assistant[]
    /** Assistant tasks only: a run is never a task. */
    tasks: Thread[]
    /** Every run thread, for the search's own results. */
    runs: Thread[]
    /**
     * Every assistant's runs, newest first, keyed by assistant id. A run inherits
     * its task's `assistantId`, so a run whose task is hidden still groups here.
     */
    runsByAssistant: ReadonlyMap<string, Thread[]>
    selectedThreadId: string | null
    /** Bind the scroll container so the workspace can reveal the active row. */
    scroller?: HTMLElement | null
    onOpenTask: (task: Thread) => void
    /** Open an assistant's knowledge panel (its behaviour), and a first task when
     *  it has none. */
    onOpenAssistantKnowledge: (assistant: Assistant) => void
    onMoveAssistant: (draggedId: string, targetId: string, position: 'before' | 'after') => void
    /** Group a dragged task into an assistant. */
    onAssignTask: (taskId: string, assistantId: string) => void
    /** Create an assistant from the sidebar's own top row. */
    onCreateAssistant: (draft: NewAssistantDraft) => void | Promise<void>
    onCreateAssistantViaChat?: () => void | Promise<void>
    /** External open signal (a keyboard shortcut) for the new-assistant dialog. */
    assistantCreateTrigger?: number
  }

  let {
    assistants,
    tasks,
    runs,
    runsByAssistant,
    selectedThreadId,
    scroller = $bindable(null),
    onOpenTask,
    onOpenAssistantKnowledge,
    onMoveAssistant,
    onAssignTask,
    onCreateAssistant,
    onCreateAssistantViaChat,
    assistantCreateTrigger = 0
  }: Props = $props()

  /** Whether the search has grown out of its button into the field in the header. */
  let searchExpanded = $state(false)

  const EMPTY_TASKS: readonly Thread[] = []
  const EMPTY_RUNS: readonly Thread[] = []
  const EMPTY_STATE_COUNTS = emptyThreadStateCounts()

  /** Every assistant's tasks, most recent first, built once per tasks change. */
  const tasksByAssistant = $derived.by(() => {
    const map = new SvelteMap<string, Thread[]>()
    for (const task of tasks) {
      if (!task.assistantId) continue
      const list = map.get(task.assistantId) ?? []
      list.push(task)
      map.set(task.assistantId, list)
    }
    for (const list of map.values()) list.sort((a, b) => b.lastActivity - a.lastActivity)
    return map
  })

  /**
   * The assistant whose thread is open, so its row reads as the current one.
   * The open thread can be a run as well as a task, and a run is a thread of its
   * assistant too, so the lookup has to see both or the row the user is in stays
   * unlit.
   */
  const selectedAssistantId = $derived.by(() => {
    const task = tasks.find((candidate) => candidate.id === selectedThreadId)
    if (task?.assistantId) return task.assistantId
    for (const [assistantId, runs] of runsByAssistant) {
      if (runs.some((run) => run.id === selectedThreadId)) return assistantId
    }
    return null
  })

  /**
   * How each assistant's threads break down   working, attention, error   over
   * its tasks and their runs, so an assistant row wears the same indicator a
   * project row does.
   */
  const assistantStateCounts = $derived.by(() => {
    const map = new SvelteMap<string, ThreadStateCounts>()
    for (const [assistantId, list] of tasksByAssistant) {
      map.set(
        assistantId,
        countThreadStates([...list, ...(runsByAssistant.get(assistantId) ?? EMPTY_RUNS)])
      )
    }
    // A run can outlive the assistant's task list (its task was removed), so any
    // assistant left with only runs still gets a breakdown.
    for (const [assistantId, runs] of runsByAssistant) {
      if (!map.has(assistantId)) map.set(assistantId, countThreadStates(runs))
    }
    return map
  })

  /** Threads with a pending missed run, as a set so a row never scans the list. */
  const missedThreadIds = $derived(
    new SvelteSet(assistantStore.missedRuns.map((run) => run.threadId))
  )

  /** Pinned assistants first, then the user's manual arrangement, then creation. */
  const orderedAssistants = $derived(sortAssistants(assistants))
  /** Don, the app's orchestrator: a fixed slot above the list, never a row. */
  const donAssistant = $derived(assistants.find((row) => row.id === DON_ASSISTANT_ID) ?? null)
  const donThread = $derived(tasks.find((task) => task.assistantId === DON_ASSISTANT_ID) ?? null)
  /** Every assistant the user owns, in sidebar order. Built-ins hold their own slot. */
  const listedAssistants = $derived(orderedAssistants.filter((row) => !assistantIsBuiltin(row)))

  function assistantTasks(assistantId: string): readonly Thread[] {
    return tasksByAssistant.get(assistantId) ?? EMPTY_TASKS
  }

  function runsOfAssistant(assistantId: string): readonly Thread[] {
    return runsByAssistant.get(assistantId) ?? EMPTY_RUNS
  }

  function threadsOfAssistant(assistantId: string): number {
    return assistantThreadCount(assistantTasks(assistantId), runsOfAssistant(assistantId))
  }

  /** The next intended fire across an assistant's tasks, or null when unscheduled. */
  function assistantNextRun(assistantId: string): number | null {
    let earliest: number | null = null
    for (const task of assistantTasks(assistantId)) {
      const next = assistantStore.nextRunForTask(task)
      if (next !== null && (earliest === null || next < earliest)) earliest = next
    }
    return earliest
  }

  /** Whether any task of this assistant carries a pending missed run. */
  function assistantMissed(assistantId: string): boolean {
    return assistantTasks(assistantId).some((task) => missedThreadIds.has(task.id))
  }

  /**
   * Open an assistant where the user left it: the thread they last viewed of
   * that assistant, or its latest thread when they have not opened one yet. A
   * run counts too, since it is a thread the user can have been reading.
   * An assistant with no task yet opens its setup conversation, which is also
   * what gives it one.
   */
  function openAssistant(assistant: Assistant): void {
    const rememberedId = lastViewedAssistantThreadId(assistant.id)
    const remembered = rememberedId
      ? (assistantTasks(assistant.id).find((task) => task.id === rememberedId) ??
        runsOfAssistant(assistant.id).find((run) => run.id === rememberedId))
      : undefined
    const target = remembered ?? assistantTasks(assistant.id)[0]
    if (target) onOpenTask(target)
    else onOpenAssistantKnowledge(assistant)
  }
</script>

<CollapsibleSidebar title="Assistant" hideHeader bind:scroller>
  <div class="flex h-full min-h-0 flex-col">
    <div class="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
      <!-- The panel's own controls stay pinned above the list as it scrolls: the
           search morphs out of its button into a field, and the new-assistant
           door sits beside it. The app header leaves this view alone, so they
           live here. -->
      <div class="sticky top-0 z-20 -mx-1.5 mb-1 border-b bg-surface px-1.5 pt-0.5 pb-1.5">
        <div class="flex min-h-7 items-center justify-center gap-1">
          {#if !searchExpanded}
            <button
              type="button"
              class="flex h-7 items-center gap-1.5 px-2 text-[0.6875rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
              aria-label="Search assistants, tasks and runs"
              title="Search assistants, tasks and runs"
              onclick={() => (searchExpanded = true)}
            >
              <CioSearch size={13} />
              <span>Search</span>
            </button>
          {/if}
          <AssistantSearchControl
            inline
            bind:expanded={searchExpanded}
            {assistants}
            {tasks}
            {runs}
            {onOpenTask}
            onOpenAssistant={onOpenAssistantKnowledge}
          />
          {#if !searchExpanded}
            <AssistantCreateControl
              label="New assistant"
              onCreate={onCreateAssistant}
              onCreateViaChat={onCreateAssistantViaChat}
              trigger={assistantCreateTrigger}
            />
          {/if}
        </div>
      </div>

      <div role="list" aria-label="Assistants">
        <!-- No empty note here: the shell paints this sidebar only while it holds
           an assistant, and the view's own empty state invites the first one. -->
        {#if donAssistant}
          <DonTile
            assistant={donAssistant}
            threadId={donThread?.id ?? null}
            selected={donThread !== null && selectedThreadId === donThread.id}
            iconUrl={assistantStore.iconUrls.get(donAssistant.id) ?? null}
            ready={assistantReady(donAssistant)}
            lastWorkedAt={assistantStore.previews.get(donAssistant.id)?.at ?? null}
            stateCounts={assistantStateCounts.get(donAssistant.id) ?? EMPTY_STATE_COUNTS}
            onOpen={() => {
              if (!donThread) return
              // The first open is the one moment Don introduces itself. A failure
              // here is not fatal: the thread is open and the user can write the
              // first line themselves.
              void assistantStore.startDonSetup().catch(() => undefined)
              onOpenTask(donThread)
            }}
          />
        {/if}

        {#each listedAssistants as assistant (assistant.id)}
          {@const counts = assistantStateCounts.get(assistant.id) ?? EMPTY_STATE_COUNTS}
          {@const preview = assistantStore.previews.get(assistant.id) ?? null}
          <AssistantRow
            {assistant}
            stateCounts={counts}
            attention={counts.attention > 0}
            missed={assistantMissed(assistant.id)}
            threadCount={threadsOfAssistant(assistant.id)}
            iconUrl={assistantStore.iconUrls.get(assistant.id) ?? null}
            nextRunAt={assistantNextRun(assistant.id)}
            preview={preview?.text ?? null}
            lastWorkedAt={preview?.at ?? null}
            selected={selectedAssistantId === assistant.id}
            onOpen={openAssistant}
            {onMoveAssistant}
            onDropTask={onAssignTask}
          />
        {/each}
      </div>
    </div>
  </div>
</CollapsibleSidebar>
