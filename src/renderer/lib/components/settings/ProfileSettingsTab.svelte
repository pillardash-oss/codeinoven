<script lang="ts">
  import { onMount } from 'svelte'
  import { SvelteDate } from 'svelte/reactivity'
  import { Cloud, RefreshCw, UserRound } from '@lucide/svelte'
  import { APP_NAME } from '$shared/brand'
  import type {
    AccountAuthProvider,
    AccountProfile,
    AccountProfileState,
    AccountUsageSummary
  } from '$shared/types'
  import { invoke } from '$lib/ipc.svelte'
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'

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

  let accountState = $state<AccountProfileState>({ status: 'signed-out', profile: null })
  let loading = $state(true)
  let busy = $state(false)
  let errorMessage = $state('')
  let pollTimer: ReturnType<typeof setTimeout> | null = null

  const profile = $derived<AccountProfile | null>(accountState.profile)
  const usage = $derived(profile?.usage ?? EMPTY_USAGE)
  const activityByDate = $derived(
    new Map(usage.activityDays.map((day) => [day.date, day.messageCount]))
  )
  const calendarDays = $derived.by(() => {
    const days: Array<{ date: string; count: number }> = []
    const today = new SvelteDate()
    today.setHours(12, 0, 0, 0)
    for (let offset = 363; offset >= 0; offset -= 1) {
      const date = new SvelteDate(today)
      date.setDate(today.getDate() - offset)
      const key = date.toLocaleDateString('en-CA')
      days.push({ date: key, count: activityByDate.get(key) ?? 0 })
    }
    return days
  })
  const initials = $derived.by(() => {
    const source = profile?.displayName || profile?.email || APP_NAME
    return source
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('')
  })

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

  function activityClass(count: number): string {
    if (count <= 0) return 'bg-raised'
    if (count <= 2) return 'bg-primary/25'
    if (count <= 5) return 'bg-primary/50'
    if (count <= 10) return 'bg-primary/75'
    return 'bg-primary'
  }

  function scheduleProfilePoll(): void {
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = setTimeout(() => void refreshProfile(true), 2_000)
  }

  async function refreshProfile(polling = false): Promise<void> {
    if (!polling) busy = true
    errorMessage = ''
    try {
      const state = await invoke('account:getProfile')
      accountState = state.status === 'signed-in' ? await invoke('account:syncProfile') : state
      if (accountState.status === 'pending') scheduleProfilePoll()
    } catch {
      errorMessage = 'The account service could not be reached. Try again in a moment.'
      if (polling || loading) scheduleProfilePoll()
    } finally {
      loading = false
      if (!polling) busy = false
    }
  }

  async function beginSignIn(provider: AccountAuthProvider): Promise<void> {
    if (busy) return
    busy = true
    errorMessage = ''
    try {
      const signIn = await invoke('account:beginSignIn', provider)
      accountState = { status: 'pending', profile: null }
      await invoke('shell:openExternal', signIn.url)
      scheduleProfilePoll()
    } catch {
      errorMessage = 'Sign-in could not be started. Check your connection and try again.'
      accountState = { status: 'signed-out', profile: null }
    } finally {
      busy = false
    }
  }

  onMount(() => {
    void refreshProfile()
    return () => {
      if (pollTimer) clearTimeout(pollTimer)
    }
  })
</script>

<div class="mx-auto max-w-5xl p-6 pb-24">
  <div class="mb-6 flex items-start justify-between gap-4">
    <div>
      <h1 class="text-xl font-bold tracking-tight">Profile</h1>
      <p class="mt-0.5 text-sm text-muted">Account, usage, activity, and cloud continuity.</p>
    </div>
    {#if profile}
      <button
        type="button"
        class="flex h-9 items-center gap-2 rounded-lg border bg-surface px-3 text-xs font-semibold hover:bg-elevated disabled:opacity-50"
        disabled={busy}
        onclick={() => void refreshProfile()}
      >
        <RefreshCw size={14} class={busy ? 'animate-spin' : ''} />
        Sync now
      </button>
    {/if}
  </div>

  <div class="relative min-h-[620px]">
    <div class="space-y-4" aria-hidden={!profile}>
      <section class="flex items-center gap-4 rounded-xl border bg-surface p-5">
        {#if profile?.image}
          <img
            class="h-16 w-16 rounded-full border object-cover"
            src={profile.image}
            alt={`${profile.displayName} profile`}
          />
        {:else}
          <div
            class="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-primary text-lg font-bold text-on-primary"
            aria-label="Profile initials"
          >
            {#if profile}
              {initials}
            {:else}
              <UserRound size={22} />
            {/if}
          </div>
        {/if}
        <div class="min-w-0">
          <h2 class="truncate text-lg font-semibold">{profile?.displayName ?? 'Your name'}</h2>
          <p class="truncate text-sm text-muted">{profile?.email ?? 'you@example.com'}</p>
          <p class="mt-1 flex items-center gap-1.5 text-xs text-dimmed">
            <Cloud size={13} />
            {profile
              ? `${profile.globalMemories.length} global memories stored online`
              : 'Global memories and remote access stored online'}
          </p>
        </div>
      </section>

      <section class="grid grid-cols-2 gap-3 xl:grid-cols-4" aria-label="Usage totals">
        <div class="rounded-xl border bg-surface p-4">
          <p class="text-xs font-semibold uppercase tracking-wide text-muted">Tokens</p>
          <p class="mt-2 text-2xl font-bold tabular-nums">{formatNumber(usage.tokens)}</p>
        </div>
        <div class="rounded-xl border bg-surface p-4">
          <p class="text-xs font-semibold uppercase tracking-wide text-muted">Cost</p>
          <p class="mt-2 text-2xl font-bold tabular-nums">{formatCost(usage.costUsd)}</p>
        </div>
        <div class="rounded-xl border bg-surface p-4">
          <p class="text-xs font-semibold uppercase tracking-wide text-muted">Responses</p>
          <p class="mt-2 text-2xl font-bold tabular-nums">{formatNumber(usage.messageCount)}</p>
        </div>
        <div class="rounded-xl border bg-surface p-4">
          <p class="text-xs font-semibold uppercase tracking-wide text-muted">Active days</p>
          <p class="mt-2 text-2xl font-bold tabular-nums">{usage.activityDays.length}</p>
        </div>
      </section>

      <section class="grid gap-4 lg:grid-cols-3">
        <div class="rounded-xl border bg-surface p-4">
          <h3 class="text-sm font-semibold">Most used</h3>
          <dl class="mt-4 space-y-3 text-sm">
            <div class="flex items-center justify-between gap-4">
              <dt class="text-muted">Harness</dt>
              <dd class="truncate font-semibold">{usage.topHarnessId ?? 'No usage yet'}</dd>
            </div>
            <div class="flex items-center justify-between gap-4">
              <dt class="text-muted">Model</dt>
              <dd class="truncate font-semibold">{usage.topModelId ?? 'No usage yet'}</dd>
            </div>
          </dl>
        </div>
        <div class="rounded-xl border bg-surface p-4">
          <h3 class="text-sm font-semibold">Harness usage</h3>
          <div class="mt-3 space-y-2">
            {#each usage.harnesses.slice(0, 4) as harness (harness.id)}
              <div class="flex items-center justify-between gap-3 text-xs">
                <span class="truncate font-medium">{harness.id}</span>
                <span class="shrink-0 tabular-nums text-muted">
                  {formatNumber(harness.tokens)} tokens
                </span>
              </div>
            {:else}
              <p class="text-xs text-muted">Usage appears after your first agent response.</p>
            {/each}
          </div>
        </div>
        <div class="rounded-xl border bg-surface p-4">
          <h3 class="text-sm font-semibold">Model usage</h3>
          <div class="mt-3 space-y-2">
            {#each usage.models.slice(0, 4) as model (model.id)}
              <div class="flex items-center justify-between gap-3 text-xs">
                <span class="truncate font-medium">{model.id}</span>
                <span class="shrink-0 tabular-nums text-muted">
                  {formatNumber(model.tokens)} tokens
                </span>
              </div>
            {:else}
              <p class="text-xs text-muted">Model usage appears after a reported response.</p>
            {/each}
          </div>
        </div>
      </section>

      <section class="overflow-hidden rounded-xl border bg-surface p-4">
        <div class="flex items-center justify-between gap-4">
          <div>
            <h3 class="text-sm font-semibold">Activity</h3>
            <p class="mt-0.5 text-xs text-muted">Agent responses over the last 52 weeks.</p>
          </div>
          <span class="text-xs tabular-nums text-dimmed"
            >{usage.activityDays.length} active days</span
          >
        </div>
        <div class="mt-4 overflow-x-auto pb-1">
          <div
            class="grid w-max grid-flow-col grid-rows-7 gap-1"
            aria-label="Account activity calendar"
          >
            {#each calendarDays as day (day.date)}
              <span
                class="h-2.5 w-2.5 rounded-sm {activityClass(day.count)}"
                title={`${day.date}: ${day.count} responses`}
                aria-label={`${day.date}: ${day.count} responses`}
              ></span>
            {/each}
          </div>
        </div>
      </section>
    </div>

    {#if !profile}
      <section
        class="absolute inset-0 z-10 flex min-h-[620px] items-center justify-center rounded-xl bg-primary/95 p-6 text-on-primary backdrop-blur-sm"
        aria-label="Sign in to view profile"
      >
        <div class="w-full max-w-xs text-center">
          <img class="mx-auto h-20 w-20 rounded-2xl" src="/logo.png" alt={APP_NAME} />
          <h2 class="mt-5 text-lg font-semibold">Profile</h2>
          <p class="mt-1 text-sm text-on-primary/70">
            {accountState.status === 'pending'
              ? 'Finish signing in in your browser.'
              : `Sign in to continue ${APP_NAME} on any device.`}
          </p>

          {#if errorMessage}
            <p class="mt-4 rounded-lg bg-danger px-3 py-2 text-xs text-on-primary" role="alert">
              {errorMessage}
            </p>
          {/if}

          <div class="mt-6 space-y-2">
            <button
              class="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-surface px-4 text-sm font-semibold text-foreground hover:bg-elevated disabled:opacity-50"
              type="button"
              disabled={busy || loading || accountState.status === 'pending'}
              onclick={() => void beginSignIn('google')}
            >
              <VendorIcon name="Google" size={16} /> Continue with Google
            </button>
            <button
              class="flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-on-primary/25 px-4 text-sm font-semibold text-on-primary hover:bg-on-primary/10 disabled:opacity-50"
              type="button"
              disabled={busy || loading || accountState.status === 'pending'}
              onclick={() => void beginSignIn('apple')}
            >
              <VendorIcon name="Apple" size={16} /> Continue with Apple
            </button>
          </div>
        </div>
      </section>
    {/if}
  </div>
</div>
