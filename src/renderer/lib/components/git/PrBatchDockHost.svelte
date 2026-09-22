<script lang="ts">
  /**
   * Global dock for confirmed pull request batches, mirroring the worktree dock.
   *
   * Mounted at the app root so a batch keeps closing (or reopening) pull requests
   * whatever thread, project or view the user moves to, and so the same batch is
   * never mounted twice: the git panel draws the list, not the run.
   */
  import PrBatchJobPanel from './PrBatchJobPanel.svelte'
  import JobDockRow from '$lib/components/ui/JobDockRow.svelte'
  import {
    prBatchJobStatusLabel,
    prBatchJobSubject,
    prBatchJobs
  } from '$lib/stores/pr-batch-jobs.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { APP_SLUG } from '$shared/brand'

  function projectName(projectId: string): string {
    return scopeState.projectRecords.find((project) => project.id === projectId)?.name ?? ''
  }

  const minimized = $derived(
    prBatchJobs.jobs
      .filter((job) => job.minimized)
      .map((job) => ({
        id: job.id,
        project: projectName(job.projectId),
        title: prBatchJobSubject(job),
        statusLabel: prBatchJobStatusLabel(job),
        status: job.status
      }))
  )
</script>

{#each prBatchJobs.jobs as job (job.id)}
  <PrBatchJobPanel
    {job}
    projectName={projectName(job.projectId)}
    storageKey={prBatchJobs.storageKeyFor(job.id)}
    onMinimize={() => prBatchJobs.minimize(job.id)}
    onClose={() => prBatchJobs.close(job.id)}
  />
{/each}

<JobDockRow
  storageKey={`${APP_SLUG}.prBatchDock.v1`}
  label="Move docked pull request batches"
  groupLabel="Docked pull request batches"
  jobs={minimized}
  expandLabel={(job) => `Show the pull request batch ${job.title} in ${job.project}`}
  onExpand={(id) => prBatchJobs.expand(id)}
/>
