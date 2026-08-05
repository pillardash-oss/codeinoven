<script lang="ts">
  import { ChevronDown, ChevronRight, FileDiff, RotateCcw } from '@lucide/svelte'
  import FileTypeIcon from '../files/FileTypeIcon.svelte'
  import type { TurnCheckpointChangeSummary, TurnCheckpointSummary } from '$shared/types'

  interface Props {
    checkpoint: TurnCheckpointSummary
    onOpenFile: (path: string) => void
    onReview: () => void
    onUndo: () => Promise<void>
  }

  let { checkpoint, onOpenFile, onReview, onUndo }: Props = $props()

  let open = $state(true)
  let showAll = $state(false)
  let undoing = $state(false)

  const additionsTotal = $derived(
    checkpoint.changes.reduce((total, change) => total + (change.additions ?? 0), 0)
  )
  const deletionsTotal = $derived(
    checkpoint.changes.reduce((total, change) => total + (change.deletions ?? 0), 0)
  )
  const remainingChanges = $derived(
    checkpoint.changes.filter((change) => !checkpoint.rolledBackPaths?.includes(change.path))
  )
  const visibleChanges = $derived(showAll ? checkpoint.changes : checkpoint.changes.slice(0, 3))
  const hiddenCount = $derived(Math.max(0, checkpoint.changes.length - 3))
  const rolledBack = $derived(
    checkpoint.status === 'rolled_back' ||
      (checkpoint.changes.length > 0 && remainingChanges.length === 0)
  )
  const canUndo = $derived(checkpoint.changes.length > 0 && !rolledBack)

  function statusLabel(kind: TurnCheckpointChangeSummary['kind']): string {
    if (kind === 'created') return 'A'
    if (kind === 'deleted') return 'D'
    return 'M'
  }

  function additions(change: TurnCheckpointChangeSummary): number | null {
    return 'additions' in change && typeof change.additions === 'number' ? change.additions : null
  }

  function deletions(change: TurnCheckpointChangeSummary): number | null {
    return 'deletions' in change && typeof change.deletions === 'number' ? change.deletions : null
  }

  async function undo(): Promise<void> {
    if (undoing || !canUndo) return
    undoing = true
    try {
      await onUndo()
    } finally {
      undoing = false
    }
  }
</script>

<div class="overflow-hidden rounded-xl border border-border bg-surface">
  <div class="flex min-h-16 items-center gap-3 px-3 py-2.5">
    <button
      type="button"
      class="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      aria-expanded={open}
      title={open ? 'Hide changed files' : 'Show changed files'}
      onclick={() => (open = !open)}
    >
      <span
        class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-raised text-muted"
      >
        <FileDiff size={18} />
      </span>
      <span class="min-w-0 flex-1">
        <span class="flex items-center gap-1.5">
          <span class="truncate text-sm font-semibold text-foreground">
            Edited {checkpoint.changes.length}
            {checkpoint.changes.length === 1 ? 'file' : 'files'}
          </span>
          {#if open}
            <ChevronDown size={13} class="shrink-0 text-dimmed" />
          {:else}
            <ChevronRight size={13} class="shrink-0 text-dimmed" />
          {/if}
        </span>
        <span class="mt-0.5 flex gap-1.5 text-xs font-medium tabular-nums">
          <span class="text-success">+{additionsTotal}</span>
          <span class="text-danger">−{deletionsTotal}</span>
          {#if checkpoint.changes.some((change) => change.lineCountsTruncated)}
            <span class="font-normal text-dimmed">partial count</span>
          {/if}
        </span>
      </span>
    </button>

    <div class="flex shrink-0 items-center gap-1.5">
      <button
        type="button"
        class="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        title={rolledBack
          ? 'This turn has already been undone'
          : canUndo
            ? 'Undo this turn’s file changes'
            : 'This turn did not change any files'}
        disabled={undoing || !canUndo}
        onclick={() => void undo()}
      >
        <RotateCcw size={13} class={undoing ? 'animate-spin' : ''} />
        {undoing ? 'Undoing…' : rolledBack ? 'Undone' : 'Undo'}
      </button>
      <button
        type="button"
        class="h-8 rounded-lg border border-border bg-elevated px-3 text-xs font-medium text-foreground transition-colors hover:bg-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        title="Review all changes from this turn"
        onclick={onReview}
      >
        Review
      </button>
    </div>
  </div>

  {#if open}
    <div class="border-t border-border">
      {#if checkpoint.failure}
        <p class="border-b border-border px-4 py-2 text-[10px] leading-relaxed text-danger">
          {checkpoint.failure}
        </p>
      {/if}

      {#if checkpoint.changes.length === 0}
        <p class="px-4 py-3 text-[11px] text-dimmed">No file changes detected.</p>
      {:else}
        <div>
          {#each visibleChanges as change (`${change.kind}:${change.path}`)}
            {@const added = additions(change)}
            {@const removed = deletions(change)}
            {@const changeRolledBack = checkpoint.rolledBackPaths?.includes(change.path)}
            <button
              type="button"
              class="flex min-h-9 w-full min-w-0 items-center gap-2 border-b border-border px-4 text-left font-mono text-[11px] transition-colors last:border-b-0 hover:bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
              title={`Open ${change.path}`}
              onclick={() => onOpenFile(change.path)}
            >
              <span
                class="w-3 shrink-0 text-center font-semibold text-warning"
                class:text-success={change.kind === 'created'}
                class:text-danger={change.kind === 'deleted'}
              >
                {statusLabel(change.kind)}
              </span>
              <FileTypeIcon path={change.path} size={14} />
              <span
                class="min-w-0 flex-1 truncate text-muted"
                class:line-through={changeRolledBack}
              >
                {change.path}
              </span>
              {#if changeRolledBack}
                <span class="shrink-0 font-sans text-[9px] text-dimmed">restored</span>
              {:else if change.binary}
                <span class="shrink-0 font-sans text-[9px] text-dimmed">binary</span>
              {:else if added !== null || removed !== null}
                <span class="flex shrink-0 gap-1 tabular-nums">
                  <span class="text-success">+{added ?? 0}</span>
                  <span class="text-danger">−{removed ?? 0}</span>
                </span>
              {/if}
            </button>
          {/each}
        </div>

        {#if hiddenCount > 0}
          <button
            type="button"
            class="flex min-h-9 w-full items-center gap-1 border-t border-border bg-elevated px-4 text-[11px] font-medium text-muted transition-colors hover:bg-overlay hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
            aria-expanded={showAll}
            onclick={() => (showAll = !showAll)}
          >
            {#if showAll}
              <ChevronDown size={11} />
              Show fewer
            {:else}
              <ChevronRight size={11} />
              +{hiddenCount} more {hiddenCount === 1 ? 'file' : 'files'}
            {/if}
          </button>
        {/if}
      {/if}
    </div>
  {/if}
</div>
