<script lang="ts">
  import { onMount } from 'svelte'
  import { SvelteDate } from 'svelte/reactivity'
  import { Check, LogIn, RefreshCw } from '@lucide/svelte'
  import { Popover } from 'bits-ui'
  import type {
    AccountAuthProvider,
    AccountProfileState,
    AccountUsageBreakdown,
    AccountUsageSummary
  } from '$shared/types'
  import { invoke } from '$lib/ipc.svelte'
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'

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
  let accountState = $state<AccountProfileState>({ status: 'signed-out', profile: null })
  let loading = $state(true)
  let errorMessage = $state('')
  let signInOpen = $state(false)
  let accountBusy = $state(false)
  let activeProvider = $state<AccountAuthProvider | null>(null)
  let signInError = $state('')

  const accountProfile = $derived(accountState.profile)
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

  function handleWindowFocus(): void {
    if (accountState.status === 'pending') void refreshAccount()
  }

  onMount(() => {
    void loadUsage()
    void refreshAccount()
  })
</script>

<svelte:window onfocus={handleWindowFocus} />

<div class="w-full p-6 pb-24">
  <div class="mb-6 flex items-start justify-between gap-4">
    <div>
      <h1 class="text-xl font-bold tracking-tight">Profile</h1>
      <p class="mt-0.5 text-sm text-muted">Your local activity and agent usage at a glance.</p>
    </div>
    <div class="flex items-center gap-2">
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
            {:else if accountState.status === 'pending'}
              <p class="text-sm font-semibold">Finish signing in</p>
              <p class="mt-1 text-xs leading-relaxed text-muted">
                Complete Google or Apple sign-in in your browser, then return to CodeInOven.
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
      <div class="min-w-[46rem]">
        <div class="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-2">
          <span aria-hidden="true"></span>
          <div class="grid grid-cols-[repeat(52,minmax(0,1fr))] gap-1" aria-hidden="true">
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
            class="grid grid-cols-[repeat(52,minmax(0,1fr))] gap-1"
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
