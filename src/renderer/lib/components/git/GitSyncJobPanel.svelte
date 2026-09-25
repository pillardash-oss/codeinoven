<script lang="ts">
  /**
   * One sync run, as the shared job panel draws it.
   *
   * This adapter owns everything sync-specific: the heading a run between two
   * ends deserves, what its single checklist line says, and the outcome the
   * integration left behind. The panel, its footer and its dockable behaviour
   * are shared with the worktree runs and the pull request batches.
   */
  import JobPanel from '$lib/components/ui/JobPanel.svelte'
  import type { JobStatus, JobStepView } from '$lib/components/ui/job-view'
  import { syncIntegrationLabel, syncOutcomeCopy } from './git-sync-copy'
  import type { GitSyncJob } from '$lib/stores/git-sync-jobs.svelte'

  interface Props {
    job: GitSyncJob
    storageKey: string
    onMinimize: () => void
    onClose: () => void
  }

  let { job, storageKey, onMinimize, onClose }: Props = $props()

  const running = $derived(job.status === 'running')
  const done = $derived(job.status === 'succeeded')
  /** Whether the run reads another end into this checkout, or writes into it. */
  const incoming = $derived(job.direction === 'from')

  const outcome = $derived(job.result ? syncOutcomeCopy(job.result) : null)
  const conflicted = $derived((job.result?.status.conflicted.length ?? 0) > 0)
  /**
   * The red block: the refusal that stopped the run, or the conflict the
   * integration stopped on. A conflict is not an exception, so its sentence
   * comes from the outcome copy rather than being written twice.
   */
  const blocker = $derived(job.error ?? (conflicted ? (outcome?.notes[0] ?? null) : null))
  /** What the integration left behind, from the outcome copy either way. */
  const findings = $derived(outcome?.findings ?? [])
  /** What a landed sync still asks the user to look at. */
  const attention = $derived(outcome !== null && outcome.tone === 'attention' && !conflicted)
  /**
   * Everything the outcome adds to its summary, whatever the run's tone. A
   * conflict's own sentence is taken by the red block above, so it is not
   * repeated here.
   */
  const notes = $derived(conflicted ? (outcome?.notes.slice(1) ?? []) : (outcome?.notes ?? []))

  const status = $derived<JobStatus>(
    job.status === 'running' ? 'running' : job.status === 'succeeded' ? 'succeeded' : 'failed'
  )

  /** The one thing a sync does, in the words the chooser's footer used. */
  const integration = $derived(syncIntegrationLabel(job.direction, job.strategy, job.peerLabel))

  const heading = $derived(
    running
      ? `Syncing ${incoming ? 'from' : 'to'} ${job.peerLabel}…`
      : done
        ? `Synced ${incoming ? 'from' : 'to'} ${job.peerLabel}`
        : `Sync ${incoming ? 'from' : 'to'} ${job.peerLabel} stopped`
  )

  const statusLabel = $derived(running ? integration : (outcome?.summary ?? 'Failed'))

  const steps = $derived<JobStepView[]>([
    {
      id: 'sync',
      label: integration,
      state: running ? 'active' : done ? 'complete' : 'failed'
    }
  ])

  const note = $derived(
    running
      ? 'You can keep working. The sync continues in the background.'
      : done
        ? attention
          ? `The commits landed and nothing was rolled back. Check what is written above before ${
              incoming ? 'this checkout is' : 'the other end is'
            } next built or started.`
          : incoming
            ? 'Nothing else to do here. The commits that arrived are in this checkout.'
            : 'The other checkout received these commits. Nothing was pushed to a remote.'
        : job.result
          ? 'Nothing was rolled back. Resolve what is written above and finish the integration in the Changes view.'
          : 'Nothing was moved. Fix what is written above, then run the sync again from the Sync menu.'
  )

  /** The other end as git named it, plus the branch it holds when that adds detail. */
  function peerLine(current: GitSyncJob): string {
    const name = current.result?.peerLabel ?? current.peerLabel
    const branch = current.result?.peerBranch
    if (!branch || branch === name) return name
    return `${name} · ${branch}`
  }
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
  dragLabel="Drag to move the sync"
  defaultHeight={380}
>
  {#snippet details()}
    {#if notes.length > 0 || findings.length > 0}
      <!--
        What the outcome adds to its summary: a warning when the integration
        left work behind in a checkout (the commits are in, and the breakage only
        shows up in that checkout's next build or start), a plain note otherwise.
      -->
      <div
        class={[
          'rounded-lg border px-3 py-2',
          attention ? 'border-warning/25 bg-warning/10' : 'bg-overlay'
        ]}
      >
        {#each notes as note, index (index)}
          <p
            class="text-xs leading-relaxed {attention && index === 0
              ? 'font-semibold text-warning'
              : 'text-muted'}"
          >
            {note}
          </p>
        {/each}
        {#if findings.length > 0}
          <ul class="mt-1 space-y-0.5">
            {#each findings as finding, index (index)}
              <li class="text-xs leading-relaxed text-muted">{finding}</li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}

    {#if job.result}
      <div class="space-y-1 rounded-lg border bg-overlay px-3 py-2 text-xs text-muted">
        <p class="flex min-w-0 items-start gap-1.5">
          <span class="shrink-0 text-dimmed">Other end</span>
          <span class="min-w-0 truncate text-foreground">{peerLine(job)}</span>
        </p>
        <p class="flex min-w-0 items-start gap-1.5">
          <span class="shrink-0 text-dimmed">{incoming ? 'Into' : 'From'}</span>
          <code class="min-w-0 truncate font-mono text-foreground">{job.result.branch}</code>
        </p>
        {#if incoming}
          <p class="flex min-w-0 items-start gap-1.5">
            <span class="shrink-0 text-dimmed">Integrated</span>
            <code class="min-w-0 truncate font-mono text-foreground">{job.result.ref}</code>
          </p>
        {/if}
        {#if job.result.remote && job.result.fetched}
          <p class="truncate text-dimmed">
            {job.result.remote}/{job.result.peerBranch} was refreshed before integrating.
          </p>
        {/if}
      </div>
    {/if}
  {/snippet}
</JobPanel>
