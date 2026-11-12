<script lang="ts">
  import AssistantIcon from '$lib/components/icons/cio/AssistantIcon.svelte'
  import CollapsibleSidebar from '$lib/components/layout/CollapsibleSidebar.svelte'
  import EmptyState from '$lib/components/ui/EmptyState.svelte'
  import DonTile from './DonTile.svelte'
  import AssistantRow from './AssistantRow.svelte'
  import AssistantSearchControl from './AssistantSearchControl.svelte'
  import SidebarSearchBar from '$lib/components/layout/SidebarSearchBar.svelte'
  import AssistantCreateControl from './AssistantCreateControl.svelte'
  import type { NewAssistantDraft } from './assistant-create'
  import { SvelteMap, SvelteSet } from 'svelte/reactivity'
  import { assistants as assistantStore } from '$lib/stores/assistants.svelte'
  import { panelSearchRequest } from '$lib/stores/panel-search-request.svelte'
  import { selectedSearchText } from '$lib/selection-text'
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

  /** Whether the search owns the panel's top row instead of its button. */
  let searchExpanded = $state(false)
  let searchQuery = $state('')

  /**
   * Open the panel's own search on its top row.
   *
   * A search asked for while text is highlighted starts from that passage
   * instead of an empty field, whether it was asked for by the chord or by the
   * button. A query already on screen is left alone.
   */
  function openSearch(): void {
    if (!searchExpanded && !searchQuery.trim()) {
      const selected = selectedSearchText()
      if (selected) searchQuery = selected
    }
    searchExpanded = true
  }

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

  /**
   * Whether the panel has nothing to list.
   *
   * The empty panel is one door, not two: while it stands, the copy and the
   * create button under it are the only invitation, so the toolbar's search and
   * New assistant row is not drawn beneath them. A search the user opened keeps
   * the toolbar, because its field lives there.
   */
  const panelEmpty = $derived(listedAssistants.length === 0 && !searchExpanded)

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
  /**
   * The shell owns the chord and publishes one request per press; this panel is
   * the one that knows what its own search is, so it answers the request.
   */
  let handledPanelSearch = 0
  $effect(() => {
    const request = panelSearchRequest.requestId
    if (request === handledPanelSearch) return
    handledPanelSearch = request
    openSearch()
  })
</script>

<CollapsibleSidebar title="Assistant" hideHeader bind:scroller>
  <!-- The panel's controls live at its foot, on the same line as the rail's own
       utility icons, so the list keeps the whole column above them. -->
  {#snippet footer()}
    <!-- The empty panel carries its own create door, so the toolbar is not drawn
         under it: one way in, where the user is already reading. -->
    {#if !panelEmpty}
      <div class="@container bg-surface px-2 pt-1.5 pb-2">
        <div class="flex min-h-7 items-center justify-center gap-1 overflow-hidden">
          <div class="min-w-0 {searchExpanded ? 'flex-1' : ''}">
            <SidebarSearchBar
              open={searchExpanded}
              query={searchQuery}
              placeholder="Search assistants, tasks and runs…"
              ariaLabel="Search assistants and threads"
              onOpenChange={(open) => {
                if (open) openSearch()
                else {
                  searchExpanded = false
                  searchQuery = ''
                }
              }}
              onQueryChange={(value) => (searchQuery = value)}
              label="Search all"
            />
          </div>
          {#if !searchExpanded}
            <AssistantCreateControl
              label="New assistant"
              labelClass="assistant-panel-label truncate"
              onCreate={onCreateAssistant}
              onCreateViaChat={onCreateAssistantViaChat}
              trigger={assistantCreateTrigger}
            />
          {/if}
        </div>
      </div>
    {/if}
  {/snippet}

  <div class="flex h-full min-h-0 flex-col [container-type:inline-size]">
    <div class="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
      {#if searchExpanded && searchQuery.trim().length > 0}
        <AssistantSearchControl
          bind:query={searchQuery}
          {assistants}
          {tasks}
          {runs}
          {onOpenTask}
          onOpenAssistant={onOpenAssistantKnowledge}
        />
      {:else}
        <!-- Empty, the column is a flex pair: Don holds the top and the invitation
             takes what is left, so it sits centred between his tile and the foot
             of the panel instead of hanging directly under him. -->
        <div class={panelEmpty ? 'flex h-full flex-col' : ''}>
          <div role="list" aria-label="Assistants">
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

          <!-- Don keeps his place at the top. With no teammate under him the panel
             is not empty, it is missing them, so the invitation carries its own
             create door and the toolbar that would duplicate it stays hidden. -->
          {#if panelEmpty}
            <EmptyState
              class="flex-1 px-2"
              icon={AssistantIcon}
              title="Add a teammate"
              description="You can continue using just Don, or create a special teammate for a special task, like handling your social media."
            >
              {#snippet action()}
                <AssistantCreateControl
                  variant="primary"
                  label="New assistant"
                  onCreate={onCreateAssistant}
                  onCreateViaChat={onCreateAssistantViaChat}
                  trigger={assistantCreateTrigger}
                />
              {/snippet}
            </EmptyState>
          {/if}
        </div>
      {/if}
    </div>
  </div>
</CollapsibleSidebar>

<style>
  /* A narrow panel keeps the two controls as icons: the glyphs identify them, and
     a squeezed label is harder to read than none. Labels truncate before this. */
  @container (max-width: 13rem) {
    :global([data-panel-label]) {
      display: none;
    }
  }
</style>
