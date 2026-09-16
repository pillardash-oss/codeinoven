<script lang="ts">
  import { CircleCheck, Loader2, TriangleAlert } from '@lucide/svelte'
  import ScopeJobPanel from './ScopeJobPanel.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { scopeJobStageLabel, scopeJobs, type ScopeJob } from '$lib/stores/scope-jobs.svelte'
  import { trackNativeViewOverlay } from '$lib/stores/native-view-occlusion.svelte'

  const minimized = $derived(scopeJobs.jobs.filter((job) => job.minimized))

  /** Short state text beside the scope name in the dock chip. */
  function chipState(job: ScopeJob): string {
    if (job.status === 'running') return scopeJobStageLabel(job.stage.stage)
    return job.status === 'succeeded' ? 'Ready' : 'Failed'
  }

  function projectName(projectId: string): string {
    return scopeState.projectRecords.find((project) => project.id === projectId)?.name ?? ''
  }
</script>

<!--
  Global worktree dock   mirrors `PrDockHost` and `HarnessRunModal`. Mounted at
  the app root so a create/adopt run keeps streaming its stages whatever thread,
  project or view the user moves to while git and the setup commands work.
-->
{#each scopeJobs.jobs as job (job.id)}
  <ScopeJobPanel
    {job}
    storageKey={scopeJobs.storageKeyFor(job.id)}
    onMinimize={() => scopeJobs.minimize(job.id)}
    onExpand={() => scopeJobs.expand(job.id)}
    onClose={() => scopeJobs.close(job.id)}
  />
{/each}

<!--
  Unified dock: each minimized run reports through this single row instead of
  its own chip, so several projects' runs can never stack on top of each other.
-->
{#if minimized.length > 0}
  <div
    class="fixed right-4 bottom-4 z-50 flex max-w-[calc(100vw-2rem)] items-stretch gap-1 overflow-x-auto rounded-xl border bg-surface p-1.5 shadow-xl"
    {@attach trackNativeViewOverlay}
    role="group"
    aria-label="Docked worktree runs"
  >
    {#each minimized as job (job.id)}
      {@const project = projectName(job.projectId)}
      <button
        type="button"
        class="flex min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-elevated"
        title={`${project ? `${project}: ` : ''}${job.title}, ${chipState(job)}`}
        aria-label={`Show the worktree run for ${job.title}`}
        onclick={() => scopeJobs.expand(job.id)}
      >
        {#if job.status === 'running'}
          <Loader2 size={13} class="shrink-0 animate-spin text-info" aria-hidden="true" />
        {:else if job.status === 'succeeded'}
          <CircleCheck size={13} class="shrink-0 text-success" aria-hidden="true" />
        {:else}
          <TriangleAlert size={13} class="shrink-0 text-danger" aria-hidden="true" />
        {/if}
        <span class="flex min-w-0 flex-col">
          {#if project}
            <span class="max-w-40 truncate text-[0.5625rem] font-medium leading-tight text-muted">
              {project}
            </span>
          {/if}
          <span class="max-w-40 truncate text-[0.625rem] font-medium leading-tight text-foreground">
            {job.title}
          </span>
          <span class="max-w-40 truncate text-[0.5625rem] leading-tight text-muted">
            {chipState(job)}
          </span>
        </span>
      </button>
    {/each}
  </div>
{/if}
