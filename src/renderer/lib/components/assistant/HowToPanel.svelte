<script lang="ts">
  import { AlertTriangle, Plus, RotateCcw, ScrollText, X } from '@lucide/svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import { invoke } from '$lib/ipc.svelte'
  import { reportError } from '$lib/stores/app-errors.svelte'
  import { assistantRoutines } from '$lib/stores/assistant-routines.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { routineHowToComplete, type Routine, type RoutineSchedule, type UtilityCatalog } from '$shared/types'
  import AssistantHandoffControl from './AssistantHandoffControl.svelte'
  import ScheduleEditor from './ScheduleEditor.svelte'

  interface Props {
    projectId: string
    threadId: string
    /** Routine snapshot from the tab; the task's own routineId wins when set. */
    routineId: string | null
    /** Open a forked task thread in its project after a hand-off. */
    onHandedOff?: (forked: import('$shared/types').Thread) => void
    /** Bring the routine's authoring task on screen so the user can describe it. */
    onOpenAuthoringTask?: (threadId: string) => void
  }

  let { projectId, threadId, routineId, onHandedOff, onOpenAuthoringTask }: Props = $props()

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

  // The tab strip only exists once there is a missed run to surface; until then
  // the panel is a single read-only how-to view with no chrome.
  const showMissedTab = $derived(missedRuns.length > 0)
  let tab = $state<'how-to' | 'missed'>('how-to')
  const effectiveTab = $derived(tab === 'missed' && showMissedTab ? 'missed' : 'how-to')

  const howTo = $derived(routine?.howTo.trim() ?? '')
  const incomplete = $derived(routine ? !routineHowToComplete(routine) : false)

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
  {#if showMissedTab}
    <!-- Real tab strip: only rendered once a scheduled run was actually missed. -->
    <div
      class="flex h-9 shrink-0 items-stretch gap-0 border-b border-border px-2"
      role="tablist"
      aria-label="Assistant how-to sections"
    >
      <button
        type="button"
        role="tab"
        aria-selected={effectiveTab === 'how-to'}
        class="relative flex items-center px-3 text-[0.6875rem] transition-colors {effectiveTab ===
        'how-to'
          ? 'text-foreground'
          : 'text-muted hover:text-foreground'}"
        onclick={() => (tab = 'how-to')}
      >
        How-to
        {#if effectiveTab === 'how-to'}
          <span class="absolute inset-x-1.5 bottom-0 h-[2px] rounded-full bg-primary"></span>
        {/if}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={effectiveTab === 'missed'}
        class="relative flex items-center gap-1.5 px-3 text-[0.6875rem] transition-colors {effectiveTab ===
        'missed'
          ? 'text-foreground'
          : 'text-muted hover:text-foreground'}"
        onclick={() => (tab = 'missed')}
      >
        <AlertTriangle
          size={12}
          strokeWidth={1.8}
          style="color: var(--color-missed)"
          aria-hidden="true"
        />
        Missed runs
        <span class="tabular-nums text-dimmed">{missedRuns.length}</span>
        {#if effectiveTab === 'missed'}
          <span class="absolute inset-x-1.5 bottom-0 h-[2px] rounded-full bg-primary"></span>
        {/if}
      </button>
    </div>
  {/if}

  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if effectiveTab === 'missed'}
      <section aria-label="Missed runs" class="flex flex-col gap-2 p-3">
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
      <div class="flex flex-col gap-4 p-3">
        <section aria-label="How-to">
          <div class="mb-2 flex items-center gap-1.5">
            <ScrollText size={13} strokeWidth={1.8} class="shrink-0 text-muted" />
            <h2 class="min-w-0 flex-1 truncate text-[0.75rem] font-medium text-foreground">
              {routine?.name ?? task?.title ?? 'How-to'}
            </h2>
            {#if incomplete}
              <span
                class="flex shrink-0 items-center"
                style="color: var(--color-warning)"
                role="img"
                aria-label="This routine has no how-to yet"
                title="Incomplete: this routine has no how-to yet"
              >
                <AlertTriangle size={12} />
              </span>
            {/if}
          </div>

          {#if howTo}
            <div
              class="whitespace-pre-wrap rounded-lg border border-border bg-elevated/40 px-3 py-2.5 text-[0.75rem] leading-relaxed text-foreground"
            >
              {howTo}
            </div>
          {:else if routine}
            <p class="text-[0.75rem] leading-relaxed text-muted">
              No how-to yet. Describe how this routine should run to the agent in its first
              task, refine it together, then send <span class="text-foreground">/save-how-to</span>
              to commit it.
            </p>
            {#if onOpenAuthoringTask}
              <button
                type="button"
                class="mt-2 rounded-md border border-border bg-elevated px-2.5 py-1.5 text-[0.6875rem] font-medium text-foreground transition-colors hover:bg-overlay"
                onclick={() => onOpenAuthoringTask(threadId)}
              >
                Open the routine's task
              </button>
            {/if}
          {:else}
            <p class="text-[0.75rem] leading-relaxed text-muted">
              This task has no routine, so it has no how-to. Group it into a routine to give it one.
            </p>
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
