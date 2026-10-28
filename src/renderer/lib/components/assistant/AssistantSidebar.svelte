<script lang="ts">
  import { threadMediaActivity } from '$lib/speech/thread-media-activity.svelte'
  import { SvelteMap, SvelteSet } from 'svelte/reactivity'
  import CollapsibleSidebar from '$lib/components/layout/CollapsibleSidebar.svelte'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import PinnedSection from '$lib/components/threads/PinnedSection.svelte'
  import SidebarListRow from '$lib/components/shared/SidebarListRow.svelte'
  import { RowPageBudget, THREAD_LIST_PAGE_SIZE } from '$lib/components/shared/RowPageBudget.svelte'
  import { ListRowReflow, rowArrangement } from '$lib/motion'
  import { ThreadOrderSettle } from '$lib/components/workspace/thread-order-settle.svelte'
  import { assistants as assistantStore } from '$lib/stores/assistants.svelte'
  import { pinnedThreadSort } from '$lib/stores/workspace.svelte'
  import { sortAssistants } from '$shared/assistant-order'
  import {
    isAssistantSetupThread,
    isThreadWorking,
    assistantKnowledgeComplete,
    type Assistant,
    type Thread
  } from '$shared/types'
  import {
    countThreadStates,
    emptyThreadStateCounts,
    type ThreadStateCounts
  } from '$lib/thread-state-counts'
  import AssistantRow from './AssistantRow.svelte'
  import AssistantTaskRow from './AssistantTaskRow.svelte'
  import AssistantEditModal from './AssistantEditModal.svelte'
  import { foreignRuns } from '$lib/stores/foreign-runs.svelte'
  import { reportError } from '$lib/stores/app-errors.svelte'
  import {
    TASK_RUN_PREVIEW,
    assistantForeignThread,
    assistantSubjectName,
    assistantThreadCount,
    previewRuns,
    assistantSiblingRuns
  } from './assistant-view'

  interface Props {
    assistants: Assistant[]
    /** Assistant tasks only: a run is never a task. */
    tasks: Thread[]
    /**
     * Every task's runs, newest first, keyed by task id. A run executes on its
     * own thread; an assistant lifts it out to the assistant's own level, while a
     * assistant-less task (Pinned or Tasks) renders it nested under the task.
     */
    runsByTask: ReadonlyMap<string, Thread[]>
    /**
     * Every assistant's runs, newest first, keyed by assistant id. A run inherits
     * its task's `assistantId`, so a run whose task is hidden still groups here.
     */
    runsByAssistant: ReadonlyMap<string, Thread[]>
    selectedThreadId: string | null
    /** Bind the scroll container so the workspace can reveal the active row. */
    scroller?: HTMLElement | null
    onOpenTask: (task: Thread) => void
    onOpenTaskKnowledge: (task: Thread) => void
    onOpenAssistantKnowledge: (assistant: Assistant) => void
    /** Create a new task inside an assistant (the row's plus action). */
    onCreateTaskInAssistant: (assistant: Assistant) => void
    /** Full thread action set for task rows, so a task behaves like a thread. */
    onRenameTask: (task: Thread, newName: string) => Promise<void>
    onTogglePinTask: (task: Thread) => void
    onDeleteTask: (task: Thread) => Promise<void>
    onForkTask: (task: Thread) => void
    onOpenTaskNotes: (task: Thread) => void
    /** Hand a task off to a project, forking it and seeding a summary. */
    onHandedOffTask: (forked: Thread) => void
    /** Hide an assistant's knowledge thread (its row has no other state change). */
    onHideKnowledge: (task: Thread) => void
    onDeleteAssistant: (assistantId: string) => Promise<void>
    onHasAssistantRunsToday: (assistant: Assistant) => Promise<boolean>
    onSkipNextAssistantRun: (assistant: Assistant) => Promise<void>
    onSkipAssistantRunsToday: (assistant: Assistant) => Promise<void>
    onTogglePinAssistant: (assistant: Assistant) => void
    onMoveAssistant: (draggedId: string, targetId: string, position: 'before' | 'after') => void
    /** Group a dragged task into an assistant. */
    onAssignTask: (taskId: string, assistantId: string) => void
  }

  let {
    assistants,
    tasks,
    runsByTask,
    runsByAssistant,
    selectedThreadId,
    scroller = $bindable(null),
    onOpenTask,
    onOpenTaskKnowledge,
    onOpenAssistantKnowledge,
    onCreateTaskInAssistant,
    onRenameTask,
    onTogglePinTask,
    onDeleteTask,
    onForkTask,
    onOpenTaskNotes,
    onHandedOffTask,
    onHideKnowledge,
    onDeleteAssistant,
    onHasAssistantRunsToday,
    onSkipNextAssistantRun,
    onSkipAssistantRunsToday,
    onTogglePinAssistant,
    onMoveAssistant,
    onAssignTask
  }: Props = $props()

  /**
   * Toggle one function's clock independently of its assistant. The change is
   * persisted and broadcast, so the fresh row flows back through `tasks` and
   * the row re-renders without a local list to keep in sync.
   */
  async function toggleTaskScheduled(task: Thread): Promise<void> {
    const next = !assistantStore.taskScheduled(task)
    try {
      await assistantStore.setTaskScheduled(task.id, next)
    } catch (caught) {
      reportError(caught, 'Could not change this function’s schedule')
    }
  }

  /**
   * The open/fold call the user made on an assistant row, keyed by assistant id. With
   * no entry the row follows the automatic rule (see `assistantExpanded`); an entry
   * is the user's own decision and always wins, which is what lets the assistant
   * holding the active thread be folded.
   */
  const assistantFoldChoice = new SvelteMap<string, boolean>()
  /** Tasks whose full run history the user asked to see. */
  const expandedRuns = new SvelteSet<string>()
  const assistantSearchOpen = new SvelteSet<string>()
  const assistantSearchQueries = new SvelteMap<string, string>()

  let editTarget = $state<Assistant | null>(null)
  let deleteTarget = $state<Assistant | null>(null)

  const EMPTY_RUNS: readonly Thread[] = []
  const EMPTY_TASKS: readonly Thread[] = []
  const EMPTY_STATE_COUNTS = emptyThreadStateCounts()

  /** Every assistant's tasks, most recent first, built once per tasks change.
   *  The sidebar reads an assistant's task list from this map instead of re-running
   *  a filter + sort for each of the five call sites per assistant per render. */
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

  /** The subset of each assistant's tasks that render nested under it (a
   *  user-pinned task leaves for the Pinned section above). */
  const nestedTasksByAssistant = $derived.by(() => {
    const map = new SvelteMap<string, Thread[]>()
    for (const [assistantId, list] of tasksByAssistant) {
      map.set(
        assistantId,
        list.filter((task) => !task.pinned || isAssistantSetupThread(task))
      )
    }
    return map
  })

  /** Threads with a pending missed run, and the assistants those runs belong to,
   *  as sets so a row never scans the whole missed-run list. */
  const missedThreadIds = $derived.by(() => {
    const ids = new SvelteSet<string>()
    for (const run of assistantStore.missedRuns) ids.add(run.threadId)
    return ids
  })

  const missedAssistantIds = $derived.by(() => {
    const ids = new SvelteSet<string>()
    for (const run of assistantStore.missedRuns) {
      if (run.assistantId) ids.add(run.assistantId)
    }
    return ids
  })

  /**
   * Assistants with a thread parked on the user (awaiting approval) or failed,
   * across tasks and runs. The rail already counts these as attention, but the
   * assistant row only wore unread/missed, so a waiting run was invisible until
   * its row was opened.
   */
  const attentionAssistantIds = $derived.by(() => {
    const ids = new SvelteSet<string>()
    const isAttention = (thread: Thread): boolean =>
      thread.status === 'awaiting_approval' || thread.status === 'failed'
    for (const task of tasks) {
      if (task.assistantId && isAttention(task)) ids.add(task.assistantId)
    }
    for (const runs of runsByAssistant.values()) {
      for (const run of runs) {
        if (run.assistantId && isAttention(run)) ids.add(run.assistantId)
      }
    }
    return ids
  })

  /**
   * How each assistant's threads break down   working, attention, error   over
   * its tasks and their runs, so an assistant row wears the same indicator a
   * project row does. Built once per tasks/runs change instead of re-scanning a
   * assistant's whole history on every render.
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
      if (!map.has(assistantId)) {
        map.set(assistantId, countThreadStates(runs))
      }
    }
    return map
  })

  /**
   * Pinned assistants first, then the user's manual arrangement, then creation
   * (newest first). `sortAssistants` is the same order the main process lists
   * assistants in, so dragging a row and seeing it stay put agree on one rule.
   */
  const orderedAssistants = $derived(sortAssistants(assistants))

  /** Assistant-less, unpinned tasks, most recently active first. */
  const standaloneTasks = $derived(
    tasks
      .filter((task) => !task.assistantId && !task.pinned)
      .sort((a, b) => b.lastActivity - a.lastActivity)
  )

  /**
   * Pinned tasks that leave their assistant and join the flat Pinned section, in
   * one shared pin order, exactly as the project sidebar treats pinned threads.
   * An assistant's knowledge ("Getting started") thread is the exception: it is pinned
   * for its whole life so it is never evicted, but it belongs to its assistant and
   * stays nested there. Only an assistant-less knowledge thread (its assistant was
   * removed) rises to this list.
   */
  const pinnedTasks = $derived(
    tasks
      .filter((task) => task.pinned && !(task.assistantId && isAssistantSetupThread(task)))
      .sort((a, b) => pinnedThreadSort(a, b))
  )

  /**
   * Holds activity-driven reordering of the task lists back, exactly as the
   * thread sidebars do: the lists sort by last activity, and a live run ticks
   * constantly, so without this an assistant's tasks re-sort under the reader on
   * every tick. Runs sort by creation and never move, so only the task lists are
   * settled.
   */
  const assistantOrderSettle = new ThreadOrderSettle()

  /** One page of tasks per assistant is mounted; the rest is one click away. */
  const assistantTaskBudget = new RowPageBudget(THREAD_LIST_PAGE_SIZE)

  // The assistant list travels on the same pair of measurements as the thread
  // lists: where every row was before the DOM updated, and where it is after. The
  // rows live inside nested containers (an assistant, its task, its runs), so
  // Svelte's per-list FLIP has nothing to measure; this pair has the whole tree's
  // boxes. See `ListRowReflow`.
  const assistantRowReflow = new ListRowReflow()
  let assistantListElement = $state<HTMLElement | null>(null)
  /** When the assistant list first painted; a row created after this is an
   *  arrival and plays the fade, every other row appears at its final place. */
  const assistantListAttachedAt = Date.now()

  /**
   * The rows the assistant list is about to draw, in render order: the pinned
   * tasks, then each assistant's tasks and their runs, then the standalone tasks.
   *
   * It is built from the data lists rather than mirrored from every fold, so it
   * only changes when rows really move. A fold animates its own height (`slide`)
   * and needs no travel, and an over-inclusive entry costs at most one measurement
   * in which no row moved, which the reflow skips.
   */
  const assistantRowArrangement = $derived(
    rowArrangement([
      { key: 'pinned', rowKeys: pinnedTasks.map((task) => task.id) },
      ...orderedAssistants.map((assistant) => ({
        key: `assistant:${assistant.id}`,
        rowKeys: [
          ...nestedAssistantTasks(assistant.id).map((task) => task.id),
          ...runsOfAssistant(assistant.id).map((run) => run.id)
        ]
      })),
      { key: 'standalone', rowKeys: standaloneTasks.map((task) => task.id) }
    ])
  )

  $effect(() => {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const activeKeys = new Set<string>(['assistant:standalone'])
    for (const assistant of orderedAssistants) {
      const key = `assistant:${assistant.id}`
      activeKeys.add(key)
      assistantOrderSettle.sync(key, nestedTasksByAssistant.get(assistant.id) ?? EMPTY_TASKS)
    }
    assistantOrderSettle.sync('assistant:standalone', standaloneTasks)
    assistantOrderSettle.prune(activeKeys)
  })

  $effect.pre(() => {
    assistantRowReflow.capture(assistantListElement, scroller ?? null, assistantRowArrangement)
  })

  $effect(() => {
    assistantRowReflow.play(assistantListElement, scroller ?? null, assistantRowArrangement)
  })

  /** Open a pinned task, docking its assistant's knowledge panel like a nested row. */
  function openPinnedTask(task: Thread): void {
    onOpenTask(task)
    const assistant = assistants.find((entry) => entry.id === task.assistantId)
    if (assistant) onOpenAssistantKnowledge(assistant)
    else onOpenTaskKnowledge(task)
  }

  /** Every task of an assistant, pinned ones included, most recent first. */
  function assistantTasks(assistantId: string): readonly Thread[] {
    return tasksByAssistant.get(assistantId) ?? EMPTY_TASKS
  }

  /** One task's runs, newest first (empty while it has never run). */
  function runsFor(taskId: string): readonly Thread[] {
    return runsByTask.get(taskId) ?? EMPTY_RUNS
  }

  /** One assistant's runs, newest first (empty while it has never run). */
  function runsOfAssistant(assistantId: string): readonly Thread[] {
    return runsByAssistant.get(assistantId) ?? EMPTY_RUNS
  }

  /**
   * The threads an assistant row states: its tasks and their runs, so an
   * assistant that has never fired still reports the threads the user can open
   * below it instead of `0 runs`.
   */
  function threadsOfAssistant(assistantId: string): number {
    return assistantThreadCount(assistantTasks(assistantId), runsOfAssistant(assistantId))
  }

  /** True while any of a task's runs is actually working. */
  function taskRunWorking(taskId: string): boolean {
    return runsFor(taskId).some((run) => isThreadWorking(run))
  }

  /**
   * The runs a task row shows: the newest slice while folded, the whole history
   * once the user asks for it. Bounded by default so an assistant that has run for
   * months cannot turn the sidebar into a log.
   */
  function toggleRuns(key: string): void {
    if (expandedRuns.has(key)) expandedRuns.delete(key)
    else expandedRuns.add(key)
  }

  /** Every on-screen assistant task by id, so a run's parent can be resolved
   *  even when that parent renders outside the assistant's own list. */
  const tasksById = $derived(new Map(tasks.map((task) => [task.id, task])))

  /**
   * The task name a hoisted run row reports. A run lifted to its assistant's own
   * level has no parent row above it to say which task it ran, so without this
   * every hoisted run read as a bare time. A run nested under its task (a Pinned
   * or assistant-less task) already sits below that task's name, so it needs
   * nothing. The name resolves through
   * `assistantSubjectName`, so an assistant's Getting started host keeps naming the
   * assistant instead of leaking "Getting started" onto its own runs.
   */
  function runContextLabel(
    run: Thread,
    nested: boolean,
    assistantName: string | null
  ): string | null {
    if (nested) return null
    if (!run.assistantTaskId) return null
    const parent = tasksById.get(run.assistantTaskId)
    if (!parent) return null
    return assistantSubjectName(parent, assistantName, '') || null
  }

  /** The runs an assistant shows at its own level, beside its task rows (see
   *  `assistantSiblingRuns`). */
  function siblingRuns(assistant: Assistant): readonly Thread[] {
    const runs = runsOfAssistant(assistant.id)
    if (runs.length === 0) return EMPTY_RUNS
    const renderedTaskIds = new Set(nestedAssistantTasks(assistant.id).map((task) => task.id))
    return assistantSiblingRuns(
      runs,
      assistantKnowledgeComplete(assistant),
      renderedTaskIds,
      tasksById
    )
  }

  /**
   * Whether a task row nests its own runs. Only an assistant's Getting started
   * thread nests, and only while the assistant is still being written: its runs
   * are the failed startup passes that set the assistant up. Every other task's
   * runs, and the seed's once its knowledge is saved, lift to the assistant's own
   * level instead, so a task row never swallows a run. An assistant-less task has
   * no assistant row to lift them to, so it keeps them (see the Tasks and Pinned
   * sections, which always nest).
   */
  function taskNestsRuns(task: Thread, assistant: Assistant): boolean {
    return !assistantKnowledgeComplete(assistant) && isAssistantSetupThread(task)
  }

  /**
   * The assistant's tasks that render nested under it. A user-pinned task leaves
   * for the Pinned section above, but a pinned knowledge thread stays here: its pin
   * is retention, not a request to move it out of its assistant.
   */
  function nestedAssistantTasks(assistantId: string): readonly Thread[] {
    return nestedTasksByAssistant.get(assistantId) ?? EMPTY_TASKS
  }

  /** The accent colour a flat (pinned) row should tint its icon with. */
  function assistantColorFor(task: Thread): string | undefined {
    if (!task.assistantId) return undefined
    return assistants.find((assistant) => assistant.id === task.assistantId)?.color
  }

  function assistantNextRun(assistantId: string): number | null {
    let earliest: number | null = null
    for (const task of assistantTasks(assistantId)) {
      const next = assistantStore.nextRunForTask(task)
      if (next !== null && (earliest === null || next < earliest)) earliest = next
    }
    return earliest
  }

  /**
   * Whether an assistant's rows are on screen. The user's own call wins; without
   * one the assistant follows the automatic rule: open while its own inline search
   * is open, and open while the selected thread is one of its rows, meaning its
   * task, a run nested under that task, or a run lifted to the assistant's own
   * level, so the row the user is working in stays on screen.
   *
   * `siblingRunRows` is passed in because every render call site already resolves
   * it for the run rows it draws; only a click has to resolve it again.
   */
  function assistantExpanded(assistant: Assistant, siblingRunRows: readonly Thread[]): boolean {
    const choice = assistantFoldChoice.get(assistant.id)
    if (choice !== undefined) return choice
    if (assistantSearchOpen.has(assistant.id)) return true
    const selected = selectedThreadId
    if (!selected) return false
    return (
      nestedAssistantTasks(assistant.id).some(
        (task) => task.id === selected || runsFor(task.id).some((run) => run.id === selected)
      ) || siblingRunRows.some((run) => run.id === selected)
    )
  }

  /** Fold or open an assistant: the row flips what the user is looking at, and that
   *  decision outranks the automatic rule from then on. */
  function toggleAssistant(assistant: Assistant): void {
    assistantFoldChoice.set(assistant.id, !assistantExpanded(assistant, siblingRuns(assistant)))
  }

  function openAssistantSearch(assistant: Assistant): void {
    assistantSearchOpen.add(assistant.id)
    assistantFoldChoice.set(assistant.id, true)
  }

  function closeAssistantSearch(assistant: Assistant): void {
    assistantSearchOpen.delete(assistant.id)
    assistantSearchQueries.delete(assistant.id)
  }

  function filteredAssistantTasks(assistant: Assistant): readonly Thread[] {
    const query = (assistantSearchQueries.get(assistant.id) ?? '').trim().toLowerCase()
    // The settled order is what the reader sees, so both the open list and the
    // search filter read from it; the query then narrows the rows, never reorders
    // them.
    const list = assistantOrderSettle.view(
      `assistant:${assistant.id}`,
      nestedAssistantTasks(assistant.id)
    )
    if (!assistantSearchOpen.has(assistant.id) || query.length === 0) return list
    return list.filter((task) => task.title.toLowerCase().includes(query))
  }

  function startEdit(assistant: Assistant): void {
    editTarget = assistant
  }

  /**
   * Close the dialog and hand the removal to the workspace, which drops the
   * container from the sidebar immediately and cleans up in the background. The
   * dialog never waits on the sweep, so the removal feels like the plain UI
   * action it is.
   */
  function submitDelete(): void {
    const target = deleteTarget
    if (!target) return
    deleteTarget = null
    void onDeleteAssistant(target.id)
  }
</script>

{#snippet runRows(
  runs: readonly Thread[],
  color: string | undefined,
  key: string,
  ariaLabel: string,
  nested: boolean,
  assistantName: string | null = null
)}
  {#if runs.length > 0}
    <div
      class={nested ? 'mb-1 ml-3 border-l border-border/70 pl-1.5' : 'mb-1'}
      role="group"
      aria-label={ariaLabel}
    >
      {#each [...new SvelteSet( [...runs.filter((run) => threadMediaActivity(run.id).length > 0), ...previewRuns(runs, expandedRuns.has(key))] )] as run (run.id)}
        {@const runForeignThread = foreignRuns.isForeign(run.projectId, run.id) ? run : null}
        <SidebarListRow
          rowKey={run.id}
          createdAt={run.createdAt}
          attachedAt={assistantListAttachedAt}
        >
          <AssistantTaskRow
            task={run}
            variant="run"
            foreignThread={runForeignThread}
            {color}
            active={run.id === selectedThreadId}
            missed={false}
            nextRunAt={null}
            contextLabel={runContextLabel(run, nested, assistantName)}
            onSelect={onOpenTask}
            onRename={onRenameTask}
            onTogglePin={onTogglePinTask}
            onDelete={onDeleteTask}
            onFork={onForkTask}
            onOpenNotes={onOpenTaskNotes}
            onHandedOff={onHandedOffTask}
            {onHideKnowledge}
          />
        </SidebarListRow>
      {/each}
      {#if runs.length > TASK_RUN_PREVIEW}
        <button
          type="button"
          class="flex w-full items-center px-2 py-1 text-left text-[0.5625rem] text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
          aria-expanded={expandedRuns.has(key)}
          onclick={() => toggleRuns(key)}
        >
          {expandedRuns.has(key) ? 'Show fewer runs' : `Show all ${runs.length} runs`}
        </button>
      {/if}
    </div>
  {/if}
{/snippet}

{#snippet taskWithRuns(
  task: Thread,
  color: string | undefined,
  select: (task: Thread) => void,
  nestRuns: boolean
)}
  <SidebarListRow rowKey={task.id} createdAt={task.createdAt} attachedAt={assistantListAttachedAt}>
    <AssistantTaskRow
      {task}
      media={[
        ...new SvelteSet(
          [task, ...runsFor(task.id)].flatMap((thread) => threadMediaActivity(thread.id))
        )
      ]}
      foreignThread={assistantForeignThread(task, runsFor(task.id), (projectId, threadId) =>
        foreignRuns.isForeign(projectId, threadId)
      )}
      {color}
      active={task.id === selectedThreadId}
      missed={missedThreadIds.has(task.id)}
      nextRunAt={assistantStore.nextRunForTask(task)}
      scheduled={assistantStore.taskScheduled(task)}
      onToggleScheduled={(t) => void toggleTaskScheduled(t)}
      runWorking={nestRuns && taskRunWorking(task.id)}
      onSelect={select}
      onRename={onRenameTask}
      onTogglePin={onTogglePinTask}
      onDelete={onDeleteTask}
      onFork={onForkTask}
      onOpenNotes={onOpenTaskNotes}
      onHandedOff={onHandedOffTask}
      {onHideKnowledge}
    />
  </SidebarListRow>
  {#if nestRuns}
    {@render runRows(runsFor(task.id), color, task.id, `Runs of ${task.title}`, true)}
  {/if}
{/snippet}

<CollapsibleSidebar title="Assistant" hideHeader bind:scroller>
  <div class="flex h-full min-h-0 flex-col">
    <div
      bind:this={assistantListElement}
      class="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5"
      role="list"
      aria-label="Assistants and tasks"
    >
      <!-- No empty note here: the shell paints this sidebar only while it holds a
           assistant or a task, and the view's own empty state is what invites the
           first one. -->
      <!-- Pinned tasks lead the list, above the assistants: the shared
           PinnedSection owns the header, the fold state, and the row list,
           and the assistant supplies its own task row to it. -->
      <PinnedSection
        sectionKey="assistant"
        label="Pinned"
        threads={pinnedTasks}
        activeThreadId={selectedThreadId}
        onOpen={openPinnedTask}
        onRename={onRenameTask}
        onTogglePin={onTogglePinTask}
        onDelete={onDeleteTask}
        onFork={onForkTask}
      >
        {#snippet row(task: Thread)}
          {@render taskWithRuns(task, assistantColorFor(task), openPinnedTask, true)}
        {/snippet}
      </PinnedSection>

      {#each orderedAssistants as assistant (assistant.id)}
        {@const assistantTaskList = assistantTasks(assistant.id)}
        {@const visibleTasks = filteredAssistantTasks(assistant)}
        {@const tasksShown = assistantTaskBudget.visibleRows(
          `assistant:${assistant.id}`,
          visibleTasks,
          selectedThreadId
        )}
        {@const tasksHidden = assistantTaskBudget.hiddenCount(visibleTasks, tasksShown)}
        {@const searching = assistantSearchOpen.has(assistant.id)}
        {@const query = assistantSearchQueries.get(assistant.id) ?? ''}
        {@const siblingRunRows = siblingRuns(assistant)}
        {@const isExpanded = assistantExpanded(assistant, siblingRunRows)}
        <AssistantRow
          {assistant}
          media={[
            ...new SvelteSet(
              [...assistantTaskList, ...runsOfAssistant(assistant.id)].flatMap((thread) =>
                threadMediaActivity(thread.id)
              )
            )
          ]}
          expanded={isExpanded}
          stateCounts={assistantStateCounts.get(assistant.id) ?? EMPTY_STATE_COUNTS}
          attention={attentionAssistantIds.has(assistant.id)}
          missed={missedAssistantIds.has(assistant.id)}
          threadCount={threadsOfAssistant(assistant.id)}
          iconUrl={assistantStore.iconUrls.get(assistant.id) ?? null}
          nextRunAt={assistantNextRun(assistant.id)}
          searchOpen={searching}
          searchQuery={query}
          onToggle={toggleAssistant}
          onSearchOpenChange={(r, open) =>
            open ? openAssistantSearch(r) : closeAssistantSearch(r)}
          onSearchQueryChange={(r, value) => assistantSearchQueries.set(r.id, value)}
          onCreateTask={onCreateTaskInAssistant}
          onOpenKnowledge={onOpenAssistantKnowledge}
          onEdit={startEdit}
          onTogglePin={onTogglePinAssistant}
          onDelete={(r) => (deleteTarget = r)}
          {onHasAssistantRunsToday}
          {onSkipNextAssistantRun}
          {onSkipAssistantRunsToday}
          {onMoveAssistant}
          onDropTask={onAssignTask}
        />
        {#if isExpanded}
          <div class="mb-1 ml-2 border-l border-border pl-1.5">
            {#if searching && query.trim().length > 0 && visibleTasks.length === 0}
              <p class="px-2 py-1 text-[0.625rem] text-dimmed">No matching tasks</p>
            {:else}
              {#each tasksShown as task (task.id)}
                {@render taskWithRuns(
                  task,
                  assistant.color,
                  (selected) => {
                    // Working inside an assistant keeps it open: the user's own
                    // call, so the automatic rule cannot fold it back.
                    assistantFoldChoice.set(assistant.id, true)
                    onOpenTask(selected)
                    onOpenAssistantKnowledge(assistant)
                  },
                  taskNestsRuns(task, assistant)
                )}
              {:else}
                {#if siblingRunRows.length === 0}
                  <p class="px-2 py-1 text-[0.625rem] text-dimmed">
                    {assistantTaskList.length > 0
                      ? `${assistantTaskList.length === 1 ? 'Its only task is' : 'Its tasks are'} pinned, in the Pinned section above.`
                      : 'No tasks in this assistant yet.'}
                  </p>
                {/if}
              {/each}
              {#if tasksHidden > 0}
                <button
                  type="button"
                  class="flex w-full items-center px-2 py-1 text-left text-[0.625rem] text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
                  onclick={() =>
                    assistantTaskBudget.showMore(`assistant:${assistant.id}`, visibleTasks.length)}
                >
                  Show {tasksHidden} more
                </button>
              {:else if assistantTaskBudget.visibleCount(`assistant:${assistant.id}`) > THREAD_LIST_PAGE_SIZE}
                <button
                  type="button"
                  class="flex w-full items-center px-2 py-1 text-left text-[0.625rem] text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
                  onclick={() => assistantTaskBudget.showLess(`assistant:${assistant.id}`)}
                >
                  Show less
                </button>
              {/if}
            {/if}
            {@render runRows(
              siblingRunRows,
              assistant.color,
              `assistant:${assistant.id}`,
              `Runs of ${assistant.name}`,
              false,
              assistant.name
            )}
          </div>
        {/if}
      {/each}

      {#if standaloneTasks.length > 0}
        {@const standaloneShown = assistantTaskBudget.visibleRows(
          'assistant:standalone',
          standaloneTasks,
          selectedThreadId
        )}
        {@const standaloneHidden = assistantTaskBudget.hiddenCount(
          standaloneTasks,
          standaloneShown
        )}
        <div
          class="mt-2 mb-1 border-b border-border px-2 pb-1 text-[0.5625rem] font-semibold tracking-wide text-dimmed uppercase"
        >
          Tasks
        </div>
        {#each standaloneShown as task (task.id)}
          {@render taskWithRuns(
            task,
            undefined,
            (selected) => {
              onOpenTask(selected)
              onOpenTaskKnowledge(selected)
            },
            true
          )}
        {/each}
        {#if standaloneHidden > 0}
          <button
            type="button"
            class="flex w-full items-center px-2 py-1 text-left text-[0.625rem] text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
            onclick={() =>
              assistantTaskBudget.showMore('assistant:standalone', standaloneTasks.length)}
          >
            Show {standaloneHidden} more
          </button>
        {:else if assistantTaskBudget.visibleCount('assistant:standalone') > THREAD_LIST_PAGE_SIZE}
          <button
            type="button"
            class="flex w-full items-center px-2 py-1 text-left text-[0.625rem] text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
            onclick={() => assistantTaskBudget.showLess('assistant:standalone')}
          >
            Show less
          </button>
        {/if}
      {/if}
    </div>
  </div>
</CollapsibleSidebar>

<AssistantEditModal assistant={editTarget} onClose={() => (editTarget = null)} />

<ConfirmDialog
  open={deleteTarget !== null}
  title="Remove assistant"
  confirmLabel="Remove assistant"
  onCancel={() => (deleteTarget = null)}
  onConfirm={submitDelete}
  note="This cannot be undone."
>
  <p>
    Remove <strong class="text-foreground">{deleteTarget?.name ?? ''}</strong>? Its tasks, the runs
    they produced, and its artifact folder are deleted with it.
  </p>
</ConfirmDialog>
