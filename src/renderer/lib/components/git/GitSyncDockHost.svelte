<script lang="ts">
  /**
   * Global dock for sync runs, mirroring the worktree and pull request docks.
   *
   * Mounted at the app root so a sync keeps reporting whatever thread, project
   * or view the user moves to, and so nothing about it holds the window: the
   * chooser that started it is gone by the time the first ref moves.
   */
  import GitSyncJobPanel from './GitSyncJobPanel.svelte'
  import JobDockRow from '$lib/components/ui/JobDockRow.svelte'
  import { gitSyncJobs } from '$lib/stores/git-sync-jobs.svelte'
  import { gitSyncJobStatusLabel } from './git-sync-copy'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { APP_SLUG } from '$shared/brand'

  function projectName(projectId: string): string {
    return scopeState.projectRecords.find((project) => project.id === projectId)?.name ?? ''
  }

  const minimized = $derived(
    gitSyncJobs.jobs
      .filter((job) => job.minimized)
      .map((job) => ({
        id: job.id,
        project: projectName(job.projectId),
        title: `Sync ${job.direction === 'from' ? 'from' : 'to'} ${job.peerLabel}`,
        statusLabel: gitSyncJobStatusLabel(job),
        status: job.status
      }))
  )
</script>

{#each gitSyncJobs.jobs as job (job.id)}
  <GitSyncJobPanel
    {job}
    storageKey={gitSyncJobs.storageKeyFor(job.id)}
    onMinimize={() => gitSyncJobs.minimize(job.id)}
    onClose={() => gitSyncJobs.close(job.id)}
  />
{/each}

<JobDockRow
  storageKey={`${APP_SLUG}.gitSyncDock.v1`}
  label="Move docked syncs"
  groupLabel="Docked syncs"
  jobs={minimized}
  expandLabel={(job) => `Show ${job.title} in ${job.project}`}
  onExpand={(id) => gitSyncJobs.expand(id)}
/>
