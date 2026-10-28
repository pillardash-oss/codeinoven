<script lang="ts">
  /**
   * One pull, as the shared job panel draws it.
   *
   * This adapter owns everything pull-specific: the heading the run deserves,
   * what its single checklist line says, and the outcome the integration left
   * behind. The panel, its footer and its dockable behaviour are shared with
   * the worktree runs, the pull request batches and the syncs between checkouts.
   */
  import JobPanel from '$lib/components/ui/JobPanel.svelte'
  import type { JobStatus, JobStepView } from '$lib/components/ui/job-view'
  import type { GitPullJob } from '$lib/stores/git-pull-jobs.svelte'
  import { pullIntegrationLabel, pullOutcomeCopy, pullRef } from './git-pull-copy'

  interface Props {
    job: GitPullJob
    storageKey: string
    onMinimize: () => void
    onClose: () => void
  }

  let { job, storageKey, onMinimize, onClose }: Props = $props()

  const running = $derived(job.status === 'running')
  const done = $derived(job.status === 'succeeded')
  const ref = $derived(pullRef(job.remote, job.branch))

  const outcome = $derived(pullOutcomeCopy(job))
  const conflicted = $derived((job.result?.conflicted.length ?? 0) > 0)
  /**
   * The red block: the refusal that stopped the run, or the conflict the
   * integration stopped on. A conflict is not an exception, so its sentence
   * comes from the outcome copy rather than being written twice.
   */
  const blocker = $derived(job.error ?? (conflicted ? (outcome?.notes[0] ?? null) : null))
  /** What a landed pull still asks the user to look at. */
  const attention = $derived(outcome !== null && outcome.tone === 'attention' && !conflicted)
  /**
   * Everything the outcome adds to its summary. A conflict's own sentence is
   * taken by the red block above, so it is not repeated here.
   */
  const notes = $derived(conflicted ? (outcome?.notes.slice(1) ?? []) : (outcome?.notes ?? []))

  const status = $derived<JobStatus>(job.status)

  /** The one thing a pull does, in the words the chooser and the menu used. */
  const integration = $derived(pullIntegrationLabel(job.strategy, job.remote, job.branch))

  const heading = $derived(
    running ? `Pulling ${ref}…` : done ? `Pulled ${ref}` : `Pull from ${ref} stopped`
  )

  const statusLabel = $derived(running ? integration : (outcome?.summary ?? 'Failed'))

  const steps = $derived<JobStepView[]>([
    {
      id: 'pull',
      label: integration,
      state: running ? 'active' : done ? 'complete' : 'failed'
    }
  ])

  const note = $derived(
    running
      ? 'You can keep working. The pull continues in the background.'
      : done
        ? attention
          ? 'The commits landed and nothing was rolled back. What is written above is waiting for you before this branch is published.'
          : 'Nothing else to do here. The commits that arrived are in this checkout.'
        : job.result
          ? 'Nothing was rolled back. Resolve what is written above and finish the integration in the Changes view.'
          : 'Nothing was moved. Fix what is written above, then pull again.'
  )
</script>

<JobPanel
  title={heading}
  {status}
  {statusLabel}
  {steps}
  error={blocker}
  {note}
  minimized={job.minimized}
  {onMinimize}
  {onClose}
  {storageKey}
  dragLabel="Drag to move the pull"
  defaultHeight={340}
>
  {#snippet details()}
    {#if notes.length > 0}
      <!--
        What the outcome adds to its summary: a warning when the pull left work
        to publish, a plain note otherwise.
      -->
      <div
        class={['border px-3 py-2', attention ? 'border-warning/25 bg-warning/10' : 'bg-overlay']}
      >
        {#each notes as line, index (index)}
          <p
            class="text-xs leading-relaxed {attention && index === 0
              ? 'font-semibold text-warning'
              : 'text-muted'}"
          >
            {line}
          </p>
        {/each}
      </div>
    {/if}

    {#if job.result}
      <div class="space-y-1 border bg-overlay px-3 py-2 text-xs text-muted">
        <p class="flex min-w-0 items-start gap-1.5">
          <span class="shrink-0 text-dimmed">From</span>
          <span class="min-w-0 truncate text-foreground">{ref}</span>
        </p>
        <p class="flex min-w-0 items-start gap-1.5">
          <span class="shrink-0 text-dimmed">Into</span>
          <code class="min-w-0 truncate font-mono text-foreground"
            >{job.result.branch ?? job.branch}</code
          >
        </p>
        <p class="flex min-w-0 items-start gap-1.5">
          <span class="shrink-0 text-dimmed">Strategy</span>
          <span class="min-w-0 truncate text-foreground">{integration}</span>
        </p>
        {#if job.incoming > 0}
          <p class="truncate text-dimmed">
            {job.incoming} commit{job.incoming === 1 ? '' : 's'} were waiting on the remote.
          </p>
        {/if}
      </div>
    {:else}
      <div class="space-y-1 border bg-overlay px-3 py-2 text-xs text-muted">
        <p class="flex min-w-0 items-start gap-1.5">
          <span class="shrink-0 text-dimmed">From</span>
          <span class="min-w-0 truncate text-foreground">{ref}</span>
        </p>
        <p class="flex min-w-0 items-start gap-1.5">
          <span class="shrink-0 text-dimmed">Strategy</span>
          <span class="min-w-0 truncate text-foreground">{integration}</span>
        </p>
      </div>
    {/if}
  {/snippet}
</JobPanel>
