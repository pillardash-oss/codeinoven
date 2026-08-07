<script lang="ts">
  import { Archive, BatteryMedium, ChevronDown, ChevronRight, Loader2 } from '@lucide/svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import AgentIcon from '$lib/agent-icons/AgentIcon.svelte'
  import { getAgentIcon } from '$lib/agent-icons/registry'
  import type {
    AgentContextUsage,
    AgentHarnessUsage,
    AgentRateLimitWindow,
    HarnessModelUsage
  } from '$shared/types'

  interface Props {
    usage?: AgentContextUsage
    /** Per-harness quota telemetry when a thread used more than one harness. */
    harnessUsage?: AgentHarnessUsage[]
    canCompact?: boolean
    compacting?: boolean
    onCompact?: () => void
    /** Called when the user hovers the indicator to flush the latest usage. */
    onReveal?: () => void
  }

  let {
    usage,
    harnessUsage = [],
    canCompact = false,
    compacting = false,
    onCompact,
    onReveal
  }: Props = $props()

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
  const multiHarness = $derived(harnessUsage.length > 1)

  /** Collapsed harness sections — sections are open by default. */
  const collapsedHarnesses = new SvelteSet<string>()
  function toggleHarness(id: string): void {
    if (collapsedHarnesses.has(id)) collapsedHarnesses.delete(id)
    else collapsedHarnesses.add(id)
  }

  function harnessKey(entry: AgentHarnessUsage): string {
    return `${entry.harnessId}:${entry.providerId}`
  }

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
    const date = new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    }).format(value)
    const now = Date.now()
    if (value <= now) return `Reset ${date}`
    const minutes = Math.max(1, Math.round((value - now) / 60_000))
    const duration =
      minutes >= 1_440
        ? `${Math.round(minutes / 1_440)}d ${Math.round((minutes % 1_440) / 60)}h`
        : minutes >= 60
          ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
          : `${minutes}m`
    return `Resets in ${duration} · ${date}`
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

  function creditsLine(usage: AgentContextUsage | AgentHarnessUsage): string | undefined {
    const credits = usage.credits
    if (!credits) return undefined
    if (credits.unlimited) return 'Unlimited'
    if (credits.balance !== undefined) return `${formatMoney(credits.balance)} credits`
    if (credits.hasCredits) return 'Credits active'
    return undefined
  }
</script>

{#snippet limitRows(limits: AgentRateLimitWindow[])}
  {#each limits as limit (limit.id)}
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
{/snippet}

{#snippet modelRows(models: HarnessModelUsage[])}
  <div class="rounded-md border border-border bg-app/40 p-2">
    <p class="mb-1.5 text-[9px] font-semibold uppercase tracking-wide text-muted">Models used</p>
    {#each models as model (`${model.providerId}:${model.modelId}`)}
      <div class="flex items-baseline justify-between gap-3 py-0.5 text-[10px]">
        <span class="flex min-w-0 items-baseline gap-1.5">
          <span class="truncate font-medium text-foreground">{model.modelId}</span>
          {#if model.providerId && model.providerId !== model.modelId}
            <span class="shrink-0 text-[9px] text-dimmed">via {model.providerId}</span>
          {/if}
        </span>
        <span class="shrink-0 tabular-nums text-dimmed">
          {model.costUsd > 0
            ? `${formatMoney(model.costUsd)} · ${compactNumber(model.tokens.total)} tok`
            : `${compactNumber(model.tokens.total)} tok`}
        </span>
      </div>
    {/each}
  </div>
{/snippet}

{#snippet harnessSection(entry: AgentHarnessUsage)}
  {@const key = harnessKey(entry)}
  {@const collapsed = collapsedHarnesses.has(key)}
  {@const icon = getAgentIcon(entry.harnessId)}
  {@const name = icon?.name ?? entry.harnessId}
  <div class="overflow-hidden rounded-lg border border-border bg-elevated">
    <button
      type="button"
      class="flex h-9 w-full items-center gap-1.5 rounded-lg px-2 text-left transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
      aria-expanded={!collapsed}
      title={collapsed ? `Expand ${name} quota` : `Collapse ${name} quota`}
      onclick={() => toggleHarness(key)}
    >
      {#if collapsed}
        <ChevronRight size={13} class="shrink-0 text-dimmed" />
      {:else}
        <ChevronDown size={13} class="shrink-0 text-dimmed" />
      {/if}
      <AgentIcon agentId={entry.harnessId} size={16} />
      <span class="min-w-0 truncate text-[10px] font-medium text-foreground">{name}</span>
      <span class="ml-auto shrink-0 tabular-nums text-[10px] text-dimmed">
        {entry.costUsd > 0 ? `${formatMoney(entry.costUsd)} consumed` : 'Cost not reported'}
      </span>
    </button>
    {#if !collapsed}
      <div class="space-y-2.5 px-2.5 pb-2.5">
        {#if entry.tokens && entry.tokens.total > 0}
          <p class="text-[9px] text-dimmed">
            Consumed {compactNumber(entry.tokens.total)} tokens
            {#if entry.messageCount}
              · {entry.messageCount} turn{entry.messageCount === 1 ? '' : 's'}
            {/if}
          </p>
        {/if}
        {#if entry.models?.length}
          {@render modelRows(entry.models)}
        {/if}
        {#if entry.rateLimits.length > 0}
          {@render limitRows(entry.rateLimits)}
        {:else if !creditsLine(entry) && !entry.tokens && !entry.models?.length}
          <p class="text-[10px] text-dimmed">No quota reported for this harness.</p>
        {/if}
        {#if creditsLine(entry)}
          <p class="text-[9px] text-dimmed">Credits: {creditsLine(entry)}</p>
        {/if}
      </div>
    {/if}
  </div>
{/snippet}

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

    {#if multiHarness}
      <div
        class="mt-3 max-h-64 space-y-2 overflow-y-auto border-t border-border pt-3"
        aria-label="Per-harness quota"
      >
        {#each harnessUsage as entry (harnessKey(entry))}
          {@render harnessSection(entry)}
        {/each}
      </div>
    {:else if usage && usage.rateLimits.length > 0}
      <div class="mt-3 space-y-2.5 border-t border-border pt-3">
        {#if harnessUsage[0]?.models?.length}
          {@render modelRows(harnessUsage[0].models)}
        {/if}
        {@render limitRows(usage.rateLimits)}
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
