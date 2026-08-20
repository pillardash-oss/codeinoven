<script lang="ts">
  import { onMount } from 'svelte'
  import { SvelteDate } from 'svelte/reactivity'
  import { Brain, Check, LogIn, LogOut, RefreshCw } from '@lucide/svelte'
  import { AlertDialog, Popover } from 'bits-ui'
  import type {
    AccountAuthProvider,
    AccountProfileState,
    AccountUsageBreakdown,
    LocalProfileAnalytics,
    LocalProfileAnalyticsRange,
    LocalProfileModelPerformance,
    LocalProfileProjectBreakdown,
    LocalProfileUsageBreakdown,
    LocalProfileUsageHour,
    ThinkingLevel,
    TurnOutcomeTaskType
  } from '$shared/types'
  import { STANDARD_THINKING_PRESETS } from '$shared/thinking-presets'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { getAgentIcon } from '$lib/agent-icons/registry'
  import { getProjectIcon, projectIconOnError } from '$lib/project-icons'
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'

  type ThinkingFilter = 'all' | ThinkingLevel | 'unknown'
  type TaskFilter = 'all' | TurnOutcomeTaskType
  type RangePreset = 'today' | '7d' | '30d' | 'year' | 'custom'

  interface CalendarDay {
    date: string
    count: number
    outsideRange: boolean
  }

  interface CalendarWeek {
    days: CalendarDay[]
    monthLabel: string
  }

  const RANGE_PRESETS: ReadonlyArray<{
    id: Exclude<RangePreset, 'custom'>
    label: string
    days: number
  }> = [
    { id: 'today', label: 'Today', days: 1 },
    { id: '7d', label: '7 days', days: 7 },
    { id: '30d', label: '30 days', days: 30 },
    { id: 'year', label: '12 months', days: 365 }
  ]

  function analyticsRange(days: number): LocalProfileAnalyticsRange {
    const end = new SvelteDate()
    end.setHours(0, 0, 0, 0)
    end.setDate(end.getDate() + 1)
    const start = new SvelteDate(end)
    start.setDate(end.getDate() - days)
    return { startAt: start.getTime(), endAt: end.getTime() }
  }

  function dateInputValue(value: number): string {
    return localDateKey(new SvelteDate(value))
  }

  function localDateFromInput(value: string): SvelteDate | null {
    const parts = value.split('-').map(Number)
    if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) return null
    const [year, month, day] = parts
    if (year === undefined || month === undefined || day === undefined) return null
    const date = new SvelteDate(year, month - 1, day)
    date.setHours(0, 0, 0, 0)
    return localDateKey(date) === value ? date : null
  }

  const DEFAULT_RANGE = analyticsRange(7)

  const EMPTY_USAGE: LocalProfileAnalytics = {
    range: DEFAULT_RANGE,
    messageCount: 0,
    costUsd: 0,
    tokens: 0,
    durationMs: 0,
    topHarnessId: null,
    topProviderId: null,
    topModelId: null,
    harnesses: [],
    providers: [],
    models: [],
    thinkingLevels: [],
    utilities: [],
    projects: [],
    activityDays: [],
    dailyUsage: [],
    hourlyUsage: [],
    modelPerformance: [],
    feedbackCost: {
      outcomes: 0,
      pricedOutcomes: 0,
      costUsd: 0,
      knownCostUsd: 0,
      estimatedCostUsd: 0,
      tokensTotal: 0
    },
    generatedAt: 0
  }

  let usage = $state<LocalProfileAnalytics>(EMPTY_USAGE)
  let accountState = $state<AccountProfileState>({ status: 'signed-out', profile: null })
  let loading = $state(true)
  let errorMessage = $state('')
  let signInOpen = $state(false)
  let signOutOpen = $state(false)
  let accountBusy = $state(false)
  let activeProvider = $state<AccountAuthProvider | null>(null)
  let signInError = $state('')
  let selectedRange = $state<LocalProfileAnalyticsRange>(DEFAULT_RANGE)
  let rangePreset = $state<RangePreset>('7d')
  let customStartDate = $state(dateInputValue(DEFAULT_RANGE.startAt))
  let customEndDate = $state(dateInputValue(DEFAULT_RANGE.endAt - 1))
  let projectIconUrls = $state<Record<string, string>>({})
  let usageRequestGeneration = 0

  const accountProfile = $derived(accountState.profile)
  const syncedDevices = $derived(
    accountProfile
      ? Object.values(accountProfile.usageByDevice).sort((a, b) => b.durationMs - a.durationMs)
      : []
  )
  const rangeLabel = $derived(formatDateRange(usage.range))
  const accountInitials = $derived.by(() => {
    const source = accountProfile?.displayName || accountProfile?.email || ''
    return source
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('')
  })

  const activityByDate = $derived(
    new Map(usage.activityDays.map((day) => [day.date, day.messageCount]))
  )
  const maxActivity = $derived(
    usage.activityDays.reduce((maximum, day) => Math.max(maximum, day.messageCount), 0)
  )
  const calendarWeeks = $derived.by(() => {
    const rangeStart = new SvelteDate(usage.range.startAt)
    const rangeEndDay = new SvelteDate(usage.range.endAt - 1)
    const start = new SvelteDate(rangeStart)
    start.setDate(rangeStart.getDate() - rangeStart.getDay())
    start.setHours(12, 0, 0, 0)
    const end = new SvelteDate(rangeEndDay)
    end.setDate(rangeEndDay.getDate() + (6 - rangeEndDay.getDay()))
    end.setHours(12, 0, 0, 0)

    const weeks: CalendarWeek[] = []
    let previousMonth = -1
    for (let weekIndex = 0; weekIndex < 54; weekIndex += 1) {
      const days: CalendarDay[] = []
      const firstDay = new SvelteDate(start)
      firstDay.setDate(start.getDate() + weekIndex * 7)
      if (firstDay.getTime() > end.getTime()) break
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
          outsideRange: date.getTime() < usage.range.startAt || date.getTime() >= usage.range.endAt
        })
      }
      weeks.push({ days, monthLabel })
    }
    return weeks
  })
  const calendarResponseCount = $derived(
    calendarWeeks.reduce(
      (total, week) =>
        total +
        week.days.reduce((weekTotal, day) => weekTotal + (day.outsideRange ? 0 : day.count), 0),
      0
    )
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
  const hourlyTimeline = $derived.by(() => {
    const byHour = new Map(usage.hourlyUsage.map((item) => [item.hour, item]))
    return Array.from({ length: 24 }, (_, hour): LocalProfileUsageHour => {
      return (
        byHour.get(hour) ?? {
          id: String(hour),
          hour,
          messageCount: 0,
          costUsd: 0,
          tokens: 0,
          durationMs: 0
        }
      )
    })
  })
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
  let taskFilter = $state<TaskFilter>('all')

  const mostUsedModel = $derived<LocalProfileUsageBreakdown | null>(usage.models[0] ?? null)
  const availableThinkingLevels = $derived(
    usage.models
      .map((model) => model.thinkingLevel ?? 'unknown')
      .filter((level, index, all) => all.indexOf(level) === index)
  )
  const filteredModels = $derived(
    usage.models.filter((model) =>
      thinkingFilter === 'all' ? true : (model.thinkingLevel ?? 'unknown') === thinkingFilter
    )
  )
  const filteredPerformance = $derived(
    usage.modelPerformance.filter((entry) =>
      taskFilter === 'all' ? true : entry.taskType === taskFilter
    )
  )

  function thinkingLevelLabel(level: ThinkingLevel | 'unknown'): string {
    if (level === 'unknown') return 'Unknown'
    return (
      STANDARD_THINKING_PRESETS.find((preset) => preset.id === level)?.label ??
      level.charAt(0).toUpperCase() + level.slice(1)
    )
  }

  function taskTypeLabel(taskType: TurnOutcomeTaskType): string {
    switch (taskType) {
      case 'main':
        return 'Main work'
      case 'audit':
        return 'Audit'
      case 'assignment':
        return 'Assignment'
    }
  }

  function successRateLabel(entry: LocalProfileModelPerformance): string {
    if (entry.outcomes === 0) return 'No sessions yet'
    return `${Math.round((entry.successRate ?? 0) * 100)}%`
  }

  function successRateWidth(entry: LocalProfileModelPerformance): string {
    const rate = entry.successRate
    if (rate === null) return '0%'
    return `${Math.max(4, Math.min(100, rate * 100))}%`
  }

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

  function utilityLabel(id: string): string {
    switch (id) {
      case 'image_descriptor':
        return 'Image descriptor'
      case 'memory':
        return 'Memory'
      case 'title':
        return 'Title generation'
      default:
        return id
    }
  }

  function platformLabel(platform: string): string {
    switch (platform) {
      case 'darwin':
        return 'macOS'
      case 'win32':
        return 'Windows'
      case 'linux':
        return 'Linux'
      default:
        return platform
    }
  }

  function formatDateRange(range: LocalProfileAnalyticsRange): string {
    const format = new Intl.DateTimeFormat(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    })
    return `${format.format(range.startAt)} – ${format.format(range.endAt - 1)}`
  }

  function formatDate(value: number): string {
    return new Intl.DateTimeFormat(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    }).format(value)
  }

  function formatUsageDate(value: string): string {
    const date = localDateFromInput(value)
    if (!date) return value
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date)
  }

  function formatHour(hour: number): string {
    const date = new SvelteDate(2000, 0, 1, hour)
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).format(date)
  }

  function formatDateTime(value: number): string {
    return new Intl.DateTimeFormat(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(value)
  }

  function formatIdentifier(value: string): string {
    return value
      .split(/[-_]/u)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ')
  }

  function activityClass(day: CalendarDay): string {
    if (day.outsideRange) return 'bg-transparent'
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

  function usageHeight(item: AccountUsageBreakdown, maximum: number): string {
    if (maximum <= 0 || item.tokens <= 0) return '2px'
    return `${Math.max(8, (item.tokens / maximum) * 100)}%`
  }

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

  function selectRangePreset(preset: Exclude<RangePreset, 'custom'>, days: number): void {
    rangePreset = preset
    selectedRange = analyticsRange(days)
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

  async function refreshAccount(showError = false): Promise<void> {
    if (accountBusy) return
    accountBusy = true
    if (showError) signInError = ''
    try {
      const state = await invoke('account:getProfile')
      accountState = state
      if (state.status === 'signed-in') {
        signInOpen = false
        accountState = await invoke('account:syncProfile')
      } else if (showError && state.status === 'pending') {
        signInError = 'Sign-in is not finished yet. Complete it in your browser, then check again.'
      }
    } catch {
      if (showError)
        signInError = 'The account service could not be reached. Try again in a moment.'
    } finally {
      accountBusy = false
    }
  }

  async function beginSignIn(provider: AccountAuthProvider): Promise<void> {
    if (accountBusy) return
    accountBusy = true
    activeProvider = provider
    signInError = ''
    try {
      const signIn = await invoke('account:beginSignIn', provider)
      accountState = { status: 'pending', profile: null }
      await invoke('shell:openExternal', signIn.url)
    } catch {
      accountState = { status: 'signed-out', profile: null }
      signInError = 'Sign-in could not be started. Check your connection and try again.'
    } finally {
      accountBusy = false
      activeProvider = null
    }
  }

  async function signOut(): Promise<void> {
    if (accountBusy) return
    accountBusy = true
    signInError = ''
    try {
      await invoke('account:signOut')
      accountState = { status: 'signed-out', profile: null }
      signInOpen = false
      signOutOpen = false
    } catch {
      signOutOpen = false
      signInError = 'Sign-out could not be completed. Try again in a moment.'
    } finally {
      accountBusy = false
    }
  }

  function handleWindowFocus(): void {
    if (accountState.status === 'pending') void refreshAccount()
  }

  onMount(() => {
    void loadUsage()
    void refreshAccount()
    return subscribe('account:profileChanged', (state) => {
      accountState = state
      if (state.status === 'signed-in') {
        signInOpen = false
        signInError = ''
      } else if (state.status === 'error') {
        signInOpen = true
        signInError = state.message
      }
    })
  })
</script>

<svelte:window onfocus={handleWindowFocus} />

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

      <Popover.Root open={signInOpen} onOpenChange={(open) => (signInOpen = open)}>
        <Popover.Trigger
          class="flex h-9 items-center gap-2 rounded-lg px-3 text-xs font-semibold {accountProfile
            ? 'border hover:bg-elevated'
            : 'bg-primary text-on-primary hover:bg-primary-hover'}"
          title={accountProfile ? `Signed in as ${accountProfile.email}` : 'Sign in to CodeInOven'}
          aria-label={accountProfile
            ? `Signed in as ${accountProfile.displayName || accountProfile.email}`
            : 'Sign in to CodeInOven'}
        >
          {#if accountProfile}
            {#if accountProfile.image}
              <img class="h-5 w-5 rounded-full object-cover" src={accountProfile.image} alt="" />
            {:else}
              <span
                class="grid h-5 w-5 place-items-center rounded-full bg-primary text-[9px] font-bold text-on-primary"
                aria-hidden="true">{accountInitials}</span
              >
            {/if}
            <span class="max-w-32 truncate">{accountProfile.displayName}</span>
          {:else if accountState.status === 'pending'}
            <RefreshCw size={14} class="animate-spin" /> Sign-in pending
          {:else}
            <LogIn size={14} /> Sign in
          {/if}
        </Popover.Trigger>

        <Popover.Portal>
          <Popover.Content
            side="bottom"
            align="end"
            sideOffset={8}
            collisionPadding={16}
            class="z-50 w-80 rounded-xl border bg-surface p-4 shadow-xl outline-none"
          >
            {#if accountProfile}
              <div class="flex items-center gap-3">
                <span
                  class="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-full bg-primary text-xs font-bold text-on-primary"
                >
                  {#if accountProfile.image}
                    <img class="h-full w-full object-cover" src={accountProfile.image} alt="" />
                  {:else}
                    {accountInitials}
                  {/if}
                </span>
                <div class="min-w-0">
                  <p class="truncate text-sm font-semibold">{accountProfile.displayName}</p>
                  <p class="truncate text-xs text-muted">{accountProfile.email}</p>
                </div>
                <Check size={16} class="ml-auto shrink-0 text-primary" aria-hidden="true" />
              </div>
              <p class="mt-3 text-xs leading-relaxed text-muted">
                Your account is connected. Local analytics remain available on this device.
              </p>
              {#if signInError}
                <p class="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
                  {signInError}
                </p>
              {/if}
              <button
                type="button"
                class="mt-3 flex h-9 w-full items-center justify-center gap-2 rounded-lg border text-xs font-semibold text-danger transition-colors hover:bg-danger/10 disabled:opacity-50"
                title="Sign out of CodeInOven"
                disabled={accountBusy}
                onclick={() => (signOutOpen = true)}
              >
                <LogOut size={14} />
                Sign out
              </button>
            {:else if accountState.status === 'pending'}
              <p class="text-sm font-semibold">Finish signing in</p>
              <p class="mt-1 text-xs leading-relaxed text-muted">
                Complete Google or Apple sign-in in your browser. CodeInOven will detect the secure
                callback automatically.
              </p>
              {#if signInError}
                <p class="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
                  {signInError}
                </p>
              {/if}
              <button
                type="button"
                class="mt-4 flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-primary px-3 text-xs font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50"
                disabled={accountBusy}
                onclick={() => void refreshAccount(true)}
              >
                <RefreshCw size={14} class={accountBusy ? 'animate-spin' : ''} />
                Check sign-in status
              </button>
            {:else}
              <p class="text-sm font-semibold">Sign in to CodeInOven</p>
              <p class="mt-1 text-xs leading-relaxed text-muted">
                Continue with Google or Apple. If your account does not exist, it is created
                automatically.
              </p>
              {#if signInError}
                <p class="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
                  {signInError}
                </p>
              {/if}
              <div class="mt-4 space-y-2">
                <button
                  type="button"
                  class="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-primary px-3 text-xs font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50"
                  disabled={accountBusy}
                  onclick={() => void beginSignIn('google')}
                >
                  <VendorIcon name="Google" size={16} />
                  {activeProvider === 'google' ? 'Opening Google…' : 'Continue with Google'}
                </button>
                <button
                  type="button"
                  class="flex h-10 w-full items-center justify-center gap-2 rounded-lg border px-3 text-xs font-semibold hover:bg-elevated disabled:opacity-50"
                  disabled={accountBusy}
                  onclick={() => void beginSignIn('apple')}
                >
                  <VendorIcon name="Apple" size={16} />
                  {activeProvider === 'apple' ? 'Opening Apple…' : 'Continue with Apple'}
                </button>
              </div>
            {/if}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
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

  <section class="mb-4 rounded-xl border bg-surface p-3" aria-labelledby="usage-range-heading">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2
          id="usage-range-heading"
          class="text-xs font-semibold uppercase tracking-wide text-muted"
        >
          Reporting period
        </h2>
        <p class="mt-0.5 text-xs tabular-nums text-dimmed">{rangeLabel}</p>
      </div>
      <div class="flex flex-wrap items-center gap-1" role="group" aria-label="Usage date range">
        {#each RANGE_PRESETS as preset (preset.id)}
          <button
            type="button"
            class="h-8 rounded-lg px-3 text-xs font-medium transition-colors {rangePreset ===
            preset.id
              ? 'bg-overlay text-foreground'
              : 'text-muted hover:bg-elevated hover:text-foreground'}"
            aria-pressed={rangePreset === preset.id}
            disabled={loading}
            onclick={() => selectRangePreset(preset.id, preset.days)}
          >
            {preset.label}
          </button>
        {/each}
        <button
          type="button"
          class="h-8 rounded-lg px-3 text-xs font-medium transition-colors {rangePreset === 'custom'
            ? 'bg-overlay text-foreground'
            : 'text-muted hover:bg-elevated hover:text-foreground'}"
          aria-pressed={rangePreset === 'custom'}
          onclick={showCustomRange}
        >
          Custom
        </button>
      </div>
    </div>
    {#if rangePreset === 'custom'}
      <div class="mt-3 flex flex-wrap items-end gap-2 border-t pt-3">
        <label class="grid gap-1 text-[11px] font-medium text-muted">
          Start date
          <input
            type="date"
            class="h-9 rounded-lg border bg-elevated px-2.5 text-xs tabular-nums text-foreground outline-none focus:border-primary"
            max={customEndDate}
            bind:value={customStartDate}
          />
        </label>
        <label class="grid gap-1 text-[11px] font-medium text-muted">
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
  </section>

  <section class="grid grid-cols-2 gap-3 xl:grid-cols-4" aria-label="Local usage totals">
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
      <p class="mt-2 text-2xl font-bold tabular-nums">{usage.activityDays.length}</p>
      <p class="mt-1 text-xs text-dimmed">{formatDuration(usage.durationMs)} of agent runtime</p>
    </div>
  </section>

  {#if accountProfile}
    <section class="mt-4 rounded-xl border" aria-labelledby="devices-heading">
      <div class="border-b px-4 py-3">
        <h2 id="devices-heading" class="text-sm font-semibold">Devices</h2>
        <p class="mt-0.5 text-xs text-muted">
          Synced usage from every device signed in to this account.
        </p>
      </div>
      {#if syncedDevices.length > 0}
        <div class="grid gap-4 p-4 lg:grid-cols-2">
          {#each syncedDevices as device (device.deviceId)}
            <article class="rounded-xl border p-4">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <p class="truncate text-sm font-semibold">{device.deviceLabel}</p>
                  <p class="mt-0.5 text-[11px] text-dimmed">
                    {platformLabel(device.platform)} · last synced {formatDateTime(
                      device.updatedAt
                    )}
                  </p>
                </div>
                <span
                  class="shrink-0 rounded-md bg-raised px-2 py-1 text-[10px] font-medium tabular-nums text-muted"
                  title="Total agent runtime"
                >
                  {formatDuration(device.durationMs)}
                </span>
              </div>
              <dl class="mt-4 grid grid-cols-4 gap-2 text-xs">
                <div>
                  <dt class="text-dimmed">Sessions</dt>
                  <dd class="mt-0.5 font-semibold tabular-nums">
                    {formatNumber(device.messageCount)}
                  </dd>
                </div>
                <div>
                  <dt class="text-dimmed">Tokens</dt>
                  <dd class="mt-0.5 font-semibold tabular-nums">{formatNumber(device.tokens)}</dd>
                </div>
                <div>
                  <dt class="text-dimmed">Cost</dt>
                  <dd class="mt-0.5 font-semibold tabular-nums">{formatCost(device.costUsd)}</dd>
                </div>
                <div>
                  <dt class="text-dimmed">Active days</dt>
                  <dd class="mt-0.5 font-semibold tabular-nums">{device.activeDays}</dd>
                </div>
              </dl>
              {#if device.projects.length > 0}
                <div class="mt-4 border-t pt-3">
                  <p class="text-[11px] font-semibold uppercase tracking-wide text-muted">
                    Top projects
                  </p>
                  <ul class="mt-2 space-y-1.5">
                    {#each device.projects.slice(0, 4) as project (project.id)}
                      <li class="flex items-center justify-between gap-3 text-xs">
                        <span class="min-w-0 truncate font-medium">{project.name}</span>
                        <span class="shrink-0 tabular-nums text-muted">
                          {formatNumber(project.messageCount)} sessions · {formatDuration(
                            project.durationMs
                          )}
                        </span>
                      </li>
                    {/each}
                  </ul>
                </div>
              {/if}
            </article>
          {/each}
        </div>
      {:else}
        <p class="px-4 py-8 text-center text-xs text-muted">
          No device usage has been synced yet. It appears after your first signed-in agent session.
        </p>
      {/if}
    </section>
  {/if}

  {#if mostUsedModel}
    <section class="mt-4 rounded-xl border" aria-labelledby="most-used-heading">
      <div class="border-b px-4 py-3">
        <h2 id="most-used-heading" class="text-sm font-semibold">Most used model</h2>
        <p class="mt-0.5 text-xs text-muted">Your top model across projects in this period.</p>
      </div>
      <div class="flex flex-wrap items-center gap-x-6 gap-y-4 px-4 py-4">
        <div class="flex min-w-0 items-center gap-3">
          {#if getAgentIcon(mostUsedModel.harnessId)}
            <img
              class="h-10 w-10 shrink-0 rounded-lg object-contain"
              src={getAgentIcon(mostUsedModel.harnessId)?.iconUrl}
              alt=""
            />
          {:else}
            <span class="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-elevated">
              <VendorIcon name={mostUsedModel.providerId ?? mostUsedModel.id} size={18} />
            </span>
          {/if}
          <div class="min-w-0">
            <p class="flex items-center gap-2 truncate text-base font-semibold">
              <span class="truncate">{mostUsedModel.id}</span>
              {#if mostUsedModel.thinkingLevel}
                <span
                  class="flex shrink-0 items-center gap-1 rounded-md bg-elevated px-1.5 py-0.5 text-[10px] capitalize text-muted"
                  title={`Thinking level: ${mostUsedModel.thinkingLevel}`}
                  aria-label={`Thinking level: ${mostUsedModel.thinkingLevel}`}
                >
                  <Brain size={10} />
                  {thinkingLevelLabel(mostUsedModel.thinkingLevel)}
                </span>
              {/if}
            </p>
            <p class="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
              <VendorIcon name={mostUsedModel.providerId ?? mostUsedModel.id} size={13} />
              <span class="truncate">
                {formatIdentifier(mostUsedModel.providerId ?? '')} · {formatIdentifier(
                  mostUsedModel.harnessId ?? ''
                )}
              </span>
            </p>
          </div>
        </div>
        <dl class="ml-auto grid flex-1 grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-4">
          <div>
            <dt class="text-[11px] text-dimmed">Responses</dt>
            <dd class="mt-0.5 text-sm font-semibold tabular-nums">
              {formatNumber(mostUsedModel.messageCount)}
            </dd>
          </div>
          <div>
            <dt class="text-[11px] text-dimmed">Tokens</dt>
            <dd class="mt-0.5 text-sm font-semibold tabular-nums">
              {formatNumber(mostUsedModel.tokens)}
            </dd>
          </div>
          <div>
            <dt class="text-[11px] text-dimmed">Estimated cost</dt>
            <dd class="mt-0.5 text-sm font-semibold tabular-nums">
              {formatCost(mostUsedModel.costUsd)}
            </dd>
          </div>
          <div>
            <dt class="text-[11px] text-dimmed">Runtime</dt>
            <dd class="mt-0.5 text-sm font-semibold tabular-nums">
              {formatDuration(mostUsedModel.durationMs)}
            </dd>
          </div>
        </dl>
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
            <p class="text-[10px] font-semibold uppercase tracking-wide text-dimmed">Peak day</p>
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
            <p class="text-[10px] font-semibold uppercase tracking-wide text-dimmed">Peak</p>
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
      <div class="mt-2 grid grid-cols-4 text-[10px] tabular-nums text-dimmed" aria-hidden="true">
        <span>12 AM</span><span class="text-center">6 AM</span><span class="text-center">12 PM</span
        ><span class="text-right">6 PM</span>
      </div>
      <p class="mt-3 border-t pt-3 text-[11px] text-dimmed">
        Gold marks the busiest hour; shorter bars show non-peak consumption.
      </p>
    </section>
  </div>

  <section class="mt-4 overflow-hidden rounded-xl border p-4" aria-labelledby="activity-heading">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 id="activity-heading" class="text-sm font-semibold">Active days</h2>
        <p class="mt-0.5 text-xs text-muted">
          {formatNumber(calendarResponseCount)} agent responses during the selected period.
        </p>
      </div>
      <span
        class="rounded-lg bg-raised px-2.5 py-1.5 text-[11px] font-medium tabular-nums text-muted"
      >
        {rangeLabel}
      </span>
    </div>

    <div class="mt-5 overflow-x-auto pb-2">
      <div class="min-w-[46rem]">
        <div class="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-2">
          <span aria-hidden="true"></span>
          <div
            class="activity-columns gap-1"
            style:--calendar-weeks={calendarWeeks.length}
            aria-hidden="true"
          >
            {#each calendarWeeks as week, index (`month-${index}`)}
              <span class="min-w-0 overflow-visible whitespace-nowrap text-[10px] text-dimmed">
                {week.monthLabel}
              </span>
            {/each}
          </div>
          <div
            class="grid w-6 shrink-0 grid-rows-7 gap-1 text-[10px] leading-2.5 text-dimmed"
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
              <div class="flex min-w-0 flex-col gap-1">
                {#each week.days as day (day.date)}
                  <span
                    class="aspect-square w-full rounded-sm {activityClass(day)}"
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
              <p class="mt-0.5 text-[11px] text-dimmed">
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
          <p class="mt-3 truncate text-[11px] tabular-nums text-muted">
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
                <VendorIcon name={provider.id} size={16} />
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
            <p class="mt-1.5 text-[11px] tabular-nums text-dimmed">
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
                <Brain size={15} class="text-muted" />
                {thinkingLevelLabel(level.thinkingLevel ?? 'unknown')}
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
            <p class="mt-1.5 text-[11px] tabular-nums text-dimmed">
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
              class="flex h-7 items-center gap-1 rounded-lg px-2.5 text-[11px] font-medium {thinkingFilter ===
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
                class="flex h-7 items-center gap-1 rounded-lg px-2.5 text-[11px] font-medium capitalize {thinkingFilter ===
                level
                  ? 'bg-overlay text-foreground'
                  : 'text-muted hover:bg-elevated hover:text-foreground'}"
                aria-pressed={thinkingFilter === level}
                onclick={() => (thinkingFilter = level)}
              >
                {#if level !== 'unknown'}
                  <Brain size={11} />
                {/if}
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
                <VendorIcon name={model.providerId ?? model.id} size={15} />
                <span class="truncate">{model.id}</span>
                {#if model.thinkingLevel}
                  <span
                    class="flex shrink-0 items-center gap-1 rounded-md bg-elevated px-1.5 py-0.5 text-[9px] capitalize text-muted"
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

  <section class="mt-4 rounded-xl border" aria-labelledby="model-performance-heading">
    <div class="border-b px-4 py-3">
      <h2 id="model-performance-heading" class="text-sm font-semibold">Best model by feedback</h2>
      <p class="mt-0.5 text-xs text-muted">
        Success rate from your sessions: continuing positively, switching context, or leaving the
        thread until cleanup scores a pass; a corrective follow-up scores a miss.
      </p>
      {#if usage.feedbackCost.outcomes > 0}
        <p class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span class="font-semibold tabular-nums text-foreground">
            {formatCost(usage.feedbackCost.costUsd)} spent
          </span>
          <span class="text-dimmed">
            across {usage.feedbackCost.outcomes} scored sessions{usage.feedbackCost.pricedOutcomes <
            usage.feedbackCost.outcomes
              ? ` · ${usage.feedbackCost.outcomes - usage.feedbackCost.pricedOutcomes} without a reported cost`
              : ''}
          </span>
        </p>
      {/if}
      {#if usage.modelPerformance.length > 0}
        <div
          class="mt-3 flex flex-wrap items-center gap-1"
          role="group"
          aria-label="Filter model performance by task type"
        >
          <button
            type="button"
            class="flex h-7 items-center rounded-lg px-2.5 text-[11px] font-medium {taskFilter ===
            'all'
              ? 'bg-overlay text-foreground'
              : 'text-muted hover:bg-elevated hover:text-foreground'}"
            aria-pressed={taskFilter === 'all'}
            onclick={() => (taskFilter = 'all')}
          >
            All tasks
          </button>
          {#each ['main', 'audit', 'assignment'] as task (task)}
            <button
              type="button"
              class="flex h-7 items-center rounded-lg px-2.5 text-[11px] font-medium {taskFilter ===
              task
                ? 'bg-overlay text-foreground'
                : 'text-muted hover:bg-elevated hover:text-foreground'}"
              aria-pressed={taskFilter === task}
              onclick={() => (taskFilter = task as TaskFilter)}
            >
              {taskTypeLabel(task as TurnOutcomeTaskType)}
            </button>
          {/each}
        </div>
      {/if}
    </div>
    <div class="divide-y">
      {#each filteredPerformance.slice(0, 10) as entry (`${entry.harnessId}:${entry.providerId}:${entry.modelId}:${entry.thinkingLevel}:${entry.taskType}`)}
        <div class="px-4 py-3">
          <div class="flex items-center justify-between gap-4 text-xs">
            <span class="flex min-w-0 items-center gap-1.5 truncate font-semibold">
              {#if getAgentIcon(entry.harnessId)}
                <img
                  class="h-4 w-4 shrink-0 object-contain"
                  src={getAgentIcon(entry.harnessId)?.iconUrl}
                  alt=""
                />
              {/if}
              <VendorIcon name={entry.providerId || entry.modelId} size={15} />
              <span class="truncate">{entry.modelId}</span>
              {#if entry.thinkingLevel}
                <span
                  class="flex shrink-0 items-center gap-1 rounded-md bg-elevated px-1.5 py-0.5 text-[9px] capitalize text-muted"
                  title={`Thinking level: ${entry.thinkingLevel}`}
                  aria-label={`Thinking level: ${entry.thinkingLevel}`}
                >
                  <Brain size={9} />
                  {entry.thinkingLevel}
                </span>
              {/if}
              <span class="shrink-0 rounded-md bg-raised px-1.5 py-0.5 text-[9px] text-muted">
                {taskTypeLabel(entry.taskType)}
              </span>
            </span>
            <span class="shrink-0 tabular-nums text-muted">
              {successRateLabel(entry)}
            </span>
          </div>
          <div class="mt-2 h-1 overflow-hidden rounded-full bg-raised">
            <div
              class="h-full rounded-full {entry.successRate !== null && entry.successRate >= 0.5
                ? 'bg-primary'
                : 'bg-danger/70'}"
              style:width={successRateWidth(entry)}
            ></div>
          </div>
          <p class="mt-1.5 text-[11px] tabular-nums text-dimmed">
            {entry.outcomes} sessions · {entry.successes} passed{entry.corrected > 0
              ? ` · ${entry.corrected} corrected`
              : ''}{entry.costUsd > 0 ? ` · ${formatCost(entry.costUsd)} total` : ''}
          </p>
        </div>
      {:else}
        <p class="px-4 py-8 text-center text-xs text-muted">
          Scores and their cost appear as you use agents: after a turn, continuing or moving on
          counts as a pass, and a corrective follow-up counts as a miss.
        </p>
      {/each}
    </div>
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

<AlertDialog.Root open={signOutOpen} onOpenChange={(open) => (signOutOpen = open)}>
  <AlertDialog.Portal>
    <AlertDialog.Overlay class="fixed inset-0 z-50 bg-overlay/70" />
    <AlertDialog.Content
      class="fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-xl"
    >
      <AlertDialog.Title class="text-sm font-semibold text-foreground">
        Sign out of CodeInOven?
      </AlertDialog.Title>
      <AlertDialog.Description class="mt-2 text-xs leading-5 text-muted">
        Your saved profile will be removed from this device and you will be signed out. You can sign
        in again anytime.
      </AlertDialog.Description>
      <div class="mt-5 flex justify-end gap-2">
        <AlertDialog.Cancel
          class="h-8 cursor-pointer rounded-lg border border-border px-3 text-xs text-foreground hover:bg-elevated"
        >
          Cancel
        </AlertDialog.Cancel>
        <AlertDialog.Action
          class="h-8 cursor-pointer rounded-lg bg-danger px-3 text-xs font-medium text-on-primary hover:opacity-90"
          onclick={() => void signOut()}
        >
          Sign out
        </AlertDialog.Action>
      </div>
    </AlertDialog.Content>
  </AlertDialog.Portal>
</AlertDialog.Root>

<style>
  .hourly-columns {
    display: grid;
    grid-template-columns: repeat(24, minmax(0, 1fr));
  }

  .activity-columns {
    display: grid;
    grid-template-columns: repeat(var(--calendar-weeks), minmax(0, 1fr));
  }
</style>
