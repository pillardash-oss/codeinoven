<script lang="ts">
  import { AlertTriangle, Plus, RotateCcw, X } from '@lucide/svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import StatusBadge from '$lib/components/shared/StatusBadge.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { reportError } from '$lib/stores/app-errors.svelte'
  import { assistantRoutines } from '$lib/stores/assistant-routines.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { routineHowToComplete, type Routine, type RoutineSchedule, type UtilityCatalog } from '$shared/types'
  import ComposeWithAgentCard from './ComposeWithAgentCard.svelte'
  import AssistantHandoffControl from './AssistantHandoffControl.svelte'
  import ScheduleEditor from './ScheduleEditor.svelte'

  interface Props {
    projectId: string
    threadId: string
    /** Routine snapshot from the tab; the task's own routineId wins when set. */
    routineId: string | null
    /** Open a forked task thread in its project after a hand-off. */
    onHandedOff?: (forked: import('$shared/types').Thread) => void
  }

  let { projectId, threadId, routineId, onHandedOff }: Props = $props()

  const task = $derived(
    workspaceState.selectedThread?.id === threadId &&
      workspaceState.selectedThread.projectId === projectId
      ? workspaceState.selectedThread
      : (scopeState.allScopeThreads.find(
          (thread) => thread.id === threadId && thread.projectId === projectId
        ) ?? null)
  )

  const routine = $derived.by((): Routine | null => {
    const id = task?.routineId ?? routineId
    if (!id) return null
    return assistantRoutines.routines.find((candidate) => candidate.id === id) ?? null
  })

  const missedRuns = $derived.by(() => {
    const forTask = assistantRoutines.missedForTask(threadId)
    const forRoutine = routine ? assistantRoutines.missedForRoutine(routine.id) : []
    const ids = new SvelteSet<string>()
    return [...forTask, ...forRoutine].filter((run) => {
      if (ids.has(run.id)) return false
      ids.add(run.id)
      return true
    })
  })

  let tab = $state<'how-to' | 'missed'>('how-to')
  const showMissedTab = $derived(missedRuns.length > 0)
  const effectiveTab = $derived(tab === 'missed' && showMissedTab ? 'missed' : 'how-to')

  // Manual how-to draft, reset when the targeted routine changes.
  let howToDraft = $state('')
  let draftRoutineId: string | null = null
  $effect(() => {
    const current = routine?.id ?? null
    if (current !== draftRoutineId) {
      draftRoutineId = current
      howToDraft = routine?.howTo ?? ''
    }
  })

  let catalog = $state<UtilityCatalog | null>(null)
  let connectionToAdd = $state('')

  $effect(() => {
    if (catalog) return
    void invoke('utilities:list')
      .then((result) => (catalog = result))
      .catch(() => undefined)
  })

  const connectedIds = $derived(new Set((routine?.connections ?? []).map((c) => c.utilityId)))
  const addableUtilities = $derived(
    (catalog?.utilities ?? []).filter((utility) => !connectedIds.has(utility.id))
  )

  async function saveHowTo(): Promise<void> {
    if (!routine) return
    try {
      await assistantRoutines.updateRoutine(routine.id, { howTo: howToDraft })
    } catch (error) {
      reportError(error, 'Could not save the how-to')
    }
  }

  async function updateRoutineSchedule(schedule: Routine['schedule']): Promise<void> {
    if (!routine) return
    try {
      await assistantRoutines.updateRoutine(routine.id, { schedule })
    } catch (error) {
      reportError(error, 'Could not save the routine schedule')
    }
  }

  async function updateTaskSchedule(schedule: RoutineSchedule | null): Promise<void> {
    if (!task) return
    try {
      const updated = await assistantRoutines.setTaskSchedule(task.id, schedule)
      workspaceState.updateThread(updated)
      scopeState.updateThread(updated)
    } catch (error) {
      reportError(error, 'Could not save the task schedule')
    }
  }

  async function addConnection(utilityId: string): Promise<void> {
    if (!routine || !utilityId) return
    const utility = addableUtilities.find((candidate) => candidate.id === utilityId)
    if (!utility) return
    const connections = [
      ...routine.connections,
      { utilityId: utility.id, label: utility.name, kind: utility.kind }
    ]
    connectionToAdd = ''
    try {
      await assistantRoutines.updateRoutine(routine.id, { connections })
    } catch (error) {
      reportError(error, 'Could not add the connection')
    }
  }

  async function removeConnection(utilityId: string): Promise<void> {
    if (!routine) return
    const connections = routine.connections.filter((c) => c.utilityId !== utilityId)
    try {
      await assistantRoutines.updateRoutine(routine.id, { connections })
    } catch (error) {
      reportError(error, 'Could not remove the connection')
    }
  }

  async function dismissRun(id: string): Promise<void> {
    try {
      await assistantRoutines.dismissMissedRun(id)
    } catch (error) {
      reportError(error, 'Could not dismiss the missed run')
    }
  }

  async function runNow(id: string): Promise<void> {
    try {
      await assistantRoutines.runMissedRunNow(id)
    } catch (error) {
      reportError(error, 'Could not run the missed task')
    }
  }
</script>

<div class="flex h-full min-h-0 flex-col" aria-label="Assistant how-to">
  <header class="shrink-0 border-b border-border p-4">
    <div class="flex items-center gap-2">
      <h2 class="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
        {routine?.name ?? task?.title ?? 'How-to'}
      </h2>
      {#if routine && !routineHowToComplete(routine)}
        <span
          class="shrink-0 rounded px-1.5 py-0.5 text-[0.625rem] font-medium"
          style="color: var(--color-warning); background: color-mix(in srgb, var(--color-warning) 16%, transparent)"
          title="This routine has no how-to yet"
          aria-label="This routine has no how-to yet"
        >
          Incomplete
        </span>
      {/if}
    </div>
    <p class="mt-1 text-[0.6875rem] text-muted">
      {routine
        ? 'The how-to is the routine-wide instruction every task follows.'
        : 'This task has no routine yet, so it has no how-to.'}
    </p>

    <!-- Tabs: the Missed runs tab only exists when there is a missed run. -->
    <div class="mt-3 flex items-center gap-1" role="tablist" aria-label="How-to panel sections">
      <button
        type="button"
        role="tab"
        aria-selected={effectiveTab === 'how-to'}
        class="rounded-md px-2 py-1 text-[0.6875rem] transition-colors {effectiveTab === 'how-to'
          ? 'bg-elevated text-foreground'
          : 'text-muted hover:bg-elevated hover:text-foreground'}"
        onclick={() => (tab = 'how-to')}
      >
        How-to
      </button>
      {#if showMissedTab}
        <button
          type="button"
          role="tab"
          aria-selected={effectiveTab === 'missed'}
          class="flex items-center gap-1.5 rounded-md px-2 py-1 text-[0.6875rem] transition-colors {effectiveTab ===
          'missed'
            ? 'bg-elevated text-foreground'
            : 'text-muted hover:bg-elevated hover:text-foreground'}"
          onclick={() => (tab = 'missed')}
        >
          <StatusBadge tone="missed" size="sm" title="Missed runs" />
          Missed runs
          <span class="tabular-nums text-dimmed">{missedRuns.length}</span>
        </button>
      {/if}
    </div>
  </header>

  <div class="min-h-0 flex-1 overflow-y-auto p-4">
    {#if effectiveTab === 'missed'}
      <section aria-label="Missed runs" class="flex flex-col gap-2">
        {#each missedRuns as run (run.id)}
          <div class="rounded-lg border border-border p-2.5">
            <div class="flex items-center gap-2">
              <AlertTriangle size={14} strokeWidth={1.8} style="color: var(--color-missed)" />
              <span class="min-w-0 flex-1 truncate text-[0.75rem] text-foreground">{run.title}</span>
            </div>
            <p class="mt-1 text-[0.625rem] text-dimmed">
              Was due {new Date(run.dueAt).toLocaleString()} while the app was closed.
            </p>
            <div class="mt-2 flex justify-end gap-1.5">
              <button
                type="button"
                class="rounded-md px-2 py-1 text-[0.6875rem] text-muted transition-colors hover:bg-elevated hover:text-foreground"
                onclick={() => void dismissRun(run.id)}
              >
                Dismiss
              </button>
              <button
                type="button"
                class="flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-[0.6875rem] text-on-primary transition-colors hover:bg-primary-hover"
                onclick={() => void runNow(run.id)}
              >
                <RotateCcw size={12} strokeWidth={1.8} />
                Run now
              </button>
            </div>
          </div>
        {/each}
      </section>
    {:else}
      <div class="flex flex-col gap-4">
        {#if routine && task}
          <ComposeWithAgentCard {task} {routine} />
        {/if}

        <section aria-label="How-to">
          <label class="mb-1.5 block text-[0.6875rem] font-medium text-muted" for="assistant-how-to">
            How-to
          </label>
          <textarea
            id="assistant-how-to"
            class="min-h-32 w-full resize-y rounded-md border border-border bg-surface px-2.5 py-2 text-[0.75rem] text-foreground focus:border-border-strong focus:outline-none disabled:opacity-50"
            placeholder={routine
              ? 'Describe how the agent should carry out this routine.'
              : 'Create a routine to give this task a how-to.'}
            disabled={!routine}
            bind:value={howToDraft}
          ></textarea>
          {#if routine}
            <div class="mt-2 flex justify-end">
              <button
                type="button"
                class="rounded-md bg-primary px-3 py-1.5 text-[0.75rem] text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
                disabled={howToDraft === routine.howTo}
                onclick={() => void saveHowTo()}
              >
                Save how-to
              </button>
            </div>
          {/if}
        </section>

        {#if routine}
          <section aria-label="Schedule" class="rounded-lg border border-border p-3">
            <h3 class="mb-2 text-[0.6875rem] font-medium text-muted">Routine schedule</h3>
            <ScheduleEditor
              value={routine.schedule ?? null}
              onChange={(schedule) => void updateRoutineSchedule(schedule)}
            />
          </section>

          {#if task}
            <section aria-label="Task schedule" class="rounded-lg border border-border p-3">
              <h3 class="mb-2 text-[0.6875rem] font-medium text-muted">This task's schedule</h3>
              <ScheduleEditor
                value={task.scheduleOverride ?? null}
                onChange={(schedule) => void updateTaskSchedule(schedule)}
                inheritLabel={task.scheduleOverride ? 'Use routine schedule' : undefined}
                onInherit={task.scheduleOverride ? () => void updateTaskSchedule(null) : undefined}
              />
            </section>
          {/if}

          <section aria-label="Connections" class="rounded-lg border border-border p-3">
            <h3 class="mb-2 text-[0.6875rem] font-medium text-muted">Connections</h3>
            {#if routine.connections.length === 0}
              <p class="text-[0.6875rem] text-dimmed">
                No connections yet. The agent adds them as it writes the how-to.
              </p>
            {:else}
              <div class="mb-2 flex flex-wrap gap-1.5">
                {#each routine.connections as connection (connection.utilityId)}
                  <span
                    class="flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[0.6875rem] text-foreground"
                  >
                    {connection.label}
                    <button
                      type="button"
                      class="text-dimmed transition-colors hover:text-foreground"
                      title="Remove {connection.label}"
                      aria-label="Remove {connection.label}"
                      onclick={() => void removeConnection(connection.utilityId)}
                    >
                      <X size={11} strokeWidth={2} />
                    </button>
                  </span>
                {/each}
              </div>
            {/if}
            {#if addableUtilities.length > 0}
              <div class="flex items-center gap-1.5">
                <select
                  class="min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1 text-[0.6875rem] text-foreground focus:border-border-strong focus:outline-none"
                  aria-label="Add a connection from the utility library"
                  bind:value={connectionToAdd}
                >
                  <option value="">Add a connection…</option>
                  {#each addableUtilities as utility (utility.id)}
                    <option value={utility.id}>{utility.name}</option>
                  {/each}
                </select>
                <button
                  type="button"
                  class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
                  title="Add connection"
                  aria-label="Add connection"
                  disabled={!connectionToAdd}
                  onclick={() => void addConnection(connectionToAdd)}
                >
                  <Plus size={13} strokeWidth={1.8} />
                </button>
              </div>
            {/if}
          </section>
        {/if}

        {#if task && onHandedOff}
          <section aria-label="Hand-off">
            <AssistantHandoffControl {task} onHandedOff={onHandedOff} />
          </section>
        {/if}
      </div>
    {/if}
  </div>
</div>
