<script lang="ts">
  import { Archive, BatteryMedium, Loader2 } from '@lucide/svelte'
  import type { AgentContextUsage, AgentRateLimitWindow } from '$shared/types'

  interface Props {
    usage?: AgentContextUsage
    canCompact?: boolean
    compacting?: boolean
    onCompact?: () => void
    /** Called when the user hovers the indicator to flush the latest usage. */
    onReveal?: () => void
  }

  let { usage, canCompact = false, compacting = false, onCompact, onReveal }: Props = $props()

  const boundedPercent = $derived(
    usage?.contextPercent === undefined
      ? undefined
      : Math.max(0, Math.min(100, usage.contextPercent))
  )
  const fillClass = $derived(
    boundedPercent === undefined
      ? 'bg-overlay'
      : boundedPercent >= 90
        ? 'bg-danger'
        : boundedPercent >= 70
          ? 'bg-warning'
          : 'bg-success'
  )
  const iconClass = $derived(
    boundedPercent === undefined
      ? 'text-dimmed'
      : boundedPercent >= 90
        ? 'text-danger'
        : boundedPercent >= 70
          ? 'text-warning'
          : 'text-success'
  )
  const percentLabel = $derived(
    boundedPercent === undefined ? '' : `${Math.round(boundedPercent)}%`
  )

  function compactNumber(value: number): string {
    const absolute = Math.abs(value)
    if (absolute < 1_000) return Math.round(value).toLocaleString()
    const divisor = absolute >= 1_000_000 ? 1_000_000 : 1_000
    const suffix = divisor === 1_000_000 ? 'm' : 'k'
    const scaled = value / divisor
    const precision = Math.abs(scaled) < 100 ? 1 : 0
    return `${scaled.toFixed(precision).replace(/\.0$/, '')}${suffix}`
  }

  function formatMoney(value: number): string {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: value > 0 && value < 0.01 ? 4 : 2,
      maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2
    }).format(value)
  }

  function formatReset(value: number | undefined): string {
    if (!value) return 'Reset time unavailable'
    const now = Date.now()
    if (value > now) {
      const minutes = Math.max(1, Math.round((value - now) / 60_000))
      const duration =
        minutes >= 1_440
          ? `${Math.round(minutes / 1_440)}d ${Math.round((minutes % 1_440) / 60)}h`
          : minutes >= 60
            ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
            : `${minutes}m`
      return `Resets in ${duration}`
    }
    return `Resets ${new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    }).format(value)}`
  }

  function readableStatus(value: string | undefined): string {
    if (!value) return 'Status unavailable'
    const normalized = value.replaceAll('_', ' ')
    return normalized.charAt(0).toUpperCase() + normalized.slice(1)
  }

  function quotaPercent(limit: AgentRateLimitWindow): number | undefined {
    const reported = limit.usedPercent
    const calculated =
      limit.remaining !== undefined && limit.limit !== undefined && limit.limit > 0
        ? ((limit.limit - limit.remaining) / limit.limit) * 100
        : undefined
    const percent = reported ?? calculated
    return percent === undefined ? undefined : Math.max(0, Math.min(100, percent))
  }

  function overageLabel(limit: AgentRateLimitWindow): string | undefined {
    if (limit.isUsingOverage) return 'Using extra usage'
    if (!limit.overageStatus && !limit.overageDisabledReason) return undefined
    const status = limit.overageStatus
      ? `Extra usage: ${readableStatus(limit.overageStatus).toLowerCase()}`
      : 'Extra usage unavailable'
    return limit.overageDisabledReason
      ? `${status} · ${readableStatus(limit.overageDisabledReason).toLowerCase()}`
      : status
  }

  function creditsLine(usage: AgentContextUsage): string | undefined {
    const credits = usage.credits
    if (!credits) return undefined
    if (credits.unlimited) return 'Unlimited'
    if (credits.balance !== undefined) return `${formatMoney(credits.balance)} credits`
    if (credits.hasCredits) return 'Credits active'
    return undefined
  }
</script>

<div class="group relative">
  <button
    type="button"
    class="flex h-8 items-center gap-1.5 rounded-lg px-1.5 text-dimmed hover:bg-elevated hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
    onmouseenter={onReveal}
    aria-label={boundedPercent === undefined
      ? 'Context usage unavailable'
      : `Context ${Math.round(boundedPercent)}% used`}
    title="Context and usage"
  >
    <span class="relative h-3 w-7 rounded-sm border border-current p-0.5" aria-hidden="true">
      <span
        class={`block h-full rounded-[1px] ${fillClass}`}
        style={`width: ${boundedPercent ?? 0}%`}
      ></span>
      <span class="absolute -right-1 top-[3px] h-1.5 w-0.5 rounded-r bg-current"></span>
    </span>
    <span class="context-usage-label tabular-nums text-[10px]">{percentLabel}</span>
  </button>

  <div
    class="invisible absolute bottom-8 right-0 z-40 w-72 rounded-xl border border-border bg-surface p-3 opacity-0 shadow-lg group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100"
    role="dialog"
    aria-label="Context and provider usage"
  >
    <div class="flex items-start justify-between gap-3">
      <div>
        <p class="text-xs font-semibold text-foreground">Usage</p>
        <p class="mt-0.5 text-[10px] text-dimmed">
          {usage && usage.costUsd > 0 ? `${formatMoney(usage.costUsd)} spent` : 'Cost not reported'}
        </p>
      </div>
      <div class="flex items-center gap-2">
        {#if usage && creditsLine(usage)}
          <span class="rounded-md bg-elevated px-1.5 py-0.5 text-[9px] font-medium text-muted">
            {creditsLine(usage)}
          </span>
        {/if}
        <BatteryMedium size={15} class={iconClass} />
      </div>
    </div>

    {#if usage && usage.rateLimits.length > 0}
      <div class="mt-3 space-y-2.5 border-t border-border pt-3">
        {#each usage.rateLimits as limit (limit.id)}
          {@const percent = quotaPercent(limit)}
          {@const overage = overageLabel(limit)}
          <div>
            <div class="mb-1 flex items-center justify-between gap-3 text-[10px]">
              <span class="font-medium text-muted">{limit.label}</span>
              <span class="tabular-nums text-dimmed">
                {#if limit.remaining !== undefined && limit.limit !== undefined}
                  {compactNumber(limit.remaining)} of {compactNumber(limit.limit)} left
                {:else if percent !== undefined}
                  {Math.round(percent)}% used
                {:else}
                  {readableStatus(limit.status)}
                {/if}
              </span>
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
                <div class="h-full rounded-full bg-info" style={`width: ${percent}%`}></div>
              </div>
            {/if}
            <p class="mt-1 text-[9px] text-dimmed">{formatReset(limit.resetsAt)}</p>
            {#if overage}
              <p class="mt-0.5 text-[9px] text-dimmed">{overage}</p>
            {/if}
          </div>
        {/each}
      </div>
    {/if}

    <div class="mt-3 border-t border-border pt-3">
      <div class="mb-1 flex items-center justify-between gap-3 text-[10px]">
        <span class="font-medium text-muted">Context (latest request)</span>
        <span class="tabular-nums text-dimmed">
          {usage ? compactNumber(usage.contextUsed) : 'Unavailable'}
          {#if usage?.contextWindow}
            / {compactNumber(usage.contextWindow)}
          {/if}
        </span>
      </div>
      <div
        class="h-1.5 overflow-hidden rounded-full bg-overlay"
        role="progressbar"
        aria-label="Context used"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={Math.round(boundedPercent ?? 0)}
      >
        <div class={`h-full rounded-full ${fillClass}`} style={`width: ${boundedPercent}%`}></div>
      </div>
      {#if usage?.contextWindow}
        <div class="mt-2 grid grid-cols-3 gap-2 text-[9px] text-dimmed">
          <span>Used {compactNumber(usage.contextUsed)}</span>
          <span
            >Available {compactNumber(Math.max(0, usage.contextWindow - usage.contextUsed))}</span
          >
          <span>Window {compactNumber(usage.contextWindow)}</span>
        </div>
      {/if}
      <div class="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[9px] text-dimmed">
        <span>Input {usage ? compactNumber(usage.tokens.input) : 'Unavailable'}</span>
        <span>Output {usage ? compactNumber(usage.tokens.output) : 'Unavailable'}</span>
        <span>Reasoning {usage ? compactNumber(usage.tokens.reasoning) : 'Unavailable'}</span>
        <span
          >Cache {usage
            ? compactNumber(usage.tokens.cacheRead + usage.tokens.cacheWrite)
            : 'Unavailable'}</span
        >
      </div>

      <button
        type="button"
        class="mt-3 flex h-8 w-full items-center justify-center gap-2 rounded-lg border border-border text-[11px] font-medium text-foreground hover:bg-elevated disabled:cursor-not-allowed disabled:text-dimmed"
        disabled={!canCompact || compacting}
        title={canCompact
          ? 'Summarize older work to free context'
          : 'This agent does not support manual compaction'}
        onclick={onCompact}
      >
        {#if compacting}
          <Loader2 size={12} class="animate-spin" />
          Compacting…
        {:else}
          <Archive size={12} />
          Compact Work
        {/if}
      </button>
    </div>
  </div>
</div>

<style>
  @container (max-width: 520px) {
    .context-usage-label {
      display: none;
    }
  }
</style>
