<script lang="ts">
  import { Archive, Loader2, Trash2 } from '@lucide/svelte'
  import type { GitDiff, GitFileChange, GitRestoreTarget, GitStashEntry } from '$shared/types'
  import GitFileRow from './GitFileRow.svelte'
  import { relativeTime } from './git-status-panel-format'

  interface Props {
    selectedStash: GitStashEntry | null
    loadingStashDiff: boolean
    stashDiffChanges: GitFileChange[]
    stashDiffs: Record<string, GitDiff>
    loadingStashDiffFile: Record<string, boolean>
    stashDiffErrors: Record<string, string | null>
    stashExpanded: Record<string, boolean>
    stashes: GitStashEntry[]
    stashOpBusy: boolean
    stashPopBusy: boolean
    onSelectStash: (stash: GitStashEntry) => void
    onToggleStashDiff: (change: GitFileChange) => void
    onRestore: (path: string, target: GitRestoreTarget) => void
    onPopStash: (id?: string) => void
    onRequestStashDrop: (stash: GitStashEntry) => void
  }

  let {
    selectedStash,
    loadingStashDiff,
    stashDiffChanges,
    stashDiffs,
    loadingStashDiffFile,
    stashDiffErrors,
    stashExpanded,
    stashes,
    stashOpBusy,
    stashPopBusy,
    onSelectStash,
    onToggleStashDiff,
    onRestore,
    onPopStash,
    onRequestStashDrop
  }: Props = $props()
</script>

<div class="p-2">
  {#if selectedStash}
    <!--
      The stash's identity and its back control live in the panel's action
      row, so the changed files start at the top of the content region.
    -->
    <div>
      {#if loadingStashDiff}
        <div class="flex items-center justify-center gap-2 py-10 text-xs text-dimmed">
          <Loader2 size={14} class="animate-spin" />
          Loading changes
        </div>
      {:else if stashDiffChanges.length === 0}
        <div class="flex flex-col items-center justify-center py-12 text-center">
          <Archive size={22} class="mx-auto mb-2 text-dimmed" />
          <p class="text-xs font-medium text-muted">No file changes</p>
          <p class="mt-1 text-[0.625rem] text-dimmed">This stash has no changes.</p>
        </div>
      {:else}
        <div class="overflow-hidden rounded-lg border border-border bg-surface">
          <div class="flex items-center gap-1.5 bg-elevated/50 px-2.5 py-1">
            <span class="text-[0.5625rem] font-semibold uppercase tracking-wide text-muted">
              Changed files
            </span>
            <span class="text-[0.5rem] tabular-nums text-dimmed">
              {stashDiffChanges.length}
            </span>
          </div>
          {#each stashDiffChanges as change (change.path)}
            <GitFileRow
              {change}
              diff={stashDiffs[change.path] ?? null}
              loadingDiff={loadingStashDiffFile[change.path] ?? false}
              error={stashDiffErrors[change.path] ?? null}
              expanded={stashExpanded[change.path] ?? false}
              readonly
              onToggleDiff={() => onToggleStashDiff(change)}
              onToggleStage={() => {}}
              {onRestore}
            />
          {/each}
        </div>
      {/if}
    </div>
  {:else}
    <div class="overflow-hidden rounded-lg border border-border bg-surface">
      {#each stashes as stash (stash.id)}
        <div
          class="flex items-center gap-2 border-b border-border px-3 py-2 last:border-b-0 hover:bg-elevated/40"
        >
          <button
            type="button"
            class="flex min-w-0 flex-1 items-center gap-2 rounded text-left transition-colors hover:text-foreground"
            title="View changes in stash {stash.id}"
            aria-label="View changes in stash {stash.id}"
            onclick={() => onSelectStash(stash)}
          >
            <Archive size={12} class="shrink-0 text-dimmed" />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-[0.6875rem] leading-snug text-foreground">
                {stash.message}
              </span>
              <span class="mt-0.5 flex items-center gap-1.5 text-[0.5625rem] text-dimmed">
                <span class="font-mono">{stash.id}</span>
                {#if stash.branch}
                  <span>·</span>
                  <span class="truncate">{stash.branch}</span>
                {/if}
                <span>·</span>
                <span>{relativeTime(stash.date)}</span>
              </span>
            </span>
          </button>
          <button
            type="button"
            class="shrink-0 rounded-md border border-border px-2 py-1 text-[0.625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
            disabled={stashOpBusy}
            title="Restore stash {stash.id} into the working tree"
            onclick={() => onPopStash(stash.id)}
          >
            {stashPopBusy ? 'Popping…' : 'Pop'}
          </button>
          <button
            type="button"
            class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border text-danger transition-colors hover:bg-danger/10 disabled:opacity-40"
            disabled={stashOpBusy}
            title="Discard stash {stash.id}"
            aria-label="Discard stash {stash.id}"
            onclick={() => onRequestStashDrop(stash)}
          >
            <Trash2 size={12} />
          </button>
        </div>
      {/each}
    </div>
    <p class="mt-2 px-1 text-[0.5625rem] leading-relaxed text-dimmed">
      Click a stash to inspect its changes. Popping restores it to your working tree and removes it
      from this list.
    </p>
  {/if}
</div>
