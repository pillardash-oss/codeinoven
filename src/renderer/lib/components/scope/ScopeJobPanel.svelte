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
  /** Step the run is on right now, or the one it stopped on. */
  const active = $derived(scopeJobActiveStepId(job))

  const status = $derived<JobStatus>(
    job.status === 'running' ? 'running' : job.status === 'succeeded' ? 'succeeded' : 'failed'
  )

  /** Panel title: who the run belongs to and where it stands. */
  function headingFor(run: ScopeJob): string {
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
        ? doneNote
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
  dragLabel="Drag to move the worktree run"
>
  {#snippet details()}
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
  {/snippet}
</JobPanel>
