<script lang="ts">
  /**
   * Global dock for pull runs, mirroring the sync, worktree and pull request
   * docks.
   *
   * Mounted at the app root so a pull keeps reporting whatever thread, project
   * or view the user moves to, and so nothing about it holds the window: the
   * chooser that started it is gone by the time the first ref moves.
   */
  import GitPullJobPanel from './GitPullJobPanel.svelte'
  import JobDockRow from '$lib/components/ui/JobDockRow.svelte'
  import { gitPullJobs } from '$lib/stores/git-pull-jobs.svelte'
  import { gitPullJobStatusLabel } from './git-pull-copy'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { APP_SLUG } from '$shared/brand'

  function projectName(projectId: string): string {
    return scopeState.projectRecords.find((project) => project.id === projectId)?.name ?? ''
  }

  const minimized = $derived(
    gitPullJobs.jobs
      .filter((job) => job.minimized)
      .map((job) => ({
        id: job.id,
        project: projectName(job.projectId),
        title: `Pull ${job.remote}/${job.branch}`,
        statusLabel: gitPullJobStatusLabel(job),
        status: job.status
      }))
  )
</script>

{#each gitPullJobs.jobs as job (job.id)}
  <GitPullJobPanel
    {job}
    storageKey={gitPullJobs.storageKeyFor(job.id)}
    onMinimize={() => gitPullJobs.minimize(job.id)}
    onClose={() => gitPullJobs.close(job.id)}
  />
{/each}

<JobDockRow
  storageKey={`${APP_SLUG}.gitPullDock.v1`}
  label="Move docked pulls"
  groupLabel="Docked pulls"
  jobs={minimized}
  expandLabel={(job) => `Show ${job.title} in ${job.project}`}
  onExpand={(id) => gitPullJobs.expand(id)}
/>
