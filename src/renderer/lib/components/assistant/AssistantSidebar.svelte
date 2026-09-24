<script lang="ts">
  import { SvelteMap, SvelteSet } from 'svelte/reactivity'
  import { Workflow } from '@lucide/svelte'
  import CollapsibleSidebar from '$lib/components/layout/CollapsibleSidebar.svelte'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import SidebarFooterControls from '$lib/components/workspace/SidebarFooterControls.svelte'
  import PinnedSection from '$lib/components/threads/PinnedSection.svelte'
  import { assistantRoutines } from '$lib/stores/assistant-routines.svelte'
  import type { MainView } from '$lib/stores/renderer-recovery.svelte'
  import { pinnedThreadSort } from '$lib/stores/workspace.svelte'
  import { isAssistantSetupThread, isThreadWorking, type Routine, type Thread } from '$shared/types'
  import { threadStatusPolicy } from '$shared/thread-status-policy'
  import AssistantRoutineRow from './AssistantRoutineRow.svelte'
  import AssistantTaskRow from './AssistantTaskRow.svelte'
  import RoutineEditModal from './RoutineEditModal.svelte'
  import { TASK_RUN_PREVIEW, previewRuns } from './assistant-view'

  interface Props {
    routines: Routine[]
    /** Assistant tasks only: a run is never a task. */
    tasks: Thread[]
    /**
     * Every task's runs, newest first, keyed by task id. A run executes on its
     * own thread and renders nested under the task it ran.
     */
    runsByTask: ReadonlyMap<string, Thread[]>
    selectedThreadId: string | null
    /** Bind the scroll container so the workspace can reveal the active row. */
    scroller?: HTMLElement | null
    navigate: (view: MainView) => void
    onOpenTask: (task: Thread) => void
    onOpenTaskHowTo: (task: Thread) => void
    onOpenRoutineHowTo: (routine: Routine) => void
    /** Create a new task inside a routine (the row's plus action). */
    onCreateTaskInRoutine: (routine: Routine) => void
    /** Full thread action set for task rows, so a task behaves like a thread. */
    onRenameTask: (task: Thread, newName: string) => Promise<void>
    onTogglePinTask: (task: Thread) => void
    onDeleteTask: (task: Thread) => Promise<void>
    onForkTask: (task: Thread) => void
    onOpenTaskNotes: (task: Thread) => void
    /** Hand a task off to a project, forking it and seeding a summary. */
    onHandedOffTask: (forked: Thread) => void
    /** Hide a routine's how-to thread (its row has no other state change). */
    onHideHowTo: (task: Thread) => void
    onDeleteRoutine: (routineId: string) => Promise<void>
    onTogglePinRoutine: (routine: Routine) => void
    onMoveRoutine: (draggedId: string, targetId: string, position: 'before' | 'after') => void
    /** Group a dragged task into a routine. */
    onAssignTask: (taskId: string, routineId: string) => void
  }

  let {
    routines,
    tasks,
    runsByTask,
    selectedThreadId,
    scroller = $bindable(null),
    navigate,
    onOpenTask,
    onOpenTaskHowTo,
    onOpenRoutineHowTo,
    onCreateTaskInRoutine,
    onRenameTask,
    onTogglePinTask,
    onDeleteTask,
    onForkTask,
    onOpenTaskNotes,
    onHandedOffTask,
    onHideHowTo,
    onDeleteRoutine,
    onTogglePinRoutine,
    onMoveRoutine,
    onAssignTask
  }: Props = $props()

  const expanded = new SvelteSet<string>()
  /** Tasks whose full run history the user asked to see. */
  const expandedRuns = new SvelteSet<string>()
  const routineSearchOpen = new SvelteSet<string>()
  const routineSearchQueries = new SvelteMap<string, string>()

  let editTarget = $state<Routine | null>(null)
  let deleteTarget = $state<Routine | null>(null)
  let deleteBusy = $state(false)

  const EMPTY_RUNS: readonly Thread[] = []
  const EMPTY_TASKS: readonly Thread[] = []

  /** Every routine's tasks, most recent first, built once per tasks change.
   *  The sidebar reads a routine's task list from this map instead of re-running
   *  a filter + sort for each of the five call sites per routine per render. */
  const tasksByRoutine = $derived.by(() => {
    const map = new SvelteMap<string, Thread[]>()
    for (const task of tasks) {
      if (!task.routineId) continue
      const list = map.get(task.routineId) ?? []
      list.push(task)
      map.set(task.routineId, list)
    }
    for (const list of map.values()) list.sort((a, b) => b.lastActivity - a.lastActivity)
    return map
  })

  /** The subset of each routine's tasks that render nested under it (a
   *  user-pinned task leaves for the Pinned section above). */
  const nestedTasksByRoutine = $derived.by(() => {
    const map = new SvelteMap<string, Thread[]>()
    for (const [routineId, list] of tasksByRoutine) {
      map.set(
        routineId,
        list.filter((task) => !task.pinned || isAssistantSetupThread(task))
      )
    }
    return map
  })

  /** Threads with a pending missed run, and the routines those runs belong to,
   *  as sets so a row never scans the whole missed-run list. */
  const missedThreadIds = $derived.by(() => {
    const ids = new SvelteSet<string>()
    for (const run of assistantRoutines.missedRuns) ids.add(run.threadId)
    return ids
  })

  const missedRoutineIds = $derived.by(() => {
    const ids = new SvelteSet<string>()
    for (const run of assistantRoutines.missedRuns) {
      if (run.routineId) ids.add(run.routineId)
    }
    return ids
  })

  /** Pinned routines first, then manual sort order, then most recently updated. */
  const orderedRoutines = $derived(
    [...routines].sort((a, b) => {
      const aPinned = a.pinned ? 1 : 0
      const bPinned = b.pinned ? 1 : 0
      if (aPinned !== bPinned) return bPinned - aPinned
      if (aPinned && bPinned) return (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0)
      const aOrder = a.sortOrder ?? Number.MAX_SAFE_INTEGER
      const bOrder = b.sortOrder ?? Number.MAX_SAFE_INTEGER
      if (aOrder !== bOrder) return aOrder - bOrder
      return b.updatedAt - a.updatedAt
    })
  )

  /** Routine-less, unpinned tasks, most recently active first. */
  const standaloneTasks = $derived(
    tasks
      .filter((task) => !task.routineId && !task.pinned)
      .sort((a, b) => b.lastActivity - a.lastActivity)
  )

  /**
   * Pinned tasks that leave their routine and join the flat Pinned section, in
   * one shared pin order, exactly as the project sidebar treats pinned threads.
   * A routine's how-to ("Getting started") thread is the exception: it is pinned
   * for its whole life so it is never evicted, but it belongs to its routine and
   * stays nested there. Only a routine-less how-to thread (its routine was
   * removed) rises to this list.
   */
  const pinnedTasks = $derived(
    tasks
      .filter((task) => task.pinned && !(task.routineId && isAssistantSetupThread(task)))
      .sort((a, b) => pinnedThreadSort(a, b))
  )

  /** Open a pinned task, docking its routine's how-to panel like a nested row. */
  function openPinnedTask(task: Thread): void {
    onOpenTask(task)
    const routine = routines.find((entry) => entry.id === task.routineId)
    if (routine) onOpenRoutineHowTo(routine)
    else onOpenTaskHowTo(task)
  }

  /** Every task of a routine, pinned ones included, most recent first. */
  function routineTasks(routineId: string): readonly Thread[] {
    return tasksByRoutine.get(routineId) ?? EMPTY_TASKS
  }

  /** One task's runs, newest first (empty while it has never run). */
  function runsFor(taskId: string): readonly Thread[] {
    return runsByTask.get(taskId) ?? EMPTY_RUNS
  }

  /** True while any of a task's runs is actually working. */
  function taskRunWorking(taskId: string): boolean {
    return runsFor(taskId).some((run) => isThreadWorking(run))
  }

  /**
   * The runs a task row shows: the newest slice while folded, the whole history
   * once the user asks for it. Bounded by default so a routine that has run for
   * months cannot turn the sidebar into a log.
   */
  function visibleRuns(taskId: string): Thread[] {
    return previewRuns(runsFor(taskId), expandedRuns.has(taskId))
  }

  function toggleRuns(taskId: string): void {
    if (expandedRuns.has(taskId)) expandedRuns.delete(taskId)
    else expandedRuns.add(taskId)
  }

  /**
   * The routine's tasks that render nested under it. A user-pinned task leaves
   * for the Pinned section above, but a pinned how-to thread stays here: its pin
   * is retention, not a request to move it out of its routine.
   */
  function nestedRoutineTasks(routineId: string): readonly Thread[] {
    return nestedTasksByRoutine.get(routineId) ?? EMPTY_TASKS
  }

  /** The accent colour a flat (pinned) row should tint its icon with. */
  function routineColorFor(task: Thread): string | undefined {
    if (!task.routineId) return undefined
    return routines.find((routine) => routine.id === task.routineId)?.color
  }

  function routineWorking(routineId: string): boolean {
    return routineTasks(routineId).some(
      (task) => threadStatusPolicy(task.status).tone === 'working' || taskRunWorking(task.id)
    )
  }

  function routineNextRun(routineId: string): number | null {
    let earliest: number | null = null
    for (const task of routineTasks(routineId)) {
      const next = assistantRoutines.nextRunForTask(task)
      if (next !== null && (earliest === null || next < earliest)) earliest = next
    }
    return earliest
  }

  function toggleRoutine(routine: Routine): void {
    if (expanded.has(routine.id)) expanded.delete(routine.id)
    else expanded.add(routine.id)
  }

  function openRoutineSearch(routine: Routine): void {
    routineSearchOpen.add(routine.id)
    expanded.add(routine.id)
  }

  function closeRoutineSearch(routine: Routine): void {
    routineSearchOpen.delete(routine.id)
    routineSearchQueries.delete(routine.id)
  }

  function filteredRoutineTasks(routine: Routine): readonly Thread[] {
    const query = (routineSearchQueries.get(routine.id) ?? '').trim().toLowerCase()
    const list = nestedRoutineTasks(routine.id)
    if (!routineSearchOpen.has(routine.id) || query.length === 0) return list
    return list.filter((task) => task.title.toLowerCase().includes(query))
  }

  function startEdit(routine: Routine): void {
    editTarget = routine
  }

  async function submitDelete(): Promise<void> {
    const target = deleteTarget
    if (!target) return
    deleteBusy = true
    try {
      await onDeleteRoutine(target.id)
      deleteTarget = null
    } finally {
      deleteBusy = false
    }
  }
</script>

{#snippet taskWithRuns(task: Thread, color: string | undefined, select: (task: Thread) => void)}
  <AssistantTaskRow
    {task}
    {color}
    active={task.id === selectedThreadId}
    missed={missedThreadIds.has(task.id)}
    nextRunAt={assistantRoutines.nextRunForTask(task)}
    runWorking={taskRunWorking(task.id)}
    onSelect={select}
    onRename={onRenameTask}
    onTogglePin={onTogglePinTask}
    onDelete={onDeleteTask}
    onFork={onForkTask}
    onOpenNotes={onOpenTaskNotes}
    onHandedOff={onHandedOffTask}
    {onHideHowTo}
  />
  {#if runsFor(task.id).length > 0}
    <div
      class="mb-1 ml-3 border-l border-border/70 pl-1.5"
      role="group"
      aria-label="Runs of {task.title}"
    >
      {#each visibleRuns(task.id) as run (run.id)}
        <AssistantTaskRow
          task={run}
          variant="run"
          {color}
          active={run.id === selectedThreadId}
          missed={false}
          nextRunAt={null}
          onSelect={onOpenTask}
          onRename={onRenameTask}
          onTogglePin={onTogglePinTask}
          onDelete={onDeleteTask}
          onFork={onForkTask}
          onOpenNotes={onOpenTaskNotes}
          onHandedOff={onHandedOffTask}
          {onHideHowTo}
        />
      {/each}
      {#if runsFor(task.id).length > TASK_RUN_PREVIEW}
        <button
          type="button"
          class="flex w-full items-center rounded-md px-2 py-1 text-left text-[0.5625rem] text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
          aria-expanded={expandedRuns.has(task.id)}
          onclick={() => toggleRuns(task.id)}
        >
          {expandedRuns.has(task.id)
            ? 'Show fewer runs'
            : `Show all ${runsFor(task.id).length} runs`}
        </button>
      {/if}
    </div>
  {/if}
{/snippet}

<CollapsibleSidebar title="Assistant" hideHeader bind:scroller>
  {#snippet footer()}
    <SidebarFooterControls {navigate} />
  {/snippet}

  <div class="flex h-full min-h-0 flex-col">
    <div
      class="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5"
      role="list"
      aria-label="Routines and tasks"
    >
      {#if orderedRoutines.length === 0 && pinnedTasks.length === 0 && standaloneTasks.length === 0}
        <div class="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
          <Workflow size={18} class="text-dimmed" />
          <p class="text-[0.6875rem] text-dimmed">
            No routines or tasks yet. Create a routine or a task from the header.
          </p>
        </div>
      {:else}
        <!-- Pinned tasks lead the list, above the routines: the shared
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
            {@render taskWithRuns(task, routineColorFor(task), openPinnedTask)}
          {/snippet}
        </PinnedSection>

        {#each orderedRoutines as routine (routine.id)}
          {@const routineTaskList = routineTasks(routine.id)}
          {@const visibleTasks = filteredRoutineTasks(routine)}
          {@const searching = routineSearchOpen.has(routine.id)}
          {@const query = routineSearchQueries.get(routine.id) ?? ''}
          {@const holdsSelected = nestedRoutineTasks(routine.id).some(
            (task) =>
              task.id === selectedThreadId ||
              runsFor(task.id).some((run) => run.id === selectedThreadId)
          )}
          <AssistantRoutineRow
            {routine}
            expanded={expanded.has(routine.id) || searching || holdsSelected}
            working={routineWorking(routine.id)}
            missed={missedRoutineIds.has(routine.id)}
            taskCount={routineTaskList.length}
            iconUrl={assistantRoutines.iconUrls.get(routine.id) ?? null}
            nextRunAt={routineNextRun(routine.id)}
            searchOpen={searching}
            searchQuery={query}
            onToggle={toggleRoutine}
            onSearchOpenChange={(r, open) => (open ? openRoutineSearch(r) : closeRoutineSearch(r))}
            onSearchQueryChange={(r, value) => routineSearchQueries.set(r.id, value)}
            onCreateTask={onCreateTaskInRoutine}
            onOpenHowTo={onOpenRoutineHowTo}
            onEdit={startEdit}
            onTogglePin={onTogglePinRoutine}
            onDelete={(r) => (deleteTarget = r)}
            {onMoveRoutine}
            onDropTask={onAssignTask}
          />
          {#if expanded.has(routine.id) || searching || holdsSelected}
            <div class="mb-1 ml-2 border-l border-border pl-1.5">
              {#if searching && query.trim().length > 0 && visibleTasks.length === 0}
                <p class="px-2 py-1 text-[0.625rem] text-dimmed">No matching tasks</p>
              {:else}
                {#each visibleTasks as task (task.id)}
                  {@render taskWithRuns(task, routine.color, (selected) => {
                    expanded.add(routine.id)
                    onOpenTask(selected)
                    onOpenRoutineHowTo(routine)
                  })}
                {:else}
                  <p class="px-2 py-1 text-[0.625rem] text-dimmed">
                    {routineTaskList.length > 0
                      ? `${routineTaskList.length === 1 ? 'Its only task is' : 'Its tasks are'} pinned, in the Pinned section above.`
                      : 'No tasks in this routine yet.'}
                  </p>
                {/each}
              {/if}
            </div>
          {/if}
        {/each}

        {#if standaloneTasks.length > 0}
          <div
            class="mt-2 mb-1 px-2 text-[0.5625rem] font-medium tracking-wide text-dimmed uppercase"
          >
            Tasks
          </div>
          {#each standaloneTasks as task (task.id)}
            {@render taskWithRuns(task, undefined, (selected) => {
              onOpenTask(selected)
              onOpenTaskHowTo(selected)
            })}
          {/each}
        {/if}
      {/if}
    </div>
  </div>
</CollapsibleSidebar>

<RoutineEditModal routine={editTarget} onClose={() => (editTarget = null)} />

<ConfirmDialog
  open={deleteTarget !== null}
  title="Remove routine"
  confirmLabel="Remove routine"
  busy={deleteBusy}
  onCancel={() => (deleteTarget = null)}
  onConfirm={submitDelete}
>
  <p>
    Remove <strong class="text-foreground">{deleteTarget?.name ?? ''}</strong>? Its tasks survive as
    routine-less tasks.
  </p>
</ConfirmDialog>
