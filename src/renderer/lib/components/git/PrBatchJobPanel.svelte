<script lang="ts">
  /**
   * One pull request batch, as the shared job panel draws it.
   *
   * This adapter owns everything batch-specific: how each pull request's turn is
   * phrased, what the run reports while it works, and the summary it leaves behind.
   * The panel, its checklist, its footer and its dockable behaviour are shared with
   * the worktree runs.
   */
  import JobPanel from '$lib/components/ui/JobPanel.svelte'
  import type { JobStatus, JobStepView } from '$lib/components/ui/job-view'
  import {
    prBatchJobStatusLabel,
    prBatchJobSubject,
    type PrBatchJob,
    type PrBatchJobItem
  } from '$lib/stores/pr-batch-jobs.svelte'

  interface Props {
    job: PrBatchJob
    /** Project display name, so the panel says which repository it is working on. */
    projectName: string
    storageKey: string
    onMinimize: () => void
    onClose: () => void
  }

  let { job, projectName, storageKey, onMinimize, onClose }: Props = $props()

  const running = $derived(job.status === 'running')
  const succeeded = $derived(job.status === 'succeeded')
  const closing = $derived(job.mode === 'close')
  const verb = $derived(closing ? 'Closing' : 'Reopening')
  const pastVerb = $derived(closing ? 'closed' : 'reopened')
  /** The verb a heading starts with. */
  const headline = $derived(closing ? 'Closed' : 'Reopened')

  const total = $derived(job.items.length)
  const carried = $derived(job.result?.succeeded.length ?? 0)
  const subject = $derived(prBatchJobSubject(job))

  const title = $derived(
    running
      ? `${verb} ${subject}…`
      : succeeded
        ? `${headline} ${subject}`
        : `${headline} ${carried} of ${total}`
  )

  const statusLabel = $derived(prBatchJobStatusLabel(job))

  const status = $derived<JobStatus>(
    job.status === 'running' ? 'running' : job.status === 'succeeded' ? 'succeeded' : 'failed'
  )

  /** One checklist line per pull request, with the reason it did not change. */
  function stepFor(item: PrBatchJobItem): JobStepView {
    return {
      id: String(item.number),
      label: `#${item.number} ${item.title}`,
      state: item.state,
      ...(item.message ? { detail: item.message } : {})
    }
  }

  const steps = $derived<JobStepView[]>(job.items.map(stepFor))

  const note = $derived(
    running
      ? 'You can keep working. The batch continues in the background and the list drains as it goes.'
      : succeeded
        ? `Every pull request in this batch is ${pastVerb}${
            job.comment ? ', each with your comment' : ''
          }.`
        : `Fix the problem above and ${closing ? 'close' : 'reopen'} the rows that remain from the list.`
  )
</script>

<JobPanel
  {title}
  {status}
  {statusLabel}
  {steps}
  error={job.error}
  {note}
  minimized={job.minimized}
  {onMinimize}
  {onClose}
  {storageKey}
  dragLabel="Drag to move the pull request batch"
  defaultHeight={460}
>
  {#snippet details()}
    {#if job.result}
      <div class="space-y-1 rounded-lg border bg-overlay px-3 py-2 text-[0.6875rem] text-muted">
        {#if projectName}
          <p class="truncate">
            <span class="text-dimmed">Repository</span>
            <code class="font-mono text-foreground">{projectName}</code>
          </p>
        {/if}
        <p>
          <strong class="text-foreground">{job.result.succeeded.length}</strong>
          {pastVerb}
          {#if job.result.failed.length > 0}
            · <strong class="text-danger">{job.result.failed.length}</strong> failed
          {/if}
          {#if job.result.skipped.length > 0}
            · <strong class="text-foreground">{job.result.skipped.length}</strong> not attempted
          {/if}
        </p>
        {#if job.comment}
          <p>Your comment was posted on each one before it changed.</p>
        {/if}
      </div>
    {/if}
  {/snippet}
</JobPanel>
