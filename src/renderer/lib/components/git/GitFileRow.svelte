<script lang="ts">
  import type { GitDiff, GitFileChange, TurnCheckpointFileDiff } from '$shared/types'
  import FileTypeIcon from '../files/FileTypeIcon.svelte'
  import FileDiffView from '../files/FileDiffView.svelte'
  import { ChevronDown, ChevronRight, Loader2 } from '@lucide/svelte'

  interface Props {
    change: GitFileChange
    diff: GitDiff | null
    loadingDiff: boolean
    error: string | null
    expanded: boolean
    onToggleDiff: () => void
    onToggleStage: () => void
  }

  let { change, diff, loadingDiff, error, expanded, onToggleDiff, onToggleStage }: Props = $props()

  const letter = $derived(
    change.status === 'added'
      ? 'A'
      : change.status === 'deleted'
        ? 'D'
        : change.status === 'renamed'
          ? 'R'
          : change.status === 'untracked'
            ? '?'
            : change.status === 'conflicted'
              ? 'U'
              : 'M'
  )

  const color = $derived(
    change.status === 'added'
      ? 'text-success'
      : change.status === 'deleted'
        ? 'text-danger'
        : 'text-warning'
  )

  const viewDiff = $derived(
    diff
      ? ({
          path: diff.path,
          kind:
            change.status === 'added' || change.status === 'untracked'
              ? 'created'
              : change.status === 'deleted'
                ? 'deleted'
                : 'modified',
          binary: diff.binary,
          before: diff.before,
          after: diff.after,
          truncated: diff.truncated
        } satisfies TurnCheckpointFileDiff)
      : null
  )
</script>

<div class="overflow-hidden border-b border-border last:border-b-0">
  <div class="group flex min-h-9 items-center pr-1.5">
    <button
      type="button"
      class="flex min-h-9 min-w-0 flex-1 items-center gap-2 px-3 text-left transition-colors hover:bg-elevated/50"
      title={expanded ? `Collapse diff for ${change.path}` : `Show diff for ${change.path}`}
      aria-expanded={expanded}
      onclick={onToggleDiff}
    >
      <span class={['w-4 shrink-0 text-center font-mono text-[10px] font-semibold', color]}>
        {letter}
      </span>
      <FileTypeIcon path={change.path} size={13} />
      <span class="min-w-0 flex-1 truncate font-mono text-[10px] text-muted">{change.path}</span>
      {#if change.oldPath}
        <span class="shrink-0 text-[9px] text-dimmed">from {change.oldPath}</span>
      {/if}
      {#if diff && !diff.binary}
        <span class="shrink-0 font-mono text-[10px] tabular-nums text-success">
          +{diff.additions}
        </span>
        <span class="shrink-0 font-mono text-[10px] tabular-nums text-danger">
          −{diff.deletions}
        </span>
      {:else if diff?.binary}
        <span class="shrink-0 text-[9px] text-dimmed">binary</span>
      {/if}
      {#if loadingDiff}
        <Loader2 size={11} class="shrink-0 animate-spin text-dimmed" />
      {:else if expanded}
        <ChevronDown size={12} class="shrink-0 text-dimmed" />
      {:else}
        <ChevronRight size={12} class="shrink-0 text-dimmed" />
      {/if}
    </button>
    <button
      type="button"
      class={[
        'shrink-0 rounded px-2 py-1 text-[10px] font-medium transition-colors disabled:opacity-40',
        change.staged
          ? 'text-danger hover:bg-danger/10'
          : 'text-muted hover:bg-elevated hover:text-foreground'
      ]}
      disabled={change.status === 'conflicted'}
      aria-label={change.staged ? `Unstage ${change.path}` : `Stage ${change.path}`}
      title={change.staged ? `Unstage ${change.path}` : `Stage ${change.path}`}
      onclick={onToggleStage}
    >
      {change.staged ? 'Unstage' : 'Stage'}
    </button>
  </div>
  {#if expanded}
    <div class="border-t border-border bg-app/50">
      {#if loadingDiff}
        <div class="flex items-center gap-2 px-3 py-4 text-dimmed">
          <Loader2 size={12} class="animate-spin" />
          <span class="text-[10px]">Loading diff…</span>
        </div>
      {:else if error}
        <p class="px-3 py-4 text-[10px] text-danger" role="alert">{error}</p>
      {:else if viewDiff}
        <FileDiffView diff={viewDiff} maxHeight="18rem" />
        {#if viewDiff.truncated}
          <p class="border-t border-border px-3 py-1 text-[9px] text-dimmed">
            Diff truncated to a bounded preview
          </p>
        {/if}
      {:else}
        <p class="px-3 py-4 text-[10px] text-dimmed">No diff available.</p>
      {/if}
    </div>
  {/if}
</div>
