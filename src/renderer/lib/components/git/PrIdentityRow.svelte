<script lang="ts">
  import { ArrowLeft } from '@lucide/svelte'
  import type { PullRequestChecks, PullRequestDetail, PullRequestSummary } from '$shared/types'
  import {
    prChecksBadgeClass,
    prChecksStateIcon,
    prChecksStateLabel,
    prChecksStateSpinning,
    prStateBadgeClass
  } from './pr-view'

  interface Props {
    summary: PullRequestSummary
    /** The fetched record, once it is in. Null while it is still loading. */
    detail: PullRequestDetail | null
    checks: PullRequestChecks | null
    onBack: () => void
    /** The checks pill is the only way into the Checks view from this row. */
    onOpenChecks: () => void
    /**
     * Name the check state next to its glyph. The full screen rail has the room
     * for the words; the panel's action row does not.
     */
    showChecksLabel?: boolean
  }

  let { summary, detail, checks, onBack, onOpenChecks, showChecksLabel = false }: Props = $props()

  const state = $derived(detail?.state ?? summary.state)
  const draft = $derived(detail?.draft ?? summary.draft)
</script>

<!--
  Who this pull request is: back control, number, state and rolled-up check
  state. The Git panel draws it in its own action row, and the full screen
  reader's rail draws it in its header, so it carries no padding of its own.
-->
<button
  type="button"
  class="shrink-0 cursor-pointer rounded p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
  title="Back to pull requests"
  aria-label="Back to pull requests"
  onclick={onBack}
>
  <ArrowLeft size={13} />
</button>
<span class="shrink-0 font-mono text-[0.625rem] text-dimmed">#{summary.number}</span>
<span
  class="min-w-0 shrink truncate rounded px-1.5 py-0.5 text-[0.5625rem] font-medium uppercase tracking-wide {prStateBadgeClass(
    state
  )}"
>
  {state}{draft ? ' · draft' : ''}
</span>
{#if checks && checks.state !== 'none'}
  {@const ChecksIcon = prChecksStateIcon(checks.state)}
  <button
    type="button"
    class="flex shrink-0 cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[0.5625rem] font-medium transition-colors {prChecksBadgeClass(
      checks.state
    )}"
    title="{prChecksStateLabel(checks.state)}, open check results"
    aria-label="{prChecksStateLabel(checks.state)}, open check results"
    onclick={onOpenChecks}
  >
    <ChecksIcon size={10} class={prChecksStateSpinning(checks.state) ? 'animate-spin' : ''} />
    {#if showChecksLabel}{prChecksStateLabel(checks.state)}{/if}
  </button>
{/if}
