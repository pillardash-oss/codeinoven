<script lang="ts">
  import { BatteryCharging, Loader2, LogIn, RefreshCw } from '@lucide/svelte'
  import { invoke } from '$lib/ipc.svelte'
  import type { ProviderAccountLoginHandoff } from '$shared/types'
  import Modal from '../ui/Modal.svelte'
  import ProviderLoginTerminal from './ProviderLoginTerminal.svelte'
  import UsageWindowList from '../shared/UsageWindowList.svelte'
  import { bankedResetSummary, creditsLabel, formatExpiry } from '$lib/format/usage'
  import { relativeTime } from '$lib/format/relative-time'
  import { harnessAccountUsageCache } from '$lib/stores/harness-account-usage.svelte'
  import { formatDateTimeWithWeekday } from '$shared/date-time-format'
  import type { HarnessAccount } from '$shared/types'

  interface Props {
    account: HarnessAccount
  }

  let { account }: Props = $props()

  const snapshot = $derived(harnessAccountUsageCache.snapshotFor(account.id))
  const probing = $derived(harnessAccountUsageCache.isProbing(account.id))
  const usage = $derived(snapshot?.usage ?? null)
  const reauthenticationRequired = $derived(
    snapshot?.reauthenticationRequired === true || usage?.reauthenticationRequired === true
  )
  const bankedResets = $derived(bankedResetSummary(usage?.bankedResets))
  const credits = $derived(usage ? creditsLabel(usage) : undefined)
  /** Any provider-reported quota at all: rolling windows, credits, or resets. */
  const hasQuota = $derived(
    usage !== null &&
      (usage.rateLimits.length > 0 || bankedResets !== undefined || credits !== undefined)
  )
  /** A probe that failed outright, as opposed to a provider reporting nothing. */
  const failed = $derived(snapshot?.error !== undefined && usage === null)
  /** One line per banked reset credit, for the tooltip detail. */
  const bankedDetail = $derived(
    usage?.bankedResets?.credits?.length
      ? usage.bankedResets.credits.map((credit) => formatExpiry(credit.expiresAt)).join(' · ')
      : 'Expiry time not reported'
  )

  const checkedAt = $derived(
    snapshot && snapshot.fetchedAt > 0 ? formatDateTimeWithWeekday(snapshot.fetchedAt) : ''
  )
  const checkedAtTitle = $derived(
    `Last checked ${checkedAt}${snapshot?.error ? ` · ${snapshot.error}` : ''}`
  )
  let loginOpen = $state(false)
  let loginHandoff = $state<ProviderAccountLoginHandoff | null>(null)
  let loginError = $state('')
  let loginTerminalId = $state('')

  async function beginSignIn(): Promise<void> {
    loginError = ''
    loginHandoff = null
    loginTerminalId = `provider-login-${crypto.randomUUID()}`
    loginOpen = true
    try {
      loginHandoff = await invoke('providerAccounts:beginLogin', account.harnessId, {
        mode: 'default',
        ...(account.providerId ? { providerId: account.providerId } : {}),
        accountId: account.id
      })
    } catch (error) {
      loginError = error instanceof Error ? error.message : 'Sign-in could not be started.'
    }
  }

  async function finishSignIn(exitCode: number): Promise<void> {
    loginHandoff = null
    if (exitCode !== 0) {
      loginError = `Sign-in exited with code ${exitCode}.`
      return
    }
    try {
      const status = await invoke(
        'providerAccounts:getAuthStatus',
        account.harnessId,
        undefined,
        account.id
      )
      if (status.state === 'unauthenticated') {
        loginError = 'Sign-in was not completed for this account.'
        return
      }
      loginOpen = false
      harnessAccountUsageCache.schedule([account], { force: true })
    } catch (error) {
      loginError = error instanceof Error ? error.message : 'The sign-in could not be verified.'
    }
  }
</script>

<div class="space-y-1.5">
  {#if usage && hasQuota}
    <UsageWindowList limits={usage.rateLimits} variant="table" />
    {#if credits}
      <p class="text-[0.625rem] text-dimmed">{credits}</p>
    {/if}
    {#if bankedResets}
      <p class="flex items-center gap-1.5 text-[0.625rem] text-muted" title={bankedDetail}>
        <BatteryCharging size={11} class="shrink-0 text-info" aria-hidden="true" />
        <span class="truncate">{bankedResets}</span>
      </p>
    {/if}
  {:else if failed || reauthenticationRequired}
    <div class="space-y-1">
      <p class="text-[0.625rem] text-dimmed">
        {reauthenticationRequired ? 'Codex sign-in expired' : 'Usage unavailable'}
      </p>
      {#if reauthenticationRequired}
        <button
          type="button"
          class="flex items-center gap-1 text-[0.625rem] font-medium text-primary hover:underline"
          title={`Sign in again to ${account.label}`}
          aria-label={`Sign in again to ${account.label}`}
          onclick={() => void beginSignIn()}
        >
          <LogIn size={10} aria-hidden="true" />
          Sign in again
        </button>
      {:else}
        <button
          type="button"
          class="flex items-center gap-1 text-[0.625rem] font-medium text-primary hover:underline disabled:text-dimmed disabled:no-underline"
          disabled={probing}
          title={`Retry reading usage for ${account.label}`}
          aria-label={`Retry reading usage for ${account.label}`}
          onclick={() => harnessAccountUsageCache.schedule([account], { force: true })}
        >
          {#if probing}
            <Loader2 size={10} class="animate-spin" aria-hidden="true" />
            Retrying…
          {:else}
            <RefreshCw size={10} aria-hidden="true" />
            Retry
          {/if}
        </button>
      {/if}
    </div>
  {:else if usage}
    <p class="text-[0.625rem] text-dimmed">No quota reported</p>
  {:else}
    <div class="space-y-1.5" aria-hidden="true">
      <div class="h-2 w-28 animate-pulse rounded-full bg-overlay"></div>
      <div class="h-1.5 w-40 animate-pulse rounded-full bg-overlay"></div>
      <div class="h-2 w-20 animate-pulse rounded-full bg-overlay"></div>
    </div>
    <span class="sr-only">Checking usage for {account.label}</span>
  {/if}

  {#if probing && snapshot && !failed}
    <p class="flex items-center gap-1 text-[0.625rem] text-dimmed">
      <Loader2 size={10} class="animate-spin" aria-hidden="true" />
      Checking…
    </p>
  {:else if !probing && snapshot && snapshot.fetchedAt > 0}
    <p class="text-[0.5625rem] text-dimmed" title={checkedAtTitle}>
      Updated {relativeTime(snapshot.fetchedAt)}
    </p>
  {/if}
</div>

<Modal open={loginOpen} title={`Sign in to ${account.label}`} onClose={() => (loginOpen = false)}>
  <div class="h-[28rem] overflow-hidden rounded-lg border border-border bg-app">
    {#if loginHandoff}
      <ProviderLoginTerminal
        terminalId={loginTerminalId}
        command={loginHandoff.command}
        args={loginHandoff.args}
        environment={loginHandoff.environment}
        onExit={(exitCode) => void finishSignIn(exitCode)}
      />
    {:else if loginError}
      <div class="flex h-full items-center justify-center p-6">
        <p class="max-w-md text-center text-sm text-danger">{loginError}</p>
      </div>
    {:else}
      <div class="flex h-full items-center justify-center text-sm text-muted">
        Preparing sign-in…
      </div>
    {/if}
  </div>
</Modal>
