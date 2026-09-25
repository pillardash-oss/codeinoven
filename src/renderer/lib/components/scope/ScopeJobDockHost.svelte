<script lang="ts">
  import ScopeJobPanel from './ScopeJobPanel.svelte'
  import JobDockRow from '$lib/components/ui/JobDockRow.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { scopeJobStatusLabel, scopeJobs } from '$lib/stores/scope-jobs.svelte'
  import { APP_SLUG } from '$shared/brand'

  const minimized = $derived(
    scopeJobs.jobs
      .filter((job) => job.minimized)
      .map((job) => ({
        id: job.id,
        project:
          scopeState.projectRecords.find((project) => project.id === job.projectId)?.name ?? '',
        title: job.title,
        statusLabel: scopeJobStatusLabel(job),
        status: job.status
      }))
  )
</script>

<!--
  Global worktree dock   mirrors `PrDockHost` and `HarnessRunModal`. Mounted at
  the app root so a create, adopt or remove run keeps reporting its stages
  whatever thread, project or view the user moves to while git, the setup
  commands and the removal work.
-->
{#each scopeJobs.jobs as job (job.id)}
  <ScopeJobPanel
    {job}
    storageKey={scopeJobs.storageKeyFor(job.id)}
    onMinimize={() => scopeJobs.minimize(job.id)}
    onClose={() => scopeJobs.close(job.id)}
  />
{/each}

<JobDockRow
  storageKey={`${APP_SLUG}.worktreeDock.v1`}
  label="Move docked worktree runs"
  groupLabel="Docked worktree runs"
  jobs={minimized}
  expandLabel={(job) => `Show the worktree run for ${job.title}`}
  onExpand={(id) => scopeJobs.expand(id)}
/>
