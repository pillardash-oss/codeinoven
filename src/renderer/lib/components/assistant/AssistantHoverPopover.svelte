<script lang="ts">
  import CioAttention from 'cio-icon/CioAttention.svelte'
  import CioCalendarClock from 'cio-icon/CioCalendarClock.svelte'
  import CioCalendarPlus from 'cio-icon/CioCalendarPlus.svelte'
  import CioClock from 'cio-icon/CioClock.svelte'
  import CioLink from 'cio-icon/CioLink.svelte'
  import CioSparkles from 'cio-icon/CioSparkles.svelte'
  import CioUndo from 'cio-icon/CioUndo.svelte'
  import { formatDateTime } from '$shared/date-time-format'
  import { describeSchedule, assistantIsScheduled, type Assistant } from '$shared/types'
  import { assistantGap } from './assistant-view'

  interface Props {
    assistant: Assistant
    /** How many times this assistant has run. The Getting started host is an
     *  authoring thread, not an execution, so it is never counted. */
    runCount: number
    /** True while any task in this assistant is running. */
    working: boolean
    /** At least one task or run waits on the user or has failed. */
    attention?: boolean
    /** Any task carries a pending missed run. */
    missed: boolean
    /** Next intended fire for the assistant, or null when unscheduled. */
    nextRunAt: number | null
  }

  let { assistant, runCount, working, missed, nextRunAt, attention = false }: Props = $props()

  const incomplete = $derived(assistantGap(assistant) !== null)
  const gapLabel = $derived(assistantGap(assistant) ?? '')
  const scheduled = $derived(assistantIsScheduled(assistant))
  const scheduleLabel = $derived(
    scheduled ? describeSchedule(assistant.schedule ?? null) : 'Runs on demand'
  )
  const scheduleAt = $derived(
    !scheduled || nextRunAt === null ? null : `Next ${formatDateTime(nextRunAt)}`
  )
  const knowledgePreview = $derived.by(() => {
    const text = assistant.knowledge.trim().replace(/\s+/g, ' ')
    if (text.length === 0) return 'No knowledge written yet.'
    return text.length > 180 ? `${text.slice(0, 180)}…` : text
  })
  const description = $derived(assistant.description?.trim() ?? '')
  const createdLabel = $derived(formatDateTime(assistant.createdAt))
  const updatedLabel = $derived(formatDateTime(assistant.updatedAt))

  const statusLabel = $derived(
    assistant.paused
      ? 'Paused'
      : incomplete
        ? gapLabel
        : !scheduled
          ? 'On demand'
          : attention
            ? 'Needs attention'
            : missed
              ? 'Missed run'
              : working
                ? 'Working'
                : nextRunAt
                  ? 'Scheduled'
                  : 'Ready'
  )
  const statusColor = $derived(
    assistant.paused
      ? 'var(--color-warning)'
      : incomplete
        ? 'var(--color-warning)'
        : attention
          ? 'var(--color-warning)'
          : missed
            ? 'var(--color-missed)'
            : working
              ? 'var(--color-thread-working)'
              : 'var(--color-dimmed)'
  )
</script>

<p class="mb-2 break-words text-sm font-medium text-foreground">{assistant.name}</p>
{#if description}
  <p class="mb-2 break-words text-[0.6875rem] leading-relaxed text-muted">{description}</p>
{/if}
<dl class="space-y-1.5 text-[0.6875rem]">
  <div class="flex gap-2">
    <dt class="w-16 shrink-0 text-dimmed">Status</dt>
    <dd class="flex min-w-0 items-center gap-1 text-muted">
      {#if incomplete || missed || attention}
        <CioAttention size={12} style="color: {statusColor}" />
      {:else}
        <span class="h-1.5 w-1.5 shrink-0" style="background: {statusColor}"></span>
      {/if}
      <span class="min-w-0 break-words" style="color: {statusColor}">{statusLabel}</span>
    </dd>
  </div>
  <div class="flex gap-2">
    <dt class="w-16 shrink-0 text-dimmed">Type</dt>
    <dd class="flex min-w-0 items-center gap-1 text-muted">
      <CioClock size={12} class="shrink-0" />
      <span class="min-w-0 break-words">{scheduleLabel}</span>
    </dd>
  </div>
  {#if scheduleAt}
    <div class="flex gap-2">
      <dt class="w-16 shrink-0 text-dimmed">Next run</dt>
      <dd class="flex min-w-0 items-center gap-1 text-muted">
        <CioSparkles size={12} class="shrink-0" />
        <span class="min-w-0 break-words">{scheduleAt}</span>
      </dd>
    </div>
  {/if}
  <div class="flex gap-2">
    <dt class="w-16 shrink-0 text-dimmed">Runs</dt>
    <dd class="flex min-w-0 items-center gap-1 text-muted">
      <CioUndo size={12} class="shrink-0" />
      <span>{runCount === 1 ? '1 run' : `${runCount} runs`}</span>
    </dd>
  </div>
  <div class="flex gap-2">
    <dt class="w-16 shrink-0 text-dimmed">Knows</dt>
    <dd class="flex min-w-0 items-start gap-1 text-muted">
      <CioLink size={12} class="mt-0.5 shrink-0" />
      <span class="min-w-0 break-words">{knowledgePreview}</span>
    </dd>
  </div>
  <div class="flex gap-2">
    <dt class="w-16 shrink-0 text-dimmed">Created</dt>
    <dd class="flex min-w-0 items-center gap-1 text-muted">
      <CioCalendarPlus size={12} class="shrink-0" />
      <span class="min-w-0 break-words">{createdLabel}</span>
    </dd>
  </div>
  <div class="flex gap-2">
    <dt class="w-16 shrink-0 text-dimmed">Updated</dt>
    <dd class="flex min-w-0 items-center gap-1 text-muted">
      <CioCalendarClock size={12} class="shrink-0" />
      <span class="min-w-0 break-words">{updatedLabel}</span>
    </dd>
  </div>
</dl>
