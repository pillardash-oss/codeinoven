<script lang="ts">
  import CioArrowLeft from '@pdslng/cio-icon/CioArrowLeft.svelte'
  import CioEye from '@pdslng/cio-icon/CioEye.svelte'
  import CioEyeOff from '@pdslng/cio-icon/CioEyeOff.svelte'
  import CioLogIn from '@pdslng/cio-icon/CioLogIn.svelte'
  import CioPencil from '@pdslng/cio-icon/CioPencil.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import CioStar from '@pdslng/cio-icon/CioStar.svelte'
  import CioUnplug from '@pdslng/cio-icon/CioUnplug.svelte'
  import AgentIcon from '$lib/agent-icons/AgentIcon.svelte'
  import {
    formatResetCountdown,
    creditsLabel,
    formatExpiry,
    sortRateLimitWindows
  } from '$lib/format/usage'
  import { formatCompactAge } from '$shared/date-time-format'
  import type { HarnessAccount } from '$shared/types'
  import { isCodeInOvenCustomProviderId } from '$shared/custom-provider-id'
  import { harnessAccountUsageCache } from '$lib/stores/harness-account-usage.svelte'
  import {
    meterClass,
    percentClass,
    quotaHeat,
    windowPercent,
    windowScopeLabel
  } from './harness-account-presentation'

  interface Props {
    account: HarnessAccount
    harnessName: string
    canMakeDefault: boolean
    hiddenBusy: boolean
    defaultBusy: boolean
    onBack: () => void
    onEdit: () => void
    onDisconnect: () => void
    onToggleHidden: () => void
    onSignIn: () => void
    onMakeDefault: () => void
  }

  let {
    account,
    harnessName,
    canMakeDefault,
    hiddenBusy,
    defaultBusy,
    onBack,
    onEdit,
    onDisconnect,
    onToggleHidden,
    onSignIn,
    onMakeDefault
  }: Props = $props()

  const snapshot = $derived(harnessAccountUsageCache.snapshotFor(account.id))
  const usage = $derived(snapshot?.usage ?? null)
  const windows = $derived(sortRateLimitWindows(usage?.rateLimits ?? []))
  const expired = $derived(snapshot?.reauthenticationRequired === true)
  const custom = $derived(isCodeInOvenCustomProviderId(account.providerId))
  const credits = $derived(usage ? creditsLabel(usage) : undefined)
  const banked = $derived(usage?.bankedResets)
  const bankedCredits = $derived(banked?.credits ?? [])
  const checkedLabel = $derived(
    snapshot !== undefined && snapshot.fetchedAt > 0 ? formatCompactAge(snapshot.fetchedAt) : ''
  )
  const providerLabel = $derived(account.providerName || account.providerId)
</script>

<div class="flex min-h-0 flex-col">
  <div
    class="relative grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2.5 gap-y-2 border-b px-4 py-3.5 lg:px-5 lg:py-4"
  >
    <button
      type="button"
      class="col-span-3 flex h-[1.875rem] items-center gap-1.5 justify-self-start border bg-surface px-2 text-[0.6875rem] text-muted transition-colors hover:bg-elevated hover:text-foreground lg:hidden"
      title="Back to all accounts"
      aria-label="Back to all accounts"
      onclick={onBack}
    >
      <CioArrowLeft size={12} aria-hidden="true" />
      All accounts
    </button>
    <AgentIcon
      agentId={account.harnessId}
      label={harnessName}
      size={18}
      class="mt-0.5 shrink-0 text-muted"
    />
    <div class="min-w-0">
      <div class="flex min-w-0 flex-wrap items-center gap-1.5">
        <span class="truncate text-[0.9375rem] font-semibold text-foreground">{account.label}</span>
        {#if account.isDefault}
          <span
            class="shrink-0 border border-accent/45 bg-accent/10 px-1 text-[0.5625rem] font-semibold uppercase tracking-wide text-accent"
            title="Default account for this provider"
          >
            Default
          </span>
        {/if}
        {#if account.hidden}
          <span
            class="shrink-0 border bg-surface px-1 text-[0.5625rem] font-semibold uppercase tracking-wide text-muted"
            title="Hidden from account pickers, still connected"
          >
            Hidden
          </span>
        {/if}
        {#if expired}
          <span
            class="shrink-0 border border-danger/45 bg-danger/10 px-1 text-[0.5625rem] font-semibold uppercase tracking-wide text-danger"
            title="The harness sign-in for this account expired"
          >
            Sign-in expired
          </span>
        {:else if custom}
          <span
            class="shrink-0 border bg-surface px-1 text-[0.5625rem] font-semibold uppercase tracking-wide text-muted"
            title="Custom base URL provider"
          >
            Custom
          </span>
        {:else}
          <span
            class="shrink-0 border bg-surface px-1 text-[0.5625rem] font-semibold uppercase tracking-wide text-muted"
          >
            Active
          </span>
        {/if}
      </div>
      <p class="mt-0.5 truncate text-[0.6875rem] text-muted">
        {harnessName} · {providerLabel} · {account.containerKind === 'managed'
          ? 'isolated container'
          : 'harness default store'}
      </p>
    </div>
    {#if !custom}
      <button
        type="button"
        class="mt-0.5 px-1.5 py-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
        title={`Edit the label and credentials for ${account.label}`}
        aria-label={`Edit the label and credentials for ${account.label}`}
        onclick={onEdit}
      >
        <CioPencil size={13} aria-hidden="true" />
      </button>
    {/if}
  </div>

  <div class="border-b px-4 py-3.5 lg:px-5">
    <div class="mb-2 flex items-baseline justify-between gap-3">
      <span class="text-[0.6875rem] font-semibold text-foreground">Quota</span>
      {#if checkedLabel}
        <span class="text-[0.625rem] tabular-nums text-dimmed">checked {checkedLabel}</span>
      {/if}
    </div>

    {#if expired}
      <div
        class="flex items-center gap-2 border border-danger/35 bg-danger/10 px-2.5 py-2 text-[0.6875rem] text-danger"
        role="alert"
      >
        This account's harness sign-in expired. Sign in again to read its quota.
      </div>
    {:else if windows.length === 0}
      <p class="text-[0.6875rem] text-muted">
        This provider reports no rolling limits for the account.
        {#if credits}
          Balance {credits}.
        {/if}
      </p>
    {:else}
      {#each windows as window (window.id)}
        {@const percent = windowPercent(window)}
        {@const heat = quotaHeat(percent)}
        <div class="border-t border-border/60 py-2 first:border-t-0 first:pt-0">
          <div class="flex items-baseline gap-2 text-[0.6875rem]">
            <span class="truncate font-semibold text-foreground">{window.label}</span>
            <span class="shrink-0 text-[0.625rem] text-dimmed"
              >{windowScopeLabel(window.windowMinutes)}</span
            >
            {#if percent !== undefined}
              <span class={['ml-auto shrink-0 tabular-nums', percentClass(heat)]}
                >{percent}% used</span
              >
            {/if}
          </div>
          {#if percent !== undefined}
            <div
              class="mt-1.5 mb-1 h-1 overflow-hidden bg-overlay"
              role="progressbar"
              aria-label={`${window.label} usage for ${account.label}`}
              aria-valuemin="0"
              aria-valuemax="100"
              aria-valuenow={percent}
            >
              <div class={['h-full', meterClass(heat)]} style={`width: ${percent}%`}></div>
            </div>
          {/if}
          <div class="flex flex-wrap gap-x-3.5 gap-y-1 text-[0.625rem] tabular-nums text-dimmed">
            <span>{formatResetCountdown(window.resetsAt)}</span>
            {#if window.isUsingOverage}
              <span class="text-warning">Using extra usage</span>
            {/if}
          </div>
        </div>
      {/each}
    {/if}
  </div>

  {#if credits || banked}
    <div class="border-b px-4 py-3.5 lg:px-5">
      <div class="mb-2 flex items-baseline justify-between gap-3">
        <span class="text-[0.6875rem] font-semibold text-foreground">Extras</span>
      </div>
      <dl
        class="grid grid-cols-[minmax(6rem,9rem)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[0.6875rem]"
      >
        {#if credits}
          <dt class="text-muted">Credits</dt>
          <dd class="tabular-nums text-foreground">{credits} remaining</dd>
        {/if}
        {#if banked && banked.availableCount > 0}
          <dt class="text-muted">Banked resets</dt>
          <dd class="text-foreground">
            {banked.availableCount} available
            {#if bankedCredits.length > 0}
              <ul class="mt-1 space-y-0.5">
                {#each bankedCredits as credit, index (credit.id)}
                  <li class="text-[0.625rem] tabular-nums text-muted">
                    <span class="text-dimmed">#{index + 1}</span>
                    {formatExpiry(credit.expiresAt)}
                  </li>
                {/each}
              </ul>
            {/if}
          </dd>
        {/if}
      </dl>
    </div>
  {/if}

  <div class="px-4 py-3.5 lg:px-5">
    <div class="mb-2 flex items-baseline justify-between gap-3">
      <span class="text-[0.6875rem] font-semibold text-foreground">Credential</span>
      <span class="text-[0.625rem] text-dimmed">
        {account.containerKind === 'managed' ? 'isolated container' : 'shared with the harness'}
      </span>
    </div>
    <dl class="grid grid-cols-[minmax(6rem,9rem)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[0.6875rem]">
      <dt class="text-muted">Provider</dt>
      <dd class="text-foreground">{providerLabel}</dd>
      <dt class="text-muted">Harness</dt>
      <dd class="text-foreground">{harnessName}</dd>
      <dt class="text-muted">Usage check</dt>
      <dd class="tabular-nums text-foreground">
        {checkedLabel ? `last ${checkedLabel}` : 'not checked yet'}
        {#if snapshot?.error}
          <span class="block text-[0.625rem] text-danger">{snapshot.error}</span>
        {/if}
      </dd>
    </dl>
    {#if harnessAccountUsageCache.isProbing(account.id)}
      <p class="mt-2 flex items-center gap-1.5 text-[0.625rem] text-dimmed">
        <CioSpinner size={11} class="animate-spin" aria-hidden="true" />
        Checking usage…
      </p>
    {/if}
  </div>

  <div class="sticky bottom-0 flex items-center gap-1.5 border-t bg-surface px-4 py-2.5 lg:px-5">
    {#if !custom}
      <button
        type="button"
        class="flex h-9 items-center gap-1.5 border px-2.5 text-[0.6875rem] text-danger transition-colors hover:bg-danger/10 disabled:opacity-50"
        title={`Disconnect ${account.label}`}
        aria-label={`Disconnect ${account.label}`}
        onclick={onDisconnect}
      >
        <CioUnplug size={12} aria-hidden="true" />
        <span class="hidden lg:inline">Disconnect</span>
      </button>
    {/if}
    <span class="flex-1"></span>
    <button
      type="button"
      class="flex h-9 items-center gap-1.5 border bg-surface px-2.5 text-[0.6875rem] text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
      title={account.hidden
        ? `Show ${account.label} in account pickers again`
        : `Hide ${account.label} from account pickers without disconnecting it`}
      aria-label={account.hidden
        ? `Show ${account.label} in account pickers again`
        : `Hide ${account.label} from account pickers`}
      disabled={hiddenBusy}
      onclick={onToggleHidden}
    >
      {#if hiddenBusy}
        <CioSpinner size={12} class="animate-spin" aria-hidden="true" />
      {:else if account.hidden}
        <CioEye size={12} aria-hidden="true" />
      {:else}
        <CioEyeOff size={12} aria-hidden="true" />
      {/if}
      <span class="hidden lg:inline">
        {account.hidden ? 'Show in account pickers' : 'Hide from account pickers'}
      </span>
    </button>
    {#if expired}
      <button
        type="button"
        class="flex h-9 items-center gap-1.5 border bg-surface px-2.5 text-[0.6875rem] text-muted transition-colors hover:bg-elevated hover:text-foreground"
        title={`Sign in to ${providerLabel} again for ${account.label}`}
        aria-label={`Sign in to ${providerLabel} again for ${account.label}`}
        onclick={onSignIn}
      >
        <CioLogIn size={12} aria-hidden="true" />
        <span class="hidden lg:inline">Sign in again</span>
      </button>
    {/if}
    {#if canMakeDefault}
      <button
        type="button"
        class="flex h-9 items-center gap-1.5 bg-primary px-2.5 text-[0.6875rem] font-semibold text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
        title={`Make ${account.label} the default account for ${providerLabel}`}
        aria-label={`Make ${account.label} the default account for ${providerLabel}`}
        disabled={defaultBusy}
        onclick={onMakeDefault}
      >
        {#if defaultBusy}
          <CioSpinner size={12} class="animate-spin" aria-hidden="true" />
        {:else}
          <CioStar size={12} aria-hidden="true" />
        {/if}
        <span class="hidden lg:inline">Make default for {harnessName}</span>
      </button>
    {/if}
  </div>
</div>
