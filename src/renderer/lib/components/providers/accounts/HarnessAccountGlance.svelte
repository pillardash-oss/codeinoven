<script lang="ts">
  import type { HarnessAccount } from '$shared/types'
  import { bankedResetSummary, creditsLabel } from '$lib/format/usage'
  import { harnessAccountUsageCache } from '$lib/stores/harness-account-usage.svelte'
  import {
    glanceWindows,
    meterClass,
    percentClass,
    quotaHeat,
    resetShortLabel,
    usesOverage,
    windowPercent,
    windowShortLabel
  } from './harness-account-presentation'

  interface Props {
    account: HarnessAccount
  }

  let { account }: Props = $props()

  const snapshot = $derived(harnessAccountUsageCache.snapshotFor(account.id))
  const usage = $derived(snapshot?.usage ?? null)
  const limits = $derived(usage?.rateLimits ?? [])
  const windows = $derived(glanceWindows(limits))
  const expired = $derived(snapshot?.reauthenticationRequired === true)
  const banked = $derived(bankedResetSummary(usage?.bankedResets))
  const credits = $derived(usage ? creditsLabel(usage) : undefined)
  const overage = $derived(usesOverage(limits))
  const nothingReported = $derived(
    !expired && windows.length === 0 && banked === undefined && credits === undefined
  )
  const probed = $derived(snapshot !== undefined && snapshot.fetchedAt > 0)
</script>

{#if expired}
  <p class="mt-1.5 text-[0.5625rem] text-danger">Quota unreadable while signed out</p>
{:else if nothingReported}
  <p class="mt-1.5 text-[0.5625rem] text-dimmed">
    {probed ? 'No limits reported' : 'Checking usage…'}
  </p>
{:else}
  <div class="mt-1.5 space-y-[0.1875rem]">
    {#each windows as window (window.id)}
      {@const percent = windowPercent(window)}
      {@const heat = quotaHeat(percent)}
      <div
        class="grid grid-cols-[minmax(3.25rem,auto)_minmax(0,1fr)_2.25rem] items-center gap-1.5"
        title={`${window.label}${percent === undefined ? '' : `: ${percent}% used`} · ${resetShortLabel(window.resetsAt)}`}
      >
        <span class="truncate text-[0.625rem] font-medium text-muted"
          >{windowShortLabel(window)}</span
        >
        {#if percent !== undefined}
          <span
            class="h-1 overflow-hidden bg-overlay"
            role="progressbar"
            aria-label={`${window.label} usage for ${account.label}`}
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow={percent}
          >
            <span class={['block h-full', meterClass(heat)]} style={`width: ${percent}%`}></span>
          </span>
          <span class={['text-right text-[0.625rem] tabular-nums', percentClass(heat)]}>
            {percent}%
          </span>
        {:else}
          <span class="truncate text-[0.625rem] text-dimmed">no percentage</span>
          <span></span>
        {/if}
      </div>
    {/each}
    <p class="flex flex-wrap gap-x-2 gap-y-0.5 text-[0.5625rem] text-dimmed">
      {#each windows.slice(0, 2) as window (window.id)}
        <span>{windowShortLabel(window)} {resetShortLabel(window.resetsAt)}</span>
      {/each}
      {#if overage}
        <span class="text-warning">using extra usage</span>
      {/if}
      {#if banked}
        <span class="text-info">{banked}</span>
      {/if}
      {#if credits}
        <span>{credits}</span>
      {/if}
    </p>
  </div>
{/if}
