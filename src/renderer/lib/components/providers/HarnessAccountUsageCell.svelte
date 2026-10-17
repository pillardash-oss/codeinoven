<script lang="ts">
  import CioRefresh from '$lib/components/icons/cio/CioRefresh.svelte'
  import CioSpinner from '$lib/components/icons/cio/CioSpinner.svelte'
  import { BatteryCharging, LogIn } from '@lucide/svelte'
  import UsageWindowList from '../shared/UsageWindowList.svelte'
  import { bankedResetSummary, creditsLabel, formatExpiry } from '$lib/format/usage'
  import { harnessAccountUsageCache } from '$lib/stores/harness-account-usage.svelte'
  import { formatCompactAge, formatDateTimeWithWeekday } from '$shared/date-time-format'
  import type { HarnessAccount } from '$shared/types'
  import { harnessDisplayName } from '../threads/thread-message-presentation'
  import ProviderSignInPanel from './ProviderSignInPanel.svelte'

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
  let signInOpen = $state(false)
</script>

{#snippet noLimitsMessage()}
  <p class="text-xs text-dimmed">
    No limits to report
    {#if snapshot && snapshot.fetchedAt > 0}
      <span class="mx-1" aria-hidden="true">·</span>
      <span title={checkedAtTitle}>Updated {formatCompactAge(snapshot.fetchedAt)}</span>
    {/if}
  </p>
{/snippet}

<div class="min-w-0">
  <div class="min-w-0 space-y-1.5">
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
            onclick={() => (signInOpen = true)}
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
              <CioSpinner size={10} class="animate-spin" aria-hidden="true" />
              Retrying…
            {:else}
              <CioRefresh size={10} aria-hidden="true" />
              Retry
            {/if}
          </button>
        {/if}
      </div>
    {:else if usage}
      {@render noLimitsMessage()}
    {:else if snapshot && snapshot.fetchedAt > 0}
      {@render noLimitsMessage()}
    {:else}
      <div class="space-y-1.5" aria-hidden="true">
        <div class="h-2 w-28 animate-pulse bg-overlay"></div>
        <div class="h-1.5 w-40 animate-pulse bg-overlay"></div>
        <div class="h-2 w-20 animate-pulse bg-overlay"></div>
      </div>
      <span class="sr-only">Checking usage for {account.label}</span>
    {/if}
  </div>
</div>

{#if signInOpen}
  <ProviderSignInPanel
    harnessId={account.harnessId}
    harnessName={harnessDisplayName(account.harnessId)}
    providerId={account.providerId}
    providerName={account.label}
    accountId={account.id}
    onClose={() => (signInOpen = false)}
    onComplete={() => {
      signInOpen = false
      harnessAccountUsageCache.schedule([account], { force: true })
    }}
  />
{/if}
