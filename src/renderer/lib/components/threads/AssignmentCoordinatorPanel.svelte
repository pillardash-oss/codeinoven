<script lang="ts">
  import CioArrowLeft from '@pdslng/cio-icon/CioArrowLeft.svelte'
  import CioArrowUpRight from '@pdslng/cio-icon/CioArrowUpRight.svelte'
  import CioClipboardCheck from '@pdslng/cio-icon/CioClipboardCheck.svelte'
  import CioNetwork from '@pdslng/cio-icon/CioNetwork.svelte'
  import CioPlay from '@pdslng/cio-icon/CioPlay.svelte'
  import CioRows3 from '@pdslng/cio-icon/CioRows3.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import CioSquare from '@pdslng/cio-icon/CioSquare.svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import ThreadRow from './ThreadRow.svelte'
  import CoordinatorRunTimer from './CoordinatorRunTimer.svelte'
  import ThreadStatusChip from '../shared/ThreadStatusChip.svelte'
  import { isThreadLiveWorking, statusBadgeForThread } from '$lib/thread-status-badge'
  import {
    isThreadRetryPaused,
    workerReportsToCoordinator,
    type AssignmentCoordinatorPanelProps,
    type AssignmentTask,
    type AssignmentTaskStatus,
    type Thread
  } from '$shared/types'

  let {
    assignment,
    threads,
    auditThread,
    auditState,
    finalComplete = false,
    reportAvailable = false,
    selectedThreadId,
    coordinatorWorking,
    onOpenAssignment,
    onOpenAuditWork,
    onViewReport,
    onOpenThread,
    onOpenTask,
    onResume,
    onStop,
    onResumeAssignment,
    onBackToCoordinator,
    onReportToCoordinator
  }: AssignmentCoordinatorPanelProps = $props()

  let showStopConfirmation = $state(false)
  let stopBusy = $state(false)
  let stopError = $state('')
  let resumeBusy = $state(false)
  let resumeError = $state('')
  let reportBusy = $state(false)
  let reportError = $state('')

  const completed = $derived(
    assignment.content.tasks.filter((task) => task.status === 'completed').length
  )
  const running = $derived(
    assignment.content.tasks.filter((task) =>
      ['running', 'reported', 'auditing', 'rework'].includes(task.status)
    ).length
  )
  const blocked = $derived(
    assignment.content.tasks.filter((task) => task.status === 'blocked').length
  )
  const pending = $derived(
    assignment.content.tasks.filter((task) => ['planned', 'ready'].includes(task.status)).length
  )
  const attention = $derived(
    assignment.content.tasks.filter((task) =>
      ['attention', 'failed', 'stopped'].includes(task.status)
    ).length
  )

  /** Which group of tasks the list below the meters shows. */
  type TaskStatusFilter = 'all' | 'done' | 'active' | 'blocked' | 'pending' | 'attention'

  /** The status meter the user last picked; `all` shows every task. */
  let taskFilter = $state<TaskStatusFilter>('all')

  const FILTER_STATUSES: Readonly<Record<Exclude<TaskStatusFilter, 'all'>, readonly string[]>> = {
    done: ['completed'],
    active: ['running', 'reported', 'auditing', 'rework'],
    blocked: ['blocked'],
    pending: ['planned', 'ready'],
    attention: ['attention', 'failed', 'stopped']
  }

  function matchesFilter(status: AssignmentTaskStatus, filter: TaskStatusFilter): boolean {
    if (filter === 'all') return true
    return FILTER_STATUSES[filter].includes(status)
  }

  /** Tasks in the order the graph declares them, numbered by that order. */
  const visibleTasks = $derived(
    assignment.content.tasks
      .map((task, index) => ({ task, index }))
      .filter((entry) => matchesFilter(entry.task.status, taskFilter))
  )

  /** Toggle one meter as the list filter; picking it again restores every task. */
  function toggleFilter(filter: Exclude<TaskStatusFilter, 'all'>): void {
    taskFilter = taskFilter === filter ? 'all' : filter
  }
  const progress = $derived(
    assignment.content.tasks.length === 0
      ? 0
      : Math.round((completed / assignment.content.tasks.length) * 100)
  )
  const workersWorking = $derived(
    threads.some((worker) => worker.status === 'planning' || worker.status === 'executing')
  )
  const workersRetryPaused = $derived(threads.some((worker) => isThreadRetryPaused(worker)))
  const stalled = $derived(
    assignment.status !== 'stopped' &&
      completed < assignment.content.tasks.length &&
      !coordinatorWorking &&
      !workersWorking &&
      !workersRetryPaused
  )
  const auditWorkAvailable = $derived(
    (auditState === 'offered' || auditState === 'failed') && !finalComplete
  )
  /** When this run first started working: the earliest task start, or the
   *  sign-off when the Sr. Engineer is already on it. */
  const runStartedAt = $derived.by(() => {
    const starts = assignment.content.tasks
      .map((task) => task.startedAt)
      .filter((at): at is number => at !== undefined)
    return starts.length > 0 ? Math.min(...starts) : (assignment.approvedAt ?? undefined)
  })
  /** Live while any part of the run is working. Tasks may overlap or queue, so
   *  the timer is wall clock, not a sum of task durations. */
  const runLive = $derived(
    assignment.status !== 'completed' &&
      assignment.status !== 'stopped' &&
      (coordinatorWorking || workersWorking || running > 0)
  )
  /** A stopped, paused or settled run freezes at the last real activity, so the
   *  number never grows while nothing is working. */
  const runEndedAt = $derived.by(() => {
    if (assignment.status === 'completed') return assignment.completedAt ?? assignment.updatedAt
    if (assignment.status === 'stopped') return assignment.stoppedAt ?? assignment.updatedAt
    if (runLive) return undefined
    const ends = [
      ...assignment.content.tasks.map((task) => task.completedAt ?? task.startedAt),
      ...threads.map((worker) => worker.lastActivity)
    ].filter((at): at is number => at !== undefined)
    return ends.length > 0 ? Math.max(...ends) : undefined
  })

  function linkedThread(taskThreadId: string | undefined): Thread | undefined {
    return taskThreadId ? threads.find((thread) => thread.id === taskThreadId) : undefined
  }

  function statusLabel(status: AssignmentTaskStatus): string {
    return status.replace('_', ' ')
  }

  function statusClass(status: AssignmentTaskStatus): string {
    if (status === 'completed') return 'border-success/30 bg-success/10 text-success'
    if (status === 'failed' || status === 'attention' || status === 'stopped') {
      return 'border-danger/30 bg-danger/10 text-danger'
    }
    if (status === 'blocked') return 'border-warning/30 bg-warning/10 text-warning'
    if (['running', 'reported', 'auditing', 'rework'].includes(status)) {
      return 'border-info/30 bg-info/10 text-info'
    }
    return 'border-border bg-elevated text-muted'
  }

  function workerLabel(task: AssignmentTask): string {
    return task.workerName ?? (task.owner === 'senior' ? 'Sr. Engineer' : 'Unassigned')
  }

  function taskReworkCycle(task: AssignmentTask): number | undefined {
    if (task.workKind === 'rework') return task.reworkCycle ?? 1
    if (assignment.auditCycle?.reworkAssignmentVersion === assignment.version) {
      return assignment.auditCycle.reworkCycle ?? 1
    }
    return undefined
  }

  function taskTooltip(
    task: AssignmentTask,
    linkedWorker: Thread | undefined,
    reportingOff: boolean
  ): string {
    const worker = workerLabel(task)
    const destination =
      task.owner === 'senior'
        ? 'Open the Sr. Engineer thread'
        : task.threadId
          ? `Open ${linkedWorker?.title ?? worker}`
          : 'Open this task in Assignment Studio'
    // A non-reporting worker never hands its task back, so the Assignment
    // lifecycle is frozen where the user switched reporting off. The row shows
    // the worker thread's own live status instead, and the accessible name has
    // to match what is on screen.
    const liveStatus =
      reportingOff && linkedWorker
        ? statusBadgeForThread(linkedWorker, isThreadLiveWorking(linkedWorker))?.label
        : undefined
    const reporting = reportingOff ? ' · not reporting back' : ''
    return `${task.title} · ${worker} · ${liveStatus ?? statusLabel(task.status)}${reporting}. ${destination}`
  }

  async function confirmStop(): Promise<void> {
    if (stopBusy) return
    stopBusy = true
    stopError = ''
    try {
      await onStop()
      showStopConfirmation = false
    } catch (error) {
      stopError = error instanceof Error ? error.message : 'The Assignment could not be stopped.'
    } finally {
      stopBusy = false
    }
  }

  async function resumeStoppedAssignment(): Promise<void> {
    if (resumeBusy) return
    resumeBusy = true
    resumeError = ''
    try {
      await onResumeAssignment()
    } catch (error) {
      resumeError = error instanceof Error ? error.message : 'The Assignment could not be resumed.'
    } finally {
      resumeBusy = false
    }
  }

  /** Ask the open not-reporting worker to hand its finished work back. Reporting
   *  flips on in the main process, so the button unmounts once the action
   *  resolves; the busy guard stops a second click while it runs. */
  async function reportToCoordinator(): Promise<void> {
    if (reportBusy || !onReportToCoordinator) return
    reportBusy = true
    reportError = ''
    try {
      await onReportToCoordinator()
    } catch (error) {
      reportError =
        error instanceof Error ? error.message : 'The worker could not be asked to report.'
    } finally {
      reportBusy = false
    }
  }
</script>

<!--
  Docked into the context sidebar: the sidebar owns the width, the visibility,
  and the tab chrome, so this panel is just a column that fills whatever space
  it is given.
-->
<div
  class="assignment-coordinator-panel flex h-full min-h-0 flex-col"
  aria-label="Assignment coordinator"
>
  <header class="shrink-0 border-b border-border p-4">
    <div class="flex min-w-0 items-center gap-2 text-primary">
      <CioNetwork size={15} class="shrink-0" />
      <h2 class="text-xs font-semibold uppercase tracking-wide">Assignment coordinator</h2>
    </div>
    <h3 class="mt-3 text-sm font-semibold text-foreground">{assignment.content.title}</h3>
    <p class="mt-1 line-clamp-3 text-xs leading-relaxed text-muted">
      {assignment.content.summary}
    </p>
    <div class="mt-3 flex gap-2">
      <button
        type="button"
        class="flex flex-1 items-center justify-center gap-2 bg-primary px-3 py-2 text-xs font-semibold text-on-primary hover:bg-primary-hover"
        title="Open the complete Assignment in Spec Studio"
        onclick={onOpenAssignment}
      >
        {#if finalComplete}
          View Assignment
        {:else}
          <span class="assignment-label-full">Review Assignment</span>
          <span class="assignment-label-short">Assignment</span>
        {/if}
        <CioArrowUpRight size={13} />
      </button>
      {#if assignment.status === 'stopped'}
        <button
          type="button"
          class="flex items-center justify-center gap-1.5 border border-border bg-elevated px-3 py-2 text-xs font-semibold text-foreground hover:bg-overlay disabled:cursor-not-allowed disabled:opacity-60"
          title="Resume this Assignment"
          disabled={resumeBusy}
          onclick={() => void resumeStoppedAssignment()}
        >
          {#if resumeBusy}
            <CioSpinner size={13} class="animate-spin" />
          {:else}
            <CioPlay size={12} fill="currentColor" />
          {/if}
          {resumeBusy ? 'Resuming…' : 'Resume'}
        </button>
      {:else if !finalComplete}
        <button
          type="button"
          class="flex items-center justify-center gap-1.5 border border-danger/40 bg-danger/10 px-3 py-2 text-xs font-semibold text-danger hover:bg-danger/20"
          title="Stop the Sr. Engineer, workers, and auditor"
          aria-label="Stop the Sr. Engineer, workers, and auditor"
          onclick={() => (showStopConfirmation = true)}
        >
          <CioSquare size={12} fill="currentColor" />
          Stop
        </button>
      {/if}
      {#if auditWorkAvailable && onOpenAuditWork}
        <button
          type="button"
          class="border border-border bg-elevated px-3 py-2 text-xs font-semibold text-foreground hover:bg-overlay"
          title="Open the Assignment audit work"
          onclick={onOpenAuditWork}
        >
          {auditState === 'failed' ? 'Audit Failed' : 'Audit Work'}
        </button>
      {/if}
      {#if reportAvailable && !finalComplete && onViewReport}
        <button
          type="button"
          class="border border-border bg-elevated px-3 py-2 text-xs font-semibold text-foreground hover:bg-overlay"
          title="Open the latest audit report in Audit Studio"
          onclick={onViewReport}
        >
          View Report
        </button>
      {/if}
    </div>
    {#if resumeError}
      <p class="mt-2 text-xs text-danger" role="alert">{resumeError}</p>
    {/if}
  </header>

  <div class="min-h-0 flex-1 overflow-y-auto">
    <section class="border-b border-border p-4" aria-label="Assignment progress">
      <div class="flex items-end justify-between gap-3">
        <div>
          <p class="text-2xl font-semibold tabular-nums text-foreground">
            {completed}/{assignment.content.tasks.length}
          </p>
          <p class="text-[0.625rem] uppercase tracking-wide text-dimmed">tasks complete</p>
        </div>
        <p class="text-xs font-medium tabular-nums text-muted">{progress}%</p>
      </div>
      <div class="mt-3 h-1.5 overflow-hidden bg-elevated">
        <div class="h-full bg-primary transition-[width]" style:width={`${progress}%`}></div>
      </div>
      <div class="mt-3 grid grid-cols-5 gap-1 text-center" aria-label="Filter tasks by status">
        <button
          type="button"
          class="border px-1 py-1 transition-colors hover:bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border {taskFilter ===
          'done'
            ? 'border-success/40 bg-success/10'
            : 'border-transparent'}"
          title="Show only completed tasks"
          aria-label="Show only completed tasks"
          aria-pressed={taskFilter === 'done'}
          onclick={() => toggleFilter('done')}
        >
          <p class="text-sm font-semibold tabular-nums text-success">{completed}</p>
          <p class="text-[0.5625rem] uppercase text-dimmed">Done</p>
        </button>
        <button
          type="button"
          class="border px-1 py-1 transition-colors hover:bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border {taskFilter ===
          'active'
            ? 'border-info/40 bg-info/10'
            : 'border-transparent'}"
          title="Show only tasks that are working now"
          aria-label="Show only tasks that are working now"
          aria-pressed={taskFilter === 'active'}
          onclick={() => toggleFilter('active')}
        >
          <p class="text-sm font-semibold tabular-nums text-info">{running}</p>
          <p class="text-[0.5625rem] uppercase text-dimmed">Active</p>
        </button>
        <button
          type="button"
          class="border px-1 py-1 transition-colors hover:bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border {taskFilter ===
          'blocked'
            ? 'border-warning/40 bg-warning/10'
            : 'border-transparent'}"
          title="Show only blocked tasks"
          aria-label="Show only blocked tasks"
          aria-pressed={taskFilter === 'blocked'}
          onclick={() => toggleFilter('blocked')}
        >
          <p class="text-sm font-semibold tabular-nums text-warning">{blocked}</p>
          <p class="text-[0.5625rem] uppercase text-dimmed">Blocked</p>
        </button>
        <button
          type="button"
          class="border px-1 py-1 transition-colors hover:bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border {taskFilter ===
          'pending'
            ? 'border-border bg-elevated'
            : 'border-transparent'}"
          title="Show only tasks that have not started"
          aria-label="Show only tasks that have not started"
          aria-pressed={taskFilter === 'pending'}
          onclick={() => toggleFilter('pending')}
        >
          <p class="text-sm font-semibold tabular-nums text-muted">{pending}</p>
          <p class="text-[0.5625rem] uppercase text-dimmed">Pending</p>
        </button>
        <button
          type="button"
          class="border px-1 py-1 transition-colors hover:bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border {taskFilter ===
          'attention'
            ? 'border-danger/40 bg-danger/10'
            : 'border-transparent'}"
          title="Show only tasks that need attention"
          aria-label="Show only tasks that need attention"
          aria-pressed={taskFilter === 'attention'}
          onclick={() => toggleFilter('attention')}
        >
          <p class="text-sm font-semibold tabular-nums text-danger">{attention}</p>
          <p class="text-[0.5625rem] uppercase text-dimmed">Attention</p>
        </button>
      </div>
    </section>

    {#if stalled}
      <section class="border-b border-border p-4" aria-label="Assignment needs direction">
        <div class="flex items-start gap-2">
          <CioRows3 size={14} class="mt-0.5 shrink-0 text-warning" />
          <div class="min-w-0">
            <h3 class="text-xs font-semibold text-foreground">Coordination paused</h3>
            <p class="mt-1 text-xs leading-relaxed text-muted">
              Work remains, but no Sr. Engineer or worker is running. Resume coordination to review
              blockers and request any missing input.
            </p>
          </div>
        </div>
        <button
          type="button"
          class="mt-3 flex h-8 w-full items-center justify-center gap-2 border border-border bg-elevated px-3 text-xs font-semibold text-foreground hover:bg-overlay"
          title="Ask the Sr. Engineer to review blockers and continue coordination"
          onclick={onResume}
        >
          <CioPlay size={12} />
          Resume coordination
        </button>
      </section>
    {/if}

    {#if auditThread && !finalComplete}
      <section class="border-b border-border py-3" aria-label="Audit thread">
        <h3 class="px-4 pb-2 text-[0.625rem] font-semibold uppercase tracking-wide text-dimmed">
          Audit
        </h3>
        <div class="px-2">
          <ThreadRow
            thread={auditThread}
            compact
            selected={auditThread.id === selectedThreadId}
            showChangeScope={false}
            onOpen={onOpenThread}
          />
        </div>
      </section>
    {/if}

    <section class="p-4" aria-label="Assignment tasks">
      <div class="flex items-baseline justify-between gap-2 pb-2">
        <div class="flex items-baseline gap-2">
          <h3 class="text-[0.625rem] font-semibold uppercase tracking-wide text-dimmed">Tasks</h3>
          {#if taskFilter !== 'all'}
            <button
              type="button"
              class="text-[0.5625rem] font-semibold uppercase tracking-wide text-muted hover:text-foreground"
              title="Show every task again"
              aria-label="Show every task again"
              onclick={() => (taskFilter = 'all')}
            >
              {visibleTasks.length} shown · clear
            </button>
          {/if}
        </div>
        <CoordinatorRunTimer
          startedAt={runStartedAt}
          endedAt={runEndedAt}
          live={runLive}
          label="Total run time of these tasks"
        />
      </div>
      <div class="space-y-1">
        {#each visibleTasks as { task, index: taskIndex } (task.id)}
          {@const linkedWorker = linkedThread(task.threadId)}
          {@const active = task.threadId === selectedThreadId}
          {@const reworkCycle = taskReworkCycle(task)}
          {@const taskNumber = taskIndex + 1}
          {@const reportingOff =
            linkedWorker !== undefined && !workerReportsToCoordinator(linkedWorker.settings)}
          <button
            type="button"
            class="flex w-full items-start justify-between gap-2 border-l-2 px-1 py-1.5 text-left transition-colors hover:bg-elevated {active
              ? 'border-primary bg-elevated'
              : ['attention', 'failed', 'stopped'].includes(task.status)
                ? 'border-danger bg-danger/5'
                : 'border-transparent'}"
            title={taskTooltip(task, linkedWorker, reportingOff)}
            aria-label={taskTooltip(task, linkedWorker, reportingOff)}
            aria-current={active ? 'true' : undefined}
            onclick={() => onOpenTask(task)}
          >
            <span class="min-w-0 flex-1">
              <span class="flex min-w-0 items-center gap-1.5">
                <span class="min-w-0 truncate text-xs font-medium text-foreground"
                  >{task.title}</span
                >
                {#if reworkCycle}
                  <span
                    class="shrink-0 border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-[0.5625rem] font-semibold tracking-wide text-warning uppercase"
                  >
                    Rework {reworkCycle}
                  </span>
                {/if}
              </span>
              <span class="mt-0.5 flex items-center gap-1.5">
                <span
                  class="shrink-0 text-[0.625rem] font-medium tabular-nums text-dimmed"
                  aria-hidden="true">{taskNumber}.</span
                >
                <span class="min-w-0 truncate text-[0.625rem] text-dimmed">
                  {workerLabel(task)}
                </span>
                {#if reportingOff}
                  <span
                    class="shrink-0 border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-[0.5625rem] font-semibold tracking-wide text-warning uppercase"
                  >
                    Not reporting
                  </span>
                {/if}
                {#if reportingOff && linkedWorker}
                  <!-- The Assignment lifecycle is frozen while reporting is off, so the
                       worker thread's own live status is the only truthful one. -->
                  <ThreadStatusChip thread={linkedWorker} size="md" />
                {/if}
              </span>
            </span>
            {#if !(reportingOff && linkedWorker)}
              <span
                class="shrink-0 border px-1.5 py-0.5 text-[0.5625rem] font-semibold tracking-wide uppercase {statusClass(
                  task.status
                )}"
              >
                {statusLabel(task.status)}
              </span>
            {/if}
          </button>
        {/each}
      </div>
    </section>
  </div>

  {#if onBackToCoordinator || onReportToCoordinator}
    <footer class="shrink-0 space-y-2 border-t border-border p-3">
      {#if onReportToCoordinator}
        <!-- Shown only while the open worker has reporting off: the user is
             asking it to hand its finished work back, so reporting is switched
             on again and the worker submits its report. -->
        <button
          type="button"
          class="flex w-full items-center justify-center gap-1.5 whitespace-nowrap bg-primary px-3 py-2 text-xs font-semibold text-on-primary transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
          title="Switch reporting back on and ask this worker to report its finished work to the Sr. Engineer"
          aria-label="Report this worker's finished work to the Sr. Engineer"
          disabled={reportBusy}
          onclick={() => void reportToCoordinator()}
        >
          {#if reportBusy}
            <CioSpinner size={13} class="animate-spin" aria-hidden="true" />
            Reporting…
          {:else}
            <CioClipboardCheck size={13} aria-hidden="true" />
            Report to Sr. Engineer
          {/if}
        </button>
      {/if}
      {#if onBackToCoordinator}
        <button
          type="button"
          class="flex w-full items-center justify-center gap-1.5 whitespace-nowrap border border-border bg-elevated px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:bg-overlay"
          title="Back to the Sr. Engineer thread that owns this Assignment"
          aria-label="Back to the Sr. Engineer thread that owns this Assignment"
          onclick={onBackToCoordinator}
        >
          <CioArrowLeft size={13} aria-hidden="true" />
          Back to Sr. Engineer
        </button>
      {/if}
      {#if reportError}
        <p class="text-xs text-danger" role="alert">{reportError}</p>
      {/if}
    </footer>
  {/if}
</div>

<Modal
  open={showStopConfirmation}
  title="Stop Assignment?"
  onClose={() => {
    if (!stopBusy) showStopConfirmation = false
  }}
>
  <p class="text-sm leading-relaxed text-muted">
    Stop all work on this Assignment? Current agent runs and processes will be stopped. You can
    resume it later.
  </p>
  {#if stopError}
    <p class="mt-3 text-sm text-danger" role="alert">{stopError}</p>
  {/if}

  {#snippet footer()}
    <button
      type="button"
      class="px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated"
      disabled={stopBusy}
      onclick={() => (showStopConfirmation = false)}
    >
      Cancel
    </button>
    <button
      type="button"
      class="flex items-center gap-2 bg-danger px-4 py-2 text-sm font-medium text-on-danger transition-colors hover:bg-danger/90 disabled:cursor-not-allowed disabled:opacity-60"
      disabled={stopBusy}
      onclick={() => void confirmStop()}
    >
      {#if stopBusy}<CioSpinner size={14} class="animate-spin" />{/if}
      {stopBusy ? 'Stopping…' : 'Stop Assignment'}
    </button>
  {/snippet}
</Modal>

<style>
  .assignment-coordinator-panel {
    container-type: inline-size;
  }

  .assignment-label-short {
    display: none;
  }

  @container (max-width: 390px) {
    .assignment-label-full {
      display: none;
    }

    .assignment-label-short {
      display: inline;
    }
  }
</style>
