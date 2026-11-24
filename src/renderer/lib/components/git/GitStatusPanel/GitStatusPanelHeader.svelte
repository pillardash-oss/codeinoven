<script lang="ts">
  import type { Snippet } from 'svelte'
  import { DropdownMenu } from 'bits-ui'
  import CioArchive from '@pdslng/cio-icon/CioArchive.svelte'
  import CioAttention from '@pdslng/cio-icon/CioAttention.svelte'
  import CioCheckCircle from '@pdslng/cio-icon/CioCheckCircle.svelte'
  import CioDownload from '@pdslng/cio-icon/CioDownload.svelte'
  import CioEllipsis from '@pdslng/cio-icon/CioEllipsis.svelte'
  import CioMerge from '@pdslng/cio-icon/CioMerge.svelte'
  import CioPullRequest from '@pdslng/cio-icon/CioPullRequest.svelte'
  import CioRefresh from '@pdslng/cio-icon/CioRefresh.svelte'
  import CioSearch from '@pdslng/cio-icon/CioSearch.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import CioTabGit from '@pdslng/cio-icon/CioTabGit.svelte'
  import CioTabInfo from '@pdslng/cio-icon/CioTabInfo.svelte'
  import CioUpload from '@pdslng/cio-icon/CioUpload.svelte'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import { gitState } from '$lib/stores/git.svelte'
  import { githubSignIn } from '$lib/stores/github-sign-in.svelte'
  import { githubNotifications } from '$lib/stores/github-notifications.svelte'
  import { findNavState } from '$lib/stores/find-nav.svelte'
  import { prLifecycleStore } from '$lib/stores/pr-lifecycle.svelte'
  import type { GitPanelTabId } from '$lib/stores/git-panel-view.svelte'
  import type { GIT_FIND_WORDS } from '../git-panel-find'
  import type {
    GitBranchInfo,
    GitCommitInfo,
    GitFileChange,
    GitHubAuthStatus,
    GitHubNotification,
    GitStatus,
    PullRequestSummary
  } from '$shared/types'
  import BranchPicker from '../BranchPicker.svelte'
  import GitHubAccountMenu from '../GitHubAccountMenu.svelte'
  import GitViewMenu from '../GitViewMenu.svelte'
  import GitSyncButton from '../GitSyncButton.svelte'
  import GitStatusPanelViewActions from './GitStatusPanelViewActions.svelte'
  import { GITHUB_STATUS_UNAVAILABLE } from '$lib/stores/git-store-github.svelte'

  /** The working tree's state as a badge names it, most urgent first. */
  type WorktreeState = 'clean' | 'dirty' | 'conflicted'

  /**
   * Every state that names work waiting in the Changes view. The branch
   * trigger's badge offers exactly these as controls; a clean tree has nothing
   * behind it, so it stays a mark.
   */
  type WorktreeActionState = Exclude<WorktreeState, 'clean'>

  interface Props {
    repoState: 'loading' | 'git_unavailable' | 'not_git' | 'git'
    githubStatus: GitHubAuthStatus | null
    primaryRemote: { name: string; url: string } | null
    remotes: Array<{ name: string; url: string }>
    status: GitStatus | null
    conflicted: GitFileChange[]
    worktreeState: WorktreeState | null
    tabs: Array<{
      id: GitPanelTabId
      label: string
      icon: typeof CioTabGit
      count: number | null
    }>
    activeTab: GitPanelTabId
    changesView: 'list' | 'tree'
    onShowIntegrateModal: () => void
    onShowStashModal: () => void
    onRequestCreateBranch: () => void
    showsSync: boolean
    branchSyncBusy: boolean
    remoteActionsInMenu: boolean
    showsPull: boolean
    showsPush: boolean
    commitsBehind: number
    commitsAhead: number
    pushBlocked: boolean
    fetching: boolean
    busy: boolean
    localBranches: GitBranchInfo[]
    selectedCommit: GitCommitInfo | null
    isHeadCommit: boolean
    selectedPullRequest: PullRequestSummary | null
    deploymentsExternal: { url: string; title: string } | null
    openNotification: GitHubNotification | null
    notificationActionClass: string
    notificationBusy: boolean
    githubConnected: boolean
    projectId: string
    threadId: string
    scopeBucketId: string
    findWords: (typeof GIT_FIND_WORDS)[keyof typeof GIT_FIND_WORDS]
    commitActions: Snippet<[GitCommitInfo, boolean]>
    selectTab: (id: GitPanelTabId) => void
    signOutGitHub: () => Promise<void>
    switchGitHubAccount: (accountId: string) => Promise<void>
    requestCheckout: (branch: GitBranchInfo) => void
    createBranchAction: (name: string) => Promise<void>
    deleteBranchAction: (name: string, force?: boolean) => Promise<void>
    openAddOrigin: () => void
    openReplaceOrigin: () => void
    syncMainAction: (direction: 'from' | 'to') => void
    openSyncPeer: (direction: 'from' | 'to') => void
    openFind: () => void
    closeFind: () => void
    refreshPanel: () => Promise<void>
    startAmend: () => void
    openPullRequestFullscreen: (pr: PullRequestSummary | null) => void
    pullAction: () => void
    pushAction: () => Promise<void>
    onOpenWorkingChanges: () => void
  }

  let {
    repoState,
    githubStatus,
    primaryRemote,
    remotes,
    status,
    conflicted,
    worktreeState,
    tabs,
    activeTab,
    changesView = $bindable(),
    onShowIntegrateModal,
    onShowStashModal,
    onRequestCreateBranch,
    showsSync,
    branchSyncBusy,
    remoteActionsInMenu,
    showsPull,
    showsPush,
    commitsBehind,
    commitsAhead,
    pushBlocked,
    fetching,
    busy,
    localBranches,
    selectedCommit,
    isHeadCommit,
    selectedPullRequest,
    deploymentsExternal,
    openNotification,
    notificationActionClass,
    notificationBusy,
    githubConnected,
    projectId,
    threadId,
    scopeBucketId,
    findWords,
    commitActions,
    selectTab,
    signOutGitHub,
    switchGitHubAccount,
    requestCheckout,
    createBranchAction,
    deleteBranchAction,
    openAddOrigin,
    openReplaceOrigin,
    syncMainAction,
    openSyncPeer,
    openFind,
    closeFind,
    refreshPanel,
    startAmend,
    openPullRequestFullscreen,
    pullAction,
    pushAction,
    onOpenWorkingChanges
  }: Props = $props()

  const dirtyBadgeClass =
    'shrink-0 bg-warning/10 px-1 py-0.5 text-[0.5rem] font-semibold uppercase tracking-wide text-warning'

  const statusActionCopy: Record<
    WorktreeActionState,
    { title: string; ariaLabel: string; hoverClass: string }
  > = {
    conflicted: {
      title: 'Conflicts to resolve. Open the Changes view',
      ariaLabel: 'Open the Changes view for the conflicts in this working tree',
      hoverClass: 'hover:bg-danger/20'
    },
    dirty: {
      title: 'Uncommitted changes in this branch. Open the Changes view',
      ariaLabel: 'Open the Changes view for the uncommitted changes in this branch',
      hoverClass: 'hover:bg-warning/20'
    }
  }

  /**
   * Take the branch trigger's status badge to the work it names: the Changes view
   * with any commit that was open closed, so the click lands on the working tree
   * instead of the commit sheet the view would otherwise still be showing. The
   * click itself is left to bubble to the trigger, which closes a picker that
   * was already open before the view beneath it changes.
   */
  function openWorkingChanges(): void {
    onOpenWorkingChanges()
  }

  /**
   * Every state badge is a control, so Enter and Space do what a click does. Both
   * keys are consumed here: the trigger toggles the picker from its own keydown,
   * and a cancelled key is what keeps it out of that path.
   */
  function activateWorkingChangesFromKeyboard(event: KeyboardEvent): void {
    if (!keymapState.matches('ui-activate', event)) return
    event.preventDefault()
    event.stopPropagation()
    openWorkingChanges()
  }
</script>

{#snippet worktreeStatusAction(state: WorktreeActionState)}
  {@const copy = statusActionCopy[state]}
  <span
    class={[
      '-m-1 flex shrink-0 cursor-pointer items-center p-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
      copy.hoverClass
    ]}
    role="button"
    tabindex="0"
    data-status-action
    title={copy.title}
    aria-label={copy.ariaLabel}
    onclick={openWorkingChanges}
    onkeydown={activateWorkingChangesFromKeyboard}
  >
    {#if state === 'conflicted'}
      <CioAttention size={12} class="shrink-0 text-danger" aria-hidden="true" />
    {:else}
      <span class={dirtyBadgeClass}>dirty</span>
    {/if}
  </span>
{/snippet}

{#snippet branchStatusIcon(interactive: boolean)}
  {#if interactive && worktreeState !== null && worktreeState !== 'clean'}
    {@render worktreeStatusAction(worktreeState)}
  {:else if worktreeState === 'conflicted'}
    <CioAttention
      size={12}
      class="shrink-0 text-danger"
      role="img"
      aria-label="Conflicts to resolve"
      title="Conflicts to resolve"
    />
  {:else if worktreeState === 'dirty'}
    <!--
    A badge rather than a ring: at 12px an outlined circle reads as a bullet,
    where the amber chip reads as the state it names. The picker's own list
    marks the dirty branch with the same chip.
  -->
    <span class={dirtyBadgeClass} title="Uncommitted changes in this branch">dirty</span>
  {:else}
    <CioCheckCircle
      size={12}
      class="shrink-0 text-success"
      role="img"
      aria-label="Working tree clean"
      title="Working tree clean"
    />
  {/if}
{/snippet}

{#snippet refreshStatusButton()}
  <!--
  Multipurpose on purpose: it refreshes the view in focus *and* the repository
  behind it (status, branches, History, remote-tracking refs), so one control is
  enough to trust the panel again. The repository half never disables the
  control: only the view the click asked for is awaited, the rest lands on its
  own, which is why the fetch spins below without blocking a second click.
-->
  <button
    type="button"
    class="flex h-6 w-6 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
    aria-label="Refresh the current view, the git status and the remote refs"
    title="Refresh the current view, the git status and the remote refs"
    disabled={busy}
    onclick={() => void refreshPanel()}
  >
    <CioRefresh
      size={12}
      class={gitState.isBusy([
        'refresh',
        'fetch',
        'pr-list',
        'pr-detail',
        'deployment-runs',
        'deployment-environments'
      ]) || githubNotifications.loading
        ? 'animate-spin'
        : ''}
    />
  </button>
{/snippet}

<div
  class="git-panel-header flex h-9 items-center gap-1 overflow-x-auto border-b border-border px-2"
>
  {#if repoState === 'git'}
    <GitHubAccountMenu
      github={githubStatus ?? GITHUB_STATUS_UNAVAILABLE}
      {primaryRemote}
      onSignIn={() => githubSignIn.start()}
      onSignOut={() => void signOutGitHub()}
      onSwitchAccount={(accountId) => void switchGitHubAccount(accountId)}
      onOpenNotifications={() => selectTab('notifications')}
    />
  {/if}
  {#if repoState === 'git' && gitState.branches.length > 0}
    <BranchPicker
      branches={gitState.branches}
      currentBranch={status?.branch ?? null}
      isBusy={gitState.isBusy('checkout')}
      {primaryRemote}
      onSelect={requestCheckout}
      onCreate={(name) => void createBranchAction(name)}
      onDelete={(name) => void deleteBranchAction(name)}
      onAddOrigin={openAddOrigin}
      onReplaceOrigin={openReplaceOrigin}
      statusIcon={worktreeState ? branchStatusIcon : undefined}
      statusBadge={worktreeState === 'dirty' ? branchStatusIcon : undefined}
    />
  {:else}
    <div class="flex items-center gap-1.5 px-2">
      <CioTabGit size={12} class="shrink-0 text-muted" />
      <span class="font-mono text-[0.6875rem] font-medium text-foreground">
        {status?.branch ?? (repoState === 'git' ? 'detached' : 'Repository')}
      </span>
    </div>
  {/if}

  {#if repoState === 'git'}
    <span class="mx-0.5 h-4 w-px shrink-0 bg-border" aria-hidden="true"></span>
    <!--
        The views are a dropdown, not a strip: six of them never fit one row at
        every sidebar width, and a strip that scrolls sideways hides views
        behind a gesture. The trigger is the view in use, with its count.
      -->
    <GitViewMenu {tabs} {activeTab} onSelect={selectTab} />
    <span class="min-w-0 flex-1"></span>
    <!--
        The view's own action comes first, ahead of Search: it acts on what you
        are looking at, while Search, Refresh and the overflow act on the panel.
        Sync belongs to the same group   it trades commits with another
        checkout, it is not an action on this branch's own drift   and it is
        worktree-only, which `showsSync` decides.
      -->
    <div class="flex shrink-0 items-center gap-0.5">
      <GitStatusPanelViewActions
        {activeTab}
        {selectedCommit}
        {isHeadCommit}
        bind:changesView
        {onRequestCreateBranch}
        {selectedPullRequest}
        {deploymentsExternal}
        {openNotification}
        {notificationActionClass}
        {notificationBusy}
        {githubConnected}
        {projectId}
        {threadId}
        {scopeBucketId}
        {startAmend}
        {openPullRequestFullscreen}
      />
      {#if showsSync}
        <GitSyncButton
          busy={gitState.isBusy('sync')}
          blocked={branchSyncBusy || conflicted.length > 0}
          onSync={(direction) => void syncMainAction(direction)}
          onPickPeer={openSyncPeer}
        />
      {/if}
      <button
        type="button"
        class={[
          'flex h-6 w-6 shrink-0 items-center justify-center transition-colors',
          findNavState.gitFindOpen
            ? 'bg-elevated text-foreground'
            : 'text-dimmed hover:bg-elevated hover:text-foreground'
        ]}
        aria-label={findWords.label}
        title={findWords.label}
        aria-pressed={findNavState.gitFindOpen}
        onclick={() => (findNavState.gitFindOpen ? closeFind() : openFind())}
      >
        <CioSearch size={12} aria-hidden="true" />
      </button>
      {@render refreshStatusButton()}
      {#if activeTab === 'changes' && selectedCommit}
        <!--
            While a commit is open the overflow control *is* that commit's menu:
            the same snippet the History rows open on right click, because the
            two lists of actions were already identical in everything but the
            order they happened to be written in.
          -->
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            class="flex h-6 w-6 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground data-[state=open]:bg-elevated data-[state=open]:text-foreground"
            aria-label={`Actions for commit ${selectedCommit.shortHash}`}
            title={`Actions for commit ${selectedCommit.shortHash}`}
          >
            <CioTabInfo size={13} />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              class="z-50 min-w-48 overflow-hidden border border-border bg-surface p-1 shadow-xl"
              side="bottom"
              align="end"
              sideOffset={4}
              collisionPadding={8}
            >
              {@render commitActions(selectedCommit, isHeadCommit)}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      {:else}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            class="flex h-6 w-6 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground data-[state=open]:bg-elevated data-[state=open]:text-foreground"
            aria-label="Git actions"
            title="Git actions"
          >
            {#if gitState.isBusy('fetch')}
              <CioSpinner size={12} class="animate-spin" />
            {:else}
              <CioEllipsis size={13} />
            {/if}
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              side="bottom"
              align="end"
              sideOffset={4}
              collisionPadding={8}
              class="z-50 w-56 overflow-hidden border border-border bg-surface py-1 shadow-xl"
            >
              <!--
                Fetch is the one remote action with no control of its own: it
                advertises no drift, so it stays here with the working-tree
                actions. Pull, Push and the main-worktree sync each own a
                header control, so the menu does not repeat them. They land
                here instead while conflicts are open, when the row belongs to
                the resolution controls, and in a worktree checkout, where a
                managed scope keeps publishing out of the row.
              -->
              {#if remoteActionsInMenu}
                {#if showsPull}
                  <DropdownMenu.Item
                    class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:pointer-events-none data-disabled:opacity-40"
                    disabled={branchSyncBusy}
                    onSelect={() => void pullAction()}
                  >
                    <CioDownload size={12} class="shrink-0 text-dimmed" />
                    Pull {commitsBehind}
                  </DropdownMenu.Item>
                {/if}
                {#if showsPush}
                  <DropdownMenu.Item
                    class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:pointer-events-none data-disabled:opacity-40"
                    disabled={pushBlocked}
                    onSelect={() => void pushAction()}
                  >
                    <CioUpload size={12} class="shrink-0 text-dimmed" />
                    Push{commitsAhead > 0 ? ` ${String(commitsAhead)}` : ''}
                  </DropdownMenu.Item>
                {/if}
              {/if}
              <DropdownMenu.Item
                class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated"
                onSelect={() => prLifecycleStore.open(projectId, threadId, scopeBucketId)}
              >
                <CioPullRequest size={12} class="shrink-0 text-dimmed" />
                Create pull request…
              </DropdownMenu.Item>
              <DropdownMenu.Item
                class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:opacity-40"
                disabled={localBranches.length < 2}
                onSelect={onShowIntegrateModal}
              >
                <CioMerge size={12} class="shrink-0 text-dimmed" />
                Merge or rebase…
              </DropdownMenu.Item>
              <DropdownMenu.Separator class="my-1 h-px bg-border" />
              <DropdownMenu.Item
                class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:pointer-events-none data-disabled:opacity-40"
                disabled={remotes.length === 0 || fetching}
                onSelect={() => void gitState.fetch(projectId)}
              >
                <CioDownload size={12} class="shrink-0 text-dimmed" />
                Fetch
              </DropdownMenu.Item>
              <DropdownMenu.Separator class="my-1 h-px bg-border" />
              <DropdownMenu.Item
                class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:opacity-40"
                disabled={status?.clean ?? true}
                onSelect={onShowStashModal}
              >
                <CioArchive size={12} class="shrink-0 text-dimmed" />
                Stash changes…
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      {/if}
    </div>
  {:else}
    <span class="flex-1"></span>
    <!-- Off-git states render no tabs, so the refresh control stays on this row. -->
    {@render refreshStatusButton()}
  {/if}
</div>

<style>
  /*
    The header row is a query container so the action labels can retreat before
    the row runs out of room. The glyphs always say what the control does, and the
    tooltip names it in full, so dropping the word is a compress, not a loss.
  */
  .git-panel-header {
    container: git-header / inline-size;
  }
</style>
