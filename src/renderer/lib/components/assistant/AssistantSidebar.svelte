<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity'
  import { Plus, Search, Workflow } from '@lucide/svelte'
  import CollapsibleSidebar from '$lib/components/layout/CollapsibleSidebar.svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import { assistantRoutines } from '$lib/stores/assistant-routines.svelte'
  import type { Routine, Thread } from '$shared/types'
  import AssistantRoutineRow from './AssistantRoutineRow.svelte'
  import AssistantTaskRow from './AssistantTaskRow.svelte'

  interface Props {
    routines: Routine[]
    tasks: Thread[]
    selectedThreadId: string | null
    /** Bind the scroll container so the workspace can reveal the active row. */
    scroller?: HTMLElement | null
    onOpenTask: (task: Thread) => void
    /** Create a routine-less task; the title seeds the new thread when given. */
    onCreateTask: (title: string) => void
    /** Open a routine's or a task's how-to panel in the context sidebar. */
    onOpenHowTo: (routine: Routine) => void
    onOpenTaskHowTo: (task: Thread) => void
  }

  let {
    routines,
    tasks,
    selectedThreadId,
    scroller = $bindable(null),
    onOpenTask,
    onCreateTask,
    onOpenHowTo,
    onOpenTaskHowTo
  }: Props = $props()

  const expanded = new SvelteSet<string>()
  let composerText = $state('')
  let createRoutineOpen = $state(false)
  let newRoutineName = $state('')

  /** Routine-less tasks, most recently active first. */
  const standaloneTasks = $derived(
    tasks
      .filter((task) => !task.routineId)
      .sort((a, b) => b.lastActivity - a.lastActivity)
  )

  function routineTasks(routineId: string): Thread[] {
    return tasks.filter((task) => task.routineId === routineId)
  }

  function toggleRoutine(routine: Routine): void {
    if (expanded.has(routine.id)) expanded.delete(routine.id)
    else expanded.add(routine.id)
  }

  /** Expand the routine that owns a task and reveal it. */
  function revealTask(task: Thread): void {
    if (task.routineId) expanded.add(task.routineId)
  }

  function submitComposer(): void {
    const text = composerText.trim()
    onCreateTask(text)
    composerText = ''
  }

  async function createRoutine(): Promise<void> {
    const name = newRoutineName.trim()
    if (!name) return
    const routine = await assistantRoutines.createRoutine({ name })
    createRoutineOpen = false
    newRoutineName = ''
    expanded.add(routine.id)
    onOpenHowTo(routine)
  }
</script>

<CollapsibleSidebar title="Assistant" bind:scroller>
  <div class="flex h-full min-h-0 flex-col">
    <!-- Top composer: creates a routine-less task, groupable afterwards. -->
    <div class="shrink-0 border-b border-border p-2">
      <div class="flex items-center gap-1">
        <input
          class="min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1.5 text-[0.75rem] text-foreground placeholder:text-dimmed focus:border-border-strong focus:outline-none"
          placeholder="Ask for a new task…"
          aria-label="New assistant task"
          bind:value={composerText}
          onkeydown={(event) => {
            if (event.key === 'Enter' && !event.isComposing) {
              event.preventDefault()
              submitComposer()
            }
          }}
        />
        <button
          type="button"
          class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-foreground"
          title="Create task"
          aria-label="Create task"
          onclick={submitComposer}
        >
          <Plus size={15} strokeWidth={1.8} />
        </button>
      </div>
      <button
        type="button"
        class="mt-1.5 flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[0.6875rem] text-muted transition-colors hover:bg-elevated hover:text-foreground"
        title="Create a routine"
        aria-label="Create a routine"
        onclick={() => (createRoutineOpen = true)}
      >
        <Workflow size={13} strokeWidth={1.8} />
        <span>New routine</span>
      </button>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5" role="list" aria-label="Routines and tasks">
      {#if routines.length === 0 && standaloneTasks.length === 0}
        <div class="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
          <Search size={18} class="text-dimmed" />
          <p class="text-[0.6875rem] text-dimmed">
            No routines or tasks yet. Ask for a task above, or create a routine.
          </p>
        </div>
      {:else}
        {#each routines as routine (routine.id)}
          <AssistantRoutineRow
            {routine}
            expanded={expanded.has(routine.id)}
            active={false}
            missed={assistantRoutines.hasMissedForRoutine(routine.id)}
            taskCount={routineTasks(routine.id).length}
            onToggle={toggleRoutine}
            onOpenHowTo={onOpenHowTo}
          />
          {#if expanded.has(routine.id)}
            <div class="mb-1 ml-2 border-l border-border pl-1.5">
              {#each routineTasks(routine.id) as task (task.id)}
                <AssistantTaskRow
                  {task}
                  active={task.id === selectedThreadId}
                  color={routine.color}
                  missed={assistantRoutines.missedForTask(task.id).length > 0}
                  nextRunAt={assistantRoutines.nextRunForTask(task)}
                  onSelect={(selected) => {
                    revealTask(selected)
                    onOpenTask(selected)
                  }}
                />
              {:else}
                <p class="px-2 py-1 text-[0.625rem] text-dimmed">No tasks in this routine yet.</p>
              {/each}
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
  open={createRoutineOpen}
  title="New routine"
  onClose={() => (createRoutineOpen = false)}
>
  <p class="mb-3 text-[0.75rem] text-muted">
    A routine groups tasks under one how-to. You will write the how-to with the agent next.
  </p>
  <input
    class="w-full rounded-md border border-border bg-surface px-2.5 py-2 text-[0.8125rem] text-foreground placeholder:text-dimmed focus:border-border-strong focus:outline-none"
    placeholder="e.g. Triage CodeInOven PRs daily, 9am and 5pm"
    aria-label="Routine name"
    bind:value={newRoutineName}
    onkeydown={(event) => {
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault()
        void createRoutine()
      }
    }}
  />
  {#snippet footer()}
    <div class="flex justify-end gap-2">
      <button
        type="button"
        class="rounded-md px-3 py-1.5 text-[0.75rem] text-muted transition-colors hover:bg-elevated hover:text-foreground"
        onclick={() => (createRoutineOpen = false)}
      >
        Cancel
      </button>
      <button
        type="button"
        class="rounded-md bg-primary px-3 py-1.5 text-[0.75rem] text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
        disabled={newRoutineName.trim().length === 0}
        onclick={() => void createRoutine()}
      >
        Create routine
      </button>
    </div>
  {/snippet}
</Modal>
