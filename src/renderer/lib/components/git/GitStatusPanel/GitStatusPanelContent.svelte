<script lang="ts">
  import type { Snippet } from 'svelte'
  import { prLifecycleStore } from '$lib/stores/pr-lifecycle.svelte'
  import { githubSignIn } from '$lib/stores/github-sign-in.svelte'
  import { githubNotifications } from '$lib/stores/github-notifications.svelte'
  import { gitState } from '$lib/stores/git.svelte'
  import { openInBrowser } from '$lib/open-in-browser'
  import type {
    GitBranchInfo,
    GitCommitInfo,
    GitDiff,
    GitFileChange,
    GitRestoreTarget,
    GitStashEntry,
    GitHubDeployment,
    GitHubDeploymentJob,
    GitHubDeploymentJobLog,
    GitHubNotification,
    GitRemoteUpdate,
    GitStatus,
    GitHubWorkflowRun,
    PrListFilter,
    PrListSort,
    PrState,
    PullRequestSummary
  } from '$shared/types'
  import type { GitPanelTabId } from '$lib/stores/git-panel-view.svelte'
  import type { PrDetailTabId } from '../pr-view'
  import OvenSurfaceOverlay from '../../shared/OvenSurfaceOverlay.svelte'
  import GitStatusPanelRepoStates from '../GitStatusPanelRepoStates.svelte'
  import GitStatusPanelNotices from '../GitStatusPanelNotices.svelte'
  import GitStatusPanelChangesView from '../GitStatusPanelChangesView.svelte'
  import GitStatusPanelBranchesView from '../GitStatusPanelBranchesView.svelte'
  import GitStatusPanelStashesView from '../GitStatusPanelStashesView.svelte'
  import GitGraphView from '../GitGraphView.svelte'
  import GitPullRequestList from '../GitPullRequestList.svelte'
  import GitPullRequestDetail from '../GitPullRequestDetail.svelte'
  import GitIssuesView from '../GitIssuesView.svelte'
  import GitIssueReader from '../GitIssueReader.svelte'
  import GitNotificationsPanel from '../GitNotificationsPanel.svelte'
  import GitDeploymentsMonitor from '../GitDeploymentsMonitor.svelte'
  import EmptyState from '../../ui/EmptyState.svelte'
  import { notificationIssueSummary, subjectIcon, subjectKindLabel } from '../notification-view'
  import type { PrListAction } from '../pr-view'
  import type { CommitTreeNode } from '../git-status-panel-format'

  interface Props {
    activeTab: GitPanelTabId
    ovenTarget: unknown
    ovenError: string | null
    repoState: 'loading' | 'git_unavailable' | 'not_git' | 'git'
    preflightDetail: string
    scopeUnhealthy: boolean
    projectId: string
    threadId: string
    scopeBucketId: string
    conflictState: 'none' | 'merge' | 'rebase'
    conflicted: GitFileChange[]
    conflictRowAborts: boolean
    integrationActions: Snippet<[boolean?]>
    commitActions: Snippet<[GitCommitInfo, boolean]>
    status: GitStatus | null
    identityNeeded: boolean
    showIdentityForm: boolean
    identityName: string
    identityEmail: string
    changes: GitFileChange[]
    conflictSections: Array<{ title: string; files: GitFileChange[] }>
    stagedSections: Array<{ title: string; files: GitFileChange[] }>
    workingSections: Array<{ title: string; files: GitFileChange[] }>
    selectedCommit: GitCommitInfo | null
    commitDiffChanges: GitFileChange[]
    commitTree: CommitTreeNode
    commitTreeCollapsedDirs: Record<string, boolean>
    changesView: 'list' | 'tree'
    loadingCommitDiff: boolean
    diffs: Record<string, GitDiff>
    expanded: Record<string, boolean>
    loadingDiff: Record<string, boolean>
    diffErrors: Record<string, string | null>
    commitDiffs: Record<string, GitDiff>
    commitExpanded: Record<string, boolean>
    loadingCommitDiffFile: Record<string, boolean>
    commitDiffErrors: Record<string, string | null>
    selectedPaths: Record<string, boolean>
    paneClass: string
    commitHistory: GitCommitInfo[]
    loadingHistory: boolean
    loadingMoreHistory: boolean
    historyHasMore: boolean
    unpushedCount: number
    remoteUpdates: GitRemoteUpdate[]
    localBranches: GitBranchInfo[]
    worktreeBranches: GitBranchInfo[]
    localBranchNames: Set<string>
    creatingBranch: boolean
    newBranchName: string
    selectedPullRequest: PullRequestSummary | null
    prDetailTab: PrDetailTabId
    githubIdentity: { owner: string; repo: string } | null
    githubConnected: boolean
    prListState: PrState
    prListFilter: PrListFilter
    prListSort: PrListSort
    prListPage: number
    prListSelection: Record<number, boolean>
    openNotification: GitHubNotification | null
    notificationIdentity: { owner: string; repo: string } | null
    notificationPullRequest: PullRequestSummary | null
    notificationIssue: ReturnType<typeof notificationIssueSummary> | null
    onNotificationStackSelection: (selection: {
      notificationId: string
      pr: PullRequestSummary
    }) => void
    onNotificationStackSelectionReset: () => void
    selectedDeployment: GitHubDeployment | null
    selectedRun: GitHubWorkflowRun | null
    requestedWorkflowRunId: number | null
    selectedStash: GitStashEntry | null
    loadingStashDiff: boolean
    stashDiffChanges: GitFileChange[]
    stashDiffs: Record<string, GitDiff>
    loadingStashDiffFile: Record<string, boolean>
    stashDiffErrors: Record<string, string | null>
    stashExpanded: Record<string, boolean>
    stashOpBusy: boolean
    loadRepoState: (force?: boolean) => Promise<void>
    handleContentScroll: (event: Event) => void
    initializeRepository: () => Promise<void>
    refreshStatus: () => Promise<void>
    saveIdentity: () => Promise<void>
    toggleDiff: (change: GitFileChange) => Promise<void>
    toggleStage: (change: GitFileChange) => Promise<void>
    toggleSelection: (change: GitFileChange, additive: boolean) => void
    toggleSectionSelection: (files: GitFileChange[]) => void
    stagePathsAction: (paths: string[], staged: boolean) => Promise<void>
    requestStashFor: (paths: string[]) => void
    openInEditor: (path: string) => Promise<void>
    openDirectory: (path: string) => Promise<void>
    ignorePathsAction: (paths: string[]) => Promise<void>
    requestDiscard: (paths: string[]) => void
    routeConflictResolution: (initial?: string) => void
    restoreFromSource: (source: string, path: string, target: GitRestoreTarget) => Promise<void>
    toggleCommitDiff: (change: GitFileChange) => Promise<void>
    toggleCommitDir: (path: string) => void
    requestRemoveCommitChanges: (paths: string[]) => void
    selectCommit: (commit: GitCommitInfo) => Promise<void>
    createBranchAction: (name: string) => Promise<void>
    requestCheckout: (branch: GitBranchInfo) => void
    fetchBranchAction: (branch: GitBranchInfo) => Promise<void>
    requestDeleteBranch: (name: string) => void
    requestDeleteRemoteBranch: (branch: GitBranchInfo) => void
    openPullRequestFullscreen: (pr: PullRequestSummary | null) => void
    handlePrListAction: (action: PrListAction) => void
    selectPrListState: (next: PrState) => void
    selectPrListFilter: (next: PrListFilter) => void
    selectPrListSort: (next: PrListSort) => void
    selectPrListPage: (next: number) => void
    openCommitByHash: (hash: string) => Promise<void>
    openCommitFor: (identity: { owner: string; repo: string }, hash: string) => void
    openWorkflowRunFor: (identity: { owner: string; repo: string }, runId: number) => void
    isPanelRepository: (identity: { owner: string; repo: string } | null) => boolean
    startDeploymentDiagnosis: (
      deployment: GitHubDeployment,
      run: GitHubWorkflowRun | null,
      job: GitHubDeploymentJob,
      log: GitHubDeploymentJobLog | null
    ) => void
    selectStash: (stash: GitStashEntry) => Promise<void>
    toggleStashDiff: (change: GitFileChange) => Promise<void>
    popStash: (id?: string) => Promise<void>
    requestStashDrop: (stash: GitStashEntry) => void
    assignAgentToPullRequest: (pr: PullRequestSummary) => void
    openAgentThread: (threadId: string) => void
    resolveConflictsLocally: (pr: PullRequestSummary) => Promise<void>
    startConflictResolution: (pr: PullRequestSummary) => Promise<void>
  }

  let {
    activeTab,
    ovenTarget,
    ovenError,
    repoState,
    preflightDetail,
    scopeUnhealthy,
    projectId,
    threadId,
    scopeBucketId,
    conflictState,
    conflicted,
    conflictRowAborts,
    integrationActions,
    commitActions,
    status,
    identityNeeded,
    showIdentityForm = $bindable(),
    identityName = $bindable(),
    identityEmail = $bindable(),
    changes,
    conflictSections,
    stagedSections,
    workingSections,
    selectedCommit,
    commitDiffChanges,
    commitTree,
    commitTreeCollapsedDirs,
    changesView,
    loadingCommitDiff,
    diffs,
    expanded,
    loadingDiff,
    diffErrors,
    commitDiffs,
    commitExpanded,
    loadingCommitDiffFile,
    commitDiffErrors,
    selectedPaths = $bindable(),
    paneClass,
    commitHistory,
    loadingHistory,
    loadingMoreHistory,
    historyHasMore,
    unpushedCount,
    remoteUpdates,
    localBranches,
    worktreeBranches,
    localBranchNames,
    creatingBranch = $bindable(),
    newBranchName = $bindable(),
    selectedPullRequest = $bindable(),
    prDetailTab = $bindable(),
    githubIdentity,
    githubConnected,
    prListState,
    prListFilter,
    prListSort,
    prListPage,
    prListSelection = $bindable(),
    openNotification,
    notificationIdentity,
    notificationPullRequest,
    notificationIssue,
    onNotificationStackSelection,
    onNotificationStackSelectionReset,
    selectedDeployment = $bindable(),
    selectedRun = $bindable(),
    requestedWorkflowRunId = $bindable(),
    selectedStash,
    loadingStashDiff,
    stashDiffChanges,
    stashDiffs,
    loadingStashDiffFile,
    stashDiffErrors,
    stashExpanded,
    stashOpBusy,
    loadRepoState,
    handleContentScroll,
    initializeRepository,
    refreshStatus,
    saveIdentity,
    toggleDiff,
    toggleStage,
    toggleSelection,
    toggleSectionSelection,
    stagePathsAction,
    requestStashFor,
    openInEditor,
    openDirectory,
    ignorePathsAction,
    requestDiscard,
    routeConflictResolution,
    restoreFromSource,
    toggleCommitDiff,
    toggleCommitDir,
    requestRemoveCommitChanges,
    selectCommit,
    createBranchAction,
    requestCheckout,
    fetchBranchAction,
    requestDeleteBranch,
    requestDeleteRemoteBranch,
    openPullRequestFullscreen,
    handlePrListAction,
    selectPrListState,
    selectPrListFilter,
    selectPrListSort,
    selectPrListPage,
    openCommitByHash,
    openCommitFor,
    openWorkflowRunFor,
    isPanelRepository,
    startDeploymentDiagnosis,
    selectStash,
    toggleStashDiff,
    popStash,
    requestStashDrop,
    assignAgentToPullRequest,
    openAgentThread,
    resolveConflictsLocally,
    startConflictResolution
  }: Props = $props()
</script>

{#snippet pullRequestReader(
  readerIdentity: { owner: string; repo: string },
  summary: PullRequestSummary,
  onBack: () => void,
  fullscreen: (() => void) | undefined,
  onOpen: (pr: PullRequestSummary) => void
)}
  <GitPullRequestDetail
    {projectId}
    {threadId}
    identity={readerIdentity}
    {summary}
    bind:tab={prDetailTab}
    {onBack}
    onFullscreen={fullscreen}
    onOpenPullRequest={onOpen}
    onAssignAgent={(pr) => void assignAgentToPullRequest(pr)}
    onOpenThread={(id) => void openAgentThread(id)}
    onOpenWorkflowRun={(runId) => openWorkflowRunFor(readerIdentity, runId)}
    onOpenCommit={(hash) => openCommitFor(readerIdentity, hash)}
    onResolveLocally={isPanelRepository(readerIdentity)
      ? (pr) => void resolveConflictsLocally(pr)
      : undefined}
    onResolveWithAgent={isPanelRepository(readerIdentity)
      ? (pr) => startConflictResolution(pr)
      : undefined}
  />
{/snippet}

<OvenSurfaceOverlay
  active={Boolean(ovenTarget)}
  loading={gitState.isBusy('refresh')}
  showingCached={gitState.showingCachedStatus}
  error={ovenError}
  title="Git could not be read from the Oven"
  loadingLabel="Reading Git from the Oven…"
  onRetry={() => void loadRepoState(true)}
>
  <div class="min-h-0 flex-1 overflow-auto" onscroll={handleContentScroll}>
    {#if repoState === 'loading' || repoState === 'git_unavailable' || repoState === 'not_git'}
      <GitStatusPanelRepoStates
        {repoState}
        {preflightDetail}
        onInitialize={() => void initializeRepository()}
      />
    {:else}
      <GitStatusPanelNotices
        {scopeUnhealthy}
        {projectId}
        {scopeBucketId}
        {conflictState}
        {conflicted}
        {conflictRowAborts}
        {integrationActions}
        suppressError={Boolean(ovenError)}
        onRepaired={() => void refreshStatus()}
      />

      {#if identityNeeded}
        <div class="mx-2 mt-2 border border-border bg-surface px-3 py-2">
          <p class="text-[0.625rem] font-medium text-foreground">Commit identity not configured</p>
          {#if showIdentityForm}
            <div class="mt-2 space-y-1.5">
              <input
                class="h-7 w-full border border-border bg-elevated px-2 font-mono text-[0.6875rem] text-foreground outline-none placeholder:text-dimmed focus:border-primary"
                placeholder="Name"
                bind:value={identityName}
              />
              <input
                class="h-7 w-full border border-border bg-elevated px-2 font-mono text-[0.6875rem] text-foreground outline-none placeholder:text-dimmed focus:border-primary"
                placeholder="Email"
                type="email"
                bind:value={identityEmail}
              />
              <div class="flex items-center justify-end gap-1.5">
                <button
                  type="button"
                  class="px-2 py-1 text-[0.625rem] font-medium text-muted hover:bg-elevated"
                  onclick={() => (showIdentityForm = false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  class="bg-primary px-2.5 py-1 text-[0.625rem] font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
                  disabled={!identityName.trim() || !identityEmail.trim()}
                  onclick={() => void saveIdentity()}
                >
                  Save
                </button>
              </div>
            </div>
          {:else}
            <button
              type="button"
              class="mt-1.5 border border-border px-2 py-1 text-[0.625rem] font-medium text-muted hover:bg-elevated hover:text-foreground"
              onclick={() => {
                identityName = gitState.identity?.name ?? ''
                identityEmail = gitState.identity?.email ?? ''
                showIdentityForm = true
              }}
            >
              Set identity
            </button>
          {/if}
        </div>
      {/if}

      {#if activeTab === 'changes'}
        <GitStatusPanelChangesView
          {selectedCommit}
          {status}
          {changes}
          {conflictSections}
          {stagedSections}
          {workingSections}
          {commitDiffChanges}
          {commitTree}
          {commitTreeCollapsedDirs}
          {changesView}
          {loadingCommitDiff}
          {diffs}
          {expanded}
          {loadingDiff}
          {diffErrors}
          {commitDiffs}
          {commitExpanded}
          {loadingCommitDiffFile}
          {commitDiffErrors}
          bind:selectedPaths
          {paneClass}
          {toggleDiff}
          {toggleStage}
          {toggleSelection}
          {toggleSectionSelection}
          {stagePathsAction}
          {requestStashFor}
          {openInEditor}
          {openDirectory}
          {ignorePathsAction}
          {requestDiscard}
          {routeConflictResolution}
          {restoreFromSource}
          {toggleCommitDiff}
          {toggleCommitDir}
          {requestRemoveCommitChanges}
        />
      {:else if activeTab === 'history'}
        <GitGraphView
          commits={commitHistory}
          loading={loadingHistory}
          loadingMore={loadingMoreHistory}
          hasMore={historyHasMore}
          {unpushedCount}
          upstream={status?.upstream ?? null}
          {remoteUpdates}
          selectedHash={selectedCommit?.hash ?? null}
          onSelectCommit={(commit) => void selectCommit(commit)}
        >
          {#snippet menu({ commit, isHead }: { commit: GitCommitInfo; isHead: boolean })}
            {@render commitActions(commit, isHead)}
          {/snippet}
        </GitGraphView>
      {:else if activeTab === 'branches'}
        <GitStatusPanelBranchesView
          branches={gitState.branches}
          {localBranches}
          {worktreeBranches}
          {localBranchNames}
          bind:creatingBranch
          bind:newBranchName
          onCreateBranch={(name) => void createBranchAction(name)}
          onRequestCheckout={requestCheckout}
          onFetchBranch={(branch) => void fetchBranchAction(branch)}
          onRequestDeleteBranch={requestDeleteBranch}
          onRequestDeleteRemoteBranch={requestDeleteRemoteBranch}
        />
      {:else if activeTab === 'pulls'}
        <div class="h-full min-h-0">
          {#if selectedPullRequest && githubIdentity}
            {@render pullRequestReader(
              githubIdentity,
              selectedPullRequest,
              () => (selectedPullRequest = null),
              () => openPullRequestFullscreen(selectedPullRequest),
              (pr) => {
                selectedPullRequest = pr
                prDetailTab = 'conversation'
              }
            )}
          {:else}
            <!--
            The panel draws the filter and the actions for this list in its own
            rows, so the list renders rows and paging only (`showControls`).
          -->
            <GitPullRequestList
              {projectId}
              identity={githubIdentity}
              {githubConnected}
              state={prListState}
              filter={prListFilter}
              sort={prListSort}
              page={prListPage}
              showControls={false}
              selected={prListSelection}
              onSelectionChange={(next) => (prListSelection = next)}
              onAction={handlePrListAction}
              onStateChange={selectPrListState}
              onFilterChange={selectPrListFilter}
              onSortChange={selectPrListSort}
              onPageChange={selectPrListPage}
              onOpen={(pr) => (selectedPullRequest = pr)}
              onFullscreen={() => openPullRequestFullscreen(null)}
              onSignIn={() => githubSignIn.start()}
              onCreate={() => prLifecycleStore.open(projectId, threadId, scopeBucketId)}
            />
          {/if}
        </div>
      {:else if activeTab === 'issues'}
        <div class="h-full min-h-0">
          <GitIssuesView
            {projectId}
            {threadId}
            {scopeBucketId}
            identity={githubIdentity}
            {githubConnected}
            onSignIn={() => githubSignIn.start()}
            onOpenCommit={(hash) => void openCommitByHash(hash)}
          />
        </div>
      {:else if activeTab === 'notifications'}
        <div class="h-full min-h-0">
          {#if openNotification && notificationPullRequest && notificationIdentity}
            {@render pullRequestReader(
              notificationIdentity,
              notificationPullRequest,
              () => {
                onNotificationStackSelectionReset()
                githubNotifications.closeNotification()
              },
              undefined,
              (pr) => {
                if (openNotification)
                  onNotificationStackSelection({ notificationId: openNotification.id, pr })
              }
            )}
          {:else if openNotification && notificationIssue && notificationIdentity}
            <GitIssueReader
              {projectId}
              {threadId}
              {scopeBucketId}
              identity={notificationIdentity}
              issue={notificationIssue}
              localRepository={isPanelRepository(notificationIdentity)}
              onOpenCommit={(hash) => openCommitFor(notificationIdentity, hash)}
            />
          {:else if openNotification}
            <!--
              A kind the panel reads nowhere else: a commit, a release, a
              discussion, an alert. The notification's own facts are in the
              action row above, so this names what kind it is and leaves the
              thread itself to github.com rather than inventing a reader for it.
            -->
            <EmptyState
              icon={subjectIcon(openNotification.subjectType)}
              title={openNotification.title}
              description="The panel reads pull requests and issues in place. This is a {subjectKindLabel(
                openNotification.subjectType
              ).toLowerCase()}, which GitHub serves on github.com."
            >
              {#snippet action()}
                <button
                  type="button"
                  class="cursor-pointer bg-primary px-3 py-1 text-[0.6875rem] font-medium text-on-primary transition-colors hover:opacity-90"
                  data-external-url={openNotification.url ?? ''}
                  onclick={() => void openInBrowser(openNotification?.url ?? '')}
                >
                  Open on GitHub
                </button>
              {/snippet}
            </EmptyState>
          {:else}
            <GitNotificationsPanel {githubConnected} onSignIn={() => githubSignIn.start()} />
          {/if}
        </div>
      {:else if activeTab === 'deployments'}
        <GitDeploymentsMonitor
          {projectId}
          identity={githubIdentity}
          {githubConnected}
          bind:selectedDeployment
          bind:selectedRun
          onSignIn={() => githubSignIn.start()}
          requestedRunId={requestedWorkflowRunId}
          onRequestedRunOpened={() => (requestedWorkflowRunId = null)}
          onAgentDiagnoseDeployment={startDeploymentDiagnosis}
        />
      {:else if activeTab === 'stashes'}
        <GitStatusPanelStashesView
          {selectedStash}
          {loadingStashDiff}
          {stashDiffChanges}
          {stashDiffs}
          {loadingStashDiffFile}
          {stashDiffErrors}
          {stashExpanded}
          stashes={gitState.stashes}
          {stashOpBusy}
          stashPopBusy={gitState.isBusy('stash-pop')}
          onSelectStash={(stash) => void selectStash(stash)}
          onToggleStashDiff={(change) => void toggleStashDiff(change)}
          onRestore={(path, target) =>
            void restoreFromSource(selectedStash?.id ?? 'HEAD', path, target)}
          onPopStash={(id) => void popStash(id)}
          onRequestStashDrop={requestStashDrop}
        />
      {/if}
    {/if}
  </div>
</OvenSurfaceOverlay>
