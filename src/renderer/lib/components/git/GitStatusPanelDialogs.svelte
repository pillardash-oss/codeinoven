<script lang="ts">
  import { GitMerge, Loader2 } from '@lucide/svelte'
  import type { Snippet } from 'svelte'
  import { gitState } from '$lib/stores/git.svelte'
  import type {
    GitBranchInfo,
    GitCommitInfo,
    GitFileChange,
    GitPullStrategy,
    GitSyncDirection,
    GitRemoteInfo,
    GitResetMode,
    GitStatus
  } from '$shared/types'
  import FileTypeIcon from '../files/FileTypeIcon.svelte'
  import GitHubSignInModal from './GitHubSignInModal.svelte'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'
  import Modal from '../ui/Modal.svelte'
  import Switch from '../ui/Switch.svelte'

  interface Props {
    repoState: 'loading' | 'git_unavailable' | 'not_git' | 'git'
    status: GitStatus | null
    primaryRemote: GitRemoteInfo | null
    remoteBranchExists: boolean
    /** Push is unavailable: another remote action is running, or a fetch is. */
    pushBlocked: boolean
    pullStrategyOpen: boolean
    pullStrategyError: string
    syncMainOpen: boolean
    syncDirection: GitSyncDirection
    syncMainError: string
    integrationOpen: boolean
    conflictState: 'merge' | 'rebase' | 'none'
    conflicted: GitFileChange[]
    mergeAwaitsCompletion: boolean
    mergePending: boolean
    prResolveBranch: string | null
    completeMergeBusy: boolean
    pushRecoverMode: 'merge' | 'rebase' | null
    localBranches: GitBranchInfo[]
    integrateBusy: boolean
    resetOptions: Array<{ mode: GitResetMode; label: string; hint: string }>
    atRiskFiles: string[]
    agentTurnActive: boolean
    originModalOpen: boolean
    originMode: 'add' | 'replace'
    originName: string
    originBusy: boolean
    pushConfirm: boolean
    pushDiverged: boolean
    completeMergeOpen: boolean
    mergeTitle: string
    mergeDescription: string
    showGitHubSignIn: boolean
    showStashModal: boolean
    stashPaths: string[] | null
    stashMessage: string
    showIntegrateModal: boolean
    mergeTarget: string
    pendingOperation: { kind: 'merge' | 'rebase'; target: string } | null
    acknowledgeActiveTurn: boolean
    resetConfirm: { mode: GitResetMode; target: string } | null
    deleteCommitTarget: GitCommitInfo | null
    checkoutConfirm: GitBranchInfo | null
    deleteBranchConfirm: string | null
    forceDeleteBranchConfirm: string | null
    deleteRemoteBranchConfirm: { remote: string; name: string } | null
    originReplaceConfirm: boolean
    originUrl: string
    integrationActions: Snippet<[boolean?]>
    confirmPushUpstream: () => void
    recoverPush: (mode: 'merge' | 'rebase') => void
    closePullStrategy: () => void
    performPull: (strategy: GitPullStrategy) => void
    closeSyncMain: () => void
    performSyncMain: (direction: GitSyncDirection, strategy: GitPullStrategy) => void
    confirmCompleteMerge: () => void
    openCompleteMerge: () => void
    loadGitHubAuth: () => void
    stashChanges: () => void
    requestMergeOrRebase: (kind: 'merge' | 'rebase') => void
    confirmPendingOperation: () => void
    confirmReset: () => void
    confirmDeleteCommit: () => void
    confirmCheckoutBranch: () => void
    confirmDeleteBranch: () => void
    confirmForceDeleteBranch: () => void
    confirmDeleteRemoteBranch: () => void
    closeOriginModal: () => void
    requestSetOrigin: () => void
    runSetOrigin: () => void
  }

  let {
    repoState,
    status,
    primaryRemote,
    remoteBranchExists,
    pushBlocked,
    pullStrategyOpen,
    pullStrategyError,
    syncMainOpen,
    syncDirection,
    syncMainError,
    integrationOpen,
    conflictState,
    conflicted,
    mergeAwaitsCompletion,
    mergePending,
    prResolveBranch,
    completeMergeBusy,
    pushRecoverMode,
    localBranches,
    integrateBusy,
    resetOptions,
    atRiskFiles,
    agentTurnActive,
    originModalOpen,
    originMode,
    originName,
    originBusy,
    pushConfirm = $bindable(),
    pushDiverged = $bindable(),
    completeMergeOpen = $bindable(),
    mergeTitle = $bindable(),
    mergeDescription = $bindable(),
    showGitHubSignIn = $bindable(),
    showStashModal = $bindable(),
    stashPaths = $bindable(),
    stashMessage = $bindable(),
    showIntegrateModal = $bindable(),
    mergeTarget = $bindable(),
    pendingOperation = $bindable(),
    acknowledgeActiveTurn = $bindable(),
    resetConfirm = $bindable(),
    deleteCommitTarget = $bindable(),
    checkoutConfirm = $bindable(),
    deleteBranchConfirm = $bindable(),
    forceDeleteBranchConfirm = $bindable(),
    deleteRemoteBranchConfirm = $bindable(),
    originReplaceConfirm = $bindable(),
    originUrl = $bindable(),
    integrationActions,
    confirmPushUpstream,
    recoverPush,
    closePullStrategy,
    performPull,
    closeSyncMain,
    performSyncMain,
    confirmCompleteMerge,
    openCompleteMerge,
    loadGitHubAuth,
    stashChanges,
    requestMergeOrRebase,
    confirmPendingOperation,
    confirmReset,
    confirmDeleteCommit,
    confirmCheckoutBranch,
    confirmDeleteBranch,
    confirmForceDeleteBranch,
    confirmDeleteRemoteBranch,
    closeOriginModal,
    requestSetOrigin,
    runSetOrigin
  }: Props = $props()
</script>

{#if pushConfirm}
  <div class="shrink-0 border-t border-border bg-warning/10 px-3 py-2">
    <p class="text-[0.625rem] font-medium text-foreground">
      {remoteBranchExists
        ? `Push ${status?.branch} and track it on the remote?`
        : `Publish ${status?.branch} as a new branch on the remote?`}
    </p>
    <p class="mt-0.5 text-[0.5625rem] leading-relaxed text-muted">
      <span class="font-mono text-foreground">{status?.branch}</span> has no upstream.
      {#if remoteBranchExists}
        <span class="font-mono text-foreground">{primaryRemote?.name}/{status?.branch}</span>
        already exists there, so this push brings it up to date and makes it this branch's upstream.
      {:else}
        This push creates
        <span class="font-mono text-foreground">{primaryRemote?.name}/{status?.branch}</span>
        on <span class="font-mono text-foreground">{primaryRemote?.name}</span> and makes it this branch's
        upstream, so later pushes and pulls go there.
      {/if}
      Nothing is forced: git refuses the push when it would drop remote commits.
    </p>
    <div class="mt-1.5 flex justify-end gap-1.5">
      <button
        type="button"
        class="rounded-md px-2 py-1 text-[0.625rem] font-medium text-muted hover:bg-elevated"
        onclick={() => (pushConfirm = false)}
      >
        Cancel
      </button>
      <button
        type="button"
        class="rounded-md bg-primary px-2.5 py-1 text-[0.625rem] font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
        disabled={pushBlocked}
        onclick={() => void confirmPushUpstream()}
      >
        {remoteBranchExists ? 'Push' : 'Publish branch'}
      </button>
    </div>
  </div>
{/if}

{#if pushDiverged}
  <Modal open title="Push blocked   branch has diverged" onClose={() => (pushDiverged = false)}>
    <div class="space-y-2">
      <p class="text-[0.625rem] leading-relaxed text-muted">
        The remote branch has commits you don't have locally, so Git will not let you push over
        them. Integrate the remote changes first, then push again.
      </p>
      <p class="rounded-lg border border-border bg-surface px-3 py-2 text-[0.625rem] text-dimmed">
        {status?.branch && primaryRemote
          ? `${primaryRemote.name}/${status.branch}`
          : 'Remote branch'}
        {#if (status?.behind ?? 0) > 0 || (status?.ahead ?? 0) > 0}
          <span class="font-medium text-muted">{status?.ahead ?? 0} ahead</span> ·
          <span class="font-medium text-muted">{status?.behind ?? 0} behind</span>
        {/if}
      </p>
      <p class="text-[0.5625rem] leading-relaxed text-dimmed">
        Merge keeps both histories and adds a merge commit. Rebase replays your commits on top of
        the remote for a straight history. Conflicts pause integration so you can resolve them here
        before anything is pushed.
      </p>
    </div>
    {#snippet footer()}
      <div class="flex items-center justify-end gap-2">
        <button
          type="button"
          class="cursor-pointer rounded-lg px-3 py-1.5 text-[0.6875rem] font-medium text-muted hover:bg-elevated hover:text-foreground"
          onclick={() => (pushDiverged = false)}
        >
          Cancel
        </button>
        <button
          type="button"
          class="h-8 cursor-pointer rounded-lg border border-border px-3 text-[0.6875rem] font-medium text-foreground transition-colors hover:bg-elevated disabled:cursor-default disabled:opacity-50"
          disabled={pushRecoverMode !== null}
          onclick={() => void recoverPush('rebase')}
        >
          {#if pushRecoverMode === 'rebase'}
            <Loader2 size={11} class="animate-spin" />
          {/if}
          Rebase &amp; push
        </button>
        <button
          type="button"
          class="h-8 cursor-pointer rounded-lg bg-primary px-3 text-[0.6875rem] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:cursor-default disabled:opacity-50"
          disabled={pushRecoverMode !== null}
          onclick={() => void recoverPush('merge')}
        >
          {#if pushRecoverMode === 'merge'}
            <Loader2 size={11} class="animate-spin" />
          {/if}
          Pull &amp; push
        </button>
      </div>
    {/snippet}
  </Modal>
{/if}

{#if pullStrategyOpen}
  <Modal open title="Choose pull strategy" onClose={closePullStrategy}>
    <div class="space-y-3">
      <div class="rounded-lg border border-border bg-elevated px-3 py-2">
        <p class="text-[0.625rem] font-medium text-foreground">
          Pull into <span class="font-mono">{status?.branch ?? 'current branch'}</span>
        </p>
        <p class="mt-0.5 text-[0.5625rem] text-dimmed">
          {status?.ahead ?? 0} ahead, {status?.behind ?? 0} behind
          <span class="font-mono">{status?.upstream ?? 'its remote'}</span>
        </p>
      </div>
      {#if pullStrategyError}
        <div class="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2" role="alert">
          <p class="text-[0.625rem] font-semibold text-danger">
            That pull strategy could not finish
          </p>
          <p
            class="mt-0.5 whitespace-pre-wrap break-words text-[0.5625rem] leading-relaxed text-danger"
          >
            {pullStrategyError}
          </p>
          <p class="mt-1 text-[0.5625rem] leading-relaxed text-dimmed">
            Choose another strategy below, or cancel without changing the branch further.
          </p>
        </div>
      {/if}
      <div class="space-y-1 text-[0.5625rem] leading-relaxed text-dimmed">
        <p>
          <span class="font-medium text-foreground">Merge</span> keeps both histories and may create a
          merge commit.
        </p>
        <p>
          <span class="font-medium text-foreground">Rebase</span> replays local commits on top of the
          remote branch.
        </p>
        <p>
          <span class="font-medium text-foreground">Fast-forward only</span> pulls only when no reconciliation
          is needed.
        </p>
      </div>
    </div>
    {#snippet footer()}
      <div class="flex items-center justify-end gap-2">
        <button
          type="button"
          class="cursor-pointer rounded-lg px-3 py-1.5 text-[0.6875rem] font-medium text-muted hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-50"
          disabled={gitState.isBusy('pull')}
          onclick={closePullStrategy}
        >
          Cancel
        </button>
        <button
          type="button"
          class="h-8 cursor-pointer rounded-lg border border-border px-3 text-[0.6875rem] font-medium text-foreground transition-colors hover:bg-elevated disabled:cursor-default disabled:opacity-50"
          disabled={gitState.isBusy('pull')}
          onclick={() => void performPull('ff-only')}
        >
          Fast-forward only
        </button>
        <button
          type="button"
          class="h-8 cursor-pointer rounded-lg border border-border px-3 text-[0.6875rem] font-medium text-foreground transition-colors hover:bg-elevated disabled:cursor-default disabled:opacity-50"
          disabled={gitState.isBusy('pull')}
          onclick={() => void performPull('rebase')}
        >
          Rebase
        </button>
        <button
          type="button"
          class="h-8 cursor-pointer rounded-lg bg-primary px-3 text-[0.6875rem] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:cursor-default disabled:opacity-50"
          data-modal-primary
          disabled={gitState.isBusy('pull')}
          onclick={() => void performPull('merge')}
        >
          Merge
        </button>
      </div>
    {/snippet}
  </Modal>
{/if}

<!--
    Main-sync strategy chooser: the same `ask` preference as the Pull button for
    `from`, and always shown for `to`, which mutates the project root.
  -->
{#if syncMainOpen}
  <Modal
    open
    title={syncDirection === 'from' ? 'Sync from main' : 'Sync to main'}
    onClose={closeSyncMain}
  >
    <div class="space-y-3">
      <div class="rounded-lg border border-border bg-elevated px-3 py-2">
        {#if syncDirection === 'from'}
          <p class="text-[0.625rem] font-medium text-foreground">
            Into <span class="font-mono">{status?.branch ?? 'this worktree'}</span>
          </p>
          <p class="mt-0.5 text-[0.5625rem] text-dimmed">
            From the branch checked out in the project root, refreshed from its remote first.
          </p>
        {:else}
          <p class="text-[0.625rem] font-medium text-foreground">
            From <span class="font-mono">{status?.branch ?? 'this worktree'}</span> into the project root
          </p>
          <p class="mt-0.5 text-[0.5625rem] text-dimmed">
            Both checkouts must be committed and idle. Nothing is pushed to a remote.
          </p>
        {/if}
      </div>
      {#if integrationOpen}
        <!--
            Every sync strategy fails identically while an integration is open, so
            the modal stops offering them and offers the way out instead. The
            state is read from the worktree, not parsed out of the error text, so
            it is right even before a strategy was tried.
          -->
        <div class="rounded-lg border border-warning/25 bg-warning/10 px-3 py-2">
          <p class="text-[0.625rem] font-semibold text-warning">
            This worktree is mid-{conflictState}
          </p>
          <p class="mt-0.5 text-[0.5625rem] leading-relaxed text-muted">
            No sync strategy can run until it is idle.
            {#if conflicted.length > 0}
              <span class="font-medium text-foreground">{conflicted.length}</span>
              {conflicted.length === 1 ? 'file still has' : 'files still have'} conflicts to resolve in
              the Changes view.
            {:else if conflictState === 'rebase'}
              Every conflict is resolved and staged, so the rebase is ready to continue.
            {:else}
              Every conflict is resolved and staged, so the merge is ready to be completed.
            {/if}
          </p>
          <div class="mt-2 flex flex-wrap items-center gap-1.5">
            {@render integrationActions()}
          </div>
        </div>
      {:else if syncMainError}
        <div class="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2" role="alert">
          <p class="text-[0.625rem] font-semibold text-danger">
            {syncDirection === 'from'
              ? 'Main could not be synced'
              : 'This worktree could not be sent to main'}
          </p>
          <p
            class="mt-0.5 whitespace-pre-wrap break-words text-[0.5625rem] leading-relaxed text-danger"
          >
            {syncMainError}
          </p>
          <p class="mt-1 text-[0.5625rem] leading-relaxed text-dimmed">
            {syncDirection === 'from'
              ? 'Choose another strategy below, or cancel without changing this worktree further.'
              : 'Choose another strategy below, or cancel without changing anything further.'}
          </p>
        </div>
      {/if}
      {#if !integrationOpen}
        <div class="space-y-1 text-[0.5625rem] leading-relaxed text-dimmed">
          {#if syncDirection === 'from'}
            <p>
              <span class="font-medium text-foreground">Merge</span> keeps both histories and may create
              a merge commit.
            </p>
            <p>
              <span class="font-medium text-foreground">Rebase</span> replays this worktree's commits
              on top of main.
            </p>
            <p>
              <span class="font-medium text-foreground">Fast-forward only</span> integrates only when
              no reconciliation is needed.
            </p>
          {:else}
            <p>
              <span class="font-medium text-foreground">Merge</span> merges this branch into main and
              refuses if that would conflict. Resolve it here with Sync from main instead.
            </p>
            <p>
              <span class="font-medium text-foreground">Rebase</span> replays this branch's commits on
              top of main, then moves main onto them. Keeps main linear, rewrites this branch.
            </p>
            <p>
              <span class="font-medium text-foreground">Fast-forward only</span> moves main only when
              main has not diverged.
            </p>
          {/if}
        </div>
      {/if}
    </div>
    {#snippet footer()}
      <div class="flex items-center justify-end gap-2">
        <button
          type="button"
          class="cursor-pointer rounded-lg px-3 py-1.5 text-[0.6875rem] font-medium text-muted hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-50"
          disabled={gitState.isBusy('sync')}
          onclick={closeSyncMain}
        >
          Cancel
        </button>
        {#if !integrationOpen}
          <button
            type="button"
            class="h-8 cursor-pointer rounded-lg border border-border px-3 text-[0.6875rem] font-medium text-foreground transition-colors hover:bg-elevated disabled:cursor-default disabled:opacity-50"
            disabled={gitState.isBusy('sync')}
            onclick={() => void performSyncMain(syncDirection, 'ff-only')}
          >
            Fast-forward only
          </button>
          <button
            type="button"
            class="h-8 cursor-pointer rounded-lg border border-border px-3 text-[0.6875rem] font-medium text-foreground transition-colors hover:bg-elevated disabled:cursor-default disabled:opacity-50"
            disabled={gitState.isBusy('sync')}
            onclick={() => void performSyncMain(syncDirection, 'rebase')}
          >
            Rebase
          </button>
          <button
            type="button"
            class="h-8 cursor-pointer rounded-lg bg-primary px-3 text-[0.6875rem] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:cursor-default disabled:opacity-50"
            data-modal-primary
            disabled={gitState.isBusy('sync')}
            onclick={() => void performSyncMain(syncDirection, 'merge')}
          >
            Merge
          </button>
        {/if}
      </div>
    {/snippet}
  </Modal>
{/if}

<!-- Completing a resolved merge: optional title/description, auto-generated when skipped.
       It closes itself if the state it describes goes away (an abort elsewhere, a
       temporary branch deleted by hand), so it can never offer a stale completion. -->
{#if completeMergeOpen && mergeAwaitsCompletion}
  <Modal open title="Complete merge" onClose={() => (completeMergeOpen = false)}>
    <div class="space-y-2">
      {#if mergePending}
        <p class="text-[0.6875rem] leading-relaxed text-muted">
          Every conflict is resolved and staged. Completing the merge commits it{#if prResolveBranch},
            pushes the resolution back to the pull request, restores your previous branch, and
            deletes the temporary <span class="font-mono text-foreground">{prResolveBranch}</span> branch{/if}.
          Add a message below, or leave it empty to generate one.
        </p>
        <input
          class="h-8 w-full rounded-md border border-border bg-elevated px-2.5 text-[0.6875rem] text-foreground outline-none placeholder:text-dimmed focus:border-primary"
          placeholder="Title (e.g. Merge branch '{status?.upstream ?? 'main'}')"
          bind:value={mergeTitle}
          disabled={completeMergeBusy}
        />
        <textarea
          class="min-h-16 w-full resize-y rounded-md border border-border bg-elevated px-2.5 py-2 text-[0.6875rem] text-foreground outline-none placeholder:text-dimmed focus:border-primary"
          placeholder="Description (optional)"
          bind:value={mergeDescription}
          disabled={completeMergeBusy}></textarea>
      {:else}
        <p class="text-[0.6875rem] leading-relaxed text-muted">
          The resolution is committed on the temporary <span class="font-mono text-foreground"
            >{prResolveBranch}</span
          > branch. Completing the merge pushes it back to the pull request, restores your previous branch,
          and deletes that temporary branch.
        </p>
      {/if}
    </div>
    {#snippet footer()}
      <div class="flex items-center justify-end gap-2">
        <button
          type="button"
          class="rounded-lg px-3 py-1.5 text-[0.6875rem] font-medium text-muted hover:bg-elevated hover:text-foreground"
          onclick={() => (completeMergeOpen = false)}
        >
          Cancel
        </button>
        <button
          type="button"
          class="flex h-8 cursor-pointer items-center gap-1.5 rounded-lg bg-foreground px-3 text-[0.6875rem] font-semibold text-app transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-50"
          data-modal-primary
          disabled={completeMergeBusy}
          onclick={() => void confirmCompleteMerge()}
        >
          {#if completeMergeBusy}<Loader2 size={11} class="animate-spin" />{:else}<GitMerge
              size={11}
            />{/if}
          Complete merge
        </button>
      </div>
    {/snippet}
  </Modal>
{/if}

<!--
    Fetch, pull and push used to sit here as three permanent buttons on every
    working-tree tab. They now live in the surface-nav row, where only the
    action that is actually needed is labelled and the rest sit in the menu
    beside it. This bar keeps only what completing a merge genuinely needs, and
    it stays up until the merge is actually complete: a merge still waiting on
    its commit, or a temporary PR branch still waiting to be pushed and deleted.
  -->
{#if repoState === 'git' && status && mergeAwaitsCompletion}
  <div class="flex shrink-0 items-center gap-1.5 border-t border-border px-2 py-1.5">
    <button
      type="button"
      class="flex h-7 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md bg-foreground text-[0.625rem] font-semibold text-app transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-50"
      title={mergePending
        ? `Commit the resolved files to complete the merge${prResolveBranch ? `, then push the resolution to the pull request and delete ${prResolveBranch}` : ''}`
        : `Push the resolution to the pull request, restore your previous branch, and delete ${prResolveBranch}`}
      disabled={completeMergeBusy}
      onclick={openCompleteMerge}
    >
      {#if completeMergeBusy}
        <Loader2 size={11} class="animate-spin" />
      {:else}
        <GitMerge size={11} />
      {/if}
      Complete merge
    </button>
  </div>
{/if}

<!-- Modals -->
{#if showGitHubSignIn}
  <GitHubSignInModal
    onClose={() => (showGitHubSignIn = false)}
    onConnected={() => {
      // Reload the full status so the avatar/name land in the branch picker
      // instead of leaving a stale "Sign in" button behind.
      void loadGitHubAuth()
    }}
  />
{/if}

{#if showStashModal}
  <Modal
    open
    title={stashPaths ? 'Stash selected changes' : 'Stash changes'}
    onClose={() => (showStashModal = false)}
  >
    <div class="space-y-2">
      {#if stashPaths}
        <div class="rounded-lg border border-border bg-elevated/50 px-3 py-2">
          <p class="text-[0.625rem] font-medium text-foreground">
            {stashPaths.length}
            {stashPaths.length === 1 ? 'file' : 'files'} to stash
          </p>
          <div class="mt-1 max-h-24 overflow-auto">
            {#each stashPaths as path (path)}
              <p class="truncate font-mono text-[0.5625rem] text-dimmed">{path}</p>
            {/each}
          </div>
        </div>
      {:else}
        <p class="text-[0.6875rem] leading-relaxed text-muted">
          Shelves your staged and unstaged changes so you can switch work. Restore them any time
          from the Stashes tab.
        </p>
      {/if}
      <input
        class="h-8 w-full rounded-md border border-border bg-elevated px-2.5 text-[0.6875rem] text-foreground outline-none placeholder:text-dimmed focus:border-primary"
        placeholder="Describe this stash (optional)"
        bind:value={stashMessage}
      />
    </div>
    {#snippet footer()}
      <div class="flex items-center justify-end gap-2">
        <button
          type="button"
          class="rounded-lg px-3 py-1.5 text-[0.6875rem] font-medium text-muted hover:bg-elevated hover:text-foreground"
          onclick={() => {
            showStashModal = false
            stashPaths = null
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          class="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[0.6875rem] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
          disabled={(status?.clean ?? true) || gitState.isBusy('stash')}
          onclick={() => void stashChanges()}
        >
          {#if gitState.isBusy('stash')}
            <Loader2 size={12} class="animate-spin" />
          {/if}
          {stashPaths ? 'Stash selected' : 'Stash changes'}
        </button>
      </div>
    {/snippet}
  </Modal>
{/if}

{#if showIntegrateModal}
  <Modal open title="Merge or rebase" onClose={() => (showIntegrateModal = false)}>
    <div class="space-y-2">
      <label
        class="block text-[0.625rem] font-semibold uppercase tracking-wide text-muted"
        for="integrate-target"
      >
        Bring changes into {status?.branch ?? 'HEAD'} from
      </label>
      <select
        id="integrate-target"
        class="h-8 w-full rounded-md border border-border bg-elevated px-2 font-mono text-[0.6875rem] text-foreground outline-none focus:border-primary"
        bind:value={mergeTarget}
      >
        <option value="" disabled>Select a branch…</option>
        {#each localBranches as branch (branch.ref)}
          {#if branch.name !== status?.branch}
            <option value={branch.name}>{branch.name}</option>
          {/if}
        {/each}
      </select>
      <p class="text-[0.625rem] leading-relaxed text-dimmed">
        Merge keeps both histories and adds a merge commit. Rebase replays your commits on top of
        the selected branch for a straight history.
      </p>
    </div>
    {#snippet footer()}
      <div class="flex items-center justify-end gap-2">
        <button
          type="button"
          class="rounded-lg px-3 py-1.5 text-[0.6875rem] font-medium text-muted hover:bg-elevated hover:text-foreground"
          onclick={() => (showIntegrateModal = false)}
        >
          Cancel
        </button>
        <button
          type="button"
          class="h-8 rounded-lg border border-border px-3 text-[0.6875rem] font-medium text-foreground transition-colors hover:bg-elevated disabled:opacity-50"
          disabled={!mergeTarget || integrateBusy}
          onclick={() => requestMergeOrRebase('rebase')}
        >
          Rebase
        </button>
        <button
          type="button"
          class="h-8 rounded-lg bg-primary px-3 text-[0.6875rem] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
          disabled={!mergeTarget || integrateBusy}
          onclick={() => requestMergeOrRebase('merge')}
        >
          Merge
        </button>
      </div>
    {/snippet}
  </Modal>
{/if}

{#if pendingOperation}
  {@const operation = pendingOperation}
  <Modal
    open
    title={operation.kind === 'merge' ? 'Merge branch' : 'Rebase onto branch'}
    onClose={() => (pendingOperation = null)}
  >
    <div class="space-y-3">
      <p class="text-[0.6875rem] leading-relaxed text-muted">
        {operation.kind === 'merge'
          ? `Merge into ${status?.branch ?? 'HEAD'}.`
          : `Rebase ${status?.branch ?? 'HEAD'} onto the branch.`}
      </p>
      {#if atRiskFiles.length > 0}
        <div>
          <p class="mb-1 text-[0.625rem] font-semibold uppercase tracking-wide text-muted">
            Affected files
          </p>
          <div class="max-h-40 overflow-auto rounded-lg border border-border bg-surface">
            {#each atRiskFiles as path (path)}
              <div class="flex h-7 items-center gap-2 border-b border-border px-3 last:border-b-0">
                <FileTypeIcon {path} size={12} class="shrink-0" />
                <span class="min-w-0 flex-1 truncate font-mono text-[0.625rem] text-muted"
                  >{path}</span
                >
              </div>
            {/each}
          </div>
        </div>
      {:else}
        <p
          class="rounded-lg border border-border bg-surface px-3 py-1.5 text-[0.625rem] text-muted"
        >
          No local changes should apply cleanly.
        </p>
      {/if}
      {#if agentTurnActive}
        <div class="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2">
          <p class="text-[0.625rem] font-semibold text-warning">Agent turn in progress</p>
          <p class="mt-0.5 text-[0.5625rem] leading-relaxed text-muted">
            Acknowledge to continue anyway.
          </p>
          <div class="mt-1.5 flex items-center justify-between gap-2">
            <span class="text-[0.625rem] text-muted">I understand the risk</span>
            <Switch
              checked={acknowledgeActiveTurn}
              onchange={(value) => (acknowledgeActiveTurn = value)}
              aria-label="Acknowledge risk"
            />
          </div>
        </div>
      {/if}
    </div>
    {#snippet footer()}
      <div class="flex items-center justify-end gap-2">
        <button
          type="button"
          class="rounded-lg px-3 py-1.5 text-[0.6875rem] font-medium text-muted hover:bg-elevated hover:text-foreground"
          onclick={() => (pendingOperation = null)}
        >
          Cancel
        </button>
        <button
          type="button"
          class="flex h-8 items-center rounded-lg bg-primary px-3 text-[0.6875rem] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
          disabled={integrateBusy || (agentTurnActive && !acknowledgeActiveTurn)}
          onclick={() => void confirmPendingOperation()}
        >
          {#if gitState.isBusy('merge') || gitState.isBusy('rebase')}
            <Loader2 size={12} class="animate-spin" />
          {/if}
          {operation.kind === 'merge' ? 'Merge' : 'Rebase'}
        </button>
      </div>
    {/snippet}
  </Modal>
{/if}

{#if resetConfirm}
  {@const pendingReset = resetConfirm}
  <Modal open title="Reset branch" onClose={() => (resetConfirm = null)}>
    <div class="space-y-3">
      <p class="text-[0.6875rem] leading-relaxed text-muted">
        Reset <span class="font-mono text-foreground">{status?.branch ?? 'HEAD'}</span> to commit
        <span class="font-mono text-foreground"> {pendingReset.target.slice(0, 7)}</span>.
      </p>

      <div>
        <p class="mb-1 text-[0.625rem] font-semibold uppercase tracking-wide text-muted">Mode</p>
        <div class="grid grid-cols-3 gap-1.5">
          {#each resetOptions as option (option.mode)}
            <button
              type="button"
              class={[
                'rounded-md border px-2 py-1.5 text-left transition-colors',
                pendingReset.mode === option.mode
                  ? 'border-primary/50 bg-primary/10'
                  : 'border-border hover:bg-elevated'
              ]}
              onclick={() => (resetConfirm = { mode: option.mode, target: pendingReset.target })}
            >
              <span
                class={[
                  'block text-[0.625rem] font-semibold',
                  pendingReset.mode === option.mode ? 'text-primary' : 'text-foreground'
                ]}
              >
                {option.label}
              </span>
              <span class="block text-[0.5rem] leading-snug text-dimmed">{option.hint}</span>
            </button>
          {/each}
        </div>
      </div>

      {#if pendingReset.mode === 'hard'}
        <div class="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2">
          <p class="text-[0.625rem] font-semibold text-danger">Hard reset discards changes</p>
          <p class="mt-0.5 text-[0.5625rem] leading-relaxed text-muted">
            Staged and unstaged changes since this commit will be permanently lost. This cannot be
            undone.
          </p>
        </div>
      {/if}

      {#if atRiskFiles.length > 0}
        <div>
          <p class="mb-1 text-[0.625rem] font-semibold uppercase tracking-wide text-muted">
            Affected files
          </p>
          <div class="max-h-40 overflow-auto rounded-lg border border-border bg-surface">
            {#each atRiskFiles as path (path)}
              <div class="flex h-7 items-center gap-2 border-b border-border px-3 last:border-b-0">
                <FileTypeIcon {path} size={12} class="shrink-0" />
                <span class="min-w-0 flex-1 truncate font-mono text-[0.625rem] text-muted"
                  >{path}</span
                >
              </div>
            {/each}
          </div>
        </div>
      {/if}
      {#if agentTurnActive}
        <div class="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2">
          <p class="text-[0.625rem] font-semibold text-warning">Agent turn in progress</p>
          <p class="mt-0.5 text-[0.5625rem] leading-relaxed text-muted">
            Acknowledge to continue anyway.
          </p>
          <div class="mt-1.5 flex items-center justify-between gap-2">
            <span class="text-[0.625rem] text-muted">I understand the risk</span>
            <Switch
              checked={acknowledgeActiveTurn}
              onchange={(value) => (acknowledgeActiveTurn = value)}
              aria-label="Acknowledge risk"
            />
          </div>
        </div>
      {/if}
    </div>
    {#snippet footer()}
      <div class="flex items-center justify-end gap-2">
        <button
          type="button"
          class="rounded-lg px-3 py-1.5 text-[0.6875rem] font-medium text-muted hover:bg-elevated hover:text-foreground"
          onclick={() => (resetConfirm = null)}
        >
          Cancel
        </button>
        <button
          type="button"
          class={[
            'flex h-8 items-center gap-1.5 rounded-lg px-3 text-[0.6875rem] font-medium text-on-primary transition-colors disabled:opacity-50',
            pendingReset.mode === 'hard'
              ? 'bg-danger hover:bg-danger/90'
              : 'bg-primary hover:bg-primary-hover'
          ]}
          disabled={gitState.isBusy('reset') || (agentTurnActive && !acknowledgeActiveTurn)}
          onclick={() => void confirmReset()}
        >
          {#if gitState.isBusy('reset')}
            <Loader2 size={12} class="animate-spin" />
          {/if}
          {pendingReset.mode === 'hard' ? 'Reset hard' : 'Reset'}
        </button>
      </div>
    {/snippet}
  </Modal>
{/if}

{#if deleteCommitTarget}
  {@const deleteCommit = deleteCommitTarget}
  <ConfirmDialog
    open
    title="Delete commit?"
    onCancel={() => (deleteCommitTarget = null)}
    onConfirm={() => void confirmDeleteCommit()}
    confirmLabel="Delete commit"
    busy={gitState.isBusy('delete-commit')}
  >
    <p>
      Drop
      <strong class="font-medium text-foreground">
        “{deleteCommit.message.split('\n')[0]}”
      </strong>
      ({deleteCommit.shortHash}) from history. Commits after it are replayed and get new hashes, so
      this is safest for commits that have not been pushed yet. This cannot be undone.
    </p>
  </ConfirmDialog>
{/if}

{#if checkoutConfirm}
  {@const target = checkoutConfirm}
  <ConfirmDialog
    open
    title={target.kind === 'local'
      ? `Check out “${target.name}”?`
      : `Create local branch “${target.name}”?`}
    onCancel={() => (checkoutConfirm = null)}
    onConfirm={() => void confirmCheckoutBranch()}
    confirmLabel={target.kind === 'local' ? 'Check out' : 'Create and check out'}
    busy={gitState.isBusy('checkout')}
    variant="primary"
  >
    <p>
      {#if target.kind === 'local'}
        This switches the working tree to <strong class="font-medium text-foreground"
          >{target.name}</strong
        >. Any uncommitted changes come with you if they don't conflict.
      {:else}
        This creates and checks out <strong class="font-medium text-foreground"
          >{target.name}</strong
        >
        as a local branch that tracks
        <strong class="font-medium text-foreground">{target.ref}</strong>.
      {/if}
    </p>
  </ConfirmDialog>
{/if}

{#if deleteBranchConfirm}
  {@const target = deleteBranchConfirm}
  <ConfirmDialog
    open
    title={`Delete branch “${target}”?`}
    onCancel={() => (deleteBranchConfirm = null)}
    onConfirm={() => void confirmDeleteBranch()}
    confirmLabel="Delete branch"
    busy={gitState.isBusy('checkout')}
  >
    <p>
      Branch <strong class="font-medium text-foreground">{target}</strong> will be permanently deleted.
      This cannot be undone.
    </p>
  </ConfirmDialog>
{/if}

{#if forceDeleteBranchConfirm}
  {@const target = forceDeleteBranchConfirm}
  <ConfirmDialog
    open
    title={`Force delete branch “${target}”?`}
    onCancel={() => (forceDeleteBranchConfirm = null)}
    onConfirm={() => void confirmForceDeleteBranch()}
    confirmLabel="Delete branch"
    busy={gitState.isBusy('checkout')}
  >
    <p>
      Branch <strong class="font-medium text-foreground">{target}</strong> is not fully merged. Are you
      sure you want to delete it? Unmerged commits may become unreachable.
    </p>
  </ConfirmDialog>
{/if}

{#if deleteRemoteBranchConfirm}
  {@const target = deleteRemoteBranchConfirm}
  <ConfirmDialog
    open
    title={`Delete remote branch “${target.remote}/${target.name}”?`}
    onCancel={() => (deleteRemoteBranchConfirm = null)}
    onConfirm={() => void confirmDeleteRemoteBranch()}
    confirmLabel="Delete remote branch"
    busy={gitState.isBusy('push')}
  >
    <p>
      Branch <strong class="font-medium text-foreground">{target.name}</strong> will be deleted from
      <strong class="font-medium text-foreground">{target.remote}</strong>. Local branches are not
      affected, and the deletion cannot be undone from here.
    </p>
  </ConfirmDialog>
{/if}

<!-- Add / Replace Git Origin -->
{#if originModalOpen}
  <Modal
    open
    title={originMode === 'replace' ? 'Replace Git Origin' : 'Add Git Origin'}
    onClose={closeOriginModal}
  >
    <div class="space-y-3">
      <p class="text-[0.6875rem] leading-relaxed text-muted">
        {#if originMode === 'replace'}
          Update the URL of the <span class="font-mono text-foreground">{originName}</span> remote. This
          is the address the repository fetches from and pushes to.
        {:else}
          Add the <span class="font-mono text-foreground">{originName}</span> remote so you can pull from
          and push to a hosted repository.
        {/if}
      </p>
      <div>
        <p class="mb-1.5 text-[0.625rem] font-semibold uppercase tracking-wide text-muted">
          Remote URL
        </p>
        <input
          class="w-full rounded-lg border border-border bg-elevated px-3 py-2 font-mono text-[0.6875rem] text-foreground outline-none placeholder:text-dimmed focus:border-primary"
          placeholder="https://github.com/your-name/repo.git"
          bind:value={originUrl}
          onkeydown={(e: KeyboardEvent) => {
            if (e.key === 'Enter' && !originBusy) requestSetOrigin()
          }}
        />
      </div>
      {#if gitState.error}
        <p class="text-[0.625rem] leading-relaxed text-danger">{gitState.error}</p>
      {/if}
    </div>
    {#snippet footer()}
      <div class="flex items-center justify-end gap-2">
        <button
          type="button"
          class="rounded-lg px-3 py-1.5 text-[0.6875rem] font-medium text-muted hover:bg-elevated hover:text-foreground"
          disabled={originBusy}
          onclick={closeOriginModal}
        >
          Cancel
        </button>
        <button
          type="button"
          data-modal-primary
          class="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[0.6875rem] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
          disabled={originBusy || !originUrl.trim()}
          onclick={requestSetOrigin}
        >
          {#if originBusy}
            <Loader2 size={12} class="animate-spin" />
          {/if}
          {originMode === 'replace' ? 'Replace Origin' : 'Add Origin'}
        </button>
      </div>
    {/snippet}
  </Modal>
{/if}

{#if originReplaceConfirm}
  <ConfirmDialog
    open
    title={`Replace ${originName}?`}
    onCancel={() => (originReplaceConfirm = false)}
    onConfirm={() => void runSetOrigin()}
    confirmLabel={`Replace ${originName}`}
    busy={originBusy}
  >
    <p>
      Changing the <span class="font-mono text-foreground">{originName}</span> remote URL
      permanently redirects future <strong class="font-medium text-foreground">pull</strong>
      and <strong class="font-medium text-foreground">push</strong> operations to the new address. Your
      local history is preserved, but the current remote target is replaced. This cannot be undone automatically
      make sure this is the repository you want to use.
    </p>
  </ConfirmDialog>
{/if}
