<script lang="ts">
  /**
   * Global dock for manual cleanup runs, mirroring the worktree and sync docks.
   *
   * Mounted at the app root so a cleanup keeps reporting whatever thread,
   * project or view the user moves to. The run is app-wide, so its chip carries
   * no project, and the run itself is dockable rather than blocking the settings
   * page it started from.
   */
  import CioCleanupJobPanel, { cioCleanupStatusLabel } from './CioCleanupJobPanel.svelte'
  import JobDockRow from '$lib/components/ui/JobDockRow.svelte'
  import { cioCleanupStore } from '$lib/stores/cio-cleanup.svelte'
  import { APP_SLUG } from '$shared/brand'

  const minimized = $derived(
    cioCleanupStore.jobs
      .filter((job) => job.minimized)
      .map((job) => ({
        id: job.id,
        project: '',
        title: 'CIO Cleanup',
        statusLabel: cioCleanupStatusLabel(job.progress),
        status: job.status
      }))
  )
</script>

{#each cioCleanupStore.jobs as job (job.id)}
  <CioCleanupJobPanel
    {job}
    storageKey={cioCleanupStore.storageKeyFor(job.id)}
    onMinimize={() => cioCleanupStore.minimize(job.id)}
    onClose={() => cioCleanupStore.close(job.id)}
  />
{/each}

<JobDockRow
  storageKey={`${APP_SLUG}.cioCleanupDock.v1`}
  label="Move docked cleanup runs"
  groupLabel="Docked cleanup runs"
  jobs={minimized}
  expandLabel={(job) => `Show the ${job.title} run`}
  onExpand={(id) => cioCleanupStore.expand(id)}
/>
