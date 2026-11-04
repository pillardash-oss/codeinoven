<script lang="ts">
  import Switch from '$lib/components/ui/Switch.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { reportError } from '$lib/stores/app-errors.svelte'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import { toast } from 'svelte-sonner'
  import { assistantIsUnnamed, type Assistant, type UpdateAssistantInput } from '$shared/types'

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
