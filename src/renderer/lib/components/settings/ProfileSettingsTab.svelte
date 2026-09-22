<script lang="ts">
  import { onMount } from 'svelte'
  import { SvelteDate } from 'svelte/reactivity'
  import { Brain, Check, ChevronDown, RefreshCw } from '@lucide/svelte'
  import { DropdownMenu } from 'bits-ui'
  import type {
    LocalProfileAnalytics,
    LocalProfileAnalyticsRange,
    LocalProfileModelRanking,
    LocalProfileProjectBreakdown,
    LocalProfileUsageHour,
    ThinkingLevel
  } from '$shared/types'
  import { invoke } from '$lib/ipc.svelte'
  import DataTable, { type DataTableColumn } from '$lib/components/ui/DataTable.svelte'
  import { getAgentIcon } from '$lib/agent-icons/registry'
  import { getProjectIcon, projectIconOnError } from '$lib/project-icons'
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'
  import {
    activityClass,
    analyticsRange,
    dateInputValue,
    DEFAULT_RANGE,
    EMPTY_USAGE,
    formatCost,
    formatDate,
    formatDateRange,
    formatDuration,
    formatHour,
    formatIdentifier,
    formatNumber,
    formatUsageDate,
    localDateFromInput,
    MODEL_RANK_METRICS,
    RANGE_PRESETS,
    rankingAggregateLabel,
    rankingDurationLabel,
    rankingSamplesLabel,
    rankingScoreLabel,
    rankingTotalSamplesLabel,
    thinkingLevelLabel,
    usageHeight,
    usageWidth,
    utilityLabel,
    type ModelRankMetric,
    type RangePreset,
    type RankingSortKey,
    type ShotFilter,
    type ThinkingFilter
  } from './profile-settings-format'
  import {
    buildCalendarWeeks,
    buildHourlyTimeline,
    compareRankings,
    groupTopModels
  } from './profile-settings-analytics'

  let usage = $state<LocalProfileAnalytics>(EMPTY_USAGE) // responseDurationMs added below
  let loading = $state(true)
  let errorMessage = $state('')
  let selectedRange = $state<LocalProfileAnalyticsRange>(DEFAULT_RANGE)
  let rangePreset = $state<RangePreset>('year')
  let customStartDate = $state(dateInputValue(DEFAULT_RANGE.startAt))
  let customEndDate = $state(dateInputValue(DEFAULT_RANGE.endAt - 1))
  let projectIconUrls = $state<Record<string, string>>({})
  let usageRequestGeneration = 0
  let modelRankMetric = $state<ModelRankMetric>('tokens')

  const rangeLabel = $derived(formatDateRange(usage.range))
  const rangePresetLabel = $derived(
    rangePreset === 'custom'
      ? 'Custom range'
      : (RANGE_PRESETS.find((preset) => preset.id === rangePreset)?.label ?? 'Select range')
  )

  const activityByDate = $derived(
    new Map(usage.activityDays.map((day) => [day.date, day.messageCount]))
  )
  const maxActivity = $derived(
    usage.activityDays.reduce((maximum, day) => Math.max(maximum, day.messageCount), 0)
  )
  const calendarWeeks = $derived(buildCalendarWeeks(usage, activityByDate))
  const calendarResponseCount = $derived(
    calendarWeeks.reduce(
      (total, week) =>
        total +
        week.days.reduce((weekTotal, day) => weekTotal + (day.outsideRange ? 0 : day.count), 0),
      0
    )
  )
  const selectedActiveDays = $derived(
    usage.activityDays.filter((day) => {
      const date = localDateFromInput(day.date)
      return date && date.getTime() >= usage.range.startAt && date.getTime() < usage.range.endAt
    }).length
  )
  const maxHarnessTokens = $derived(
    usage.harnesses.reduce((maximum, item) => Math.max(maximum, item.tokens), 0)
  )
  const maxModelTokens = $derived(
    usage.models.reduce((maximum, item) => Math.max(maximum, item.tokens), 0)
  )
  const maxProviderTokens = $derived(
    usage.providers.reduce((maximum, item) => Math.max(maximum, item.tokens), 0)
  )
  const maxThinkingTokens = $derived(
    usage.thinkingLevels.reduce((maximum, item) => Math.max(maximum, item.tokens), 0)
  )
  const maxDailyTokens = $derived(
    usage.dailyUsage.reduce((maximum, item) => Math.max(maximum, item.tokens), 0)
  )
  const hourlyTimeline = $derived(buildHourlyTimeline(usage.hourlyUsage))
  const maxHourlyTokens = $derived(
    hourlyTimeline.reduce((maximum, item) => Math.max(maximum, item.tokens), 0)
  )
  const peakHour = $derived(
    usage.hourlyUsage.reduce<LocalProfileUsageHour | null>(
      (peak, item) => (!peak || item.tokens > peak.tokens ? item : peak),
      null
    )
  )
  const peakDay = $derived(
    usage.dailyUsage.reduce<(typeof usage.dailyUsage)[number] | null>(
      (peak, item) => (!peak || item.tokens > peak.tokens ? item : peak),
      null
    )
  )

  let thinkingFilter = $state<ThinkingFilter>('all')
  let shotFilter = $state<ShotFilter>('all')

  const filteredRankings = $derived(
    shotFilter === 'all'
      ? usage.modelRankings
      : usage.modelRankings.filter((entry) =>
          shotFilter === 'one_shot' ? entry.oneShot.samples > 0 : entry.multiShot.samples > 0
        )
  )
  const rankingColumns: DataTableColumn<LocalProfileModelRanking, RankingSortKey>[] = $derived.by(
    () => {
      const columns: DataTableColumn<LocalProfileModelRanking, RankingSortKey>[] = [
        { key: null, header: 'Configuration' }
      ]
      if (shotFilter !== 'multi_shot') {
        columns.push({
          key: 'one_shot',
          header: 'One-shot',
          cellClass: 'tabular-nums',
          compare: (left, right, direction) => compareRankings(left, right, 'one_shot', direction)
        })
      }
      if (shotFilter !== 'one_shot') {
        columns.push({
          key: 'multi_shot',
          header: 'Multi-shot',
          cellClass: 'tabular-nums',
          compare: (left, right, direction) => compareRankings(left, right, 'multi_shot', direction)
        })
      }
      columns.push({
        key: 'aggregate',
        header: 'Total',
        cellClass: 'tabular-nums',
        compare: (left, right, direction) => compareRankings(left, right, 'aggregate', direction)
      })
      return columns
    }
  )
  const shotFilterOptions: { value: ShotFilter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'one_shot', label: 'One-shot' },
    { value: 'multi_shot', label: 'Multi-shot' }
  ]

  const topModels = $derived(groupTopModels(usage.models, modelRankMetric))
  const modelRankMetricLabel = $derived(
    modelRankMetric === 'cost' ? 'cost' : modelRankMetric === 'runtime' ? 'runtime' : 'tokens'
  )
  const availableThinkingLevels = $derived(
    usage.models
      .map((model) => model.thinkingLevel)
      .filter((level): level is ThinkingLevel => level !== undefined)
      .filter((level, index, all) => all.indexOf(level) === index)
  )
  const filteredModels = $derived(
    usage.models.filter((model) =>
      thinkingFilter === 'all' ? true : model.thinkingLevel === thinkingFilter
    )
  )

  async function loadProjectIconUrls(projects: LocalProfileProjectBreakdown[]): Promise<void> {
    const pairs = await Promise.all(
      projects
        .filter((project) => project.hasCustomIcon)
        .map(async (project): Promise<readonly [string, string] | null> => {
          try {
            const icon = await invoke('project:getIcon', project.id)
            return icon ? ([project.id, icon] as const) : null
          } catch {
            return null
          }
        })
    )
    projectIconUrls = Object.fromEntries(
      pairs.filter((pair): pair is readonly [string, string] => pair !== null)
    )
  }

  async function loadUsage(range: LocalProfileAnalyticsRange = selectedRange): Promise<void> {
    const generation = ++usageRequestGeneration
    loading = true
    errorMessage = ''
    try {
      const result = await invoke('account:getLocalUsage', range)
      if (generation !== usageRequestGeneration) return
      usage = result
      void loadProjectIconUrls(result.projects)
    } catch {
      errorMessage = 'Local activity could not be loaded. Your usage data has not been changed.'
    } finally {
      if (generation === usageRequestGeneration) loading = false
    }
  }

  function selectRangePreset(
    preset: Exclude<RangePreset, 'custom'>,
    days: number,
    endOffsetDays?: number
  ): void {
    rangePreset = preset
    selectedRange = analyticsRange(days, endOffsetDays)
    customStartDate = dateInputValue(selectedRange.startAt)
    customEndDate = dateInputValue(selectedRange.endAt - 1)
    void loadUsage(selectedRange)
  }

  function showCustomRange(): void {
    rangePreset = 'custom'
    errorMessage = ''
  }

  function applyCustomRange(): void {
    const start = localDateFromInput(customStartDate)
    const inclusiveEnd = localDateFromInput(customEndDate)
    if (!start || !inclusiveEnd) {
      errorMessage = 'Choose a valid start and end date.'
      return
    }
    const end = new SvelteDate(inclusiveEnd)
    end.setDate(end.getDate() + 1)
    const duration = end.getTime() - start.getTime()
    if (duration <= 0 || duration > 371 * 24 * 60 * 60 * 1_000) {
      errorMessage = 'Choose a range of up to 12 months with the start before the end.'
      return
    }
    selectedRange = { startAt: start.getTime(), endAt: end.getTime() }
    void loadUsage(selectedRange)
  }

  onMount(() => {
    void loadUsage()
  })
</script>

<div class="w-full p-6 pb-24">
  <div class="mb-6 flex items-start justify-between gap-4">
    <div>
      <h1 class="text-xl font-bold tracking-tight">Usage</h1>
      <p class="mt-0.5 text-sm text-muted">
        Track total consumption, peak periods, and what drove them.
      </p>
    </div>
    <div class="flex items-center gap-2">
      <button
        type="button"
        class="flex h-9 items-center gap-2 rounded-lg border px-3 text-xs font-semibold hover:bg-elevated disabled:opacity-50"
        title="Refresh usage analytics"
        aria-label="Refresh usage analytics"
        disabled={loading}
        onclick={() => void loadUsage()}
      >
        <RefreshCw size={14} class={loading ? 'animate-spin' : ''} />
        Refresh
      </button>
    </div>
  </div>

  {#if errorMessage}
    <p
      class="mb-4 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
      role="alert"
    >
      {errorMessage}
    </p>
  {/if}

  <section class="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4" aria-label="Local usage totals">
    <div class="rounded-xl border p-4">
      <p class="text-xs font-semibold uppercase tracking-wide text-muted">Agent responses</p>
      <p class="mt-2 text-2xl font-bold tabular-nums">{formatNumber(usage.messageCount)}</p>
      <p class="mt-1 text-xs text-dimmed">Total in the selected period</p>
    </div>
    <div class="rounded-xl border p-4">
      <p class="text-xs font-semibold uppercase tracking-wide text-muted">Tokens</p>
      <p class="mt-2 text-2xl font-bold tabular-nums">{formatNumber(usage.tokens)}</p>
      <p class="mt-1 text-xs text-dimmed">Models and tracked utilities</p>
    </div>
    <div class="rounded-xl border p-4">
      <p class="text-xs font-semibold uppercase tracking-wide text-muted">Estimated cost</p>
      <p class="mt-2 text-2xl font-bold tabular-nums">{formatCost(usage.costUsd)}</p>
      <p class="mt-1 text-xs text-dimmed">From available pricing reports</p>
    </div>
    <div class="rounded-xl border p-4">
      <p class="text-xs font-semibold uppercase tracking-wide text-muted">Active days</p>
      <p class="mt-2 text-2xl font-bold tabular-nums">{selectedActiveDays}</p>
      <p class="mt-1 text-xs text-dimmed">{formatDuration(usage.durationMs)} of agent runtime</p>
    </div>
  </section>

  <section class="mb-4 overflow-hidden rounded-xl border p-4" aria-labelledby="activity-heading">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 id="activity-heading" class="text-sm font-semibold">Active days</h2>
        <p class="mt-0.5 text-xs text-muted">
          {formatNumber(calendarResponseCount)} agent responses over 12 months · Selected {rangeLabel}
        </p>
      </div>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          class="flex h-8 min-w-32 items-center justify-between gap-2 rounded-lg border bg-surface px-2.5 text-xs font-medium text-foreground hover:bg-elevated disabled:opacity-50"
          title="Choose usage range"
          aria-label={`Choose usage range. Current range: ${rangePresetLabel}`}
          disabled={loading}
        >
          <span>{rangePresetLabel}</span>
          <ChevronDown size={13} class="text-dimmed" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            side="bottom"
            align="end"
            sideOffset={6}
            collisionPadding={8}
            class="z-50 w-44 overflow-hidden rounded-lg border bg-surface p-1 shadow-lg"
          >
            {#each RANGE_PRESETS as preset (preset.id)}
              <DropdownMenu.Item
                class="flex cursor-default items-center justify-between gap-3 rounded-md px-2.5 py-2 text-xs text-muted outline-none data-[highlighted]:bg-elevated data-[highlighted]:text-foreground"
                textValue={preset.label}
                onSelect={() => selectRangePreset(preset.id, preset.days, preset.endOffsetDays)}
              >
                <span>{preset.label}</span>
                {#if rangePreset === preset.id}
                  <Check size={13} class="text-primary" />
                {/if}
              </DropdownMenu.Item>
            {/each}
            <DropdownMenu.Separator class="my-1 h-px bg-border" />
            <DropdownMenu.Item
              class="flex cursor-default items-center justify-between gap-3 rounded-md px-2.5 py-2 text-xs text-muted outline-none data-[highlighted]:bg-elevated data-[highlighted]:text-foreground"
              textValue="Custom range"
              onSelect={showCustomRange}
            >
              <span>Custom range</span>
              {#if rangePreset === 'custom'}
                <Check size={13} class="text-primary" />
              {/if}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
    {#if rangePreset === 'custom'}
      <div class="mt-3 flex flex-wrap items-end gap-2 border-t pt-3">
        <label class="grid gap-1 text-[0.6875rem] font-medium text-muted">
          Start date
          <input
            type="date"
            class="h-9 rounded-lg border bg-elevated px-2.5 text-xs tabular-nums text-foreground outline-none focus:border-primary"
            max={customEndDate}
            bind:value={customStartDate}
          />
        </label>
        <label class="grid gap-1 text-[0.6875rem] font-medium text-muted">
          End date
          <input
            type="date"
            class="h-9 rounded-lg border bg-elevated px-2.5 text-xs tabular-nums text-foreground outline-none focus:border-primary"
            min={customStartDate}
            max={dateInputValue(Date.now())}
            bind:value={customEndDate}
          />
        </label>
        <button
          type="button"
          class="h-9 rounded-lg bg-primary px-4 text-xs font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50"
          disabled={loading}
          onclick={applyCustomRange}
        >
          Apply range
        </button>
      </div>
    {/if}

    <div class="mt-5 overflow-x-auto pb-2">
      <div class="activity-calendar w-full px-1">
        <div class="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-2">
          <span aria-hidden="true"></span>
          <div
            class="activity-columns gap-1"
            style:--calendar-weeks={calendarWeeks.length}
            aria-hidden="true"
          >
            {#each calendarWeeks as week, index (`month-${index}`)}
              <span class="min-w-0 overflow-visible whitespace-nowrap text-[0.625rem] text-dimmed">
                {week.monthLabel}
              </span>
            {/each}
          </div>
          <div
            class="grid w-6 shrink-0 grid-rows-7 gap-1 text-[0.625rem] leading-3 text-dimmed"
            aria-hidden="true"
          >
            <span></span><span>Mon</span><span></span><span>Wed</span><span></span><span>Fri</span
            ><span></span>
          </div>
          <div
            class="activity-columns gap-1"
            style:--calendar-weeks={calendarWeeks.length}
            aria-label="Local activity calendar"
          >
            {#each calendarWeeks as week, weekIndex (`week-${weekIndex}`)}
              <div
                class="relative flex min-w-0 flex-col gap-1 rounded-sm {week.selected
                  ? 'bg-thread-working/5'
                  : ''}"
              >
                {#if week.selected}
                  <span
                    class="pointer-events-none absolute inset-0 z-10 border-y border-dashed border-thread-working/35 {week.rangeStart
                      ? 'rounded-l-sm border-l'
                      : ''} {week.rangeEnd ? 'rounded-r-sm border-r' : ''}"
                    aria-hidden="true"
                  ></span>
                {/if}
                {#each week.days as day (day.date)}
                  <span
                    class="aspect-square w-full min-w-2 rounded-sm {activityClass(
                      day,
                      maxActivity
                    )}"
                    title={`${day.date}: ${day.count} agent responses${day.selected ? ' · selected range' : ''}`}
                    aria-label={`${day.date}: ${day.count} agent responses${day.selected ? ', selected range' : ''}`}
                  ></span>
                {/each}
              </div>
            {/each}
          </div>
        </div>
        <div
          class="mt-3 flex items-center justify-end gap-1 text-[0.625rem] text-dimmed"
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

  {#if topModels.length > 0}
    <section class="mt-4 rounded-xl border" aria-labelledby="most-used-heading">
      <div class="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <h2 id="most-used-heading" class="text-sm font-semibold">Most used models</h2>
          <p class="mt-0.5 text-xs text-muted">Ranked by {modelRankMetricLabel} in this period.</p>
        </div>
        <div
          class="flex rounded-lg border bg-surface p-0.5"
          role="group"
          aria-label="Rank models by"
        >
          {#each MODEL_RANK_METRICS as metric (metric)}
            <button
              type="button"
              class="h-7 rounded-md px-2.5 text-[0.6875rem] font-semibold capitalize transition-colors {modelRankMetric ===
              metric
                ? 'bg-thread-working text-on-primary'
                : 'text-muted hover:bg-elevated hover:text-foreground'}"
              aria-pressed={modelRankMetric === metric}
              onclick={() => (modelRankMetric = metric)}
            >
              {metric}
            </button>
          {/each}
        </div>
      </div>
      <div class="divide-y">
        {#each topModels as model, index (`${model.harnessId}:${model.providerId}:${model.id}`)}
          <div class="flex flex-wrap items-center gap-x-5 gap-y-3 px-4 py-3">
            <span
              class="w-7 shrink-0 text-center text-lg font-bold tabular-nums {index === 0
                ? 'text-accent'
                : 'text-dimmed'}"
              aria-label={`Rank ${index + 1}`}
            >
              {index + 1}
            </span>
            <div class="flex min-w-48 flex-1 items-center gap-3">
              {#if getAgentIcon(model.harnessId)}
                <img
                  class="h-9 w-9 shrink-0 rounded-lg object-contain"
                  src={getAgentIcon(model.harnessId)?.iconUrl}
                  alt=""
                />
              {:else}
                <span class="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-elevated">
                  <VendorIcon name={model.providerId ?? model.id} id={model.providerId} size={17} />
                </span>
              {/if}
              <div class="min-w-0">
                <p class="truncate text-sm font-semibold">{model.id}</p>
                <p class="mt-0.5 flex items-center gap-1.5 text-[0.6875rem] text-muted">
                  <VendorIcon name={model.providerId ?? model.id} id={model.providerId} size={12} />
                  <span class="truncate">
                    {formatIdentifier(model.providerId ?? '')} · {formatIdentifier(
                      model.harnessId ?? ''
                    )}
                  </span>
                </p>
              </div>
            </div>
            <dl class="grid min-w-80 flex-1 grid-cols-4 gap-x-5">
              <div>
                <dt class="text-[0.625rem] text-dimmed">Responses</dt>
                <dd class="mt-0.5 text-xs font-semibold tabular-nums">
                  {formatNumber(model.messageCount)}
                </dd>
              </div>
              <div>
                <dt class="text-[0.625rem] text-dimmed">Tokens</dt>
                <dd class="mt-0.5 text-xs font-semibold tabular-nums">
                  {formatNumber(model.tokens)}
                </dd>
              </div>
              <div>
                <dt class="text-[0.625rem] text-dimmed">Cost</dt>
                <dd class="mt-0.5 text-xs font-semibold tabular-nums">
                  {formatCost(model.costUsd)}
                </dd>
              </div>
              <div>
                <dt class="text-[0.625rem] text-dimmed">Runtime</dt>
                <dd class="mt-0.5 text-xs font-semibold tabular-nums">
                  {formatDuration(model.durationMs)}
                </dd>
              </div>
            </dl>
          </div>
        {/each}
      </div>
    </section>
  {/if}

  <div class="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
    <section class="rounded-xl border p-4" aria-labelledby="daily-consumption-heading">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="daily-consumption-heading" class="text-sm font-semibold">Consumption by day</h2>
          <p class="mt-0.5 text-xs text-muted">Total tokens for each active day in this period.</p>
        </div>
        {#if peakDay}
          <div class="text-right">
            <p class="text-[0.625rem] font-semibold uppercase tracking-wide text-dimmed">
              Peak day
            </p>
            <p class="mt-0.5 text-xs font-semibold tabular-nums">
              {formatUsageDate(peakDay.date)} · {formatNumber(peakDay.tokens)}
            </p>
          </div>
        {/if}
      </div>
      {#if usage.dailyUsage.length > 0}
        <div class="mt-5 max-h-72 space-y-2 overflow-y-auto pr-1">
          {#each usage.dailyUsage.toReversed() as day (day.date)}
            <div class="grid grid-cols-[4.5rem_minmax(0,1fr)_5.5rem] items-center gap-3 text-xs">
              <span class="tabular-nums text-muted">{formatUsageDate(day.date)}</span>
              <div class="h-2 overflow-hidden rounded-full bg-raised">
                <div
                  class="h-full rounded-full {day.date === peakDay?.date
                    ? 'bg-accent'
                    : 'bg-primary'}"
                  style:width={usageWidth(day, maxDailyTokens)}
                ></div>
              </div>
              <span class="text-right font-medium tabular-nums">{formatNumber(day.tokens)}</span>
            </div>
          {/each}
        </div>
      {:else}
        <p class="py-12 text-center text-xs text-muted">
          No consumption was recorded in this period.
        </p>
      {/if}
    </section>

    <section class="rounded-xl border p-4" aria-labelledby="hourly-consumption-heading">
      <div class="flex items-start justify-between gap-3">
        <div>
          <h2 id="hourly-consumption-heading" class="text-sm font-semibold">Peak hours</h2>
          <p class="mt-0.5 text-xs text-muted">Usage by local time across the selected period.</p>
        </div>
        {#if peakHour}
          <div class="text-right">
            <p class="text-[0.625rem] font-semibold uppercase tracking-wide text-dimmed">Peak</p>
            <p class="mt-0.5 text-xs font-semibold tabular-nums">
              {formatHour(peakHour.hour)} · {formatNumber(peakHour.tokens)}
            </p>
          </div>
        {/if}
      </div>
      <div class="hourly-columns mt-5 h-40 items-end gap-1" aria-label="Usage by hour of day">
        {#each hourlyTimeline as hour (hour.hour)}
          <div class="flex h-full min-w-0 items-end">
            <span
              class="w-full rounded-t-sm {hour.hour === peakHour?.hour
                ? 'bg-accent'
                : 'bg-primary'} {hour.tokens === 0 ? 'opacity-15' : ''}"
              style:height={usageHeight(hour, maxHourlyTokens)}
              title={`${formatHour(hour.hour)}: ${formatNumber(hour.tokens)} tokens, ${formatCost(hour.costUsd)}`}
              aria-label={`${formatHour(hour.hour)}: ${formatNumber(hour.tokens)} tokens, ${formatCost(hour.costUsd)}`}
            ></span>
          </div>
        {/each}
      </div>
      <div
        class="mt-2 grid grid-cols-4 text-[0.625rem] tabular-nums text-dimmed"
        aria-hidden="true"
      >
        <span>12 AM</span><span class="text-center">6 AM</span><span class="text-center">12 PM</span
        ><span class="text-right">6 PM</span>
      </div>
      <p class="mt-3 border-t pt-3 text-[0.6875rem] text-dimmed">
        Gold marks the busiest hour; shorter bars show non-peak consumption.
      </p>
    </section>
  </div>

  <section class="mt-4 rounded-xl border" aria-labelledby="project-usage-heading">
    <div class="flex items-center justify-between border-b px-4 py-3">
      <div>
        <h2 id="project-usage-heading" class="text-sm font-semibold">Projects</h2>
        <p class="mt-0.5 text-xs text-muted">Where your agent work happened in this period.</p>
      </div>
      <span class="text-xs tabular-nums text-dimmed">{usage.projects.length} active</span>
    </div>
    <div class="grid divide-y lg:grid-cols-2 lg:divide-x lg:divide-y-0 xl:grid-cols-3">
      {#each usage.projects.slice(0, 6) as project (project.id)}
        {@const iconUrl = getProjectIcon(project, projectIconUrls[project.id])}
        <article class="min-w-0 p-4">
          <div class="flex items-start gap-3">
            {#if iconUrl}
              <img
                class="h-9 w-9 shrink-0 rounded-lg object-contain"
                src={iconUrl}
                alt=""
                onerror={projectIconOnError(project)}
              />
            {/if}
            <div class="min-w-0 flex-1">
              <h3 class="truncate text-sm font-semibold">{project.name}</h3>
              <p class="mt-0.5 text-[0.6875rem] text-dimmed">
                Last active {formatDate(project.lastActiveAt)}
              </p>
            </div>
          </div>
          <dl class="mt-4 grid grid-cols-3 gap-2 text-xs">
            <div>
              <dt class="text-dimmed">Responses</dt>
              <dd class="mt-0.5 font-semibold tabular-nums">
                {formatNumber(project.messageCount)}
              </dd>
            </div>
            <div>
              <dt class="text-dimmed">Threads</dt>
              <dd class="mt-0.5 font-semibold tabular-nums">{project.threadCount}</dd>
            </div>
            <div>
              <dt class="text-dimmed">Active days</dt>
              <dd class="mt-0.5 font-semibold tabular-nums">{project.activeDays}</dd>
            </div>
          </dl>
          <p class="mt-3 truncate text-[0.6875rem] tabular-nums text-muted">
            {formatNumber(project.tokens)} tokens · {formatCost(project.costUsd)} · {formatDuration(
              project.durationMs
            )}
          </p>
        </article>
      {:else}
        <p class="px-4 py-8 text-center text-xs text-muted lg:col-span-2 xl:col-span-3">
          No project activity was recorded during this period.
        </p>
      {/each}
    </div>
  </section>

  <div class="mt-4 grid gap-4 xl:grid-cols-2">
    <section class="rounded-xl border" aria-labelledby="harness-usage-heading">
      <div class="border-b px-4 py-3">
        <h2 id="harness-usage-heading" class="text-sm font-semibold">Harnesses</h2>
        <p class="mt-0.5 text-xs text-muted">Most used: {usage.topHarnessId ?? 'No usage yet'}</p>
      </div>
      <div class="divide-y">
        {#each usage.harnesses.slice(0, 8) as harness (harness.id)}
          <div class="px-4 py-3">
            <div class="flex items-center justify-between gap-4 text-xs">
              <span class="flex min-w-0 items-center gap-2 truncate font-semibold">
                {#if getAgentIcon(harness.id)}
                  <img
                    class="h-4 w-4 shrink-0 object-contain"
                    src={getAgentIcon(harness.id)?.iconUrl}
                    alt=""
                  />
                {:else}
                  <VendorIcon name={harness.id} size={16} />
                {/if}
                <span class="truncate"
                  >{getAgentIcon(harness.id)?.name ?? formatIdentifier(harness.id)}</span
                >
              </span>
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
            <p class="mt-1.5 text-[0.6875rem] tabular-nums text-dimmed">
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

    <section class="rounded-xl border" aria-labelledby="provider-usage-heading">
      <div class="border-b px-4 py-3">
        <h2 id="provider-usage-heading" class="text-sm font-semibold">Providers</h2>
        <p class="mt-0.5 text-xs text-muted">
          Most used: {usage.topProviderId ? formatIdentifier(usage.topProviderId) : 'No usage yet'}
        </p>
      </div>
      <div class="divide-y">
        {#each usage.providers.slice(0, 8) as provider (provider.id)}
          <div class="px-4 py-3">
            <div class="flex items-center justify-between gap-4 text-xs">
              <span class="flex min-w-0 items-center gap-2 truncate font-semibold">
                <VendorIcon name={provider.id} id={provider.id} size={16} />
                <span class="truncate">{formatIdentifier(provider.id)}</span>
              </span>
              <span class="shrink-0 tabular-nums text-muted">
                {formatNumber(provider.tokens)} tokens · {formatCost(provider.costUsd)}
              </span>
            </div>
            <div class="mt-2 h-1 overflow-hidden rounded-full bg-raised">
              <div
                class="h-full rounded-full bg-primary"
                style:width={usageWidth(provider, maxProviderTokens)}
              ></div>
            </div>
            <p class="mt-1.5 text-[0.6875rem] tabular-nums text-dimmed">
              {formatNumber(provider.messageCount)} responses
            </p>
          </div>
        {:else}
          <p class="px-4 py-8 text-center text-xs text-muted">
            Provider usage appears after a harness reports it.
          </p>
        {/each}
      </div>
    </section>

    <section class="rounded-xl border" aria-labelledby="thinking-usage-heading">
      <div class="border-b px-4 py-3">
        <h2 id="thinking-usage-heading" class="text-sm font-semibold">Thinking levels</h2>
        <p class="mt-0.5 text-xs text-muted">Reasoning effort across every model in this period.</p>
      </div>
      <div class="divide-y">
        {#each usage.thinkingLevels as level (level.id)}
          <div class="px-4 py-3">
            <div class="flex items-center justify-between gap-4 text-xs">
              <span class="flex min-w-0 items-center gap-2 truncate font-semibold">
                {#if level.thinkingLevel}
                  <Brain size={15} class="text-muted" />
                  {thinkingLevelLabel(level.thinkingLevel)}
                {:else}
                  Reported without effort metadata
                {/if}
              </span>
              <span class="shrink-0 tabular-nums text-muted">
                {formatNumber(level.tokens)} tokens · {formatCost(level.costUsd)}
              </span>
            </div>
            <div class="mt-2 h-1 overflow-hidden rounded-full bg-raised">
              <div
                class="h-full rounded-full bg-primary"
                style:width={usageWidth(level, maxThinkingTokens)}
              ></div>
            </div>
            <p class="mt-1.5 text-[0.6875rem] tabular-nums text-dimmed">
              {formatNumber(level.messageCount)} responses · {formatDuration(level.durationMs)}
            </p>
          </div>
        {:else}
          <p class="px-4 py-8 text-center text-xs text-muted">
            Thinking-level usage appears after a harness reports reasoning effort.
          </p>
        {/each}
      </div>
    </section>

    <section class="rounded-xl border" aria-labelledby="model-usage-heading">
      <div class="border-b px-4 py-3">
        <h2 id="model-usage-heading" class="text-sm font-semibold">Models</h2>
        <p class="mt-0.5 text-xs text-muted">
          {#if usage.models.length > 0}
            Breakdown by thinking level in this period.
          {:else}
            Most used: {usage.topModelId ?? 'No usage yet'}
          {/if}
        </p>
        {#if availableThinkingLevels.length > 0}
          <div
            class="mt-3 flex flex-wrap items-center gap-1"
            role="group"
            aria-label="Filter models by thinking level"
          >
            <button
              type="button"
              class="flex h-7 items-center gap-1 rounded-lg px-2.5 text-[0.6875rem] font-medium {thinkingFilter ===
              'all'
                ? 'bg-overlay text-foreground'
                : 'text-muted hover:bg-elevated hover:text-foreground'}"
              aria-pressed={thinkingFilter === 'all'}
              onclick={() => (thinkingFilter = 'all')}
            >
              All
            </button>
            {#each availableThinkingLevels as level (level)}
              <button
                type="button"
                class="flex h-7 items-center gap-1 rounded-lg px-2.5 text-[0.6875rem] font-medium capitalize {thinkingFilter ===
                level
                  ? 'bg-overlay text-foreground'
                  : 'text-muted hover:bg-elevated hover:text-foreground'}"
                aria-pressed={thinkingFilter === level}
                onclick={() => (thinkingFilter = level)}
              >
                <Brain size={11} />
                {thinkingLevelLabel(level)}
              </button>
            {/each}
          </div>
        {/if}
      </div>
      <div class="divide-y">
        {#each filteredModels.slice(0, 8) as model (`${model.harnessId}:${model.providerId}:${model.id}:${model.thinkingLevel}`)}
          <div class="px-4 py-3">
            <div class="flex items-center justify-between gap-4 text-xs">
              <span class="flex min-w-0 items-center gap-1.5 truncate font-semibold">
                {#if getAgentIcon(model.harnessId)}
                  <img
                    class="h-4 w-4 shrink-0 object-contain"
                    src={getAgentIcon(model.harnessId)?.iconUrl}
                    alt=""
                  />
                {/if}
                <VendorIcon name={model.providerId ?? model.id} id={model.providerId} size={15} />
                <span class="truncate">{model.id}</span>
                {#if model.thinkingLevel}
                  <span
                    class="flex shrink-0 items-center gap-1 rounded-md bg-elevated px-1.5 py-0.5 text-[0.5625rem] capitalize text-muted"
                    title={`Thinking level: ${model.thinkingLevel}`}
                    aria-label={`Thinking level: ${model.thinkingLevel}`}
                  >
                    <Brain size={9} />
                    {model.thinkingLevel}
                  </span>
                {/if}
              </span>
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
            <p class="mt-1.5 text-[0.6875rem] tabular-nums text-dimmed">
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

  <section class="mt-4 rounded-xl border" aria-labelledby="model-ranking-heading">
    <div class="border-b px-4 py-3">
      <h2 id="model-ranking-heading" class="text-sm font-semibold">Model rankings</h2>
      <p class="mt-0.5 text-xs text-muted">
        One-shot and multi-shot results for each harness, provider, model, and thinking level.
      </p>
      {#if usage.gradingSpend.costUsd > 0}
        <p class="mt-2 text-xs">
          <span class="font-semibold tabular-nums text-foreground">
            {formatCost(usage.gradingSpend.costUsd)} spent
          </span>
          <span class="text-dimmed"> across ranked conversations </span>
        </p>
      {/if}
    </div>
    <div class="border-b px-4 py-2" role="group" aria-label="Filter rankings by shot category">
      <div class="flex flex-wrap items-center gap-1">
        {#each shotFilterOptions as option (option.value)}
          <button
            type="button"
            class="flex h-7 items-center rounded-lg px-2.5 text-[0.6875rem] font-medium {shotFilter ===
            option.value
              ? 'bg-overlay text-foreground'
              : 'text-muted hover:bg-elevated hover:text-foreground'}"
            aria-pressed={shotFilter === option.value}
            onclick={() => (shotFilter = option.value)}
          >
            {option.label}
          </button>
        {/each}
      </div>
    </div>
    {#if filteredRankings.length > 0}
      <DataTable
        rows={filteredRankings.slice(0, 10)}
        columns={rankingColumns}
        getRowId={(entry) =>
          `${entry.harnessId}:${entry.providerId}:${entry.modelId}:${entry.thinkingLevel}:${entry.rubricVersion}`}
        label="Model rankings"
        initialSortKey="aggregate"
      >
        {#snippet cell(
          entry: LocalProfileModelRanking,
          column: DataTableColumn<LocalProfileModelRanking, RankingSortKey>
        )}
          {#if column.key === null}
            <span class="flex min-w-0 items-center gap-1.5 font-semibold">
              {#if getAgentIcon(entry.harnessId)}
                <img
                  class="h-4 w-4 shrink-0 object-contain"
                  src={getAgentIcon(entry.harnessId)?.iconUrl}
                  alt=""
                />
              {/if}
              <VendorIcon
                name={entry.providerId || entry.modelId}
                id={entry.providerId}
                size={15}
              />
              <span class="truncate">{entry.modelId}</span>
            </span>
            <span class="mt-1 flex flex-wrap items-center gap-1 text-[0.625rem] text-muted">
              {#if entry.thinkingLevel}
                <span
                  class="flex shrink-0 items-center gap-1 rounded-md bg-elevated px-1.5 py-0.5 capitalize"
                >
                  <Brain size={9} />
                  {entry.thinkingLevel}
                </span>
              {/if}
              <span class="shrink-0 rounded-md bg-raised px-1.5 py-0.5">
                {entry.harnessId}
              </span>
              <span class="shrink-0 rounded-md bg-raised px-1.5 py-0.5">
                rubric {entry.rubricVersion}
              </span>
            </span>
          {:else if column.key === 'aggregate'}
            <div class="font-semibold text-foreground">{rankingAggregateLabel(entry)}</div>
            <div class="mt-0.5 text-[0.6875rem] text-dimmed">
              {rankingTotalSamplesLabel(entry)}
            </div>
          {:else}
            {@const stats = column.key === 'one_shot' ? entry.oneShot : entry.multiShot}
            <div class="font-semibold text-foreground">{rankingScoreLabel(stats)}</div>
            <div class="mt-0.5 text-[0.6875rem] text-dimmed">
              {rankingSamplesLabel(stats)}
              {#if stats.samples > 0}
                · {rankingDurationLabel(stats)} avg
              {/if}
            </div>
          {/if}
        {/snippet}
      </DataTable>
    {:else}
      <p class="px-4 py-8 text-center text-xs text-muted">
        The more you use CodeInOven, the more models that do a good job will appear here.
      </p>
    {/if}
  </section>

  <section class="mt-4 rounded-xl border" aria-labelledby="utility-usage-heading">
    <div class="border-b px-4 py-3">
      <h2 id="utility-usage-heading" class="text-sm font-semibold">Utilities</h2>
      <p class="mt-0.5 text-xs text-muted">
        Image descriptor, memory, and title generation in this period.
      </p>
    </div>
    <div class="divide-y">
      {#each usage.utilities as utility (utility.id)}
        <div class="flex items-center justify-between gap-4 px-4 py-3 text-xs">
          <span class="min-w-0 truncate font-semibold">{utilityLabel(utility.id)}</span>
          <span class="shrink-0 tabular-nums text-muted">
            {formatNumber(utility.tokens)} tokens · {formatCost(utility.costUsd)} · {formatNumber(
              utility.messageCount
            )} calls
          </span>
        </div>
      {:else}
        <p class="px-4 py-8 text-center text-xs text-muted">
          Utility usage appears after an image is described or memory is generated.
        </p>
      {/each}
    </div>
  </section>
</div>

<style>
  .hourly-columns {
    display: grid;
    grid-template-columns: repeat(24, minmax(0, 1fr));
  }

  .activity-columns {
    display: grid;
    grid-template-columns: repeat(var(--calendar-weeks), minmax(0, 1fr));
  }

  .activity-calendar {
    min-width: 42rem;
  }
</style>
