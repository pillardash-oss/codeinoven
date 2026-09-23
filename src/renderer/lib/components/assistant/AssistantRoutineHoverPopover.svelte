<script lang="ts">
  import { AlertTriangle, Clock, Link2, ListChecks, Sparkles } from '@lucide/svelte'
  import { describeSchedule, type Routine } from '$shared/types'
  import { routineGap } from './assistant-view'

  interface Props {
    routine: Routine
    taskCount: number
    /** True while any task in this routine is running. */
    working: boolean
    /** Any task carries a pending missed run. */
    missed: boolean
    /** Next intended fire for the routine, or null when unscheduled. */
    nextRunAt: number | null
  }

  let { routine, taskCount, working, missed, nextRunAt }: Props = $props()

  const incomplete = $derived(routineGap(routine) !== null)
  const gapLabel = $derived(routineGap(routine) ?? '')
  const scheduleLabel = $derived(describeSchedule(routine.schedule ?? null))
  const scheduleAt = $derived(
    nextRunAt === null
      ? null
      : `Next ${new Date(nextRunAt).toLocaleString(undefined, {
          dateStyle: 'medium',
          timeStyle: 'short'
        })}`
  )
  const howToPreview = $derived.by(() => {
    const text = routine.howTo.trim().replace(/\s+/g, ' ')
    if (text.length === 0) return 'No how-to written yet.'
    return text.length > 180 ? `${text.slice(0, 180)}…` : text
  })
  const description = $derived(routine.description?.trim() ?? '')

  const statusLabel = $derived(
    routine.paused
      ? 'Paused'
      : incomplete
        ? gapLabel
        : missed
          ? 'Missed run'
          : working
            ? 'Working'
            : nextRunAt
              ? 'Scheduled'
              : 'Ready'
  )
  const statusColor = $derived(
    routine.paused
      ? 'var(--color-warning)'
      : incomplete
        ? 'var(--color-warning)'
        : missed
          ? 'var(--color-missed)'
          : working
            ? 'var(--color-thread-working)'
            : 'var(--color-dimmed)'
  )
</script>

<p class="mb-2 break-words text-sm font-medium text-foreground">{routine.name}</p>
{#if description}
  <p class="mb-2 break-words text-[0.6875rem] leading-relaxed text-muted">{description}</p>
{/if}
<dl class="space-y-1.5 text-[0.6875rem]">
  <div class="flex gap-2">
    <dt class="w-16 shrink-0 text-dimmed">Status</dt>
    <dd class="flex min-w-0 items-center gap-1 text-muted">
      {#if incomplete || missed}
        <AlertTriangle size={12} style="color: {statusColor}" />
      {:else}
        <span class="h-1.5 w-1.5 shrink-0 rounded-full" style="background: {statusColor}"></span>
      {/if}
      <span class="min-w-0 break-words" style="color: {statusColor}">{statusLabel}</span>
    </dd>
  </div>
  <div class="flex gap-2">
    <dt class="w-16 shrink-0 text-dimmed">Type</dt>
    <dd class="flex min-w-0 items-center gap-1 text-muted">
      <Clock size={12} class="shrink-0" />
      <span class="min-w-0 break-words">{scheduleLabel}</span>
    </dd>
  </div>
  {#if scheduleAt}
    <div class="flex gap-2">
      <dt class="w-16 shrink-0 text-dimmed">Next run</dt>
      <dd class="flex min-w-0 items-center gap-1 text-muted">
        <Sparkles size={12} class="shrink-0" />
        <span class="min-w-0 break-words">{scheduleAt}</span>
      </dd>
    </div>
  {/if}
  <div class="flex gap-2">
    <dt class="w-16 shrink-0 text-dimmed">Tasks</dt>
    <dd class="flex min-w-0 items-center gap-1 text-muted">
      <ListChecks size={12} class="shrink-0" />
      <span>{taskCount === 1 ? '1 task' : `${taskCount} tasks`}</span>
    </dd>
  </div>
  <div class="flex gap-2">
    <dt class="w-16 shrink-0 text-dimmed">How to</dt>
    <dd class="flex min-w-0 items-start gap-1 text-muted">
      <Link2 size={12} class="mt-0.5 shrink-0" />
      <span class="min-w-0 break-words">{howToPreview}</span>
    </dd>
  </div>
</dl>
