import CioArchive from '@pdslng/cio-icon/CioArchive.svelte'
import CioDiff from '@pdslng/cio-icon/CioDiff.svelte'
import CioDot from '@pdslng/cio-icon/CioDot.svelte'
import CioNetwork from '@pdslng/cio-icon/CioNetwork.svelte'
import CioNotifications from '@pdslng/cio-icon/CioNotifications.svelte'
import CioPullRequest from '@pdslng/cio-icon/CioPullRequest.svelte'
import CioRocket from '@pdslng/cio-icon/CioRocket.svelte'
import CioTabGit from '@pdslng/cio-icon/CioTabGit.svelte'
import CioUndo from '@pdslng/cio-icon/CioUndo.svelte'
import { copyText } from '$lib/copy-text'
import { openInBrowser } from '$lib/open-in-browser'
import { gitState, GitState } from '$lib/stores/git.svelte'
import { githubNotifications } from '$lib/stores/github-notifications.svelte'
import { cacheHasDeployments } from '$lib/git-deployments-cache'
import {
  diagnoseDeployment,
  preparePrConflictSession,
  resolvePrConflictsWithAgent
} from '../git-status-panel-agent-actions'
import type {
  GitCommitInfo,
  GitFileChange,
  GitHubDeployment,
  GitHubDeploymentJob,
  GitHubDeploymentJobLog,
  GitHubWorkflowRun
} from '$shared/types'
import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
import { GitStatusPanelFindController } from '../GitStatusPanel/git-status-panel-find-controller.svelte'
import { GitStatusPanelStashesController } from '../GitStatusPanel/git-status-panel-stashes-controller.svelte'
import { GitStatusPanelChangesController } from '../GitStatusPanel/git-status-panel-changes-controller.svelte'
import { gitFindScopeFor } from '../git-panel-find'
import { prSummaryChatContext, prSummaryExplainPrompt } from '../git-status-panel-prompts'
import { type PrListAction } from '../pr-view'
import { type GitPanelTabId } from '$lib/stores/git-panel-view.svelte'
import { findNavState } from '$lib/stores/find-nav.svelte'
import { prBatchJobs } from '$lib/stores/pr-batch-jobs.svelte'
import { threadSettings } from '$lib/stores/thread-settings.svelte'
import { githubDisplayLogin } from '$lib/format/github-login'
import type { PrMergeMethod, PullRequestSummary } from '$shared/types'
import type { GitStatusPanel } from './GitStatusPanel-board.svelte'
import { gitPanelView } from '$lib/stores/git-panel-view.svelte'
import type { GitStatusPanelConfirmAcceptAllConflicts } from './GitStatusPanel-confirm-accept-all-conflicts.svelte'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the GitStatusPanel board. */
export class GitStatusPanelHandlePrListAction extends BoardUnit<GitStatusPanel> {
  constructor(root: GitStatusPanel) {
    super(root)
  }

  /** Builds the stashes controller once the units it reads are there. */
  private createStashes(): GitStatusPanelStashesController {
    // The accessors below live on an object literal, where `this` is the literal,
    // so the unit is captured under a name the accessors can close over. This is
    // the one place an alias of `this` is the point rather than an accident.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const host = this
    const root = host.root
    return new GitStatusPanelStashesController({
      get projectId() {
        return root.props.projectId
      },
      get activeTab() {
        return host.activeTab
      },
      setActiveTab: (id) => (host.activeTab = id),
      refreshStatus: () => host.refreshStatus(),
      reloadHistory: () => host.reloadHistory()
    })
  }

  /** Builds the workingTree controller once the units it reads are there. */
  private createWorkingTree(): GitStatusPanelChangesController {
    // The accessors below live on an object literal, where `this` is the literal,
    // so the unit is captured under a name the accessors can close over. This is
    // the one place an alias of `this` is the point rather than an accident.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const host = this
    const root = host.root
    return new GitStatusPanelChangesController({
      get projectId() {
        return root.props.projectId
      },
      get changes() {
        return root.loadRepoState.changes
      },
      get staged() {
        return root.loadRepoState.staged
      },
      refreshStatus: () => host.refreshStatus(),
      requestCommitMessageFocus: () => (root.confirmAcceptAllConflicts.commitSelection = true)
    })
  }

  /** Builds the find controller once the units it reads are there. */
  private createFind(): GitStatusPanelFindController {
    // The accessors below live on an object literal, where `this` is the literal,
    // so the unit is captured under a name the accessors can close over. This is
    // the one place an alias of `this` is the point rather than an accident.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const host = this
    const root = host.root
    return new GitStatusPanelFindController({
      get projectId() {
        return root.props.projectId
      },
      get activeTab() {
        return host.activeTab
      },
      get githubIdentity() {
        return host.githubIdentity
      },
      get prListState() {
        return root.confirmPrMerge.prListState
      },
      openCommit: (commit) => void host.selectCommit(commit),
      requestCheckout: (branch) => root.loadRepoState.branches.requestCheckout(branch),
      openPullRequest: (pr) => {
        host.selectedPullRequest = pr
        root.confirmAcceptAllConflicts.prDetailTab = 'conversation'
      },
      openRun: (run) => {
        host.selectedRun = run
        host.selectedDeployment = null
      },
      openDeployment: (deployment) => {
        host.selectedDeployment = deployment
        host.selectedRun = null
      },
      openStash: (stash) => void host.stashes.selectStash(stash)
    })
  }

  /** Reads the view the panel was left on, once the board is bound. */
  bindSavedView(): void {
    this.savedView = this.root.confirmAcceptAllConflicts.initialViewState()
  }

  /** Builds the controllers that read sibling units. */
  bindControllers(): void {
    this.find = this.createFind()
    this.workingTree = this.createWorkingTree()
    this.stashes = this.createStashes()
  }
  /**
   * The Find bar's own state and answers. The panel supplies where a result
   * opens; the bar stays a reader of results rather than a second navigator.
   */
  /** Set by `bind()`: built from siblings that do not exist at field time. */
  find!: GitStatusPanelFindController

  /** The working tree: the diffs, the selection, and the index edits. */
  /** Set by `bind()`: built from siblings that do not exist at field time. */
  workingTree!: GitStatusPanelChangesController

  /** The Stashes view: the stash being read, its file diffs, and the list edits. */
  /** Set by `bind()`: built from siblings that do not exist at field time. */
  stashes!: GitStatusPanelStashesController

  /** Set by `bind()`: the view the panel was left on. */
  savedView: ReturnType<GitStatusPanelConfirmAcceptAllConflicts['initialViewState']> =
    gitPanelView.get('', '')

  activeTab = $state<GitPanelTabId>(this.savedView.activeTab)

  commitMessage = $state('')

  selectedCommit = $state<GitCommitInfo | null>(this.savedView.selectedCommit)

  commitDiffChanges = $state<GitFileChange[]>([])

  deleteCommitTarget = $state<GitCommitInfo | null>(null)

  /** Commit whose full record is open in the info dialog. */
  commitInfoTarget = $state<GitCommitInfo | null>(null)

  selectedPullRequest = $state<PullRequestSummary | null>(this.savedView.selectedPullRequest)

  /**
   * The lifecycle batch waiting on its confirmation. It is only ever the pending
   * question: the run itself leaves as a background job (`prBatchJobs`), so nothing
   * here holds the window while twenty pull requests are written.
   */
  prBatch = $state<{ mode: 'close' | 'reopen'; targets: PullRequestSummary[] } | null>(null)

  githubConnected = $derived(this.root.confirmPrMerge.githubStatus?.connected === true)

  /** Re-entrancy guard for the background deployment probe (not rendered). */
  detectingDeployments = false

  amendMode = $state(false)

  /**
   * The deployment or workflow run open in the Deploys view. The panel owns the
   * selection, like every other view's, so its action row can name what is open
   * and its external link can follow it.
   */
  selectedDeployment = $state<GitHubDeployment | null>(null)

  selectedRun = $state<GitHubWorkflowRun | null>(null)

  /** Force a reload of whatever the active view shows, when the store has it. */
  async refreshFocusedView(): Promise<void> {
    if (this.activeTab === 'notifications') {
      // Notifications are account-wide, so the panel's refresh button reloads
      // them from GitHub as the active account, the same way it refreshes every
      // other view.
      if (this.githubConnected) await githubNotifications.load()
      return
    }
    const identity = this.githubIdentity
    if (!identity || !this.githubConnected) return
    if (this.activeTab === 'pulls') {
      if (this.selectedPullRequest) {
        await gitState.ensurePullRequestBundle(
          this.root.props.projectId,
          identity.owner,
          identity.repo,
          this.selectedPullRequest.number,
          true
        )
        return
      }
      await gitState.ensurePullRequestPage(
        this.root.props.projectId,
        identity.owner,
        identity.repo,
        this.root.confirmPrMerge.prListState,
        this.root.confirmPrMerge.prListPage,
        {
          filter: this.root.confirmPrMerge.prListFilter,
          sort: this.root.confirmPrMerge.prListSort
        },
        true
      )
      return
    }
    if (this.activeTab === 'deployments') {
      // The view's page and filter live in the view, so the store re-reads the
      // pages it holds for this repository instead: one per view in practice.
      await gitState.refreshDeploymentPages(
        this.root.props.projectId,
        identity.owner,
        identity.repo
      )
    }
  }

  async refreshStatus(): Promise<void> {
    gitState.ensureProjectEvents(this.root.props.projectId)
    await gitState.refresh(this.root.props.projectId)
    // The refresh button must bring the whole panel up to date, including the
    // History tab   its pages are cached client-side and would otherwise keep
    // showing stale commits until a mutation happens to reload them.
    if (this.activeTab === 'history' || this.root.loadRepoState.commitHistory.length > 0)
      await this.reloadHistory()
  }

  /**
   * Discover whether the repo has GitHub deployment activity so the Deployments
   * tab can appear on its own. Only meaningful while signed in with a GitHub
   * origin remote, and only the fact is asked for: the view reads its own pages
   * when it opens, so the probe must not pay for a listing it will not show.
   */
  async detectDeployments(): Promise<void> {
    const identity = this.githubIdentity
    if (!this.githubConnected || !identity || this.detectingDeployments) return
    this.detectingDeployments = true
    try {
      const hasActivity = await gitState.ensureDeploymentActivity(
        this.root.props.projectId,
        identity.owner,
        identity.repo
      )
      if (hasActivity !== null) {
        this.root.loadRepoState.hasDeployments = hasActivity
        cacheHasDeployments(this.root.props.projectId, hasActivity)
      }
    } catch {
      // Sign-in or network failure   keep the current flag and try again later.
    } finally {
      this.detectingDeployments = false
    }
  }

  /**
   * Review the open run's failed job.
   *
   * The job's own log is read first so the agent opens with the evidence rather
   * than a request to fetch it again.
   */
  async reviewOpenRunFailedJob(): Promise<void> {
    const run = this.selectedRun
    const identity = this.githubIdentity
    const job = this.root.confirmPrMerge.openRunFailedJob
    if (!run || !identity || !job || this.preparingRunDiagnosis) return
    this.preparingRunDiagnosis = true
    try {
      const log = await gitState
        .ensureDeploymentJobLog(this.root.props.projectId, identity.owner, identity.repo, job.id)
        .catch(() => null)
      this.root.confirmPrMerge.startWorkflowDiagnosis(
        gitState.deploymentRunDetails[
          GitState.workflowRunKey(identity.owner, identity.repo, run.id)
        ]?.detail.run ?? run,
        job,
        log
      )
    } finally {
      this.preparingRunDiagnosis = false
    }
  }

  /** Route a failed deployment job to a fresh diagnosis thread. */
  startDeploymentDiagnosis(
    deployment: GitHubDeployment,
    run: GitHubWorkflowRun | null,
    job: GitHubDeploymentJob,
    log: GitHubDeploymentJobLog | null
  ): void {
    diagnoseDeployment(
      this.root.props.projectId,
      this.githubIdentity?.owner ?? '',
      this.githubIdentity?.repo ?? '',
      deployment,
      run,
      job,
      log
    )
  }

  /**
   * Resolve a PR's online conflicts manually: check out the PR head locally,
   * merge the base in, and hand the resulting conflicts to the changes-tab
   * conflict UI so the user can fix each file, commit, and push.
   */
  async resolveConflictsLocally(pr: PullRequestSummary): Promise<void> {
    const prepared = await preparePrConflictSession(
      this.root.props.projectId,
      pr,
      this.root.loadRepoState.primaryRemote?.name ?? 'origin',
      gitState.status?.branch ?? 'main'
    )
    if (!prepared) return
    this.selectedPullRequest = null
    this.activeTab = 'changes'
    void this.refreshStatus()
  }

  /**
   * Resolve a PR's online conflicts with the agent's help: check out the PR head
   * and merge the base in (so conflicts land in the tree), then hand the agent a
   * thread to resolve the conflict markers. The agent never pushes   the user
   * finishes with Complete merge, which pushes the resolution to the PR and
   * deletes the temporary branch.
   */
  async startConflictResolution(pr: PullRequestSummary): Promise<void> {
    await resolvePrConflictsWithAgent(
      this.root.props.projectId,
      pr,
      this.root.props.scopeBucketId,
      this.root.loadRepoState.primaryRemote?.name ?? 'origin',
      gitState.status?.branch ?? 'main',
      () => {
        this.selectedPullRequest = null
        this.activeTab = 'changes'
      }
    )
  }

  /** Switch the panel's view. History is the one view that pages its data in. */
  selectTab(id: GitPanelTabId): void {
    // The find bar follows the view, so a subject change drops the answers that
    // belonged to the old one while leaving the bar open if it was open.
    const subjectChanged = gitFindScopeFor(id) !== this.find.scope
    this.activeTab = id
    if (subjectChanged && findNavState.gitFindOpen) this.find.resetResults()
    if (id === 'history') void this.root.loadRepoState.loadHistory()
    // Notifications arrive from GitHub rather than the repository, so the view
    // asks for its own data the first time it is shown.
    if (id === 'notifications') void githubNotifications.ensureLoaded()
  }

  /**
   * Where a pull request list action becomes something real.
   *
   * The list hands over one action plus the rows it applies to and knows nothing
   * else, which is what keeps the two mounts of the list identical and keeps every
   * confirmation, picker, and batch in the panel that owns the state behind them.
   */
  handlePrListAction(action: PrListAction): void {
    if (action.kind === 'open') {
      const target = action.targets[0]
      if (target) this.selectedPullRequest = target
      return
    }
    if (action.kind === 'open-in-browser') {
      const target = action.targets[0]
      if (target) void openInBrowser(target.url)
      return
    }
    if (action.kind === 'copy-links' || action.kind === 'copy-branches') {
      const text = action.targets
        .map((target) => (action.kind === 'copy-links' ? target.url : target.headRef))
        .join('\n')
      void copyText(text).catch(() => undefined)
      return
    }
    if (action.kind === 'close' || action.kind === 'reopen') {
      if (action.targets.length === 0) return
      this.prBatch = { mode: action.kind, targets: action.targets }
      return
    }
    const target = action.targets[0]
    if (!target) return
    if (action.kind === 'explain' || action.kind === 'quick-chat') {
      this.openPrChat(target, action.kind === 'explain' ? 'explain' : 'quick')
      return
    }
    if (action.kind === 'assign-agent') {
      this.root.confirmAcceptAllConflicts.assignAgentToPullRequest(target)
      return
    }
    if (action.kind === 'open-agent-thread') {
      this.root.confirmAcceptAllConflicts.openAgentThread(action.threadId)
      return
    }
    if (action.kind === 'mark-ready') {
      void this.markPrReady(target)
      return
    }
    if (action.kind === 'merge') {
      this.openPrMerge(target, action.method)
      return
    }
    this.root.confirmAcceptAllConflicts.prMetadata = { pr: target, mode: action.kind }
  }

  confirmPrBatch(comment: string | null): void {
    const pending = this.prBatch
    if (!pending || !this.githubIdentity) return
    prBatchJobs.start({
      projectId: this.root.props.projectId,
      owner: this.githubIdentity.owner,
      repo: this.githubIdentity.repo,
      mode: pending.mode,
      targets: pending.targets,
      comment
    })
    this.prBatch = null
    // The selection has been acted on, so it goes with the batch rather than
    // inviting a second close of the same rows.
    this.root.confirmPrMerge.prListSelection = {}
  }

  /**
   * Anchor a read-only side chat on one pull request, the same panel the comment
   * actions open.
   *
   * The visible row is the selection and the pull request's own facts are the
   * pinned context, because a list row carries no transcript to ride and no diff to
   * quote. That gap is named in the context rather than papered over, so the agent
   * says what it cannot see instead of guessing.
   */
  openPrChat(pr: PullRequestSummary, mode: 'explain' | 'quick'): void {
    const identity = this.githubIdentity
    if (!identity) return
    contextSidebarState.openTemporaryChat(
      this.root.props.projectId,
      this.root.props.threadId,
      mode === 'explain' ? 'elaborate' : 'quick',
      [
        `#${pr.number} ${pr.title}`,
        `by ${githubDisplayLogin(pr.authorLogin)} · ${pr.headRef} → ${pr.baseRef}`,
        pr.url
      ].join('\n'),
      prSummaryChatContext(pr, `${identity.owner}/${identity.repo}`),
      threadSettings.lastUsed,
      true,
      mode === 'explain' ? prSummaryExplainPrompt(pr) : undefined
    )
  }

  async markPrReady(pr: PullRequestSummary): Promise<void> {
    const identity = this.githubIdentity
    if (!identity) return
    await gitState.markPullRequestReadyForReview(
      this.root.props.projectId,
      identity.owner,
      identity.repo,
      pr.number
    )
  }

  /**
   * Open the merge confirmation with the method the row menu chose.
   *
   * The title is seeded the way GitHub seeds it and the message is left empty: the
   * list never fetched the pull request body, and an empty message is what tells
   * GitHub to keep its own. Both are then the user's to edit before merging.
   */
  openPrMerge(pr: PullRequestSummary, method: PrMergeMethod): void {
    this.root.confirmPrMerge.prMergeTitle =
      method === 'merge' ? `Merge pull request #${pr.number} from ${pr.headRef}` : pr.title
    this.root.confirmPrMerge.prMergeMessage = ''
    this.root.confirmPrMerge.prMerge = { pr, method }
    this.root.confirmPrMerge.prMergeOpen = true
  }

  async selectCommit(commit: GitCommitInfo): Promise<void> {
    this.selectedCommit = commit
    this.activeTab = 'changes'
    // The selection belongs to the commit that was open, never to the next one.
    this.workingTree.clearSelection()
    this.root.confirmAcceptAllConflicts.loadingCommitDiff = true
    this.commitDiffChanges = await gitState.getCommitDiff(this.root.props.projectId, commit.hash)
    this.root.confirmPrMerge.commitDiffs = {}
    this.root.confirmPrMerge.commitExpanded = {}
    this.root.confirmPrMerge.loadingCommitDiffFile = {}
    this.root.confirmPrMerge.commitDiffErrors = {}
    this.root.confirmAcceptAllConflicts.commitTreeCollapsedDirs = {}
    this.root.confirmAcceptAllConflicts.loadingCommitDiff = false
  }

  clearSelectedCommit(): void {
    this.selectedCommit = null
    this.workingTree.clearSelection()
    this.commitDiffChanges = []
    this.root.confirmPrMerge.commitDiffs = {}
    this.root.confirmPrMerge.commitExpanded = {}
    this.root.confirmPrMerge.loadingCommitDiffFile = {}
    this.root.confirmPrMerge.commitDiffErrors = {}
  }

  startAmend(): void {
    const commit = this.selectedCommit
    if (!commit) return
    this.commitMessage = commit.message.split('\n')[0]
    this.amendMode = true
    this.clearSelectedCommit()
    this.activeTab = 'changes'
  }

  async confirmDeleteCommit(): Promise<void> {
    const target = this.deleteCommitTarget
    if (!target) return
    this.deleteCommitTarget = null
    await gitState.deleteCommit(this.root.props.projectId, target.hash)
    if (!gitState.error) {
      this.clearSelectedCommit()
      void this.reloadHistory()
      void this.refreshStatus()
    }
  }

  async confirmRemoveCommitChanges(): Promise<void> {
    const pending = this.root.confirmAcceptAllConflicts.removeCommitChangesConfirm
    if (!pending) return
    this.root.confirmAcceptAllConflicts.removeCommitChangesConfirm = null
    await gitState.removeCommitChanges(this.root.props.projectId, pending.hash, pending.paths)
    if (gitState.error) return
    // The commit that was open carries a new hash now, so its diff describes a
    // commit that no longer exists: leave the rewritten history in History
    // rather than an inspector pinned to a hash that is gone.
    this.clearSelectedCommit()
    void this.reloadHistory()
    void this.refreshStatus()
  }

  async confirmReset(): Promise<void> {
    const pending = this.root.confirmPrMerge.resetConfirm
    if (!pending) return
    this.root.confirmPrMerge.resetConfirm = null
    await gitState.reset(this.root.props.projectId, pending.mode, pending.target)
    if (!gitState.error) {
      this.clearSelectedCommit()
      void this.reloadHistory()
      void this.refreshStatus()
    }
  }

  async commitInline(): Promise<void> {
    if (!this.commitMessage.trim()) return
    if (this.amendMode) {
      await gitState.amend(this.root.props.projectId, this.commitMessage)
    } else {
      if (this.root.loadRepoState.staged.length === 0) return
      await gitState.commit(this.root.props.projectId, this.commitMessage)
    }
    if (!gitState.error) {
      this.commitMessage = ''
      this.amendMode = false
      // The committed files have left the panel   drop their selection so the
      // "N selected" counter next to "Stage all" doesn't point at ghosts.
      this.workingTree.clearSelection()
      void this.refreshStatus()
      void this.reloadHistory()
    }
  }

  async reloadHistory(): Promise<void> {
    this.root.loadRepoState.commitHistory = []
    this.root.loadRepoState.historyHasMore = true
    await this.root.loadRepoState.loadHistory()
  }

  /**
   * Swap to another scope bucket (a sibling worktree) without remounting:
   * clear every piece of view state scoped to the previous bucket so its
   * changes, commits, stashes and pending dialogs can never bleed into the
   * new target, then refetch. Repo availability checks and GitHub auth stay
   * untouched   they belong to the project, not the bucket   which is what
   * keeps scoped thread switches free of a full loading flash.
   */
  resetForScopeSwap(): void {
    this.root.loadRepoState.historyRequestId += 1
    this.root.confirmPrMerge.remoteUpdatesRequestId += 1
    this.root.confirmPrMerge.remoteUpdates = []
    this.find.close()
    this.selectedCommit = null
    this.amendMode = false
    this.root.confirmAcceptAllConflicts.commitSelection = false
    this.commitDiffChanges = []
    this.root.confirmPrMerge.commitDiffs = {}
    this.root.confirmPrMerge.commitExpanded = {}
    this.root.confirmAcceptAllConflicts.loadingCommitDiff = false
    this.root.confirmPrMerge.loadingCommitDiffFile = {}
    this.root.confirmPrMerge.commitDiffErrors = {}
    this.root.confirmAcceptAllConflicts.commitTreeCollapsedDirs = {}
    this.deleteCommitTarget = null
    this.stashes.resetForScopeSwap()
    this.root.confirmPrMerge.pendingOperation = null
    this.root.loadRepoState.branches.resetForScopeSwap()
    this.root.confirmPrMerge.resetConfirm = null
    this.root.loadRepoState.pushConfirm = false
    this.root.loadRepoState.pushDiverged = false
    this.root.loadRepoState.pushRecoverMode = null
    this.root.loadRepoState.pullStrategyOpen = false
    this.root.confirmPrMerge.syncMainOpen = false
    this.root.confirmPrMerge.showIntegrateModal = false
    void this.refreshStatus()
    void this.reloadHistory()
  }

  /** `owner/repo` when origin points at GitHub   the PR tab needs it to query. */
  githubIdentity = $derived.by(() => {
    const url = this.root.confirmAcceptAllConflicts.primaryRemoteUrl
    const match = /(?:github\.com[:/])([^/]+)\/([^/.]+)(?:\.git)?\/?$/u.exec(url.trim())
    const owner = match?.[1] ?? ''
    const repo = match?.[2] ?? ''
    return owner && repo ? { owner, repo } : null
  })

  commitInfoUrl = $derived(
    this.githubIdentity && this.commitInfoTarget
      ? `https://github.com/${encodeURIComponent(this.githubIdentity.owner)}/${encodeURIComponent(this.githubIdentity.repo)}/commit/${this.commitInfoTarget.hash}`
      : null
  )

  /** Opens the failed job's review thread: true while its log is being read. */
  preparingRunDiagnosis = $state(false)

  /**
   * Where the Deploys view's external link points: the deployment page, the run,
   * or the repository's Actions when neither is open. It replaces the per-view
   * external buttons the detail pages used to carry.
   */
  deploymentsExternal = $derived.by(() => {
    const identity = this.githubIdentity
    if (!identity) return null
    const repository = `https://github.com/${identity.owner}/${identity.repo}`
    if (this.selectedDeployment) {
      return {
        url: `${repository}/deployments/${String(this.selectedDeployment.id)}`,
        title: 'Open this deployment on GitHub'
      }
    }
    if (this.selectedRun?.url) {
      return { url: this.selectedRun.url, title: 'Open this workflow run on GitHub' }
    }
    return { url: `${repository}/actions`, title: 'View these workflow runs on GitHub' }
  })

  /**
   * The reader's views with their counts, for the switcher in the action row. The
   * counts come from the same bundle the reader renders, so the switcher and the
   * rail agree.
   */
  prDetailViews = $derived(
    this.root.confirmPrMerge.prDetailViewsFor(
      this.root.confirmPrMerge.pullRequestBundleFor(this.githubIdentity, this.selectedPullRequest),
      this.selectedPullRequest
    )
  )

  /**
   * Whether a repository is the one this panel stands in.
   *
   * The panel's own operations   checking a pull request out to resolve it here,
   * reading one of its commits, revealing one of its workflow runs   all act on the
   * local checkout, so a thread from anywhere else takes the github.com route
   * instead of pointing the local view at somebody else's repository.
   */
  isPanelRepository(identity: { owner: string; repo: string } | null): boolean {
    return (
      identity !== null &&
      this.githubIdentity !== null &&
      identity.owner === this.githubIdentity.owner &&
      identity.repo === this.githubIdentity.repo
    )
  }

  /**
   * The row under the header belongs to the view in focus: the commit or stash
   * being read, the pull request's identity and views, the PR list's filter, the
   * deployment being read, the staging controls, or the remote actions. It exists
   * only while at least one of those has something to say, so the common case is
   * still one line.
   */
  showsViewContext = $derived(
    (this.activeTab === 'changes' &&
      (this.selectedCommit !== null ||
        (this.root.loadRepoState.status !== null && this.root.loadRepoState.showsStageControls))) ||
      (this.activeTab === 'pulls' && this.githubConnected && this.githubIdentity !== null) ||
      (this.activeTab === 'notifications' && this.root.confirmPrMerge.openNotification !== null) ||
      (this.activeTab === 'deployments' &&
        (this.selectedDeployment !== null || this.selectedRun !== null)) ||
      (this.activeTab === 'stashes' && this.stashes.selectedStash !== null)
  )

  tabs: Array<{
    id: GitPanelTabId
    label: string
    icon: typeof CioTabGit
    count: number | null
  }> = $derived.by(() => {
    const list: Array<{
      id: GitPanelTabId
      label: string
      icon: typeof CioTabGit
      count: number | null
    }> = [
      {
        id: 'changes',
        label: 'Changes',
        icon: CioDiff,
        count:
          this.root.loadRepoState.changes.length > 0 ? this.root.loadRepoState.changes.length : null
      },
      { id: 'history', label: 'History', icon: CioUndo, count: null },
      { id: 'branches', label: 'Branches', icon: CioNetwork, count: null },
      { id: 'pulls', label: 'PRs', icon: CioPullRequest, count: null },
      { id: 'issues', label: 'Issues', icon: CioDot, count: null }
    ]
    // Notifications are account-wide, so the view earns a place only once a
    // GitHub account is signed in. Its badge is the unread count of what the
    // panel has loaded, since GitHub has no total-count endpoint.
    if (this.githubConnected) {
      list.push({
        id: 'notifications',
        label: 'Notifications',
        icon: CioNotifications,
        count: githubNotifications.counts.inbox > 0 ? githubNotifications.counts.inbox : null
      })
    }
    // Stash is just shelved work   it earns a tab only once something is shelved.
    if (gitState.stashes.length > 0) {
      list.push({
        id: 'stashes',
        label: 'Stashes',
        icon: CioArchive,
        count: gitState.stashes.length
      })
    }
    // Deployments earn a view only when the repo actually has deployment
    // activity (the flag is persisted in the DB and cached in localStorage).
    // While the panel is *on* that view the entry stays, so a cold cache cannot
    // leave the trigger naming a view the row is no longer showing.
    if (this.root.loadRepoState.hasDeployments === true || this.activeTab === 'deployments') {
      list.push({ id: 'deployments', label: 'Deploys', icon: CioRocket, count: null })
    }
    return list
  })
}
