<script lang="ts">
  import { ArrowUpRight, Loader2, Network, Play, Rows3, Square } from '@lucide/svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import ThreadRow from './ThreadRow.svelte'
  import type { AssignmentPlan, AssignmentTask, AssignmentTaskStatus, Thread } from '$shared/types'

  interface Props {
    assignment: AssignmentPlan
    threads: Thread[]
    auditThread?: Thread
    auditState?: Thread['auditState'] | 'failed'
    finalComplete?: boolean
    reportAvailable?: boolean
    selectedThreadId: string
    width: number
    coordinatorWorking: boolean
    onOpenAssignment: () => void
    onOpenAuditWork?: () => void
    onViewReport?: () => void
    onOpenThread: (thread: Thread) => void
    onOpenTask: (task: AssignmentTask) => void
    onResume: () => void
    onStop: () => Promise<void>
    onResumeAssignment: () => Promise<void>
    onWidthChange: (width: number) => void
  }

  let {
    assignment,
    threads,
    auditThread,
    auditState,
    finalComplete = false,
    reportAvailable = false,
    selectedThreadId,
    width,
    coordinatorWorking,
    onOpenAssignment,
    onOpenAuditWork,
    onViewReport,
    onOpenThread,
    onOpenTask,
    onResume,
    onStop,
    onResumeAssignment,
    onWidthChange
  }: Props = $props()

  const WIDTH_STORAGE_KEY = 'codeinoven:assignment-coordinator-width'
  const MIN_WIDTH = 280
  const MAX_WIDTH = 560

  let resizing = $state(false)
  let resizePointerId = 0
  let resizeStartX = 0
  let resizeStartWidth = 0
  let resizeCurrentWidth = 0
  let showStopConfirmation = $state(false)
  let stopBusy = $state(false)
  let stopError = $state('')
  let resumeBusy = $state(false)
  let resumeError = $state('')

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
  const progress = $derived(
    assignment.content.tasks.length === 0
      ? 0
      : Math.round((completed / assignment.content.tasks.length) * 100)
  )
  const workersWorking = $derived(
    threads.some((worker) => worker.status === 'planning' || worker.status === 'executing')
  )
  const stalled = $derived(
    assignment.status !== 'stopped' &&
      completed < assignment.content.tasks.length &&
      !coordinatorWorking &&
      !workersWorking
  )
  const auditWorkAvailable = $derived(
    (auditState === 'offered' || auditState === 'failed') && !finalComplete
  )

  function clampWidth(nextWidth: number): number {
    const viewportMaximum = Math.max(MIN_WIDTH, window.innerWidth - 480)
    return Math.min(Math.max(nextWidth, MIN_WIDTH), Math.min(MAX_WIDTH, viewportMaximum))
  }

  function restoreWidth(): void {
    const stored = Number.parseInt(localStorage.getItem(WIDTH_STORAGE_KEY) ?? '', 10)
    if (Number.isFinite(stored)) onWidthChange(clampWidth(stored))
  }

  function startResize(event: PointerEvent & { currentTarget: HTMLButtonElement }): void {
    resizing = true
    resizePointerId = event.pointerId
    resizeStartX = event.clientX
    resizeStartWidth = width
    resizeCurrentWidth = width
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function resize(event: PointerEvent): void {
    if (!resizing || event.pointerId !== resizePointerId) return
    resizeCurrentWidth = clampWidth(resizeStartWidth + resizeStartX - event.clientX)
    onWidthChange(resizeCurrentWidth)
  }

  function finishResize(event: PointerEvent): void {
    if (!resizing || event.pointerId !== resizePointerId) return
    resizing = false
    localStorage.setItem(WIDTH_STORAGE_KEY, String(resizeCurrentWidth))
  }

  function resizeWithKeyboard(event: KeyboardEvent): void {
    const step = event.shiftKey ? 48 : 16
    const nextWidth =
      event.key === 'ArrowLeft' ? width + step : event.key === 'ArrowRight' ? width - step : null
    if (nextWidth === null) return
    event.preventDefault()
    resizeCurrentWidth = clampWidth(nextWidth)
    onWidthChange(resizeCurrentWidth)
    localStorage.setItem(WIDTH_STORAGE_KEY, String(resizeCurrentWidth))
  }

  function linkedThread(taskThreadId: string | undefined): Thread | undefined {
    return taskThreadId ? threads.find((thread) => thread.id === taskThreadId) : undefined
  }

  function statusLabel(status: AssignmentTaskStatus): string {
    return status.replace('_', ' ')
  }

  function statusClass(status: AssignmentTaskStatus): string {
    if (status === 'completed') return 'bg-success/10 text-success'
    if (status === 'failed' || status === 'attention' || status === 'stopped') {
      return 'bg-danger/10 text-danger'
    }
    if (status === 'blocked') return 'bg-warning/10 text-warning'
    if (['running', 'reported', 'auditing', 'rework'].includes(status)) {
      return 'bg-info/10 text-info'
    }
    return 'bg-elevated text-muted'
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

  function taskTooltip(task: AssignmentTask, linkedWorker: Thread | undefined): string {
    const worker = workerLabel(task)
    const destination = task.threadId
      ? `Open ${linkedWorker?.title ?? worker}`
      : 'Open this task in Assignment Studio'
    return `${task.title} · ${worker} · ${statusLabel(task.status)}. ${destination}`
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
</script>

<aside
  {@attach restoreWidth}
  class="assignment-coordinator-panel absolute inset-y-0 right-0 z-10 flex min-h-0 flex-col border-l border-border bg-surface"
  class:select-none={resizing}
  style:width={`${width}px`}
  aria-label="Assignment coordinator"
>
  <button
    type="button"
    class="absolute inset-y-0 left-0 z-20 w-1.5 -translate-x-1/2 cursor-col-resize touch-none bg-transparent transition-colors hover:bg-primary/30 focus:bg-primary/30 focus:outline-none"
    title="Resize Assignment coordinator"
    aria-label="Resize Assignment coordinator"
    onpointerdown={startResize}
    onpointermove={resize}
    onpointerup={finishResize}
    onpointercancel={finishResize}
    onkeydown={resizeWithKeyboard}
  ></button>
  <header class="shrink-0 border-b border-border p-4">
    <div class="flex items-center gap-2 text-primary">
      <Network size={15} />
      <h2 class="text-xs font-semibold uppercase tracking-wide">Assignment coordinator</h2>
    </div>
    <h3 class="mt-3 text-sm font-semibold text-foreground">{assignment.content.title}</h3>
    <p class="mt-1 line-clamp-3 text-xs leading-relaxed text-muted">
      {assignment.content.summary}
    </p>
    <div class="mt-3 flex gap-2">
      <button
        type="button"
        class="flex flex-1 items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-on-primary hover:bg-primary-hover"
        title="Open the complete Assignment in Spec Studio"
        onclick={onOpenAssignment}
      >
        {#if finalComplete}
          View Assignment
        {:else}
          <span class="assignment-label-full">Review Assignment</span>
          <span class="assignment-label-short">Assignment</span>
        {/if}
        <ArrowUpRight size={13} />
      </button>
      {#if assignment.status === 'stopped'}
        <button
          type="button"
          class="flex items-center justify-center gap-1.5 rounded-lg border border-border bg-elevated px-3 py-2 text-xs font-semibold text-foreground hover:bg-overlay disabled:cursor-not-allowed disabled:opacity-60"
          title="Resume this Assignment"
          disabled={resumeBusy}
          onclick={() => void resumeStoppedAssignment()}
        >
          {#if resumeBusy}
            <Loader2 size={13} class="animate-spin" />
          {:else}
            <Play size={12} fill="currentColor" />
          {/if}
          {resumeBusy ? 'Resuming…' : 'Resume'}
        </button>
      {:else if !finalComplete}
        <button
          type="button"
          class="flex items-center justify-center gap-1.5 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs font-semibold text-danger hover:bg-danger/20"
          title="Stop the Sr. Engineer, workers, and auditor"
          aria-label="Stop the Sr. Engineer, workers, and auditor"
          onclick={() => (showStopConfirmation = true)}
        >
          <Square size={12} fill="currentColor" />
          Stop
        </button>
      {/if}
      {#if auditWorkAvailable && onOpenAuditWork}
        <button
          type="button"
          class="rounded-lg border border-border bg-elevated px-3 py-2 text-xs font-semibold text-foreground hover:bg-overlay"
          title="Open the Assignment audit work"
          onclick={onOpenAuditWork}
        >
          {auditState === 'failed' ? 'Audit Failed' : 'Audit Work'}
        </button>
      {/if}
      {#if reportAvailable && !finalComplete && onViewReport}
        <button
          type="button"
          class="rounded-lg border border-border bg-elevated px-3 py-2 text-xs font-semibold text-foreground hover:bg-overlay"
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
          <p class="text-[10px] uppercase tracking-wide text-dimmed">tasks complete</p>
        </div>
        <p class="text-xs font-medium tabular-nums text-muted">{progress}%</p>
      </div>
      <div class="mt-3 h-1.5 overflow-hidden rounded-full bg-elevated">
        <div
          class="h-full rounded-full bg-primary transition-[width]"
          style:width={`${progress}%`}
        ></div>
      </div>
      <div class="mt-3 grid grid-cols-5 gap-1 text-center">
        <div>
          <p class="text-sm font-semibold tabular-nums text-success">{completed}</p>
          <p class="text-[9px] uppercase text-dimmed">Done</p>
        </div>
        <div>
          <p class="text-sm font-semibold tabular-nums text-info">{running}</p>
          <p class="text-[9px] uppercase text-dimmed">Active</p>
        </div>
        <div>
          <p class="text-sm font-semibold tabular-nums text-warning">{blocked}</p>
          <p class="text-[9px] uppercase text-dimmed">Blocked</p>
        </div>
        <div>
          <p class="text-sm font-semibold tabular-nums text-muted">{pending}</p>
          <p class="text-[9px] uppercase text-dimmed">Pending</p>
        </div>
        <div>
          <p class="text-sm font-semibold tabular-nums text-danger">{attention}</p>
          <p class="text-[9px] uppercase text-dimmed">Attention</p>
        </div>
      </div>
    </section>

    {#if stalled}
      <section class="border-b border-border p-4" aria-label="Assignment needs direction">
        <div class="flex items-start gap-2">
          <Rows3 size={14} class="mt-0.5 shrink-0 text-warning" />
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
          class="mt-3 flex h-8 w-full items-center justify-center gap-2 rounded-lg border border-border bg-elevated px-3 text-xs font-semibold text-foreground hover:bg-overlay"
          title="Ask the Sr. Engineer to review blockers and continue coordination"
          onclick={onResume}
        >
          <Play size={12} />
          Resume coordination
        </button>
      </section>
    {/if}

    {#if auditThread && !finalComplete}
      <section class="border-b border-border py-3" aria-label="Audit thread">
        <h3 class="px-4 pb-2 text-[10px] font-semibold uppercase tracking-wide text-dimmed">
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
      <h3 class="pb-2 text-[10px] font-semibold uppercase tracking-wide text-dimmed">Tasks</h3>
      <div class="space-y-1">
        {#each assignment.content.tasks as task (task.id)}
          {@const linkedWorker = linkedThread(task.threadId)}
          {@const active = task.threadId === selectedThreadId}
          {@const reworkCycle = taskReworkCycle(task)}
          <button
            type="button"
            class="flex w-full items-start justify-between gap-2 rounded-md border-l-2 px-1 py-1.5 text-left transition-colors hover:bg-elevated {active
              ? 'border-primary bg-elevated'
              : ['attention', 'failed', 'stopped'].includes(task.status)
                ? 'border-danger bg-danger/5'
                : 'border-transparent'}"
            title={taskTooltip(task, linkedWorker)}
            aria-label={taskTooltip(task, linkedWorker)}
            aria-current={active ? 'true' : undefined}
            onclick={() => onOpenTask(task)}
          >
            <span class="min-w-0">
              <span class="flex min-w-0 items-center gap-1.5">
                <span class="min-w-0 truncate text-xs font-medium text-foreground"
                  >{task.title}</span
                >
                {#if reworkCycle}
                  <span
                    class="shrink-0 rounded bg-warning/10 px-1.5 py-0.5 text-[9px] font-semibold text-warning"
                  >
                    Rework {reworkCycle}
                  </span>
                {/if}
              </span>
              <span class="mt-0.5 block truncate text-[10px] text-dimmed">
                {workerLabel(task)}
              </span>
            </span>
            <span
              class="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium capitalize {statusClass(
                task.status
              )}"
            >
              {statusLabel(task.status)}
            </span>
          </button>
        {/each}
      </div>
    </section>
  </div>
</aside>

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
      class="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated"
      disabled={stopBusy}
      onclick={() => (showStopConfirmation = false)}
    >
      Cancel
    </button>
    <button
      type="button"
      class="flex items-center gap-2 rounded-lg bg-danger px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-danger/90 disabled:cursor-not-allowed disabled:opacity-60"
      disabled={stopBusy}
      onclick={() => void confirmStop()}
    >
      {#if stopBusy}<Loader2 size={14} class="animate-spin" />{/if}
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
