<script lang="ts">
  import { BatteryCharging, Loader2, RefreshCw } from '@lucide/svelte'
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
  {:else if failed}
    <div class="space-y-1">
      <p class="text-[0.625rem] text-dimmed">Usage unavailable</p>
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
