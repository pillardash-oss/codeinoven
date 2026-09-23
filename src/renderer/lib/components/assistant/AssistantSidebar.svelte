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
  import { threadStatusPolicy } from '$shared/thread-status-policy'
  import { isAssistantSetupThread, type Routine, type Thread } from '$shared/types'
  import AssistantRoutineRow from './AssistantRoutineRow.svelte'
  import AssistantTaskRow from './AssistantTaskRow.svelte'
  import RoutineEditModal from './RoutineEditModal.svelte'

  interface Props {
    routines: Routine[]
    tasks: Thread[]
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
  const routineSearchOpen = new SvelteSet<string>()
  const routineSearchQueries = new SvelteMap<string, string>()

  let editTarget = $state<Routine | null>(null)
  let deleteTarget = $state<Routine | null>(null)
  let deleteBusy = $state(false)

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
  function routineTasks(routineId: string): Thread[] {
    return tasks
      .filter((task) => task.routineId === routineId)
      .sort((a, b) => b.lastActivity - a.lastActivity)
  }

  /**
   * The routine's tasks that render nested under it. A user-pinned task leaves
   * for the Pinned section above, but a pinned how-to thread stays here: its pin
   * is retention, not a request to move it out of its routine.
   */
  function nestedRoutineTasks(routineId: string): Thread[] {
    return routineTasks(routineId).filter((task) => !task.pinned || isAssistantSetupThread(task))
  }

  /** The accent colour a flat (pinned) row should tint its icon with. */
  function routineColorFor(task: Thread): string | undefined {
    if (!task.routineId) return undefined
    return routines.find((routine) => routine.id === task.routineId)?.color
  }

  function routineWorking(routineId: string): boolean {
    return routineTasks(routineId).some(
      (task) => threadStatusPolicy(task.status).tone === 'working'
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

  function filteredRoutineTasks(routine: Routine): Thread[] {
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
            <AssistantTaskRow
              {task}
              active={task.id === selectedThreadId}
              color={routineColorFor(task)}
              missed={assistantRoutines.missedForTask(task.id).length > 0}
              nextRunAt={assistantRoutines.nextRunForTask(task)}
              onSelect={openPinnedTask}
              onRename={onRenameTask}
              onTogglePin={onTogglePinTask}
              onDelete={onDeleteTask}
              onFork={onForkTask}
              onOpenNotes={onOpenTaskNotes}
              onHandedOff={onHandedOffTask}
              {onHideHowTo}
            />
          {/snippet}
        </PinnedSection>

        {#each orderedRoutines as routine (routine.id)}
          {@const routineTaskList = routineTasks(routine.id)}
          {@const visibleTasks = filteredRoutineTasks(routine)}
          {@const searching = routineSearchOpen.has(routine.id)}
          {@const query = routineSearchQueries.get(routine.id) ?? ''}
          {@const holdsSelected = nestedRoutineTasks(routine.id).some(
            (task) => task.id === selectedThreadId
          )}
          <AssistantRoutineRow
            {routine}
            expanded={expanded.has(routine.id) || searching || holdsSelected}
            working={routineWorking(routine.id)}
            missed={assistantRoutines.hasMissedForRoutine(routine.id)}
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
                  <AssistantTaskRow
                    {task}
                    active={task.id === selectedThreadId}
                    color={routine.color}
                    missed={assistantRoutines.missedForTask(task.id).length > 0}
                    nextRunAt={assistantRoutines.nextRunForTask(task)}
                    onSelect={(selected) => {
                      expanded.add(routine.id)
                      onOpenTask(selected)
                      onOpenRoutineHowTo(routine)
                    }}
                    onRename={onRenameTask}
                    onTogglePin={onTogglePinTask}
                    onDelete={onDeleteTask}
                    onFork={onForkTask}
                    onOpenNotes={onOpenTaskNotes}
                    onHandedOff={onHandedOffTask}
                    {onHideHowTo}
                  />
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
            <AssistantTaskRow
              {task}
              active={task.id === selectedThreadId}
              missed={assistantRoutines.missedForTask(task.id).length > 0}
              nextRunAt={assistantRoutines.nextRunForTask(task)}
              onSelect={(selected) => {
                onOpenTask(selected)
                onOpenTaskHowTo(selected)
              }}
              onRename={onRenameTask}
              onTogglePin={onTogglePinTask}
              onDelete={onDeleteTask}
              onFork={onForkTask}
              onOpenNotes={onOpenTaskNotes}
              onHandedOff={onHandedOffTask}
              {onHideHowTo}
            />
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
