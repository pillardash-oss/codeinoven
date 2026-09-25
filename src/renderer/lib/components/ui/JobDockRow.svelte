<script lang="ts">
  /**
   * One dock row for every minimized background job.
   *
   * The shared chip row every job owner reports through, so several runs across
   * projects can never stack on top of each other. Presentational: the owner maps
   * its jobs to `JobDockEntry`s and says what expanding one means.
   */
  import { CircleCheck, Loader2, TriangleAlert } from '@lucide/svelte'
  import type { JobDockEntry } from './job-view'
  import DockRow from './DockRow.svelte'

  interface Props {
    /** Owner key the row's edge placement is remembered under. */
    storageKey: string
    /** Action description for the drag head, e.g. "Move docked worktree runs". */
    label: string
    /** Names the chip group for assistive technology. */
    groupLabel: string
    jobs: readonly JobDockEntry[]
    /** Action description for one chip, e.g. "Show the worktree run for X". */
    expandLabel: (job: JobDockEntry) => string
    onExpand: (id: string) => void
  }

  let { storageKey, label, groupLabel, jobs, expandLabel, onExpand }: Props = $props()
</script>

{#if jobs.length > 0}
  <DockRow {storageKey} {label}>
    <div
      class="flex max-w-[calc(100vw-2rem)] items-stretch gap-1 overflow-x-auto rounded-xl border bg-surface p-1.5 shadow-xl"
      role="group"
      aria-label={groupLabel}
    >
      {#each jobs as job (job.id)}
        {@const description = expandLabel(job)}
        <button
          type="button"
          class="flex min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-elevated"
          title={description}
          aria-label={description}
          onclick={() => onExpand(job.id)}
        >
          {#if job.status === 'running'}
            <Loader2 size={13} class="shrink-0 animate-spin text-info" aria-hidden="true" />
          {:else if job.status === 'succeeded'}
            <CircleCheck size={13} class="shrink-0 text-success" aria-hidden="true" />
          {:else}
            <TriangleAlert size={13} class="shrink-0 text-danger" aria-hidden="true" />
          {/if}
          <span class="flex min-w-0 flex-col">
            {#if job.project}
              <span class="max-w-40 truncate text-[0.5625rem] font-medium leading-tight text-muted">
                {job.project}
              </span>
            {/if}
            <span
              class="max-w-40 truncate text-[0.625rem] font-medium leading-tight text-foreground"
            >
              {job.title}
            </span>
            <span class="max-w-40 truncate text-[0.5625rem] leading-tight text-muted">
              {job.statusLabel}
            </span>
          </span>
        </button>
      {/each}
    </div>
  </DockRow>
{/if}
