<script module lang="ts">
  import type { CioCleanupProgress } from '$shared/types'

  /**
   * What a cleanup run is doing, or how it ended, as one short line.
   *
   * Shared with the dock chip so a minimized run reads the same there as it does
   * in its panel. Kept here, beside the panel that owns the run's other copy,
   * rather than in the store, which only carries the raw progress.
   */
  export function cioCleanupStatusLabel(progress: CioCleanupProgress): string {
    switch (progress.phase) {
      case 'preparing':
        return 'Scanning scratch folders'
      case 'sweeping':
        return progress.currentTarget
          ? `Sweeping ${progress.currentTarget}`
          : 'Sweeping stale scratch'
      case 'completed':
        return 'Cleanup finished'
      case 'cancelled':
        return 'Cleanup stopped'
      case 'failed':
        return 'Cleanup failed'
    }
  }
</script>

<script lang="ts">
  /**
   * One manual cleanup run, as the shared job panel draws it.
   *
   * This adapter owns everything cleanup-specific: the phase sentence, the
   * reclaimed counters, and the newest removals. The panel, its footer and its
   * dockable behaviour are shared with the worktree runs, the pull request
   * batches and the syncs between checkouts.
   */
  import JobPanel from '$lib/components/ui/JobPanel.svelte'
  import { formatBytes } from '$lib/format/bytes'
  import {
    cioCleanupStore,
    cioCleanupStepViews,
    type CioCleanupJob
  } from '$lib/stores/cio-cleanup.svelte'
  import { formatDateTime } from '$shared/date-time-format'

  interface Props {
    job: CioCleanupJob
    storageKey: string
    onMinimize: () => void
    onClose: () => void
  }

  let { job, storageKey, onMinimize, onClose }: Props = $props()

  const running = $derived(job.status === 'running')

  /** The phase the run is in right now, or how it ended. */
  const statusLabel = $derived(cioCleanupStatusLabel(job.progress))

  const steps = $derived(cioCleanupStepViews(job.progress))

  const entryCount = $derived(job.progress.entriesRemoved)
  const folderCount = $derived(job.progress.targetsDone)

  /** The newest removals first, so the list opens on what just happened. */
  const recentRemovals = $derived(job.progress.removed.slice(-50).reverse())

  /** One sentence: that the user may leave, or what the settled run left behind. */
  const note = $derived(
    running
      ? 'You can keep working; the cleanup runs in the background.'
      : `Removed ${entryCount} ${entryCount === 1 ? 'entry' : 'entries'} (${formatBytes(
          job.progress.bytesRemoved
        )}) in ${folderCount} ${folderCount === 1 ? 'folder' : 'folders'}.`
  )
</script>

<JobPanel
  title="CIO Cleanup"
  status={job.status}
  {statusLabel}
  {steps}
  error={job.progress.error ?? null}
  {note}
  minimized={job.minimized}
  {onMinimize}
  {onClose}
  {storageKey}
  actionLabel={running ? 'Stop cleanup' : undefined}
  onAction={running ? () => void cioCleanupStore.cancel(job.id) : undefined}
  dragLabel="Drag to move the cleanup run"
>
  {#snippet details()}
    <div class="space-y-1 rounded-lg border bg-overlay px-3 py-2 text-xs text-muted">
      {#if running && job.progress.currentTarget}
        <p class="flex min-w-0 items-center gap-1.5">
          <span class="shrink-0 text-dimmed">Sweeping</span>
          <span class="min-w-0 truncate text-foreground" title={job.progress.currentTarget}>
            {job.progress.currentTarget}
          </span>
        </p>
      {/if}
      <p class="flex items-center gap-1.5">
        <span class="shrink-0 text-dimmed">Entries removed</span>
        <span class="tabular-nums font-medium text-foreground">{entryCount}</span>
      </p>
      <p class="flex items-center gap-1.5">
        <span class="shrink-0 text-dimmed">Reclaimed</span>
        <span class="tabular-nums font-medium text-foreground">
          {formatBytes(job.progress.bytesRemoved)}
        </span>
      </p>
      <p class="flex items-center gap-1.5">
        <span class="shrink-0 text-dimmed">Started</span>
        <span class="tabular-nums text-foreground">{formatDateTime(job.startedAt)}</span>
      </p>
      {#if job.finishedAt !== null}
        <p class="flex items-center gap-1.5">
          <span class="shrink-0 text-dimmed">Finished</span>
          <span class="tabular-nums text-foreground">{formatDateTime(job.finishedAt)}</span>
        </p>
      {/if}
    </div>

    {#if recentRemovals.length > 0}
      <!--
        The newest removals the run made, capped and scrolled so a long sweep
        never grows the panel without bound. The path is relative to the swept
        folder, which is what the user navigates by.
      -->
      <ul
        class="max-h-40 space-y-0.5 overflow-y-auto rounded-lg border bg-overlay px-3 py-2 text-xs"
        aria-label="Entries removed by this cleanup run"
      >
        {#each recentRemovals as record (record.target + '\u0000' + record.path)}
          <li class="flex min-w-0 items-center gap-2">
            <span class="min-w-0 flex-1 truncate font-mono text-foreground" title={record.path}>
              {record.path}
            </span>
            <span class="shrink-0 tabular-nums text-muted">
              {record.entries}
              {record.entries === 1 ? 'entry' : 'entries'}
            </span>
            <span class="shrink-0 tabular-nums text-muted">{formatBytes(record.bytes)}</span>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="rounded-lg border bg-overlay px-3 py-2 text-xs text-dimmed">
        Nothing was stale enough to remove.
      </p>
    {/if}
  {/snippet}
</JobPanel>
