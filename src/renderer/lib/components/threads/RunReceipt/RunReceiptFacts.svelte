<script lang="ts">
  /**
   * The facts a receipt states, as one definition list.
   *
   * A definition list rather than a card grid: these are readings of one run, in
   * one column of labels with their counts right-aligned, so the eye compares
   * numbers instead of scanning cards. No micro-headings, no badges, no rounded
   * corners, nothing below 0.75rem.
   */
  import { formatLineCounts } from '$shared/run-receipt'
  import type { RunReceipt } from '$shared/types'

  interface Props {
    receipt: RunReceipt
  }

  let { receipt }: Props = $props()

  let checkLabel = $derived.by(() => {
    const { passed, failed, aborted } = receipt.checkCounts
    if (passed + failed + aborted === 0) return 'none ran'
    const parts: string[] = []
    if (passed > 0) parts.push(`${passed} passed`)
    if (failed > 0) parts.push(`${failed} failed`)
    if (aborted > 0) parts.push(`${aborted} aborted`)
    return parts.join(', ')
  })
</script>

<dl class="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 text-xs">
  <dt class="min-w-0 truncate text-muted">Workspace</dt>
  <dd class="text-right text-muted">
    {receipt.scope.scopeName}{#if receipt.scope.branch}<span class="text-muted">
        on {receipt.scope.branch}</span
      >{/if}
  </dd>

  <dt class="min-w-0 truncate text-muted">Commits</dt>
  <dd class="text-right text-foreground">
    {receipt.commits.length}{receipt.truncated.commits ? '+' : ''}
  </dd>

  <dt class="min-w-0 truncate text-muted">Files</dt>
  <dd class="text-right text-foreground">
    {receipt.totals.count}{receipt.truncated.files ? '+' : ''}
    <span class="text-muted">{formatLineCounts(receipt.totals)}</span>
  </dd>

  <dt class="min-w-0 truncate text-muted">Uncommitted</dt>
  <dd class="text-right text-foreground">
    {#if receipt.uncommittedTotals.count === 0}
      <span class="text-muted">nothing left</span>
    {:else}
      {receipt.uncommittedTotals.count}{receipt.truncated.uncommitted ? '+' : ''}
      <span class="text-muted">{formatLineCounts(receipt.uncommittedTotals)}</span>
    {/if}
  </dd>

  <dt class="min-w-0 truncate text-muted">Checks</dt>
  <dd class="text-right text-foreground">{checkLabel}</dd>
</dl>
