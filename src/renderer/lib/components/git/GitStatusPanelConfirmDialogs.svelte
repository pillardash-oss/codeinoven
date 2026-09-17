<script lang="ts">
  import { ExternalLink, Loader2 } from '@lucide/svelte'
  import { AlertDialog } from 'bits-ui'
  import { gitState } from '$lib/stores/git.svelte'
  import type { GitCommitInfo, GitConflictSide, GitStashEntry } from '$shared/types'
  import Modal from '../ui/Modal.svelte'
  import { absoluteTime, relativeTime } from './git-status-panel-format'

  interface Props {
    stashDropTarget: GitStashEntry | null
    discardConfirm: string[] | null
    restoreWorktreeConfirm: { source: string; path: string } | null
    abortConfirmOpen: boolean
    acceptConflictsSide: GitConflictSide | null
    commitInfoTarget: GitCommitInfo | null
    conflictState: 'merge' | 'rebase' | 'none'
    conflictedCount: number
    commitInfoOnRemote: boolean
    commitInfoUrl: string | null
    onConfirmStashDrop: () => void
    onConfirmDiscard: () => void
    onConfirmRestoreWorktree: () => void
    onConfirmAbortConflict: () => void
    onConfirmAcceptAllConflicts: () => void
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
    conflictState,
    conflictedCount,
    commitInfoOnRemote,
    commitInfoUrl,
    onConfirmStashDrop,
    onConfirmDiscard,
    onConfirmRestoreWorktree,
    onConfirmAbortConflict,
    onConfirmAcceptAllConflicts,
    onCopyCommitHash,
    onOpenCommitInBrowser
  }: Props = $props()
</script>

{#if stashDropTarget}
  {@const dropTarget = stashDropTarget}
  <AlertDialog.Root open onOpenChange={() => (stashDropTarget = null)}>
    <AlertDialog.Portal>
      <AlertDialog.Content
        class="fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-xl"
      >
        <AlertDialog.Title class="text-sm font-semibold text-foreground">
          Discard stash?
        </AlertDialog.Title>
        <AlertDialog.Description class="mt-2 text-xs leading-5 text-muted">
          Stash
          <strong class="font-medium text-foreground">
            “{dropTarget.message}”
          </strong>
          ({dropTarget.id}) will be permanently discarded. This cannot be undone.
        </AlertDialog.Description>
        <div class="mt-5 flex justify-end gap-2">
          <AlertDialog.Cancel
            class="h-8 rounded-lg border border-border px-3 text-xs text-foreground hover:bg-elevated"
          >
            Cancel
          </AlertDialog.Cancel>
          <AlertDialog.Action
            class="h-8 rounded-lg bg-danger px-3 text-xs font-medium text-on-primary hover:opacity-90"
            onclick={onConfirmStashDrop}
          >
            Discard
          </AlertDialog.Action>
        </div>
      </AlertDialog.Content>
    </AlertDialog.Portal>
  </AlertDialog.Root>
{/if}

{#if discardConfirm}
  <AlertDialog.Root open onOpenChange={() => (discardConfirm = null)}>
    <AlertDialog.Portal>
      <AlertDialog.Content
        class="fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-xl"
      >
        <AlertDialog.Title class="text-sm font-semibold text-foreground">
          Discard changes?
        </AlertDialog.Title>
        <AlertDialog.Description class="mt-2 text-xs leading-5 text-muted">
          Changes to
          {discardConfirm.length}
          {discardConfirm.length === 1 ? 'file' : 'files'} will be permanently discarded. This cannot
          be undone.
        </AlertDialog.Description>
        {#if discardConfirm.length > 4}
          <div
            class="mt-3 max-h-24 overflow-auto rounded-lg border border-border bg-elevated/50 p-2"
          >
            {#each discardConfirm as path (path)}
              <p class="truncate font-mono text-[0.5625rem] text-dimmed">{path}</p>
            {/each}
          </div>
        {/if}
        <div class="mt-5 flex justify-end gap-2">
          <AlertDialog.Cancel
            class="h-8 rounded-lg border border-border px-3 text-xs text-foreground hover:bg-elevated"
          >
            Cancel
          </AlertDialog.Cancel>
          <AlertDialog.Action
            class="h-8 rounded-lg bg-danger px-3 text-xs font-medium text-on-primary hover:opacity-90"
            onclick={onConfirmDiscard}
          >
            Discard changes
          </AlertDialog.Action>
        </div>
      </AlertDialog.Content>
    </AlertDialog.Portal>
  </AlertDialog.Root>
{/if}

{#if restoreWorktreeConfirm}
  <AlertDialog.Root open onOpenChange={() => (restoreWorktreeConfirm = null)}>
    <AlertDialog.Portal>
      <AlertDialog.Content
        class="fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-xl"
      >
        <AlertDialog.Title class="text-sm font-semibold text-foreground">
          Restore {restoreWorktreeConfirm.path}?
        </AlertDialog.Title>
        <AlertDialog.Description class="mt-2 text-xs leading-5 text-muted">
          The file on disk will be overwritten with its content from this history entry. Any
          uncommitted local edits to it are lost. This cannot be undone.
        </AlertDialog.Description>
        <div class="mt-5 flex justify-end gap-2">
          <AlertDialog.Cancel
            class="h-8 rounded-lg border border-border px-3 text-xs text-foreground hover:bg-elevated"
          >
            Cancel
          </AlertDialog.Cancel>
          <AlertDialog.Action
            class="h-8 rounded-lg bg-danger px-3 text-xs font-medium text-on-primary hover:opacity-90"
            onclick={onConfirmRestoreWorktree}
          >
            Restore file
          </AlertDialog.Action>
        </div>
      </AlertDialog.Content>
    </AlertDialog.Portal>
  </AlertDialog.Root>
{/if}

{#if abortConfirmOpen}
  <AlertDialog.Root open onOpenChange={() => (abortConfirmOpen = false)}>
    <AlertDialog.Portal>
      <AlertDialog.Content
        class="fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-xl"
      >
        <AlertDialog.Title class="text-sm font-semibold text-foreground">
          Abort {conflictState === 'merge' ? 'merge' : 'rebase'}?
        </AlertDialog.Title>
        <AlertDialog.Description class="mt-2 text-xs leading-5 text-muted">
          This cancels the in-progress
          <strong class="font-medium text-foreground">{conflictState}</strong> operation and
          restores the working tree to how it was before it started. Any partially resolved files
          will be lost.
          {#if conflictState === 'rebase'}
            Commits created since the rebase started are dropped with it, because the branch goes
            back to the commit it was on when the rebase began.
          {/if}
          This cannot be undone.
        </AlertDialog.Description>
        <div class="mt-5 flex justify-end gap-2">
          <AlertDialog.Cancel
            class="h-8 rounded-lg border border-border px-3 text-xs text-foreground hover:bg-elevated"
          >
            Cancel
          </AlertDialog.Cancel>
          <AlertDialog.Action
            class="flex h-8 items-center gap-1.5 rounded-lg bg-danger px-3 text-xs font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
            disabled={gitState.isBusy('abortMerge') || gitState.isBusy('abortRebase')}
            onclick={onConfirmAbortConflict}
          >
            {#if gitState.isBusy('abortMerge') || gitState.isBusy('abortRebase')}
              <Loader2 size={12} class="animate-spin" />
            {/if}
            Abort {conflictState === 'merge' ? 'merge' : 'rebase'}
          </AlertDialog.Action>
        </div>
      </AlertDialog.Content>
    </AlertDialog.Portal>
  </AlertDialog.Root>
{/if}

{#if acceptConflictsSide}
  {@const side = acceptConflictsSide}
  <AlertDialog.Root open onOpenChange={() => (acceptConflictsSide = null)}>
    <AlertDialog.Portal>
      <AlertDialog.Content
        class="fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-xl"
      >
        <AlertDialog.Title class="text-sm font-semibold text-foreground">
          Accept all {side}?
        </AlertDialog.Title>
        <AlertDialog.Description class="mt-2 text-xs leading-5 text-muted">
          Every conflicted file is replaced with its
          <strong class="font-medium text-foreground">{side}</strong> version and staged, so the
          merge editor's work on the other side of
          <strong class="font-medium text-foreground">{conflictedCount}</strong>
          {conflictedCount === 1 ? 'file' : 'files'} is discarded. This cannot be undone.
        </AlertDialog.Description>
        <div class="mt-5 flex justify-end gap-2">
          <AlertDialog.Cancel
            class="h-8 rounded-lg border border-border px-3 text-xs text-foreground hover:bg-elevated"
          >
            Cancel
          </AlertDialog.Cancel>
          <AlertDialog.Action
            class="flex h-8 items-center gap-1.5 rounded-lg bg-danger px-3 text-xs font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
            disabled={gitState.isBusy('accept-conflicts')}
            onclick={onConfirmAcceptAllConflicts}
          >
            {#if gitState.isBusy('accept-conflicts')}
              <Loader2 size={12} class="animate-spin" />
            {/if}
            Accept all {side}
          </AlertDialog.Action>
        </div>
      </AlertDialog.Content>
    </AlertDialog.Portal>
  </AlertDialog.Root>
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
