<script lang="ts">
  import { onMount } from 'svelte'
  import { SvelteDate } from 'svelte/reactivity'
  import { RefreshCw } from '@lucide/svelte'
  import type { AccountUsageBreakdown, AccountUsageSummary } from '$shared/types'
  import { invoke } from '$lib/ipc.svelte'

  interface CalendarDay {
    date: string
    count: number
    future: boolean
  }

  interface CalendarWeek {
    days: CalendarDay[]
    monthLabel: string
  }

  const EMPTY_USAGE: AccountUsageSummary = {
    messageCount: 0,
    costUsd: 0,
    tokens: 0,
    durationMs: 0,
    topHarnessId: null,
    topModelId: null,
    harnesses: [],
    models: [],
    activityDays: [],
    generatedAt: 0
  }

  let usage = $state<AccountUsageSummary>(EMPTY_USAGE)
  let loading = $state(true)
  let errorMessage = $state('')

  const activityByDate = $derived(
    new Map(usage.activityDays.map((day) => [day.date, day.messageCount]))
  )
  const maxActivity = $derived(
    usage.activityDays.reduce((maximum, day) => Math.max(maximum, day.messageCount), 0)
  )
  const calendarWeeks = $derived.by(() => {
    const today = new SvelteDate()
    today.setHours(12, 0, 0, 0)
    const start = new SvelteDate(today)
    start.setDate(today.getDate() - today.getDay() - 51 * 7)

    const weeks: CalendarWeek[] = []
    let previousMonth = -1
    for (let weekIndex = 0; weekIndex < 52; weekIndex += 1) {
      const days: CalendarDay[] = []
      const firstDay = new SvelteDate(start)
      firstDay.setDate(start.getDate() + weekIndex * 7)
      const month = firstDay.getMonth()
      const monthLabel =
        month !== previousMonth ? firstDay.toLocaleDateString(undefined, { month: 'short' }) : ''
      previousMonth = month

      for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
        const date = new SvelteDate(firstDay)
        date.setDate(firstDay.getDate() + dayIndex)
        const key = localDateKey(date)
        days.push({
          date: key,
          count: activityByDate.get(key) ?? 0,
          future: date.getTime() > today.getTime()
        })
      }
      weeks.push({ days, monthLabel })
    }
    return weeks
  })
  const calendarResponseCount = $derived(
    calendarWeeks.reduce(
      (total, week) =>
        total + week.days.reduce((weekTotal, day) => weekTotal + (day.future ? 0 : day.count), 0),
      0
    )
  )
  const maxHarnessTokens = $derived(
    usage.harnesses.reduce((maximum, item) => Math.max(maximum, item.tokens), 0)
  )
  const maxModelTokens = $derived(
    usage.models.reduce((maximum, item) => Math.max(maximum, item.tokens), 0)
  )

  function localDateKey(date: Date): string {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  function formatNumber(value: number): string {
    return new Intl.NumberFormat(undefined, {
      notation: 'compact',
      maximumFractionDigits: 1
    }).format(value)
  }

  function formatCost(value: number): string {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: value < 1 ? 2 : 0,
      maximumFractionDigits: value < 1 ? 4 : 2
    }).format(value)
  }

  function formatDuration(value: number): string {
    const totalMinutes = Math.round(value / 60_000)
    if (totalMinutes < 60) return `${totalMinutes}m`
    const hours = Math.floor(totalMinutes / 60)
    const minutes = totalMinutes % 60
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  }

  function activityClass(day: CalendarDay): string {
    if (day.future) return 'bg-transparent'
    if (day.count <= 0 || maxActivity <= 0) return 'bg-raised'
    const ratio = day.count / maxActivity
    if (ratio <= 0.25) return 'bg-primary/25'
    if (ratio <= 0.5) return 'bg-primary/50'
    if (ratio <= 0.75) return 'bg-primary/75'
    return 'bg-primary'
  }

  function usageWidth(item: AccountUsageBreakdown, maximum: number): string {
    if (maximum <= 0) return '0%'
    return `${Math.max(4, (item.tokens / maximum) * 100)}%`
  }

  async function loadUsage(): Promise<void> {
    loading = true
    errorMessage = ''
    try {
      usage = await invoke('account:getLocalUsage')
    } catch {
      errorMessage = 'Local activity could not be loaded. Your usage data has not been changed.'
    } finally {
      loading = false
    }
  }

  onMount(() => void loadUsage())
</script>

<div class="mx-auto max-w-6xl p-6 pb-24">
  <div class="mb-6 flex items-start justify-between gap-4">
    <div>
      <h1 class="text-xl font-bold tracking-tight">Profile</h1>
      <p class="mt-0.5 text-sm text-muted">Your local activity and agent usage at a glance.</p>
    </div>
    <button
      type="button"
      class="flex h-9 items-center gap-2 rounded-lg border px-3 text-xs font-semibold hover:bg-elevated disabled:opacity-50"
      title="Refresh local profile analytics"
      aria-label="Refresh local profile analytics"
      disabled={loading}
      onclick={() => void loadUsage()}
    >
      <RefreshCw size={14} class={loading ? 'animate-spin' : ''} />
      Refresh
    </button>
  </div>

  {#if errorMessage}
    <p
      class="mb-4 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
      role="alert"
    >
      {errorMessage}
    </p>
  {/if}

  <section class="grid grid-cols-2 gap-3 xl:grid-cols-4" aria-label="Local usage totals">
    <div class="rounded-xl border p-4">
      <p class="text-xs font-semibold uppercase tracking-wide text-muted">Agent responses</p>
      <p class="mt-2 text-2xl font-bold tabular-nums">{formatNumber(usage.messageCount)}</p>
      <p class="mt-1 text-xs text-dimmed">Across every local project</p>
    </div>
    <div class="rounded-xl border p-4">
      <p class="text-xs font-semibold uppercase tracking-wide text-muted">Tokens</p>
      <p class="mt-2 text-2xl font-bold tabular-nums">{formatNumber(usage.tokens)}</p>
      <p class="mt-1 text-xs text-dimmed">Reported input and output</p>
    </div>
    <div class="rounded-xl border p-4">
      <p class="text-xs font-semibold uppercase tracking-wide text-muted">Estimated cost</p>
      <p class="mt-2 text-2xl font-bold tabular-nums">{formatCost(usage.costUsd)}</p>
      <p class="mt-1 text-xs text-dimmed">From available usage reports</p>
    </div>
    <div class="rounded-xl border p-4">
      <p class="text-xs font-semibold uppercase tracking-wide text-muted">Active days</p>
      <p class="mt-2 text-2xl font-bold tabular-nums">{usage.activityDays.length}</p>
      <p class="mt-1 text-xs text-dimmed">{formatDuration(usage.durationMs)} of agent runtime</p>
    </div>
  </section>

  <section class="mt-4 overflow-hidden rounded-xl border p-4" aria-labelledby="activity-heading">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 id="activity-heading" class="text-sm font-semibold">Activity</h2>
        <p class="mt-0.5 text-xs text-muted">Agent responses recorded over the last 52 weeks.</p>
      </div>
      <span class="text-xs tabular-nums text-dimmed">
        {formatNumber(calendarResponseCount)} responses this period
      </span>
    </div>

    <div class="mt-5 overflow-x-auto pb-2">
      <div class="w-max min-w-full">
        <div class="ml-8 flex gap-1" aria-hidden="true">
          {#each calendarWeeks as week, index (`month-${index}`)}
            <span class="w-2.5 overflow-visible whitespace-nowrap text-[10px] text-dimmed">
              {week.monthLabel}
            </span>
          {/each}
        </div>
        <div class="mt-1 flex gap-2">
          <div
            class="grid w-6 shrink-0 grid-rows-7 gap-1 text-[10px] leading-2.5 text-dimmed"
            aria-hidden="true"
          >
            <span></span><span>Mon</span><span></span><span>Wed</span><span></span><span>Fri</span
            ><span></span>
          </div>
          <div class="flex gap-1" aria-label="Local activity calendar">
            {#each calendarWeeks as week, weekIndex (`week-${weekIndex}`)}
              <div class="flex flex-col gap-1">
                {#each week.days as day (day.date)}
                  <span
                    class="h-2.5 w-2.5 rounded-sm {activityClass(day)}"
                    title={`${day.date}: ${day.count} agent responses`}
                    aria-label={`${day.date}: ${day.count} agent responses`}
                  ></span>
                {/each}
              </div>
            {/each}
          </div>
        </div>
        <div
          class="mt-3 flex items-center justify-end gap-1 text-[10px] text-dimmed"
          aria-hidden="true"
        >
          <span class="mr-1">Less</span>
          <span class="h-2.5 w-2.5 rounded-sm bg-raised"></span>
          <span class="h-2.5 w-2.5 rounded-sm bg-primary/25"></span>
          <span class="h-2.5 w-2.5 rounded-sm bg-primary/50"></span>
          <span class="h-2.5 w-2.5 rounded-sm bg-primary/75"></span>
          <span class="h-2.5 w-2.5 rounded-sm bg-primary"></span>
          <span class="ml-1">More</span>
        </div>
      </div>
    </div>
  </section>

  <div class="mt-4 grid gap-4 lg:grid-cols-2">
    <section class="rounded-xl border" aria-labelledby="harness-usage-heading">
      <div class="border-b px-4 py-3">
        <h2 id="harness-usage-heading" class="text-sm font-semibold">Harnesses</h2>
        <p class="mt-0.5 text-xs text-muted">Most used: {usage.topHarnessId ?? 'No usage yet'}</p>
      </div>
      <div class="divide-y">
        {#each usage.harnesses.slice(0, 8) as harness (harness.id)}
          <div class="px-4 py-3">
            <div class="flex items-center justify-between gap-4 text-xs">
              <span class="truncate font-semibold">{harness.id}</span>
              <span class="shrink-0 tabular-nums text-muted">
                {formatNumber(harness.tokens)} tokens · {formatCost(harness.costUsd)}
              </span>
            </div>
            <div class="mt-2 h-1 overflow-hidden rounded-full bg-raised">
              <div
                class="h-full rounded-full bg-primary"
                style:width={usageWidth(harness, maxHarnessTokens)}
              ></div>
            </div>
            <p class="mt-1.5 text-[11px] tabular-nums text-dimmed">
              {formatNumber(harness.messageCount)} responses
            </p>
          </div>
        {:else}
          <p class="px-4 py-8 text-center text-xs text-muted">
            Harness usage appears after your first agent response.
          </p>
        {/each}
      </div>
    </section>

    <section class="rounded-xl border" aria-labelledby="model-usage-heading">
      <div class="border-b px-4 py-3">
        <h2 id="model-usage-heading" class="text-sm font-semibold">Models</h2>
        <p class="mt-0.5 text-xs text-muted">Most used: {usage.topModelId ?? 'No usage yet'}</p>
      </div>
      <div class="divide-y">
        {#each usage.models.slice(0, 8) as model (model.id)}
          <div class="px-4 py-3">
            <div class="flex items-center justify-between gap-4 text-xs">
              <span class="truncate font-semibold">{model.id}</span>
              <span class="shrink-0 tabular-nums text-muted">
                {formatNumber(model.tokens)} tokens · {formatCost(model.costUsd)}
              </span>
            </div>
            <div class="mt-2 h-1 overflow-hidden rounded-full bg-raised">
              <div
                class="h-full rounded-full bg-primary"
                style:width={usageWidth(model, maxModelTokens)}
              ></div>
            </div>
            <p class="mt-1.5 text-[11px] tabular-nums text-dimmed">
              {formatNumber(model.messageCount)} responses
            </p>
          </div>
        {:else}
          <p class="px-4 py-8 text-center text-xs text-muted">
            Model usage appears after a harness reports it.
          </p>
        {/each}
      </div>
    </section>
  </div>
</div>
