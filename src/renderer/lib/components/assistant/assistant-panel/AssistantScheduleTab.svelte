<script lang="ts">
  import Switch from '$lib/components/ui/Switch.svelte'
  import CioTrash from '@pdslng/cio-icon/CioTrash.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { reportError } from '$lib/stores/app-errors.svelte'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import { toast } from 'svelte-sonner'
  import {
    assistantIsUnnamed,
    type Assistant,
    type Thread,
    type UpdateAssistantInput
  } from '$shared/types'

  /**
   * The clock: whether the assistant runs on one at all, what it is called, when
   * it is due next, and how a slot missed while the app was closed is recovered.
   *
   * The switch never writes a schedule on its own. A cadence nobody agreed fires
   * at hours the user never chose, so turning it on holds the intent and hands the
   * user the button that agrees the clock with the agent. Turning it off does
   * write, but only behind a confirmation, because it drops the clock and its name.
   */
  interface Props {
    assistant: Assistant
    /** Whether this assistant runs on a clock at all; drives the switch. */
    scheduled: boolean
    /** Whether a cadence was actually agreed, which is what the countdown rows read. */
    scheduleAgreed: boolean
    /** The cadence line, shared with the panel header. */
    scheduleLabel: string
    nextRunLabel: string
    nextRunRelative: string | null
    missedRunPolicyLabel: string
    /** Whether the assistant has an authoring thread to agree the clock in. */
    hasKnowledgeThread: boolean
    /**
     * Every function this assistant owns, newest created first. Read from the
     * database, so a task scheduled elsewhere (Don, another window) is here too.
     */
    tasks: Thread[]
    /** Pause or resume one function's own clock, without touching its assistant. */
    onSetTaskScheduled: (task: Thread, scheduled: boolean) => Promise<void>
    /** Take every listed function off the clock in one write. */
    onPauseAll: () => Promise<void>
    /** Put every listed function back on the assistant's clock in one write. */
    onResumeAll: () => Promise<void>
    /** Delete every listed function, and with each one its runs. */
    onDeleteAll: () => Promise<void>
    /** Delete one function, and with it the runs it already made. */
    onDeleteTask: (task: Thread) => Promise<void>
    /** Whether every listed function is already off the clock. */
    allPaused: boolean
    /** One row's write is out, so its control reads as busy. */
    isTaskPending: (taskId: string) => boolean
    /** A bulk action is writing, so both bulk buttons are disabled. */
    tasksBusy: boolean
    /** Opens that thread, so an agent turn can ask for the clock. */
    onOpenKnowledgeThread: () => void
    /** One write path for the assistant record, owned by the panel. */
    onPersist: (patch: UpdateAssistantInput, failure: string) => Promise<void>
  }

  let {
    assistant,
    scheduled,
    scheduleAgreed,
    scheduleLabel,
    nextRunLabel,
    nextRunRelative,
    missedRunPolicyLabel,
    hasKnowledgeThread,
    tasks,
    onSetTaskScheduled,
    onPauseAll,
    onResumeAll,
    onDeleteAll,
    onDeleteTask,
    allPaused,
    isTaskPending,
    tasksBusy,
    onOpenKnowledgeThread,
    onPersist
  }: Props = $props()

  const assistantLabel = $derived(
    assistantIsUnnamed(assistant) ? 'your new assistant' : assistant.name
  )

  /** The user turned the clock on: the panel holds that intent until the agent agrees it. */
  let scheduleRequest = $state(false)
  /** The confirmation that stands between the user and dropping the clock. */
  let confirmOff = $state(false)
  let busy = $state(false)

  function setSwitch(next: boolean): void {
    if (next) {
      if (!scheduled) scheduleRequest = true
      return
    }
    if (scheduleRequest) {
      scheduleRequest = false
      return
    }
    if (scheduled) confirmOff = true
  }

  /** Hand the clock to the agent: it asks for the name, the cadence and the times. */
  async function scheduleWithAgent(): Promise<void> {
    if (!hasKnowledgeThread) {
      toast.error('This assistant has no behavior thread to schedule in')
      return
    }
    scheduleRequest = false
    onOpenKnowledgeThread()
    try {
      await invoke('assistant:scheduleWithAgent', assistant.id)
    } catch (error) {
      reportError(error, 'Could not start the schedule with your assistant')
    }
  }

  /** Drop the clock, once the user has been told what dropping it costs. */
  async function confirmScheduleOff(): Promise<void> {
    busy = true
    try {
      await onPersist({ scheduled: false }, 'Could not turn the schedule off')
      confirmOff = false
    } finally {
      busy = false
    }
  }

  /** Commit the name the user gives the clock. Typed, so it writes on blur. */
  function commitName(raw: string): void {
    const name = raw.trim()
    if (name === (assistant.scheduleName ?? '')) return
    void onPersist({ scheduleName: name || null }, 'Could not save the schedule name')
  }

  /** The functions whose own switch is mid-write, so one row never double-fires. */
  const pendingTasks = new SvelteSet<string>()

  /** The confirmation that stands between the user and deleting every function. */
  let confirmDeleteAll = $state(false)
  /** The one function the user asked to delete, or null while no confirmation is open. */
  let taskPendingDelete = $state<Thread | null>(null)

  /** Whether this assistant has anything to list. */
  const hasTasks = $derived(tasks.length > 0)

  /**
   * Whether one function runs on this clock. A task that never set its own flag
   * follows its assistant, and this tab only draws the list once that clock is
   * agreed, so an unset flag reads as scheduled.
   */
  function taskIsScheduled(task: Thread): boolean {
    return task.scheduled !== false
  }

  /**
   * Pausing a single function is a write to the task, not to the assistant: the
   * clock and its name stay, and only this row stops firing. Resuming clears the
   * override instead of writing `true`, so the task follows the assistant's clock
   * again and a later schedule change carries it along.
   */
  async function setTaskScheduled(task: Thread, next: boolean): Promise<void> {
    if (pendingTasks.has(task.id)) return
    pendingTasks.add(task.id)
    try {
      await onSetTaskScheduled(task, next)
    } finally {
      pendingTasks.delete(task.id)
    }
  }

  /** Bulk writes are one panel action each, so one busy flag covers both. */
  async function runBulk(action: () => Promise<void>): Promise<void> {
    confirmDeleteAll = false
    await action()
  }

  /** Delete the one function the user confirmed, then close its confirmation. */
  async function confirmDeleteTask(): Promise<void> {
    const doomed = taskPendingDelete
    if (!doomed) return
    taskPendingDelete = null
    await onDeleteTask(doomed)
  }
</script>

<div class="flex flex-col gap-2 p-3">
  <div class="flex flex-col gap-2 border border-border bg-surface p-2.5">
    <!--
      The switch sits on the section's own title, so nothing here repeats what the
      heading already says. The clock is a decision, not a readout: it is agreed
      with the agent during setup, and this tab is where the user turns it on or
      off afterwards.
    -->
    <div class="flex items-center justify-between gap-3">
      <h2 class="text-[0.875rem] font-semibold text-foreground">Schedule</h2>
      <Switch
        checked={scheduled || scheduleRequest}
        onchange={setSwitch}
        aria-label="Run this assistant on a schedule"
        title={scheduled
          ? 'Runs on the clock it agreed with you'
          : scheduleRequest
            ? 'Waiting for the clock it will agree with you'
            : 'Runs only when you ask'}
      />
    </div>
    {#if !scheduleAgreed && (scheduleRequest || scheduled)}
      <div class="flex flex-col gap-2 border-t border-border py-2">
        <p class="text-[0.6875rem] leading-relaxed text-muted">
          A clock is agreed, not typed: {assistantLabel} has to ask what you want to call it, how often
          it runs, and at what times. Nothing is scheduled until you save what it proposes.
        </p>
        <div class="flex justify-end">
          <button
            type="button"
            class="bg-primary px-2.5 py-1 text-[0.6875rem] text-on-primary transition-colors hover:bg-primary-hover"
            title="Agree this assistant's schedule with it"
            onclick={() => void scheduleWithAgent()}
          >
            Schedule with {assistantLabel}
          </button>
        </div>
      </div>
    {/if}
    {#if scheduleAgreed}
      <div class="flex items-center justify-between gap-3 border-t border-border py-1.5">
        <label class="shrink-0 text-[0.75rem] text-muted" for="assistant-schedule-name"
          >Schedule name</label
        >
        <input
          id="assistant-schedule-name"
          type="text"
          class="min-w-0 flex-1 border border-border bg-elevated px-2.5 py-1.5 text-[0.75rem] text-foreground outline-none transition-colors placeholder:text-dimmed focus-visible:ring-2 focus-visible:ring-primary"
          placeholder={assistant.name}
          title="What you call this assistant's clock"
          aria-label="Schedule name"
          value={assistant.scheduleName ?? ''}
          onchange={(event: Event) => commitName((event.currentTarget as HTMLInputElement).value)}
        />
      </div>
      <!-- The countdown is only worth its space when there is a clock to count
           down to, so these rows appear with the schedule and not before it. -->
      <dl class="flex flex-col">
        <div
          class="flex items-start justify-between gap-4 border-t border-border py-1.5 first:border-t-0"
        >
          <dt class="text-[0.75rem] text-muted">Runs</dt>
          <dd class="text-right text-[0.75rem] text-foreground">{scheduleLabel}</dd>
        </div>
        <div class="flex items-start justify-between gap-4 border-t border-border py-1.5">
          <dt class="text-[0.75rem] text-muted">Next run</dt>
          <dd class="text-right text-[0.75rem] text-foreground">
            {nextRunLabel}
            {#if nextRunRelative && nextRunRelative !== 'now'}
              <span class="ml-1 text-dimmed">{nextRunRelative}</span>
            {/if}
          </dd>
        </div>
        <div class="flex items-start justify-between gap-4 border-t border-border py-1.5">
          <dt class="text-[0.75rem] text-muted">If a run is missed</dt>
          <dd class="text-right text-[0.75rem] text-foreground">{missedRunPolicyLabel}</dd>
        </div>
      </dl>
    {/if}
  </div>

  <!--
    One switch per function, so a task that has nothing left to do can be taken
    off the clock on its own, and two bulk actions so the whole set can be paused
    or removed together. Before this, the only stops were the assistant-wide
    switch above or skipping a single slot, which meant pausing a whole teammate
    to silence one job.

    The list is every task the assistant owns, newest created first, read from the
    database: a job Don scheduled is owned by the assistant in charge and belongs
    here even though this window never opened it.
  -->
  {#if scheduleAgreed && hasTasks}
    <div class="flex flex-col gap-2 border border-border bg-surface p-2.5">
      <div class="flex items-start justify-between gap-3">
        <h2 class="text-[0.875rem] font-semibold text-foreground">What runs on this clock</h2>
        <div class="flex shrink-0 items-center gap-1">
          <button
            type="button"
            class="border border-border px-2 py-1 text-[0.6875rem] text-foreground transition-colors hover:bg-elevated disabled:opacity-50"
            disabled={tasksBusy}
            title={allPaused
              ? `Put every task of ${assistantLabel} back on this schedule`
              : `Stop running every task of ${assistantLabel} on this schedule`}
            aria-label={allPaused
              ? 'Resume the schedule for every task'
              : 'Pause the schedule for every task'}
            onclick={() => void runBulk(allPaused ? onResumeAll : onPauseAll)}
          >
            {allPaused ? 'Resume all' : 'Pause all'}
          </button>
          <button
            type="button"
            class="border border-border px-2 py-1 text-[0.6875rem] text-foreground transition-colors hover:border-error hover:text-error disabled:opacity-50"
            disabled={tasksBusy}
            title={`Delete every task of ${assistantLabel}, and the runs they already made`}
            aria-label="Delete every task and its runs"
            onclick={() => {
              confirmDeleteAll = true
            }}
          >
            Delete all
          </button>
        </div>
      </div>
      <p class="text-[0.6875rem] leading-relaxed text-muted">
        Every function below runs on the schedule above unless you pause it. Pausing one keeps the
        schedule and the rest of {assistantLabel}'s work exactly as they are.
      </p>
      {#each tasks as entry (entry.id)}
        <div
          class="flex items-center justify-between gap-3 border-t border-border py-1.5"
          title={taskIsScheduled(entry) ? 'Runs on this schedule' : 'Runs only when you ask'}
        >
          <span class="min-w-0 flex-1 truncate text-[0.75rem] text-foreground" title={entry.title}
            >{entry.title}</span
          >
          {#if !taskIsScheduled(entry)}
            <span class="shrink-0 text-[0.6875rem] text-dimmed">Paused</span>
          {/if}
          <Switch
            checked={taskIsScheduled(entry)}
            disabled={tasksBusy || pendingTasks.has(entry.id) || isTaskPending(entry.id)}
            onchange={(next: boolean) => void setTaskScheduled(entry, next)}
            aria-label={taskIsScheduled(entry)
              ? `Pause the schedule for ${entry.title}`
              : `Resume the schedule for ${entry.title}`}
            title={taskIsScheduled(entry)
              ? `Stop running ${entry.title} on this schedule`
              : `Run ${entry.title} on this schedule again`}
          />
          <button
            type="button"
            class="flex size-6 shrink-0 items-center justify-center text-dimmed transition-colors hover:text-error disabled:opacity-50"
            disabled={tasksBusy || isTaskPending(entry.id)}
            title={`Delete ${entry.title}, and the runs it already made`}
            aria-label={`Delete ${entry.title}`}
            onclick={() => {
              taskPendingDelete = entry
            }}
          >
            <CioTrash size={13} aria-hidden="true" />
          </button>
        </div>
      {/each}
    </div>
  {/if}
</div>

<ConfirmDialog
  open={confirmOff}
  title="Turn the schedule off"
  confirmLabel="Turn it off"
  {busy}
  onCancel={() => (confirmOff = false)}
  onConfirm={confirmScheduleOff}
>
  <p>
    Turning the schedule off drops the clock and its name. {assistantLabel} will only run when you ask,
    and putting it back on a clock means agreeing a new one with it.
  </p>
</ConfirmDialog>

<ConfirmDialog
  open={taskPendingDelete !== null}
  title="Delete this task"
  confirmLabel="Delete it"
  onCancel={() => (taskPendingDelete = null)}
  onConfirm={() => void confirmDeleteTask()}
>
  <p>
    This deletes {taskPendingDelete?.title ?? 'this task'}, and every run it already made. The
    assistant, its behavior and the rest of its tasks stay.
  </p>
</ConfirmDialog>

<ConfirmDialog
  open={confirmDeleteAll}
  title="Delete every task"
  confirmLabel="Delete them all"
  busy={tasksBusy}
  onCancel={() => (confirmDeleteAll = false)}
  onConfirm={() => void runBulk(onDeleteAll)}
>
  <p>
    This deletes all {tasks.length} tasks of {assistantLabel}, and every run they already made. The
    assistant, its behavior and its schedule stay; only the jobs it runs go.
  </p>
</ConfirmDialog>
