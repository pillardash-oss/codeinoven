<script lang="ts">
  import CioMerge from '@pdslng/cio-icon/CioMerge.svelte'
  import CioPlay from '@pdslng/cio-icon/CioPlay.svelte'
  import CioPullRequest from '@pdslng/cio-icon/CioPullRequest.svelte'
  import CioSkipForward from '@pdslng/cio-icon/CioSkipForward.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import CioTrash from '@pdslng/cio-icon/CioTrash.svelte'
  import CioUpload from '@pdslng/cio-icon/CioUpload.svelte'
  import { openInBrowser } from '$lib/open-in-browser'
  import { appConfigState } from '$lib/stores/app-config.svelte'
  import { gitState } from '$lib/stores/git.svelte'
  import { githubSignIn } from '$lib/stores/github-sign-in.svelte'
  import { DEFAULT_SCOPE_BUCKET_ID } from '$shared/types'
  import type { GitCommitInfo } from '$shared/types'
  import CommitActionsMenu from './CommitActionsMenu.svelte'
  import GitStatusPanelConfirmDialogs from './GitStatusPanelConfirmDialogs.svelte'
  import GitStatusPanelCommitComposer from './GitStatusPanelCommitComposer.svelte'
  import GitStatusPanelFind from './GitStatusPanelFind.svelte'
  import GitStatusPanelHeader from './GitStatusPanel/GitStatusPanelHeader.svelte'
  import GitStatusPanelViewContext from './GitStatusPanel/GitStatusPanelViewContext.svelte'
  import GitStatusPanelContent from './GitStatusPanel/GitStatusPanelContent.svelte'
  import GitStatusPanelDialogs from './GitStatusPanelDialogs.svelte'
  import GitPullButton from './GitPullButton.svelte'
  import GitSyncPeerDialog from './GitSyncPeerDialog.svelte'
  import GitPullRequestList from './GitPullRequestList.svelte'
  import GitPullRequestDetail from './GitPullRequestDetail.svelte'
  import PrBatchDialog from './PrBatchDialog.svelte'
  import PrMergeConfirmDialog from './PrMergeConfirmDialog.svelte'
  import PrMetadataDialog from './PrMetadataDialog.svelte'
  import FullscreenPanelDialog from '../workspace/FullscreenPanelDialog.svelte'
  import { prLifecycleStore } from '$lib/stores/pr-lifecycle.svelte'
  import { findNavState } from '$lib/stores/find-nav.svelte'
  import { createGitStatusPanel } from './GitStatusPanel/GitStatusPanel-board.svelte'
  import type { Props } from './GitStatusPanel/GitStatusPanel-types'

  let { projectId, threadId, scopeBucketId = DEFAULT_SCOPE_BUCKET_ID }: Props = $props()
  const board = createGitStatusPanel(() => ({ projectId, threadId, scopeBucketId }))
</script>

<!--
  Abort whatever integration is open, confirmed first: it discards the merge or
  rebase and restores the working tree. One snippet for both homes, the notice
  and the Changes row, which differ only in the height they have to fit and in
  how much room the label has   the row measures its four controls against a
  480px panel, so there it says `Abort` and the title names the integration.
-->
{#snippet abortIntegrationAction(compact: boolean)}
  <button
    type="button"
    class={[
      'flex shrink-0 cursor-pointer items-center gap-1.5 border border-danger/40 font-medium text-[0.625rem] text-danger transition-colors hover:bg-danger/10 disabled:cursor-default disabled:opacity-40',
      compact ? 'h-6 px-2' : 'h-7 px-2.5'
    ]}
    disabled={board.state.integrateBusy || board.confirmPrMerge.conflictState === 'none'}
    title={`Discard the whole ${board.confirmPrMerge.conflictState === 'merge' ? 'merge' : 'rebase'} and restore the working tree`}
    onclick={board.confirmPrMerge.requestAbortConflict}
  >
    {#if gitState.isBusy('abortMerge') || gitState.isBusy('abortRebase')}
      <CioSpinner size={11} class="animate-spin" />
    {:else}
      <CioTrash size={11} />
    {/if}
    {#if compact}
      Abort
    {:else}
      Abort {board.confirmPrMerge.conflictState === 'merge' ? 'merge' : 'rebase'}
    {/if}
  </button>
{/snippet}

<!--
  The strategies for whatever integration is open, in one place. A stopped rebase
  is continued or skipped, a resolved merge is completed, and either can be
  aborted. The rebase notice and the sync modal both render this, so the two can
  never offer different ways out of the same state. `withAbort` is false only
  where something else on screen already offers it.
-->
{#snippet integrationActions(withAbort = true)}
  {#if board.confirmPrMerge.conflictState === 'rebase'}
    <!--
      Both forward actions carry `data-modal-primary`, so the modal's focus and
      ⌘+Enter pipeline lands on one of them. Continue is disabled while any
      conflict is still open, and then skip is the only way forward left; abort
      deliberately carries nothing, because the shortcut must never discard the
      integration.
    -->
    <button
      type="button"
      data-modal-primary
      {@attach board.confirmPrMerge.focusSyncModalAction}
      class="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 bg-foreground px-2.5 text-[0.625rem] font-semibold text-app transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-50"
      title={board.loadRepoState.conflicted.length > 0
        ? `Resolve and stage the ${String(board.loadRepoState.conflicted.length)} remaining conflict${board.loadRepoState.conflicted.length === 1 ? '' : 's'} before continuing`
        : 'Replay the rest of your commits on top of the new base'}
      disabled={board.state.integrateBusy || board.loadRepoState.conflicted.length > 0}
      onclick={() => void board.confirmPrMerge.runRebaseAction('continue')}
    >
      {#if board.confirmPrMerge.rebaseActionRunning === 'continue'}
        <CioSpinner size={11} class="animate-spin" />
      {:else}
        <CioPlay size={11} />
      {/if}
      Continue rebase
    </button>
    <button
      type="button"
      data-modal-primary
      {@attach board.confirmPrMerge.focusSyncModalAction}
      class="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 border border-border px-2.5 text-[0.625rem] font-medium text-foreground transition-colors hover:bg-elevated disabled:cursor-default disabled:opacity-40"
      title="Drop the commit git stopped on and replay the rest"
      disabled={board.state.integrateBusy}
      onclick={() => void board.confirmPrMerge.runRebaseAction('skip')}
    >
      {#if board.confirmPrMerge.rebaseActionRunning === 'skip'}
        <CioSpinner size={11} class="animate-spin" />
      {:else}
        <CioSkipForward size={11} />
      {/if}
      Skip this commit
    </button>
  {:else if board.loadRepoState.mergePending}
    <button
      type="button"
      data-modal-primary
      {@attach board.confirmPrMerge.focusSyncModalAction}
      class="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 bg-foreground px-2.5 text-[0.625rem] font-semibold text-app transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-50"
      title="Commit the resolved files to complete the merge"
      disabled={board.confirmAcceptAllConflicts.completeMergeBusy}
      onclick={board.loadRepoState.openCompleteMerge}
    >
      {#if board.confirmAcceptAllConflicts.completeMergeBusy}
        <CioSpinner size={11} class="animate-spin" />
      {:else}
        <CioMerge size={11} />
      {/if}
      Complete merge
    </button>
  {/if}
  {#if withAbort}
    {@render abortIntegrationAction(false)}
  {/if}
{/snippet}

<!--
  One commit menu, two doors: the History rows open it on right click, and the
  header's info control opens it for the commit being read. It was two lists that
  had drifted apart for no reason, so it is one snippet now.
-->
{#snippet commitActions(commit: GitCommitInfo, isHead: boolean)}
  <CommitActionsMenu
    {isHead}
    resetBusy={gitState.isBusy('reset')}
    deleteBusy={gitState.isBusy('delete-commit')}
    onReset={(mode) => board.confirmPrMerge.requestReset(mode, commit.hash)}
    onDelete={() => board.confirmAcceptAllConflicts.requestDeleteCommit(commit)}
    onAmend={isHead ? board.handlePrListAction.startAmend : undefined}
    onCopyHash={() => void board.state.copyCommitHash(commit)}
    onCopyMessage={() => void board.state.copyCommitMessage(commit)}
    onShowInfo={() => (board.handlePrListAction.commitInfoTarget = commit)}
  />
{/snippet}

<div class="relative flex h-full min-h-0 flex-col bg-app" data-region="git-panel">
  <GitStatusPanelFind
    open={findNavState.gitFindOpen}
    scope={board.handlePrListAction.find.scope}
    query={board.handlePrListAction.find.query}
    bind:activeIndex={board.handlePrListAction.find.activeIndex}
    focusTrigger={findNavState.gitFindFocusTrigger}
    loading={board.handlePrListAction.find.loading}
    rows={board.handlePrListAction.find.rows}
    error={board.handlePrListAction.find.error}
    onQueryChange={(query) => void board.handlePrListAction.find.run(query)}
    onNext={() => board.handlePrListAction.find.move(1)}
    onPrev={() => board.handlePrListAction.find.move(-1)}
    onSubmit={() => board.handlePrListAction.find.openActiveResult()}
    onClose={() => board.handlePrListAction.find.close()}
    onSelectResult={(row) => board.handlePrListAction.find.selectRow(row)}
  />

  <!--
    Header: identity, branch, the view you are in and its tools on one line. The
    view in focus takes a second line the moment it has something to say
    (`board.confirmAcceptAllConflicts.showsActionRow`), and that row is where the remote actions live too.
  -->
  <div class="flex shrink-0 flex-col">
    <GitStatusPanelHeader
      repoState={board.loadRepoState.repoState}
      githubStatus={board.confirmPrMerge.githubStatus}
      primaryRemote={board.loadRepoState.primaryRemote}
      remotes={board.loadRepoState.remotes}
      status={board.loadRepoState.status}
      conflicted={board.loadRepoState.conflicted}
      worktreeState={board.loadRepoState.worktreeState}
      tabs={board.handlePrListAction.tabs}
      activeTab={board.handlePrListAction.activeTab}
      bind:changesView={board.confirmAcceptAllConflicts.changesView}
      showsSync={board.loadRepoState.showsSync}
      branchSyncBusy={board.confirmPrMerge.branchSyncBusy}
      remoteActionsInMenu={board.loadRepoState.remoteActionsInMenu}
      showsPull={board.loadRepoState.showsPull}
      showsPush={board.loadRepoState.showsPush}
      commitsBehind={board.loadRepoState.commitsBehind}
      commitsAhead={board.loadRepoState.commitsAhead}
      pushBlocked={board.confirmPrMerge.pushBlocked}
      fetching={board.confirmPrMerge.fetching}
      busy={board.state.busy}
      localBranches={board.confirmAcceptAllConflicts.localBranches}
      selectedCommit={board.handlePrListAction.selectedCommit}
      isHeadCommit={board.confirmAcceptAllConflicts.isHeadCommit}
      selectedPullRequest={board.handlePrListAction.selectedPullRequest}
      deploymentsExternal={board.handlePrListAction.deploymentsExternal}
      openNotification={board.confirmPrMerge.openNotification}
      notificationActionClass={board.state.notificationActionClass}
      notificationBusy={board.state.notificationBusy}
      githubConnected={board.handlePrListAction.githubConnected}
      projectId={board.props.projectId}
      threadId={board.props.threadId}
      scopeBucketId={board.props.scopeBucketId}
      findWords={board.handlePrListAction.find.words}
      {commitActions}
      selectTab={board.handlePrListAction.selectTab}
      signOutGitHub={board.confirmPrMerge.signOutGitHub}
      switchGitHubAccount={board.confirmPrMerge.switchGitHubAccount}
      requestCheckout={(branch) => board.loadRepoState.branches.requestCheckout(branch)}
      createBranchAction={(name) => board.loadRepoState.branches.createBranch(name)}
      deleteBranchAction={(name, force) => board.loadRepoState.branches.deleteBranch(name, force)}
      openAddOrigin={board.confirmPrMerge.openAddOrigin}
      openReplaceOrigin={board.loadRepoState.openReplaceOrigin}
      syncMainAction={board.confirmPrMerge.syncMainAction}
      openSyncPeer={board.syncPeerOpen.openSyncPeer}
      openFind={() => board.handlePrListAction.find.open()}
      closeFind={() => board.handlePrListAction.find.close()}
      refreshPanel={board.loadRepoState.refreshPanel}
      startAmend={board.handlePrListAction.startAmend}
      openPullRequestFullscreen={board.closeFullscreenPullRequestTab.openPullRequestFullscreen}
      pullAction={board.loadRepoState.pullAction}
      pushAction={board.loadRepoState.pushAction}
      onOpenWorkingChanges={board.confirmPrMerge.openWorkingChanges}
      onShowIntegrateModal={() => (board.confirmPrMerge.showIntegrateModal = true)}
      onShowStashModal={() => (board.handlePrListAction.stashes.showStashModal = true)}
      onRequestCreateBranch={() => (board.loadRepoState.branches.creatingBranch = true)}
    />

    {#if board.confirmAcceptAllConflicts.showsActionRow}
      <!--
        The row under the header belongs to the view in focus: the commit or
        stash being read, the pull request's identity, the PR list's filter, the
        conflict controls, and Pull and Push. Pull and Push are independent   a
        diverged branch needs both   so each gets a share of the row's width
        instead of one hiding the other, and they are the only items here that
        stretch. Pull is split at its right edge so a one-off strategy is a
        click away from the saved one. While conflicts are open they stand aside
        entirely (see `board.loadRepoState.conflictsOpen`) so the row can hold the controls that end
        them.
      -->
      <div
        class="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2 py-2"
      >
        <GitStatusPanelViewContext
          bind:activeTab={board.handlePrListAction.activeTab}
          selectedCommit={board.handlePrListAction.selectedCommit}
          selectedStash={board.handlePrListAction.stashes.selectedStash}
          bind:selectedPullRequest={board.handlePrListAction.selectedPullRequest}
          bind:selectedDeployment={board.handlePrListAction.selectedDeployment}
          bind:selectedRun={board.handlePrListAction.selectedRun}
          bind:prDetailTab={board.confirmAcceptAllConflicts.prDetailTab}
          conflicted={board.loadRepoState.conflicted}
          changes={board.loadRepoState.changes}
          staged={board.loadRepoState.staged}
          unstaged={board.loadRepoState.unstaged}
          untracked={board.loadRepoState.untracked}
          selectedPathList={board.handlePrListAction.workingTree.selectedPathList}
          integrateBusy={board.state.integrateBusy}
          batchBusy={board.state.batchBusy}
          canGoNewer={board.confirmAcceptAllConflicts.canGoNewer}
          canGoOlder={board.loadRepoState.canGoOlder}
          openNotification={board.confirmPrMerge.openNotification}
          notificationPrDetailViews={board.confirmPrMerge.notificationPrDetailViews}
          notificationBundle={board.confirmPrMerge.notificationBundle}
          notificationPullRequest={board.confirmPrMerge.notificationPullRequest}
          notificationIdentity={board.confirmPrMerge.notificationIdentity}
          prDetailViews={board.handlePrListAction.prDetailViews}
          pullRequestBundle={board.confirmPrMerge.pullRequestBundle}
          prListState={board.confirmPrMerge.prListState}
          prListFilter={board.confirmPrMerge.prListFilter}
          prListSort={board.confirmPrMerge.prListSort}
          primaryRemote={board.loadRepoState.primaryRemote}
          githubIdentity={board.handlePrListAction.githubIdentity}
          projectId={board.props.projectId}
          openDeploymentState={board.confirmPrMerge.openDeploymentState}
          openRunState={board.confirmPrMerge.openRunState}
          openRunJobs={board.confirmPrMerge.openRunJobs}
          openRunFailedJob={board.confirmPrMerge.openRunFailedJob}
          preparingRunDiagnosis={board.handlePrListAction.preparingRunDiagnosis}
          {abortIntegrationAction}
          clearSelectedCommit={board.handlePrListAction.clearSelectedCommit}
          clearSelectedStash={() => board.handlePrListAction.stashes.clearSelectedStash()}
          navigateCommit={board.loadRepoState.navigateCommit}
          stageAll={() => void board.handlePrListAction.workingTree.stageAll()}
          unstageAll={() => void board.handlePrListAction.workingTree.unstageAll()}
          stageSelectedAction={(stage) =>
            void board.handlePrListAction.workingTree.stageSelectedAction(stage)}
          requestCommitSelected={() => board.handlePrListAction.workingTree.requestCommitSelected()}
          requestStashFor={(paths) => board.handlePrListAction.stashes.requestStashFor(paths)}
          ignoreSelectedAction={() =>
            void board.handlePrListAction.workingTree.ignoreSelectedAction()}
          requestDiscard={(paths) => board.handlePrListAction.workingTree.requestDiscard(paths)}
          requestRemoveCommitChanges={board.confirmAcceptAllConflicts.requestRemoveCommitChanges}
          routeConflictResolution={board.state.routeConflictResolution}
          resolveConflictsWithAgent={board.loadRepoState.resolveConflictsWithAgent}
          requestAcceptAllConflicts={board.confirmAcceptAllConflicts.requestAcceptAllConflicts}
          reviewOpenRunFailedJob={board.handlePrListAction.reviewOpenRunFailedJob}
          reloadOpenRun={board.confirmPrMerge.reloadOpenRun}
          isPanelRepository={board.handlePrListAction.isPanelRepository}
          selectPrListState={board.confirmPrMerge.selectPrListState}
          selectPrListFilter={board.confirmPrMerge.selectPrListFilter}
          selectPrListSort={board.confirmPrMerge.selectPrListSort}
        />
        {#if board.loadRepoState.showsRemoteActions}
          {#if board.loadRepoState.showsPull}
            <GitPullButton
              behind={board.loadRepoState.commitsBehind}
              busy={gitState.isBusy('pull')}
              blocked={board.confirmPrMerge.branchSyncBusy}
              preference={appConfigState.defaultPullStrategy}
              onPull={board.loadRepoState.pullAction}
              onPullWith={board.loadRepoState.startPull}
              onAskEveryPull={board.confirmAcceptAllConflicts.askEveryPull}
            />
          {/if}
          {#if board.loadRepoState.showsPush}
            <button
              type="button"
              class="flex h-6 min-w-0 flex-1 items-center justify-center gap-1 bg-elevated px-1.5 text-[0.625rem] font-medium text-foreground transition-colors hover:bg-raised disabled:cursor-default disabled:opacity-40"
              title={board.loadRepoState.pushTitle}
              disabled={board.confirmPrMerge.pushBlocked}
              onclick={() => void board.loadRepoState.pushAction()}
            >
              {#if gitState.isBusy('push')}
                <CioSpinner size={11} class="animate-spin" />
              {:else}
                <CioUpload size={11} />
              {/if}
              <span class="min-w-0 truncate">
                Push{board.loadRepoState.commitsAhead > 0
                  ? ` ${String(board.loadRepoState.commitsAhead)}`
                  : ''}
              </span>
            </button>
          {/if}
        {/if}
      </div>
    {/if}
  </div>

  <!-- Content (scrollable) -->
  <GitStatusPanelContent
    activeTab={board.handlePrListAction.activeTab}
    ovenTarget={board.confirmPrMerge.ovenTarget}
    ovenError={board.confirmAcceptAllConflicts.ovenError}
    repoState={board.loadRepoState.repoState}
    preflightDetail={board.confirmAcceptAllConflicts.preflightDetail}
    scopeUnhealthy={board.scopeHealth.scopeUnhealthy}
    projectId={board.props.projectId}
    threadId={board.props.threadId}
    scopeBucketId={board.props.scopeBucketId}
    conflictState={board.confirmPrMerge.conflictState}
    conflicted={board.loadRepoState.conflicted}
    conflictRowAborts={board.confirmPrMerge.conflictRowAborts}
    {integrationActions}
    {commitActions}
    status={board.loadRepoState.status}
    identityNeeded={board.loadRepoState.identityNeeded}
    bind:showIdentityForm={board.saveIdentity.showIdentityForm}
    bind:identityName={board.saveIdentity.identityName}
    bind:identityEmail={board.saveIdentity.identityEmail}
    changes={board.loadRepoState.changes}
    conflictSections={board.confirmAcceptAllConflicts.conflictSections}
    stagedSections={board.confirmAcceptAllConflicts.stagedSections}
    workingSections={board.confirmAcceptAllConflicts.workingSections}
    selectedCommit={board.handlePrListAction.selectedCommit}
    commitDiffChanges={board.handlePrListAction.commitDiffChanges}
    commitTree={board.confirmAcceptAllConflicts.commitTree}
    commitTreeCollapsedDirs={board.confirmAcceptAllConflicts.commitTreeCollapsedDirs}
    changesView={board.confirmAcceptAllConflicts.changesView}
    loadingCommitDiff={board.confirmAcceptAllConflicts.loadingCommitDiff}
    diffs={board.handlePrListAction.workingTree.diffs}
    expanded={board.handlePrListAction.workingTree.expanded}
    loadingDiff={board.handlePrListAction.workingTree.loadingDiff}
    diffErrors={board.handlePrListAction.workingTree.diffErrors}
    commitDiffs={board.confirmPrMerge.commitDiffs}
    commitExpanded={board.confirmPrMerge.commitExpanded}
    loadingCommitDiffFile={board.confirmPrMerge.loadingCommitDiffFile}
    commitDiffErrors={board.confirmPrMerge.commitDiffErrors}
    bind:selectedPaths={board.handlePrListAction.workingTree.selectedPaths}
    paneClass={board.state.paneClass}
    commitHistory={board.loadRepoState.commitHistory}
    loadingHistory={board.loadRepoState.loadingHistory}
    loadingMoreHistory={board.loadRepoState.loadingMoreHistory}
    historyHasMore={board.loadRepoState.historyHasMore}
    unpushedCount={board.loadRepoState.unpushedCount}
    remoteUpdates={board.confirmPrMerge.remoteUpdates}
    localBranches={board.confirmAcceptAllConflicts.localBranches}
    worktreeBranches={board.state.worktreeBranches}
    localBranchNames={board.confirmAcceptAllConflicts.localBranchNames}
    bind:creatingBranch={board.loadRepoState.branches.creatingBranch}
    bind:newBranchName={board.loadRepoState.branches.newBranchName}
    bind:selectedPullRequest={board.handlePrListAction.selectedPullRequest}
    bind:prDetailTab={board.confirmAcceptAllConflicts.prDetailTab}
    githubIdentity={board.handlePrListAction.githubIdentity}
    githubConnected={board.handlePrListAction.githubConnected}
    prListState={board.confirmPrMerge.prListState}
    prListFilter={board.confirmPrMerge.prListFilter}
    prListSort={board.confirmPrMerge.prListSort}
    prListPage={board.confirmPrMerge.prListPage}
    bind:prListSelection={board.confirmPrMerge.prListSelection}
    openNotification={board.confirmPrMerge.openNotification}
    notificationIdentity={board.confirmPrMerge.notificationIdentity}
    notificationPullRequest={board.confirmPrMerge.notificationPullRequest}
    notificationIssue={board.confirmPrMerge.notificationIssue}
    onNotificationStackSelection={(selection) =>
      (board.confirmPrMerge.notificationStackSelection = selection)}
    onNotificationStackSelectionReset={() =>
      (board.confirmPrMerge.notificationStackSelection = null)}
    bind:selectedDeployment={board.handlePrListAction.selectedDeployment}
    bind:selectedRun={board.handlePrListAction.selectedRun}
    bind:requestedWorkflowRunId={board.confirmAcceptAllConflicts.requestedWorkflowRunId}
    selectedStash={board.handlePrListAction.stashes.selectedStash}
    loadingStashDiff={board.handlePrListAction.stashes.loadingStashDiff}
    stashDiffChanges={board.handlePrListAction.stashes.stashDiffChanges}
    stashDiffs={board.handlePrListAction.stashes.stashDiffs}
    loadingStashDiffFile={board.handlePrListAction.stashes.loadingStashDiffFile}
    stashDiffErrors={board.handlePrListAction.stashes.stashDiffErrors}
    stashExpanded={board.handlePrListAction.stashes.stashExpanded}
    stashOpBusy={board.state.stashOpBusy}
    loadRepoState={board.loadRepoState.loadRepoState}
    handleContentScroll={board.confirmAcceptAllConflicts.handleContentScroll}
    initializeRepository={board.loadRepoState.initializeRepository}
    refreshStatus={board.handlePrListAction.refreshStatus}
    saveIdentity={board.saveIdentity.saveIdentity}
    toggleDiff={(change) => board.handlePrListAction.workingTree.toggleDiff(change)}
    toggleStage={(change) => board.handlePrListAction.workingTree.toggleStage(change)}
    toggleSelection={(change, additive) =>
      board.handlePrListAction.workingTree.toggleSelection(change, additive)}
    toggleSectionSelection={(files) =>
      board.handlePrListAction.workingTree.toggleSectionSelection(files)}
    stagePathsAction={(paths, staged) =>
      board.handlePrListAction.workingTree.stagePaths(paths, staged)}
    requestStashFor={(paths) => board.handlePrListAction.stashes.requestStashFor(paths)}
    openInEditor={board.state.openInEditor}
    openDirectory={board.state.openDirectory}
    ignorePathsAction={(paths) => board.handlePrListAction.workingTree.ignorePathsAction(paths)}
    requestDiscard={(paths) => board.handlePrListAction.workingTree.requestDiscard(paths)}
    routeConflictResolution={board.state.routeConflictResolution}
    restoreFromSource={(source, path, target) =>
      board.handlePrListAction.workingTree.restoreFromSource(source, path, target)}
    toggleCommitDiff={board.confirmPrMerge.toggleCommitDiff}
    toggleCommitDir={board.confirmAcceptAllConflicts.toggleCommitDir}
    requestRemoveCommitChanges={board.confirmAcceptAllConflicts.requestRemoveCommitChanges}
    selectCommit={board.handlePrListAction.selectCommit}
    createBranchAction={(name) => board.loadRepoState.branches.createBranch(name)}
    requestCheckout={(branch) => board.loadRepoState.branches.requestCheckout(branch)}
    fetchBranchAction={(branch) => board.loadRepoState.branches.fetchBranch(branch)}
    requestDeleteBranch={(name) => board.loadRepoState.branches.requestDeleteBranch(name)}
    requestDeleteRemoteBranch={(branch) =>
      board.loadRepoState.branches.requestDeleteRemoteBranch(branch)}
    openPullRequestFullscreen={board.closeFullscreenPullRequestTab.openPullRequestFullscreen}
    handlePrListAction={board.handlePrListAction.handlePrListAction}
    selectPrListState={board.confirmPrMerge.selectPrListState}
    selectPrListFilter={board.confirmPrMerge.selectPrListFilter}
    selectPrListSort={board.confirmPrMerge.selectPrListSort}
    selectPrListPage={board.confirmPrMerge.selectPrListPage}
    openCommitByHash={board.confirmPrMerge.openCommitByHash}
    openCommitFor={board.confirmPrMerge.openCommitFor}
    openWorkflowRunFor={board.loadRepoState.openWorkflowRunFor}
    isPanelRepository={board.handlePrListAction.isPanelRepository}
    startDeploymentDiagnosis={board.handlePrListAction.startDeploymentDiagnosis}
    selectStash={(stash) => board.handlePrListAction.stashes.selectStash(stash)}
    toggleStashDiff={(change) => board.handlePrListAction.stashes.toggleStashDiff(change)}
    popStash={(id) => board.handlePrListAction.stashes.popStash(id)}
    requestStashDrop={(stash) => board.handlePrListAction.stashes.requestStashDrop(stash)}
    assignAgentToPullRequest={board.confirmAcceptAllConflicts.assignAgentToPullRequest}
    openAgentThread={board.confirmAcceptAllConflicts.openAgentThread}
    resolveConflictsLocally={board.handlePrListAction.resolveConflictsLocally}
    startConflictResolution={board.handlePrListAction.startConflictResolution}
  />

  <GitStatusPanelCommitComposer
    repoState={board.loadRepoState.repoState}
    status={board.loadRepoState.status}
    selectedCommit={board.handlePrListAction.selectedCommit}
    activeTab={board.handlePrListAction.activeTab}
    stagedCount={board.loadRepoState.staged.length}
    bind:amendMode={board.handlePrListAction.amendMode}
    mergeAwaitsCompletion={board.loadRepoState.mergeAwaitsCompletion}
    commitBusy={board.state.commitBusy}
    bind:commitMessage={board.handlePrListAction.commitMessage}
    bind:commitSelection={board.confirmAcceptAllConflicts.commitSelection}
    onCommitInline={() => void board.handlePrListAction.commitInline()}
    onCommitMessageKeydown={board.confirmAcceptAllConflicts.onCommitMessageKeydown}
  />
  <!-- Pinned action bar -->
  <GitStatusPanelDialogs
    repoState={board.loadRepoState.repoState}
    status={board.loadRepoState.status}
    primaryRemote={board.loadRepoState.primaryRemote}
    remoteBranchExists={board.loadRepoState.remoteBranchExists}
    pushBlocked={board.confirmPrMerge.pushBlocked}
    pullStrategyOpen={board.loadRepoState.pullStrategyOpen}
    syncMainOpen={board.confirmPrMerge.syncMainOpen}
    syncDirection={board.confirmPrMerge.syncDirection}
    integrationOpen={board.confirmPrMerge.integrationOpen}
    conflictState={board.confirmPrMerge.conflictState}
    conflicted={board.loadRepoState.conflicted}
    mergeAwaitsCompletion={board.loadRepoState.mergeAwaitsCompletion}
    mergePending={board.loadRepoState.mergePending}
    prResolveBranch={board.loadRepoState.prResolveBranch}
    completeMergeBusy={board.confirmAcceptAllConflicts.completeMergeBusy}
    pushRecoverMode={board.loadRepoState.pushRecoverMode}
    localBranches={board.confirmAcceptAllConflicts.localBranches}
    integrateBusy={board.state.integrateBusy}
    resetOptions={board.state.resetOptions}
    atRiskFiles={board.loadRepoState.atRiskFiles}
    agentTurnActive={board.refreshAgentTurnState.agentTurnActive}
    originModalOpen={board.confirmPrMerge.originModalOpen}
    originMode={board.confirmPrMerge.originMode}
    originName={board.confirmPrMerge.originName}
    originBusy={board.confirmPrMerge.originBusy}
    bind:pushConfirm={board.loadRepoState.pushConfirm}
    bind:pushDiverged={board.loadRepoState.pushDiverged}
    bind:completeMergeOpen={board.loadRepoState.completeMergeOpen}
    bind:mergeTitle={board.loadRepoState.mergeTitle}
    bind:mergeDescription={board.loadRepoState.mergeDescription}
    bind:showStashModal={board.handlePrListAction.stashes.showStashModal}
    bind:stashPaths={board.handlePrListAction.stashes.stashPaths}
    bind:stashMessage={board.handlePrListAction.stashes.stashMessage}
    bind:showIntegrateModal={board.confirmPrMerge.showIntegrateModal}
    bind:mergeTarget={board.confirmPrMerge.mergeTarget}
    bind:pendingOperation={board.confirmPrMerge.pendingOperation}
    bind:acknowledgeActiveTurn={board.confirmPrMerge.acknowledgeActiveTurn}
    bind:resetConfirm={board.confirmPrMerge.resetConfirm}
    bind:deleteCommitTarget={board.handlePrListAction.deleteCommitTarget}
    bind:checkoutConfirm={board.loadRepoState.branches.checkoutConfirm}
    bind:deleteBranchConfirm={board.loadRepoState.branches.deleteBranchConfirm}
    bind:forceDeleteBranchConfirm={board.loadRepoState.branches.forceDeleteBranchConfirm}
    bind:deleteRemoteBranchConfirm={board.loadRepoState.branches.deleteRemoteBranchConfirm}
    bind:originReplaceConfirm={board.confirmPrMerge.originReplaceConfirm}
    bind:originUrl={board.confirmPrMerge.originUrl}
    {integrationActions}
    confirmPushUpstream={board.loadRepoState.confirmPushUpstream}
    recoverPush={board.loadRepoState.recoverPush}
    closePullStrategy={board.loadRepoState.closePullStrategy}
    startPull={board.loadRepoState.startPull}
    closeSyncMain={board.confirmPrMerge.closeSyncMain}
    performSyncMain={board.confirmPrMerge.performSyncMain}
    confirmCompleteMerge={board.loadRepoState.confirmCompleteMerge}
    openCompleteMerge={board.loadRepoState.openCompleteMerge}
    stashChanges={() => board.handlePrListAction.stashes.stashChanges()}
    requestMergeOrRebase={board.confirmPrMerge.requestMergeOrRebase}
    confirmPendingOperation={board.confirmPrMerge.confirmPendingOperation}
    confirmReset={board.handlePrListAction.confirmReset}
    confirmDeleteCommit={board.handlePrListAction.confirmDeleteCommit}
    confirmCheckoutBranch={() => void board.loadRepoState.branches.confirmCheckoutBranch()}
    confirmDeleteBranch={() => void board.loadRepoState.branches.confirmDeleteBranch()}
    confirmForceDeleteBranch={() => void board.loadRepoState.branches.confirmForceDeleteBranch()}
    confirmDeleteRemoteBranch={() => void board.loadRepoState.branches.confirmDeleteRemoteBranch()}
    closeOriginModal={board.confirmPrMerge.closeOriginModal}
    requestSetOrigin={board.confirmPrMerge.requestSetOrigin}
    runSetOrigin={board.confirmPrMerge.runSetOrigin}
  />
</div>

<!-- Peer chooser: the panel only says which direction the user started from. -->
{#if board.syncPeerOpen.syncPeerOpen}
  <GitSyncPeerDialog
    projectId={board.props.projectId}
    scopeBucketId={board.props.scopeBucketId}
    initialDirection={board.syncPeerOpen.syncPeerDirection}
    onClose={board.syncPeerOpen.closeSyncPeer}
    onStarted={board.syncPeerOpen.syncPeerStarted}
    onSettled={() => void board.handlePrListAction.refreshStatus()}
  />
{/if}

<GitStatusPanelConfirmDialogs
  bind:stashDropTarget={board.handlePrListAction.stashes.stashDropTarget}
  bind:discardConfirm={board.handlePrListAction.workingTree.discardConfirm}
  bind:restoreWorktreeConfirm={board.handlePrListAction.workingTree.restoreWorktreeConfirm}
  bind:abortConfirmOpen={board.confirmPrMerge.abortConfirmOpen}
  bind:acceptConflictsSide={board.confirmAcceptAllConflicts.acceptConflictsSide}
  bind:commitInfoTarget={board.handlePrListAction.commitInfoTarget}
  bind:removeCommitChangesConfirm={board.confirmAcceptAllConflicts.removeCommitChangesConfirm}
  conflictState={board.confirmPrMerge.conflictState}
  conflictedCount={board.loadRepoState.conflicted.length}
  commitInfoOnRemote={board.loadRepoState.commitInfoOnRemote}
  removeCommitOnRemote={board.loadRepoState.removeCommitOnRemote}
  commitInfoUrl={board.handlePrListAction.commitInfoUrl}
  onConfirmStashDrop={() => void board.handlePrListAction.stashes.confirmStashDrop()}
  onConfirmDiscard={() => void board.handlePrListAction.workingTree.confirmDiscard()}
  onConfirmRestoreWorktree={() =>
    void board.handlePrListAction.workingTree.confirmRestoreWorktree()}
  onConfirmAbortConflict={() => void board.confirmPrMerge.confirmAbortConflict()}
  onConfirmAcceptAllConflicts={() =>
    void board.confirmAcceptAllConflicts.confirmAcceptAllConflicts()}
  onConfirmRemoveCommitChanges={() => void board.handlePrListAction.confirmRemoveCommitChanges()}
  onCopyCommitHash={(commit) => void board.state.copyCommitHash(commit)}
  onOpenCommitInBrowser={(url) => void openInBrowser(url)}
/>

<!--
  Row-menu surfaces. They are siblings of the panel's own layout for the same
  reason the full screen reader is: a confirmation has to sit above the sidebar it
  was opened from rather than inside its clipping column.
-->
{#if board.handlePrListAction.githubIdentity}
  {#if board.handlePrListAction.prBatch}
    <PrBatchDialog
      batch={board.handlePrListAction.prBatch}
      onConfirm={board.handlePrListAction.confirmPrBatch}
      onClose={() => (board.handlePrListAction.prBatch = null)}
    />
  {/if}

  {#if board.confirmAcceptAllConflicts.prMetadata}
    <PrMetadataDialog
      pr={board.confirmAcceptAllConflicts.prMetadata.pr}
      mode={board.confirmAcceptAllConflicts.prMetadata.mode}
      projectId={board.props.projectId}
      owner={board.handlePrListAction.githubIdentity.owner}
      repo={board.handlePrListAction.githubIdentity.repo}
      onClose={() => (board.confirmAcceptAllConflicts.prMetadata = null)}
    />
  {/if}

  {#if board.confirmPrMerge.prMerge}
    <PrMergeConfirmDialog
      number={board.confirmPrMerge.prMerge.pr.number}
      summary={board.confirmPrMerge.prMerge.pr}
      method={board.confirmPrMerge.prMerge.method}
      fieldSuffix="pr-list"
      busy={board.confirmPrMerge.prMergeBusy}
      bind:open={board.confirmPrMerge.prMergeOpen}
      bind:commitTitle={board.confirmPrMerge.prMergeTitle}
      bind:commitMessage={board.confirmPrMerge.prMergeMessage}
      onConfirm={() => void board.confirmPrMerge.confirmPrMerge()}
    />
  {/if}
{/if}

<!--
  Full screen pull request reader. It is a sibling of the panel's own layout so
  it can cover the whole window, and it is mounted only while a tab is active.
-->
{#if board.closeFullscreenPullRequestTab.fullscreenPullRequestId}
  <FullscreenPanelDialog
    tabs={board.closeFullscreenPullRequestTab.fullscreenPullRequestTabs}
    activeTabId={board.closeFullscreenPullRequestTab.fullscreenPullRequestId}
    newLabel="New pull request"
    minimizeLabel="Close the full screen reader"
    onSelect={(id) => (board.closeFullscreenPullRequestTab.fullscreenPullRequestId = id)}
    onCloseTab={board.closeFullscreenPullRequestTab.closeFullscreenPullRequestTab}
    onNew={() =>
      prLifecycleStore.open(board.props.projectId, board.props.threadId, board.props.scopeBucketId)}
    onMinimize={() => (board.closeFullscreenPullRequestTab.fullscreenPullRequestId = null)}
  >
    {#snippet icon()}
      <CioPullRequest size={12} class="shrink-0" aria-hidden="true" />
    {/snippet}
    <div class="flex min-h-0 flex-1 flex-col">
      {#if board.closeFullscreenPullRequestTab.fullscreenActivePullRequest && board.handlePrListAction.githubIdentity}
        <GitPullRequestDetail
          projectId={board.props.projectId}
          threadId={board.props.threadId}
          identity={board.handlePrListAction.githubIdentity}
          summary={board.closeFullscreenPullRequestTab.fullscreenActivePullRequest}
          reviewRemote={board.loadRepoState.primaryRemote?.name}
          onOpenPullRequest={board.closeFullscreenPullRequestTab.openPullRequestFullscreen}
          variant="fullscreen"
          onBack={() =>
            (board.closeFullscreenPullRequestTab.fullscreenPullRequestId =
              board.closeFullscreenPullRequestTab.PR_READER_LIST_TAB)}
          onAssignAgent={(pr) => void board.confirmAcceptAllConflicts.assignAgentToPullRequest(pr)}
          onOpenThread={(threadId) =>
            void board.confirmAcceptAllConflicts.openAgentThread(threadId)}
          onOpenWorkflowRun={board.loadRepoState.openWorkflowRunFromCheck}
          onOpenCommit={(hash) => void board.confirmPrMerge.openCommitByHash(hash)}
          onResolveLocally={(pr) => void board.handlePrListAction.resolveConflictsLocally(pr)}
          onResolveWithAgent={(pr) => void board.handlePrListAction.startConflictResolution(pr)}
        />
      {:else}
        <GitPullRequestList
          projectId={board.props.projectId}
          identity={board.handlePrListAction.githubIdentity}
          githubConnected={board.handlePrListAction.githubConnected}
          state={board.confirmPrMerge.prListState}
          filter={board.confirmPrMerge.prListFilter}
          sort={board.confirmPrMerge.prListSort}
          page={board.confirmPrMerge.prListPage}
          selected={board.confirmPrMerge.prListSelection}
          onSelectionChange={(next) => (board.confirmPrMerge.prListSelection = next)}
          onAction={board.handlePrListAction.handlePrListAction}
          onStateChange={board.confirmPrMerge.selectPrListState}
          onFilterChange={board.confirmPrMerge.selectPrListFilter}
          onSortChange={board.confirmPrMerge.selectPrListSort}
          onPageChange={board.confirmPrMerge.selectPrListPage}
          onOpen={(pr) => board.closeFullscreenPullRequestTab.openPullRequestFullscreen(pr)}
          onSignIn={() => githubSignIn.start()}
          onCreate={() =>
            prLifecycleStore.open(
              board.props.projectId,
              board.props.threadId,
              board.props.scopeBucketId
            )}
        />
      {/if}
    </div>
  </FullscreenPanelDialog>
{/if}
