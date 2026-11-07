<script lang="ts">
  /**
   * The receipt states that are not a finished run.
   *
   * Each one says what it is and why, in the app's own words. None of them fills
   * a number in, because a zero where nobody looked reads as "nothing changed",
   * which is the one claim a receipt must never make by accident.
   */
  import type { RunReceipt } from '$shared/types'
  import { STATUS_INK } from './run-receipt-ink'

  interface Props {
    receipt: RunReceipt
  }

  let { receipt }: Props = $props()
</script>

{#if receipt.state === 'running'}
  <p class="text-xs text-muted">This run has not settled yet, so its range is still moving.</p>
{:else if receipt.state === 'parked'}
  <p class="text-xs" style="color: {STATUS_INK.warning}">
    {receipt.reason ?? 'This run is parked.'}
  </p>
{:else if receipt.state === 'no-base'}
  <p class="text-xs text-muted">
    This run recorded no starting commit, so what it changed cannot be known. Runs started before
    the app began recording one, and runs that never reached a checkout, report this instead of a
    guess.
  </p>
{:else if receipt.state === 'error'}
  <p class="text-xs" style="color: {STATUS_INK.danger}">
    {receipt.reason ?? 'This receipt could not be read.'}
  </p>
{/if}
