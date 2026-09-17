<script lang="ts">
  import { slide } from 'svelte/transition'
  import type { AgentRateLimitWindow } from '$shared/types'
  import {
    compactCount,
    formatResetCountdown,
    overageLabel,
    quotaPercent,
    readableStatus,
    sortRateLimitWindows
  } from '$lib/format/usage'

  /** Visual scale. `popover` matches the conversation usage panel, `table`
   *  matches the denser Harness settings Accounts table cells. */
  type UsageWindowVariant = 'popover' | 'table'

  interface Props {
    /** Quota windows for one account. Render order is normalized internally:
     *  shortest rolling window first (5-hour → daily → weekly → monthly), with
     *  model-scoped limits such as Codex Spark kept next to their base window. */
    limits: readonly AgentRateLimitWindow[]
    /** Prefer `12k of 50k left` over `76% used` when raw amounts are reported. */
    preferAmount?: boolean
    variant?: UsageWindowVariant
    /** Extra classes for the list wrapper. */
    class?: string
  }

  let { limits, preferAmount = false, variant = 'popover', class: className = '' }: Props = $props()

  const windows = $derived(sortRateLimitWindows(limits))

  const scales: Record<
    UsageWindowVariant,
    { wrapper: string; label: string; detail: string; note: string }
  > = {
    popover: {
      wrapper: 'space-y-2.5',
      label: 'text-[0.625rem]',
      detail: 'text-[0.625rem] text-dimmed',
      note: 'text-[0.5625rem] text-dimmed'
    },
    table: {
      wrapper: 'space-y-2',
      label: 'text-[0.6875rem]',
      detail: 'text-[0.6875rem] font-medium text-foreground',
      note: 'text-[0.625rem] text-dimmed'
    }
  }

  let scale = $derived(scales[variant])

  /** The single right-aligned figure that answers "how much is left": the used
   *  percentage when the provider reports one, otherwise raw amounts or the
   *  provider's access status. */
  function windowDetail(limit: AgentRateLimitWindow): string {
    const percent = quotaPercent(limit)
    const amount =
      limit.remaining !== undefined && limit.limit !== undefined
        ? `${compactCount(limit.remaining)} of ${compactCount(limit.limit)} left`
        : undefined
    if (preferAmount && amount) return amount
    if (percent !== undefined) return `${Math.round(percent)}% used`
    if (amount) return amount
    return readableStatus(limit.status)
  }
</script>

<div class="{scale.wrapper} {className}">
  {#each windows as limit (limit.id)}
    {@const percent = quotaPercent(limit)}
    {@const overage = overageLabel(limit)}
    <div transition:slide={{ duration: 300 }} class="overflow-hidden">
      <div class="mb-1 flex items-center justify-between gap-3">
        <span class="min-w-0 truncate font-medium text-muted {scale.label}" title={limit.label}>
          {limit.label}
        </span>
        <span class="shrink-0 tabular-nums {scale.detail}">{windowDetail(limit)}</span>
      </div>
      {#if percent !== undefined}
        <div
          class="h-1.5 overflow-hidden rounded-full bg-overlay"
          role="progressbar"
          aria-label={`${limit.label} usage`}
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow={Math.round(percent)}
        >
          <div
            class="h-full rounded-full bg-info transition-[width] duration-700 ease-out"
            style={`width: ${percent}%`}
          ></div>
        </div>
      {/if}
      <p class="mt-1 {scale.note}">{formatResetCountdown(limit.resetsAt)}</p>
      {#if overage}
        <p class="mt-0.5 {scale.note}">{overage}</p>
      {/if}
    </div>
  {/each}
</div>
