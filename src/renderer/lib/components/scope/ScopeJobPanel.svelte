<script lang="ts">
  /**
   * One worktree run, as the shared job panel draws it.
   *
   * This adapter owns everything scope-specific: the heading a create, adopt or
   * remove run deserves, how a step's state is derived from the run's active step,
   * and the branch and folder the finished run leaves behind. The panel and its
   * dockable behaviour are shared with the pull request batches.
   */
  import JobPanel from '$lib/components/ui/JobPanel.svelte'
  import ScopeHealthNotice from './ScopeHealthNotice.svelte'
  import { scopeJobs } from '$lib/stores/scope-jobs.svelte'
  import type { JobStatus, JobStepView } from '$lib/components/ui/job-view'
  import {
    scopeJobActiveStepId,
    scopeJobStatusLabel,
    type ScopeJob,
    type ScopeJobStepId
  } from '$lib/stores/scope-jobs.svelte'

  interface Props {
    job: ScopeJob
    storageKey: string
    onMinimize: () => void
    onClose: () => void
  }

  let { job, storageKey, onMinimize, onClose }: Props = $props()

  const running = $derived(job.status === 'running')
  const done = $derived(job.status === 'succeeded')
  const removing = $derived(job.kind === 'remove')
  const merging = $derived(job.kind === 'merge')
  /** A failed merge can be re-run from its panel once its checkout is repaired. */
  const canRetry = $derived(job.kind === 'merge' && job.status === 'failed')
  /** Step the run is on right now, or the one it stopped on. */
  const active = $derived(scopeJobActiveStepId(job))

  const status = $derived<JobStatus>(
    job.status === 'running' ? 'running' : job.status === 'succeeded' ? 'succeeded' : 'failed'
  )

  /** Panel title: who the run belongs to and where it stands. */
  function headingFor(run: ScopeJob): string {
    if (run.kind === 'merge') {
      const target = run.merge?.targetLabel ?? 'the target scope'
      if (running) return `Merging “${run.title}” into ${target}…`
      return done
        ? `“${run.title}” was merged into ${target}`
        : `Merging “${run.title}” into ${target} stopped`
    }
    const outcome =
      run.kind === 'remove'
        ? { present: 'Deleting', done: 'is deleted', failed: 'could not be deleted' }
        : run.kind === 'create'
          ? { present: 'Creating', done: 'is ready', failed: 'could not be created' }
          : run.kind === 'agent'
            ? {
                present: 'An agent is preparing',
                done: 'is ready',
                failed: 'could not be prepared'
              }
            : {
                present: 'Adopting a worktree for',
                done: 'has a worktree',
                failed: 'could not adopt the worktree'
              }
    if (running) return `${outcome.present} “${run.title}”…`
    return done ? `“${run.title}” ${outcome.done}` : `“${run.title}” ${outcome.failed}`
  }

  const heading = $derived(headingFor(job))

  /** Where one checklist step sits relative to the run. */
  function stateFor(step: ScopeJobStepId): JobStepView['state'] {
    if (done) return 'complete'
    if (!active) return 'pending'
    const activeIndex = job.steps.findIndex((candidate) => candidate.id === active)
    const index = job.steps.findIndex((candidate) => candidate.id === step)
    if (index < activeIndex) return 'complete'
    if (index > activeIndex) return 'pending'
    return job.status === 'failed' ? 'failed' : 'active'
  }

  /** Setup commands run in order; `detail` carries the 1-based command number. */
  const setupProgress = $derived(
    job.stage?.stage === 'setup' && job.setupCommandCount > 0 && job.stage.detail
      ? ` (${job.stage.detail} of ${job.setupCommandCount})`
      : ''
  )

  const statusLabel = $derived(`${scopeJobStatusLabel(job)}${setupProgress}`)

  const steps = $derived<JobStepView[]>(
    job.steps.map((step) => ({
      id: step.id,
      label: step.label,
      state: stateFor(step.id)
    }))
  )

  /** What the finished run leaves behind, stated for its kind. */
  const doneNote = $derived(
    removing
      ? job.isolated
        ? 'The worktree, its branch and the scope are gone.'
        : 'The scope is gone.'
      : job.isolated
        ? 'Threads you move into this scope work in the new checkout.'
        : 'This scope shares the project directory with the Default scope.'
  )

  const note = $derived(
    running
      ? 'You can keep working. The run continues in the background.'
      : done
        ? merging
          ? job.merge?.mode === 'merge-keep'
            ? 'The commits are in the target scope and this scope is still here.'
            : 'The commits are in the target scope and this scope is gone.'
          : doneNote
        : merging
          ? job.conflictFiles.length > 0
            ? 'Nothing was deleted. Resolve the conflicts in the Git panel, then run the merge again.'
            : 'Nothing was deleted. Repair the worktree above if it is flagged, then try again.'
          : removing
            ? 'The scope is still there. Fix the problem above and delete it again from the scope menu.'
            : 'Nothing else changed. Fix the problem above and run it again from the scope menu.'
  )
</script>

<JobPanel
  title={heading}
  {status}
  {statusLabel}
  {steps}
  error={job.error}
  {note}
  minimized={job.minimized}
  {onMinimize}
  {onClose}
  {storageKey}
  actionLabel={canRetry ? 'Try again' : undefined}
  onAction={canRetry ? () => scopeJobs.retry(job.id) : undefined}
  dragLabel="Drag to move the worktree run"
>
  {#snippet details()}
    {#if job.conflictFiles.length > 0}
      <!--
        A conflicted merge is a failed run that needs the user: the commits that
        arrived are on disk, and the paths below are what the Git panel shows.
      -->
      <div
        class="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[0.6875rem] text-warning"
      >
        <p class="font-medium">The merge hit conflicts ({job.conflictFiles.length})</p>
        <ul class="mt-1 max-h-24 list-inside list-disc overflow-y-auto">
          {#each job.conflictFiles.slice(0, 20) as file (file)}
            <li class="truncate">{file}</li>
          {/each}
        </ul>
      </div>
    {/if}

    {#if job.result}
      <div class="space-y-1 rounded-lg border bg-overlay px-3 py-2 text-[0.6875rem] text-muted">
        <p class="flex min-w-0 items-center gap-1.5">
          <span class="shrink-0">Branch</span>
          <code class="truncate font-mono text-foreground">{job.result.branch}</code>
        </p>
        <p class="flex min-w-0 items-center gap-1.5">
          <span class="shrink-0">Folder</span>
          <code class="truncate font-mono text-foreground">{job.result.directoryName}</code>
        </p>
      </div>
    {/if}

    {#if job.status === 'failed' && job.scopeBucketId}
      <!--
        A failed run is usually a checkout the app can no longer verify, so the
        panel carries the cause, the fix and the Repair action itself instead of
        only naming a menu the user has to go find.
      -->
      <ScopeHealthNotice
        projectId={job.projectId}
        scopeBucketId={job.scopeBucketId}
        name={job.title}
      />
    {/if}
  {/snippet}
</JobPanel>
