<script lang="ts">
  import { SvelteMap, SvelteSet } from 'svelte/reactivity'
  import { Workflow } from '@lucide/svelte'
  import CollapsibleSidebar from '$lib/components/layout/CollapsibleSidebar.svelte'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import SidebarAccountControls from '$lib/components/workspace/SidebarAccountControls.svelte'
  import { assistantRoutines } from '$lib/stores/assistant-routines.svelte'
  import type { MainView } from '$lib/stores/renderer-recovery.svelte'
  import { threadStatusPolicy } from '$shared/thread-status-policy'
  import type { Routine, Thread } from '$shared/types'
  import AssistantRoutineRow from './AssistantRoutineRow.svelte'
  import AssistantTaskRow from './AssistantTaskRow.svelte'

  interface Props {
    routines: Routine[]
    tasks: Thread[]
    selectedThreadId: string | null
    /** Bind the scroll container so the workspace can reveal the active row. */
    scroller?: HTMLElement | null
    active: boolean
    navigate: (view: MainView) => void
    onOpenTask: (task: Thread) => void
    onOpenTaskHowTo: (task: Thread) => void
    onOpenRoutineHowTo: (routine: Routine) => void
    /** Create a new task inside a routine (the row's plus action). */
    onCreateTaskInRoutine: (routine: Routine) => void
    onRenameRoutine: (routineId: string, name: string) => Promise<void>
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
    active,
    navigate,
    onOpenTask,
    onOpenTaskHowTo,
    onOpenRoutineHowTo,
    onCreateTaskInRoutine,
    onRenameRoutine,
    onDeleteRoutine,
    onTogglePinRoutine,
    onMoveRoutine,
    onAssignTask
  }: Props = $props()

  const expanded = new SvelteSet<string>()
  const routineSearchOpen = new SvelteSet<string>()
  const routineSearchQueries = new SvelteMap<string, string>()

  let renameTarget = $state<Routine | null>(null)
  let renameDraft = $state('')
  let renameBusy = $state(false)
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

  /** Routine-less tasks, most recently active first. */
  const standaloneTasks = $derived(
    tasks
      .filter((task) => !task.routineId)
      .sort((a, b) => b.lastActivity - a.lastActivity)
  )

  function routineTasks(routineId: string): Thread[] {
    return tasks
      .filter((task) => task.routineId === routineId)
      .sort((a, b) => b.lastActivity - a.lastActivity)
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
    const list = routineTasks(routine.id)
    if (!routineSearchOpen.has(routine.id) || query.length === 0) return list
    return list.filter((task) => task.title.toLowerCase().includes(query))
  }

  function startRename(routine: Routine): void {
    renameTarget = routine
    renameDraft = routine.name
  }

  async function submitRename(): Promise<void> {
    const target = renameTarget
    const name = renameDraft.trim()
    if (!target || name.length === 0) return
    renameBusy = true
    try {
      await onRenameRoutine(target.id, name)
      renameTarget = null
    } finally {
      renameBusy = false
    }
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
    <SidebarAccountControls {active} {navigate} />
  {/snippet}

  <div class="flex h-full min-h-0 flex-col">
    <div class="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5" role="list" aria-label="Routines and tasks">
      {#if orderedRoutines.length === 0 && standaloneTasks.length === 0}
        <div class="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
          <Workflow size={18} class="text-dimmed" />
          <p class="text-[0.6875rem] text-dimmed">
            No routines or tasks yet. Create a routine or a task from the header.
          </p>
        </div>
      {:else}
        {#each orderedRoutines as routine (routine.id)}
          {@const routineTaskList = routineTasks(routine.id)}
          {@const visibleTasks = filteredRoutineTasks(routine)}
          {@const searching = routineSearchOpen.has(routine.id)}
          {@const query = routineSearchQueries.get(routine.id) ?? ''}
          {@const holdsSelected = routineTaskList.some(
            (task) => task.id === selectedThreadId
          )}
          <AssistantRoutineRow
            {routine}
            expanded={expanded.has(routine.id) || searching || holdsSelected}
            working={routineWorking(routine.id)}
            missed={assistantRoutines.hasMissedForRoutine(routine.id)}
            taskCount={routineTaskList.length}
            nextRunAt={routineNextRun(routine.id)}
            searchOpen={searching}
            searchQuery={query}
            onToggle={toggleRoutine}
            onSearchOpenChange={(r, open) => (open ? openRoutineSearch(r) : closeRoutineSearch(r))}
            onSearchQueryChange={(r, value) => routineSearchQueries.set(r.id, value)}
            onCreateTask={onCreateTaskInRoutine}
            onOpenHowTo={onOpenRoutineHowTo}
            onRename={startRename}
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
                  />
                {:else}
                  <p class="px-2 py-1 text-[0.625rem] text-dimmed">No tasks in this routine yet.</p>
                {/each}
              {/if}
            </div>
          {/if}
        {/each}

        {#if standaloneTasks.length > 0}
          <div class="mt-2 mb-1 px-2 text-[0.5625rem] font-medium tracking-wide text-dimmed uppercase">
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
            />
          {/each}
        {/if}
      {/if}
    </div>
  </div>
</CollapsibleSidebar>

<Modal
  open={renameTarget !== null}
  title="Rename routine"
  onClose={() => (renameTarget = null)}
>
  <input
    class="w-full rounded-md border border-border bg-surface px-2.5 py-2 text-[0.8125rem] text-foreground placeholder:text-dimmed focus:border-border-strong focus:outline-none"
    placeholder="Routine name"
    aria-label="Routine name"
    bind:value={renameDraft}
    onkeydown={(event) => {
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault()
        void submitRename()
      }
    }}
  />
  {#snippet footer()}
    <div class="flex justify-end gap-2">
      <button
        type="button"
        class="rounded-md px-3 py-1.5 text-[0.75rem] text-muted transition-colors hover:bg-elevated hover:text-foreground"
        onclick={() => (renameTarget = null)}
      >
        Cancel
      </button>
      <button
        type="button"
        class="rounded-md bg-primary px-3 py-1.5 text-[0.75rem] text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
        disabled={renameDraft.trim().length === 0 || renameBusy}
        onclick={() => void submitRename()}
      >
        Save
      </button>
    </div>
  {/snippet}
</Modal>

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
