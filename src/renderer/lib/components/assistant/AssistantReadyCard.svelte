<script lang="ts">
  import CioCheck from '@pdslng/cio-icon/CioCheck.svelte'
  import CardFrame from '../shared/CardFrame.svelte'
  import CardHead from '../shared/CardHead.svelte'
  import CardFoot from '../shared/CardFoot.svelte'
  import CardButton from '../shared/CardButton.svelte'
  import type { CardChipData } from '../shared/CardTimer.svelte'
  import { formatDateTime } from '$shared/date-time-format'
  import { describeRelativeTime } from '$shared/types/schedule'
  import { relativeTimeClock } from '$lib/relative-time.svelte'
  import { threadCardFold } from '$lib/stores/thread-card-fold.svelte'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'

  interface Props {
    threadId: string
    active?: boolean
    /**
     * Whether this assistant runs on a clock. A scheduled assistant's card states
     * its next fire and offers "Run now"; an on-demand one states "Ready" alone,
     * because there is no next run to name.
     */
    scheduled: boolean
    /** Next intended fire (epoch ms) when scheduled, else null. */
    nextRunAt: number | null
    /** A manual run is being dispatched, so the action cannot be repeated. */
    running?: boolean
    onModify: () => void
    onStartTask: () => void
    onRunNow: () => void
  }

  let {
    threadId,
    active = true,
    scheduled,
    nextRunAt,
    running = false,
    onModify,
    onStartTask,
    onRunNow
  }: Props = $props()

  const fold = {
    get folded(): boolean {
      return threadCardFold.isFolded(threadId, 'assistant-ready')
    },
    set folded(value: boolean) {
      threadCardFold.setFolded(threadId, 'assistant-ready', value)
    }
  }

  /** Keep the shared relative-age clock live while the card is on screen, so the
   *  next fire counts down with every other relative label in the app. */
  $effect(() => relativeTimeClock.hold())

  /**
   * The card's reading. A scheduled assistant states when it will next fire, so
   * its card is visibly different from an on-demand assistant's, which has no
   * clock at all and only reports that it is ready.
   */
  const chip = $derived.by((): CardChipData => {
    if (!scheduled) {
      return {
        text: 'Ready',
        tone: 'paused',
        title: 'This assistant runs only when you ask it to'
      }
    }
    if (nextRunAt === null) {
      return {
        text: 'Ready',
        tone: 'default',
        title: 'This assistant is scheduled but paused, so nothing fires'
      }
    }
    return {
      text: `Next run ${describeRelativeTime(nextRunAt, relativeTimeClock.now)}`,
      title: `Next scheduled run: ${formatDateTime(nextRunAt)}`
    }
  })
</script>

<svelte:window
  onkeydown={(event) => {
    if (
      active &&
      !event.defaultPrevented &&
      keymapState.matches('assistant-setup-primary-action', event)
    ) {
      event.preventDefault()
      onStartTask()
    }
  }}
/>

<CardFrame placement="replace" label="Assistant setup complete">
  <CardHead
    icon={CioCheck}
    title="Assistant has learned how to work for you"
    {chip}
    bind:folded={fold.folded}
    foldLabel="assistant setup complete"
  />
  {#if !fold.folded}
    <p class="px-3 py-3 text-xs text-muted">
      Do you want to make any changes, or do you want to start a task?
    </p>
    <CardFoot>
      {#snippet left()}
        <CardButton label="Modify behavior" title="Modify assistant behavior" onclick={onModify} />
      {/snippet}
      {#snippet right()}
        <!-- A scheduled assistant offers the immediate run as its one truthy
             action, with starting an interactive task kept quieter beside it:
             the clock will fire on its own, so the user's choice here is
             whether to wait for it or run one now. -->
        <CardButton
          variant={scheduled ? 'secondary' : 'primary'}
          label="Start a task"
          onclick={onStartTask}
        />
        {#if scheduled}
          <CardButton
            label="Run now"
            title="Run a task now without waiting for the schedule"
            variant="primary"
            loading={running}
            disabled={running}
            onclick={onRunNow}
          />
        {/if}
      {/snippet}
    </CardFoot>
  {/if}
</CardFrame>
