<script lang="ts">
  /**
   * The run receipt: what this run did, at the end of the turn that did it.
   *
   * One collapsible block, open by default, whose summary line states the totals
   * without a click. It is a summary, never a second changes panel: its actions
   * open the project's own Files, Changes and Git in the rail this conversation
   * already owns, resolved against the checkout the run actually worked in.
   *
   * Every number comes from Git or from a command the run executed, so a run
   * whose turns were prose shows no checks rather than hopeful ones.
   */
  import CioChevronDown from '@pdslng/cio-icon/CioChevronDown.svelte'
  import { threadCardFold } from '$lib/stores/thread-card-fold.svelte'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import { receiptSummaryLine } from '$shared/run-receipt'
  import { threadEvidenceProjectId } from '$shared/bound-scope'
  import type { RunReceipt, Thread } from '$shared/types'
  import RunReceiptFacts from './RunReceipt/RunReceiptFacts.svelte'
  import RunReceiptFiles from './RunReceipt/RunReceiptFiles.svelte'
  import RunReceiptChecks from './RunReceipt/RunReceiptChecks.svelte'
  import RunReceiptStates from './RunReceipt/RunReceiptStates.svelte'

  interface Props {
    /** The run thread this receipt describes. */
    thread: Thread
    receipt: RunReceipt
  }

  let { thread, receipt }: Props = $props()

  const FOLD_KEY = 'run-receipt'

  /** Open by default: a receipt nobody opens is not evidence. */
  let folded = $derived(threadCardFold.isFolded(thread.id, FOLD_KEY, false))

  /**
   * The checkout the receipt's actions open. It is the run's own bound scope,
   * resolved by the shared resolver, so the rail shows the same project the
   * receipt just described.
   */
  let evidenceProjectId = $derived(threadEvidenceProjectId(thread) ?? receipt.scope.projectId)

  let summary = $derived(receiptSummaryLine(receipt))
  let ready = $derived(receipt.state === 'ready')

  function toggle(): void {
    threadCardFold.setFolded(thread.id, FOLD_KEY, !folded)
  }

  function openChanges(): void {
    if (!evidenceProjectId) return
    contextSidebarState.openDiff(evidenceProjectId, thread.id)
  }

  function openGit(): void {
    if (!evidenceProjectId) return
    contextSidebarState.openGit(evidenceProjectId, thread.id)
  }

  function openFiles(): void {
    if (!evidenceProjectId) return
    contextSidebarState.openFiles(evidenceProjectId, thread.id)
  }
</script>

<section
  class="flex flex-col gap-2 border-t pt-2 text-xs"
  aria-labelledby={`run-receipt-${thread.id}`}
>
  <div class="flex min-w-0 items-baseline gap-2">
    <button
      type="button"
      class="flex min-w-0 flex-1 items-baseline gap-2 text-left"
      aria-expanded={!folded}
      aria-controls={`run-receipt-body-${thread.id}`}
      title={folded ? 'Open this run receipt' : 'Fold this run receipt'}
      onclick={toggle}
    >
      <CioChevronDown
        size={11}
        class="shrink-0 text-muted transition-transform duration-150 {folded
          ? '-rotate-90'
          : ''}"
        aria-hidden="true"
      />
      <span id={`run-receipt-${thread.id}`} class="shrink-0 font-medium text-foreground">
        Run receipt
      </span>
      <span class="min-w-0 truncate text-muted">{summary}</span>
    </button>
    {#if evidenceProjectId}
      <div class="flex shrink-0 items-baseline gap-2">
        <button
          type="button"
          class="text-muted transition-colors hover:text-foreground"
          title="Open this run's changes in the side panel"
          onclick={openChanges}
        >
          Changes
        </button>
        <button
          type="button"
          class="text-muted transition-colors hover:text-foreground"
          title="Open this run's Git panel"
          onclick={openGit}
        >
          Git
        </button>
        <button
          type="button"
          class="text-muted transition-colors hover:text-foreground"
          title="Open this run's files in the side panel"
          onclick={openFiles}
        >
          Files
        </button>
      </div>
    {/if}
  </div>

  {#if !folded}
    <div id={`run-receipt-body-${thread.id}`} class="flex flex-col gap-3">
      <RunReceiptFacts {receipt} />
      {#if ready}
        <div class="flex flex-col gap-1">
          <p class="text-muted">Changed in this run</p>
          <RunReceiptFiles files={receipt.files} truncated={receipt.truncated.files} emptyLabel="This run committed no file changes." />
        </div>
        <div class="flex flex-col gap-1">
          <p class="text-muted">Left uncommitted</p>
          <RunReceiptFiles
            files={receipt.uncommitted}
            truncated={receipt.truncated.uncommitted}
            emptyLabel="Nothing is left uncommitted."
          />
        </div>
        <div class="flex flex-col gap-1">
          <p class="text-muted">Checks that ran</p>
          <RunReceiptChecks checks={receipt.checks} truncated={false} />
        </div>
      {:else}
        <RunReceiptStates {receipt} />
      {/if}
    </div>
  {/if}
</section>
