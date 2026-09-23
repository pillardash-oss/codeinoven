<script lang="ts">
  import { ExternalLink } from '@lucide/svelte'
  import { gitState } from '$lib/stores/git.svelte'
  import type { GitCommitInfo, GitConflictSide, GitStashEntry } from '$shared/types'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'
  import Modal from '../ui/Modal.svelte'
  import { absoluteTime, relativeTime } from './git-status-panel-format'

  interface Props {
    stashDropTarget: GitStashEntry | null
    discardConfirm: string[] | null
    restoreWorktreeConfirm: { source: string; path: string } | null
    abortConfirmOpen: boolean
    acceptConflictsSide: GitConflictSide | null
    commitInfoTarget: GitCommitInfo | null
    removeCommitChangesConfirm: { hash: string; paths: string[] } | null
    conflictState: 'merge' | 'rebase' | 'none'
    conflictedCount: number
    commitInfoOnRemote: boolean
    removeCommitOnRemote: boolean
    commitInfoUrl: string | null
    onConfirmStashDrop: () => void
    onConfirmDiscard: () => void
    onConfirmRestoreWorktree: () => void
    onConfirmAbortConflict: () => void
    onConfirmAcceptAllConflicts: () => void
    onConfirmRemoveCommitChanges: () => void
    onCopyCommitHash: (commit: GitCommitInfo) => void
    onOpenCommitInBrowser: (url: string) => void
  }

  let {
    stashDropTarget = $bindable(),
    discardConfirm = $bindable(),
    restoreWorktreeConfirm = $bindable(),
    abortConfirmOpen = $bindable(),
    acceptConflictsSide = $bindable(),
    commitInfoTarget = $bindable(),
    removeCommitChangesConfirm = $bindable(),
    conflictState,
    conflictedCount,
    commitInfoOnRemote,
    removeCommitOnRemote,
    commitInfoUrl,
    onConfirmStashDrop,
    onConfirmDiscard,
    onConfirmRestoreWorktree,
    onConfirmAbortConflict,
    onConfirmAcceptAllConflicts,
    onConfirmRemoveCommitChanges,
    onCopyCommitHash,
    onOpenCommitInBrowser
  }: Props = $props()
</script>

{#if stashDropTarget}
  {@const dropTarget = stashDropTarget}
  <ConfirmDialog
    open
    title="Discard stash?"
    onCancel={() => (stashDropTarget = null)}
    onConfirm={onConfirmStashDrop}
    confirmLabel="Discard"
  >
    <p>
      Stash
      <strong class="font-medium text-foreground">
        “{dropTarget.message}”
      </strong>
      ({dropTarget.id}) will be permanently discarded. This cannot be undone.
    </p>
  </ConfirmDialog>
{/if}

{#if discardConfirm}
  <ConfirmDialog
    open
    title="Discard changes?"
    onCancel={() => (discardConfirm = null)}
    onConfirm={onConfirmDiscard}
    confirmLabel="Discard changes"
  >
    <p>
      Changes to
      {discardConfirm.length}
      {discardConfirm.length === 1 ? 'file' : 'files'} will be permanently discarded. This cannot be undone.
    </p>
    {#if discardConfirm.length > 4}
      <div class="max-h-24 overflow-auto rounded-lg border border-border bg-elevated/50 p-2">
        {#each discardConfirm as path (path)}
          <p class="truncate font-mono text-[0.5625rem] text-dimmed">{path}</p>
        {/each}
      </div>
    {/if}
  </ConfirmDialog>
{/if}

{#if restoreWorktreeConfirm}
  <ConfirmDialog
    open
    title={`Restore ${restoreWorktreeConfirm.path}?`}
    onCancel={() => (restoreWorktreeConfirm = null)}
    onConfirm={onConfirmRestoreWorktree}
    confirmLabel="Restore file"
  >
    <p>
      The file on disk will be overwritten with its content from this history entry. Any uncommitted
      local edits to it are lost. This cannot be undone.
    </p>
  </ConfirmDialog>
{/if}

{#if removeCommitChangesConfirm}
  {@const removal = removeCommitChangesConfirm}
  <ConfirmDialog
    open
    title="Remove from commit?"
    onCancel={() => (removeCommitChangesConfirm = null)}
    onConfirm={onConfirmRemoveCommitChanges}
    confirmLabel="Remove from commit"
  >
    <p>
      The selected
      {removal.paths.length === 1 ? 'file change leaves' : 'file changes leave'}
      <strong class="font-medium text-foreground">{removal.hash.slice(0, 7)}</strong>, so the commit
      is rewritten and looks like it never touched
      {removal.paths.length === 1 ? 'that file' : 'those files'}. Commits after it are replayed and
      get new hashes. A file still in the working tree keeps its content and shows up as an unstaged
      change. This cannot be undone.
    </p>
    {#if removal.paths.length > 1}
      <div class="max-h-24 overflow-auto rounded-lg border border-border bg-elevated/50 p-2">
        {#each removal.paths as path (path)}
          <p class="truncate font-mono text-[0.5625rem] text-dimmed">{path}</p>
        {/each}
      </div>
    {/if}
    {#if removeCommitOnRemote}
      <p class="text-warning">
        This commit is already on the remote, so the branch needs a force push afterwards.
      </p>
    {/if}
  </ConfirmDialog>
{/if}

{#if abortConfirmOpen}
  <ConfirmDialog
    open
    title={`Abort ${conflictState === 'merge' ? 'merge' : 'rebase'}?`}
    onCancel={() => (abortConfirmOpen = false)}
    onConfirm={onConfirmAbortConflict}
    confirmLabel={`Abort ${conflictState === 'merge' ? 'merge' : 'rebase'}`}
    busy={gitState.isBusy('abortMerge') || gitState.isBusy('abortRebase')}
  >
    <p>
      This cancels the in-progress
      <strong class="font-medium text-foreground">{conflictState}</strong> operation and restores
      the working tree to how it was before it started. Any partially resolved files will be lost.
      {#if conflictState === 'rebase'}
        Commits created since the rebase started are dropped with it, because the branch goes back
        to the commit it was on when the rebase began.
      {/if}
      This cannot be undone.
    </p>
  </ConfirmDialog>
{/if}

{#if acceptConflictsSide}
  {@const side = acceptConflictsSide}
  <ConfirmDialog
    open
    title={`Accept all ${side}?`}
    onCancel={() => (acceptConflictsSide = null)}
    onConfirm={onConfirmAcceptAllConflicts}
    confirmLabel={`Accept all ${side}`}
    busy={gitState.isBusy('accept-conflicts')}
  >
    <p>
      Every conflicted file is replaced with its
      <strong class="font-medium text-foreground">{side}</strong> version and staged, so the merge
      editor's work on the other side of
      <strong class="font-medium text-foreground">{conflictedCount}</strong>
      {conflictedCount === 1 ? 'file' : 'files'} is discarded. This cannot be undone.
    </p>
  </ConfirmDialog>
{/if}

{#if commitInfoTarget}
  {@const info = commitInfoTarget}
  <Modal open title="Commit info" size="lg" onClose={() => (commitInfoTarget = null)}>
    <div class="space-y-3">
      <div>
        <p class="text-[0.5625rem] font-semibold uppercase tracking-wide text-muted">Full hash</p>
        <div class="mt-1 flex items-center gap-1.5">
          <span
            class="min-w-0 flex-1 select-all break-all font-mono text-[0.6875rem] text-foreground"
          >
            {info.hash}
          </span>
          <button
            type="button"
            class="shrink-0 cursor-pointer rounded-sm border border-border px-1.5 py-0.5 text-[0.5625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
            title="Copy the full commit hash"
            aria-label="Copy the full commit hash"
            onclick={() => onCopyCommitHash(info)}
          >
            Copy
          </button>
          {#if commitInfoOnRemote && commitInfoUrl}
            <!--
                Only offered once the commit is actually on the remote. GitHub
                answers 404 for a commit that was never pushed, so offering it
                for local work would open a dead page.
              -->
            <button
              type="button"
              class="flex shrink-0 cursor-pointer items-center gap-1 rounded-sm border border-border px-1.5 py-0.5 text-[0.5625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
              title={`Open commit ${info.shortHash} on GitHub`}
              aria-label={`Open commit ${info.shortHash} on GitHub`}
              data-external-url={commitInfoUrl}
              onclick={() => onOpenCommitInBrowser(commitInfoUrl)}
            >
              <ExternalLink size={10} />
              Open in browser
            </button>
          {/if}
        </div>
      </div>

      <dl class="grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-1.5 text-[0.6875rem]">
        <dt class="text-dimmed">Author</dt>
        <dd class="min-w-0 truncate text-foreground">{info.author}</dd>
        <dt class="text-dimmed">Committed</dt>
        <dd class="text-foreground">
          {absoluteTime(info.date)}
          <span class="text-dimmed">({relativeTime(info.date)})</span>
        </dd>
        <dt class="text-dimmed">Short hash</dt>
        <dd class="font-mono text-foreground">{info.shortHash}</dd>
        <dt class="text-dimmed">Parents</dt>
        <dd class="font-mono text-dimmed">
          {info.parents.length > 0
            ? info.parents.map((parent) => parent.slice(0, 7)).join(', ')
            : 'root commit'}
        </dd>
        {#if info.refs.length > 0}
          <dt class="text-dimmed">Refs</dt>
          <dd class="flex flex-wrap gap-1">
            {#each info.refs as ref (ref.head ? `head:${ref.name}` : `${ref.kind}:${ref.name}`)}
              <span
                class={[
                  'rounded-sm px-1 py-px text-[0.5625rem] font-medium',
                  ref.head
                    ? 'bg-primary text-on-primary'
                    : ref.kind === 'tag'
                      ? 'bg-accent/15 text-accent'
                      : 'bg-primary/15 text-primary'
                ]}
              >
                {ref.name}
              </span>
            {/each}
          </dd>
        {/if}
      </dl>

      <div>
        <p class="text-[0.5625rem] font-semibold uppercase tracking-wide text-muted">Message</p>
        <pre
          class="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-elevated/50 p-2 font-mono text-[0.625rem] leading-relaxed text-foreground">{info.message}{info.body.trim()
            .length > 0
            ? `\n\n${info.body.trim()}`
            : ''}</pre>
      </div>
    </div>
  </Modal>
{/if}
