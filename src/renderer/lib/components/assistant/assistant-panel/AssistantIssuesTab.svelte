<script lang="ts">
  import CioActions from '@pdslng/cio-icon/CioActions.svelte'
  import CioAttention from '@pdslng/cio-icon/CioAttention.svelte'
  import CioBan from '@pdslng/cio-icon/CioBan.svelte'
  import CioUndo from '@pdslng/cio-icon/CioUndo.svelte'
  import StatusBadge from '$lib/components/shared/StatusBadge.svelte'
  import NoticeDismissButton from '$lib/components/ui/NoticeDismissButton.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { formatDateTime } from '$shared/date-time-format'
  import type { BackgroundRun, MissedRun, Thread } from '$shared/types'
  import {
    backgroundRunOutcomeLabel,
    backgroundRunReasonText,
    backgroundRunTone,
    missedRunReasonText,
    previewRuns,
    runIssueNoticeId,
    TASK_RUN_PREVIEW,
    type RunIssue
  } from '../assistant-view'

  /**
   * Everything that needs the user's eyes: slots the clock missed, runs that are
   * waiting, rate limited, failed or interrupted, and the evidence of the
   * unattended runs behind them.
   */
  interface Props {
    /** Whether the assistant runs on a clock, which decides the run-now action. */
    scheduled: boolean
    missedRuns: readonly MissedRun[]
    /** Execution problems, one entry per task and kind, already de-duplicated. */
    runIssues: readonly RunIssue[]
    /** Ledger-entried unattended runs, newest first. */
    backgroundRuns: readonly BackgroundRun[]
    onOpenTask: (thread: Thread) => void
    onDismissMissed: (id: string) => void
    onRunMissedNow: (run: MissedRun) => void
  }

  let {
    scheduled,
    missedRuns,
    runIssues,
    backgroundRuns,
    onOpenTask,
    onDismissMissed,
    onRunMissedNow
  }: Props = $props()

  let showAllRuns = $state(false)

  /** The task a run recorded, resolved from the live thread list when it survives. */
  function runTaskTitle(run: BackgroundRun): string {
    return (
      scopeState.allScopeThreads.find((thread) => thread.id === run.taskId)?.title ??
      'Assistant run'
    )
  }

  /** The run's own thread when it still exists; null once it was deleted. */
  function runThreadFor(run: BackgroundRun): Thread | null {
    return scopeState.allScopeThreads.find((thread) => thread.id === run.runThreadId) ?? null
  }
</script>

{#snippet runRowBody(run: BackgroundRun, thread: Thread | null)}
  <span class="mt-0.5 shrink-0">
    <StatusBadge
      tone={backgroundRunTone(run.outcome)}
      title={backgroundRunOutcomeLabel(run.outcome)}
    />
  </span>
  <span class="min-w-0 flex-1">
    <span class="flex items-center gap-1.5">
      <span class="min-w-0 flex-1 truncate text-[0.75rem] text-foreground">{runTaskTitle(run)}</span
      >
      <span class="shrink-0 text-[0.625rem] text-muted">
        {backgroundRunOutcomeLabel(run.outcome)}
      </span>
    </span>
    <span class="mt-0.5 block text-[0.625rem] text-dimmed">
      {backgroundRunReasonText(run.reason)} · {formatDateTime(run.startedAt)}
    </span>
    {#if run.outcome === 'failed' && run.errorSummary}
      <span class="mt-0.5 block text-[0.625rem] text-danger">{run.errorSummary}</span>
    {/if}
    {#if run.autoAnswered > 0}
      <span class="mt-0.5 block text-[0.625rem] text-dimmed">
        {run.autoAnswered} decision{run.autoAnswered === 1 ? '' : 's'} answered automatically
      </span>
    {/if}
    {#if !thread}
      <span class="mt-0.5 block text-[0.625rem] text-dimmed italic">
        Run thread deleted. Kept as evidence.
      </span>
    {/if}
  </span>
{/snippet}

<div class="flex flex-col gap-3 p-3">
  <div class="flex flex-col gap-2 border border-border bg-surface p-2.5">
    <h2 class="text-[0.875rem] font-semibold text-foreground">Missed runs</h2>
    {#if missedRuns.length === 0}
      <p class="text-[0.6875rem] text-dimmed">No scheduled run has been missed.</p>
    {:else}
      <div class="flex flex-col gap-2">
        {#each missedRuns as run (run.id)}
          <div class="flex flex-col gap-1.5 bg-elevated p-2.5">
            <div class="flex items-center gap-2">
              <CioAttention size={13} strokeWidth={1.8} style="color: var(--color-missed)" />
              <span class="min-w-0 flex-1 truncate text-[0.75rem] text-foreground">
                {run.title}
              </span>
            </div>
            <p class="text-[0.625rem] text-dimmed">
              Was due {formatDateTime(run.dueAt)}. {missedRunReasonText(run.reason)}
            </p>
            <div class="flex justify-end gap-1.5">
              <button
                type="button"
                class="px-2 py-1 text-[0.6875rem] text-muted transition-colors hover:bg-elevated hover:text-foreground"
                title="Dismiss this missed run"
                aria-label="Dismiss the missed run {run.title}"
                onclick={() => onDismissMissed(run.id)}
              >
                Dismiss
              </button>
              {#if scheduled}
                <button
                  type="button"
                  class="flex items-center gap-1 bg-primary px-2 py-1 text-[0.6875rem] text-on-primary transition-colors hover:bg-primary-hover"
                  title="Run this missed sweep now"
                  aria-label="Run the missed run {run.title} now"
                  onclick={() => onRunMissedNow(run)}
                >
                  <CioUndo size={12} strokeWidth={1.8} />
                  Run now
                </button>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <div class="flex flex-col gap-2 border border-border bg-surface p-2.5">
    <h2 class="text-[0.875rem] font-semibold text-foreground">Run problems</h2>
    {#if runIssues.length === 0}
      <p class="text-[0.6875rem] text-dimmed">
        No waiting runs, rate limits, failures or interruptions.
      </p>
    {:else}
      <div class="flex flex-col">
        {#each runIssues as issue (issue.id)}
          <!-- The row opens the problem and the dismissal beside it closes this
               occurrence: a row with no way out is a row that lives in the panel
               for good. The dismissal survives a remount and returns on the next
               occurrence, see `RunIssue.condition`. -->
          <div class="flex items-start gap-1 border-t border-border first:border-t-0">
            <button
              type="button"
              class="flex min-w-0 flex-1 items-start gap-2 py-2 text-left transition-colors hover:bg-elevated"
              title="Open {issue.task.title}"
              aria-label="Open {issue.task.title}"
              onclick={() => onOpenTask(issue.task)}
            >
              <span class="mt-0.5 shrink-0" style="color: var(--color-warning)">
                {#if issue.kind === 'Rate limited'}
                  <CioActions size={13} strokeWidth={1.8} />
                {:else if issue.kind === 'Interrupted'}
                  <CioBan size={13} strokeWidth={1.8} />
                {:else}
                  <CioAttention size={13} strokeWidth={1.8} />
                {/if}
              </span>
              <span class="min-w-0 flex-1">
                <span class="flex items-center gap-1.5">
                  <span class="min-w-0 flex-1 truncate text-[0.75rem] text-foreground">
                    {issue.task.title}
                  </span>
                  <span class="shrink-0 text-[0.625rem] text-muted">{issue.kind}</span>
                </span>
                <span class="mt-0.5 block text-[0.625rem] text-dimmed">{issue.detail}</span>
              </span>
            </button>
            <span class="mt-1.5 shrink-0">
              <NoticeDismissButton
                id={runIssueNoticeId(issue.id)}
                condition={issue.condition}
                title="Dismiss the {issue.kind.toLowerCase()} issue on {issue.task.title}"
                size="sm"
              />
            </span>
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <div class="flex flex-col gap-2 border border-border bg-surface p-2.5">
    <h2 class="text-[0.875rem] font-semibold text-foreground">Run history</h2>
    {#if backgroundRuns.length === 0}
      <p class="text-[0.6875rem] text-dimmed">No unattended runs recorded yet.</p>
    {:else}
      <div class="flex flex-col">
        {#each previewRuns(backgroundRuns, showAllRuns) as run (run.runThreadId)}
          {@const thread = runThreadFor(run)}
          {#if thread}
            <button
              type="button"
              class="flex items-start gap-2 border-t border-border py-2 text-left transition-colors first:border-t-0 hover:bg-elevated"
              title="Open this run"
              aria-label="Open unattended run for {runTaskTitle(run)}"
              onclick={() => onOpenTask(thread)}
            >
              {@render runRowBody(run, thread)}
            </button>
          {:else}
            <div
              class="flex items-start gap-2 border-t border-border py-2 first:border-t-0"
              title="The run's thread was deleted; this record is the evidence it ran"
            >
              {@render runRowBody(run, null)}
            </div>
          {/if}
        {/each}
        {#if backgroundRuns.length > TASK_RUN_PREVIEW}
          <button
            type="button"
            class="self-start border-t border-border px-2 py-1 text-[0.6875rem] text-muted transition-colors first:border-t-0 hover:bg-elevated hover:text-foreground"
            title={showAllRuns ? 'Show fewer runs' : 'Show every recorded run'}
            aria-label={showAllRuns ? 'Show fewer runs' : `Show all ${backgroundRuns.length} runs`}
            onclick={() => (showAllRuns = !showAllRuns)}
          >
            {showAllRuns ? 'Show fewer' : `Show all ${backgroundRuns.length}`}
          </button>
        {/if}
      </div>
    {/if}
  </div>
</div>
