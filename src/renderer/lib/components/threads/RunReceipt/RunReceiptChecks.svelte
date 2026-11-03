<script lang="ts">
  /**
   * The commands the run actually executed, each with its real outcome.
   *
   * The command is shown as the run issued it, and the outcome is the tool
   * call's terminal state (plus the exit code the harness reported, when it
   * reported one). A check is never inferred from the model's prose, so a run
   * that only wrote words lists nothing here.
   */
  import type { RunReceiptCheck } from '$shared/types'
  import { STATUS_INK } from './run-receipt-ink'

  interface Props {
    checks: readonly RunReceiptCheck[]
    truncated?: boolean
  }

  let { checks, truncated = false }: Props = $props()

  const OUTCOME_LABEL: Record<RunReceiptCheck['outcome'], string> = {
    passed: 'Passed',
    failed: 'Failed',
    aborted: 'Stopped'
  }

  /**
   * A failed or stopped check is tinted toward the foreground rather than with
   * the raw status token: `--color-danger` and `--color-warning` at full strength
   * do not clear 4.5:1 on either surface, and a status nobody can read is not a
   * status. Passing checks stay muted, since they are the common case.
   */
  function outcomeInk(outcome: RunReceiptCheck['outcome']): string {
    if (outcome === 'failed') return STATUS_INK.danger
    if (outcome === 'aborted') return STATUS_INK.warning
    return 'var(--color-muted)'
  }
</script>

{#if checks.length === 0}
  <p class="text-xs text-muted">No command ran in this run.</p>
{:else}
  <ul class="flex flex-col">
    {#each checks as check, index (index)}
      <li class="flex min-w-0 flex-col gap-0.5 py-0.5 text-xs">
        <div class="flex min-w-0 items-baseline gap-2">
          <code class="min-w-0 flex-1 truncate text-muted" title={check.command}>{check.command}</code
          >
          <span class="shrink-0 text-right" style:color={outcomeInk(check.outcome)}>
            {OUTCOME_LABEL[check.outcome]}{check.exitCode === undefined
              ? ''
              : ` (${check.exitCode})`}
          </span>
        </div>
        {#if check.tail}
          <pre
            class="max-h-24 overflow-auto whitespace-pre-wrap break-all text-xs text-muted">{check.tail}</pre>
        {/if}
      </li>
    {/each}
  </ul>
  {#if truncated}
    <p class="pt-1 text-xs text-muted">More commands than this receipt keeps.</p>
  {/if}
{/if}
