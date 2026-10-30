import { openInBrowser } from '$lib/open-in-browser'
import {
  invalidateRepositoryPreflight,
  loadRepositoryPreflight
} from '$lib/repository-preflight-cache'
import { appConfigState } from '$lib/stores/app-config.svelte'
import { gitState } from '$lib/stores/git.svelte'
import { cacheHasDeployments } from '$lib/git-deployments-cache'
import { resolveCurrentConflictsWithAgent } from '../git-status-panel-agent-actions'
import type { GitCommitInfo, GitFileChange, GitPullStrategy } from '$shared/types'
import { toast } from 'svelte-sonner'
import { GitStatusPanelBranchesController } from '../GitStatusPanel/git-status-panel-branches-controller.svelte'
import { gitPullJobs } from '$lib/stores/git-pull-jobs.svelte'
import type { RepoState, WorktreeState } from './GitStatusPanel-types'
import type { GitStatusPanel } from './GitStatusPanel-board.svelte'
import { SvelteSet } from 'svelte/reactivity'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the GitStatusPanel board. */
export class GitStatusPanelLoadRepoState extends BoardUnit<GitStatusPanel> {
  constructor(root: GitStatusPanel) {
    super(root)
  }

  /** Builds the branches controller once the units it reads are there. */
  private createBranches(): GitStatusPanelBranchesController {
    // The accessors below live on an object literal, where `this` is the literal,
    // so the unit is captured under a name they can close over.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const host = this
    const root = host.root
    return new GitStatusPanelBranchesController({
      get projectId() {
        return root.props.projectId
      },
      get status() {
        return host.status
      },
      get localBranchNames() {
        return root.confirmAcceptAllConflicts.localBranchNames
      }
    })
  }

  /** Builds the controllers that read sibling units. */
  bindControllers(): void {
    this.branches = this.createBranches()
  }
  /**
   * The Branches view's state and operations, including the confirmations a
   * checkout and a delete ask for before they touch the working tree.
   */
  /** Set by `bind()`: built from a sibling that does not exist at field time. */
  branches!: GitStatusPanelBranchesController

  /**
   * Why the repository check itself failed, or null.
   *
   * A preflight that never answered leaves the working-tree read with nothing
   * to report from, so this carries the reason for the remote case; a local
   * project keeps its existing "not a repository" answer.
   */
  preflightError = $state<string | null>(null)

  repoState = $state<RepoState>('loading')

  pushConfirm = $state(false)

  /** Pull strategy chooser, opened by the default `ask` preference. */
  pullStrategyOpen = $state(false)

  /** Divergence recovery dialog: the branch is behind the remote, push was rejected. */
  pushDiverged = $state(false)

  /** Which recovery action is running ('merge' | 'rebase'), to disable the buttons. */
  pushRecoverMode = $state<'merge' | 'rebase' | null>(null)

  commitHistory = $state<GitCommitInfo[]>([])

  loadingHistory = $state(false)

  loadingMoreHistory = $state(false)

  /** Invalidated whenever the panel swaps scope buckets, so a history page
   *  fetched for the previous worktree can never land in the new one's list. */
  historyRequestId = 0

  /** False once a page comes back shorter than requested   there's nothing older left. */
  historyHasMore = $state(true)

  HISTORY_PAGE_SIZE = 30

  /**
   * Whether the repo has GitHub deployments, which gates the Deployments view.
   * Null means "not read yet": the cache and the project row are both read
   * asynchronously, and treating that as "no deployments" threw a reader out of
   * the Deployments view whenever the panel remounted on a cold cache.
   */
  hasDeployments = $state<boolean | null>(null)

  status = $derived(gitState.status)

  changes = $derived(this.status?.changes ?? [])

  staged = $derived(
    this.changes.filter((change) => change.staged && change.status !== 'conflicted')
  )

  unstaged = $derived(
    this.changes.filter(
      (change) => !change.staged && change.status !== 'untracked' && change.status !== 'conflicted'
    )
  )

  untracked = $derived(this.changes.filter((change) => change.status === 'untracked'))

  conflicted = $derived(this.changes.filter((change) => change.status === 'conflicted'))

  /** Local commits not yet on the upstream remote, oldest-first-among-them   matches history order. */
  unpushedCount = $derived(this.status?.upstream ? Math.max(0, this.status.ahead) : 0)

  /**
   * The refresh button: the view in focus, then the repository behind it.
   *
   * The view's reload goes through the store rather than through a signal the
   * view watches. A view that watched a signal had to call a store method that
   * reads the very record it writes, so a forced reload re-ran its own effect:
   * the PR list and the deployments view refetched forever. The store is what
   * every view renders from, so reloading it is enough.
   *
   * Only the view is awaited, because it is the answer the click was about and
   * the one the control reports on. The repository half (working tree, chrome,
   * remote-tracking refs) is started first and left to land on its own: every
   * step of it publishes through the store, so a late answer still repaints the
   * panel instead of being dropped, and a slow network round trip can never turn
   * Refresh into a stalled control.
   */
  async refreshPanel(): Promise<void> {
    void this.refreshRepository().catch(() => undefined)
    await this.root.handlePrListAction.refreshFocusedView()
  }

  /**
   * The repository half of Refresh, deliberately never awaited by the button.
   *
   * `loadRepoState` re-asks whether this is still a repository at all (the one
   * thing a cache can be wrong about), then reads the working tree, the
   * branches and the History pages, which is what the Changes, History and
   * Branches views render from. The fetch then makes `ahead`/`behind` true
   * again. An explicit click skips the age gate that throttles the automatic
   * fetch, because the user asked for the newest answer there is; only a
   * repository with no remote is skipped, since there is nothing to ask.
   */
  async refreshRepository(): Promise<void> {
    await this.loadRepoState(true)
    // A fetch already in flight is already answering this click, and a
    // repository with no remote has nothing to ask: either way a second round
    // trip would only repeat a question that is being asked.
    if (this.remotes.length === 0 || gitState.isBusy('fetch')) return
    await gitState.fetch(this.root.props.projectId)
  }

  async loadRepoState(force = false): Promise<void> {
    // Re-checking in place must not blank a panel that is already showing data:
    // the "Checking repository" takeover belongs to the first answer, not to a
    // refresh of one. A remote checkout's last-known read counts as data, so a
    // cached tree stays on screen, dimmed by the surface overlay, until the new
    // preflight answers.
    if (!force) this.repoState = gitState.showingCachedStatus ? 'git' : 'loading'
    this.preflightError = null
    try {
      // Cached per project, so re-opening the panel does not spawn git again to
      // ask a question whose answer has not changed.
      const snapshot = await loadRepositoryPreflight(this.root.props.projectId, force)
      if (snapshot.hasDeployments !== undefined) {
        // Authoritative database value; reconcile the fast-render cache with it.
        this.hasDeployments = snapshot.hasDeployments
        cacheHasDeployments(this.root.props.projectId, snapshot.hasDeployments)
      }
      if (!snapshot.path || snapshot.preflight.status === 'not_git') {
        this.repoState = 'not_git'
        return
      }
      if (snapshot.preflight.status === 'git_unavailable') {
        this.repoState = 'git_unavailable'
        this.root.confirmAcceptAllConflicts.preflightDetail = snapshot.preflight.detail ?? ''
        return
      }
      this.repoState = 'git'
      await this.root.handlePrListAction.refreshStatus()
    } catch (reason) {
      // A preflight that could not answer is not the same as "this is not a
      // repository". On an Oven the round trip itself may have failed, and
      // claiming otherwise would show a git-less panel for a healthy checkout
      // at exactly the moment the user needs to see its last-known state. The
      // surface overlay states the real reason.
      this.preflightError = reason instanceof Error ? reason.message : 'Git could not be read.'
      this.repoState = gitState.remoteTarget ? 'git' : 'not_git'
    }
  }

  async initializeRepository(): Promise<void> {
    await gitState.initialize(this.root.props.projectId)
    // The cached preflight still says "not a repository". Without this the panel
    // would keep reporting that for the rest of the cache's life.
    invalidateRepositoryPreflight(this.root.props.projectId)
    if (gitState.status) this.repoState = 'git'
  }

  /** Route a GitHub Actions PR check into the matching in-app workflow detail. */
  openWorkflowRunFromCheck(runId: number): void {
    this.root.handlePrListAction.selectedPullRequest = null
    this.root.confirmAcceptAllConflicts.requestedWorkflowRunId = runId
    this.hasDeployments = true
    cacheHasDeployments(this.root.props.projectId, true)
    this.root.handlePrListAction.activeTab = 'deployments'
  }

  /**
   * Resolve whatever integration is in progress with the agent's help. The
   * conflicts are already in the working tree (a pull, a merge or a rebase), so
   * this only has to hand the agent the brief   the same brief the PR path uses.
   */
  async resolveConflictsWithAgent(): Promise<void> {
    await resolveCurrentConflictsWithAgent(
      this.root.props.projectId,
      this.root.props.scopeBucketId,
      this.status?.branch ?? 'this worktree'
    )
  }

  async loadHistory(): Promise<void> {
    if (this.commitHistory.length > 0) return
    this.loadingHistory = true
    const request = ++this.historyRequestId
    try {
      const page = await gitState.getLog(this.root.props.projectId, this.HISTORY_PAGE_SIZE)
      if (request !== this.historyRequestId) return
      this.commitHistory = page
      this.historyHasMore = page.length === this.HISTORY_PAGE_SIZE
    } finally {
      // A superseded or failed request must never leave the spinner stuck.
      if (request === this.historyRequestId) this.loadingHistory = false
    }
  }

  /** Pages in older commits as the history list scrolls toward its end. */
  async loadMoreHistory(): Promise<void> {
    if (this.loadingHistory || this.loadingMoreHistory || !this.historyHasMore) return
    this.loadingMoreHistory = true
    const request = ++this.historyRequestId
    try {
      const page = await gitState.getLog(
        this.root.props.projectId,
        this.HISTORY_PAGE_SIZE,
        this.commitHistory.length
      )
      if (request !== this.historyRequestId) return
      this.commitHistory = [...this.commitHistory, ...page]
      this.historyHasMore = page.length === this.HISTORY_PAGE_SIZE
    } finally {
      if (request === this.historyRequestId) this.loadingMoreHistory = false
    }
  }

  /**
   * The drift this panel has with its upstream, plus the worktree it belongs to.
   * Pushing and fetching both move it, and both add a reflog entry, so it is the
   * cheap signal that the batch boundaries in the graph are out of date. The
   * scope bucket is part of the key so a worktree swap always re-reads, even
   * when two checkouts happen to sit at the same drift.
   */
  remoteUpdatesKey = $derived(
    this.status?.upstream === null || this.status?.upstream === undefined
      ? null
      : [
          this.root.props.scopeBucketId ?? '',
          this.status.upstream,
          String(this.status.ahead),
          String(this.status.behind)
        ].join('|')
  )

  selectedCommitIndex = $derived.by(() => {
    const current = this.root.handlePrListAction.selectedCommit
    if (!current) return -1
    return this.commitHistory.findIndex((commit) => commit.hash === current.hash)
  })

  canGoOlder = $derived(
    this.selectedCommitIndex >= 0 &&
      (this.selectedCommitIndex < this.commitHistory.length - 1 || this.historyHasMore)
  )

  async navigateCommit(direction: -1 | 1): Promise<void> {
    const index = this.selectedCommitIndex
    const next = index + direction
    if (next >= this.commitHistory.length - 1 && direction > 0 && this.historyHasMore) {
      await this.loadMoreHistory()
    }
    const commit = this.commitHistory[next]
    if (commit) void this.root.handlePrListAction.selectCommit(commit)
  }

  identityNeeded = $derived(
    this.repoState === 'git' && gitState.identity !== null && !gitState.identity.configured
  )

  remotes = $derived(gitState.remotes)

  primaryRemote = $derived(
    this.remotes.find((remote) => remote.name === 'origin') ?? this.remotes[0] ?? null
  )

  /**
   * Remote-tracking ref names, used to recognise a commit the remote already
   * has without asking git: a commit wearing one of these decorations is on the
   * remote by definition.
   */
  remoteTrackingRefs = $derived(
    new SvelteSet(
      gitState.branches.filter((branch) => branch.kind === 'remote').map((branch) => branch.ref)
    )
  )

  /**
   * Whether GitHub can show the commit open in the info dialog. History is
   * `HEAD`'s log, so anything at or below the unpushed boundary the graph draws
   * is already upstream; a commit outside the loaded page has to wear a
   * remote-tracking ref to qualify.
   */
  commitInfoOnRemote = $derived.by(() => {
    const target = this.root.handlePrListAction.commitInfoTarget
    if (!target) return false
    if (target.refs.some((ref) => this.remoteTrackingRefs.has(ref.name))) return true
    if (!this.status?.upstream) return false
    return (
      this.commitHistory.findIndex((commit) => commit.hash === target.hash) >= this.unpushedCount
    )
  })

  /**
   * Whether the commit waiting to be rewritten is already upstream. Rewriting it
   * moves the branch, so an upstream copy means the next push has to force, and
   * the confirmation says so before the user commits to it.
   */
  removeCommitOnRemote = $derived.by(() => {
    const target = this.root.confirmAcceptAllConflicts.removeCommitChangesConfirm
    if (!target) return false
    const commit = this.commitHistory.find((entry) => entry.hash === target.hash)
    if (!commit) return false
    if (commit.refs.some((ref) => this.remoteTrackingRefs.has(ref.name))) return true
    if (!this.status?.upstream) return false
    return this.commitHistory.findIndex((entry) => entry.hash === target.hash) >= this.unpushedCount
  })

  /** Reveal a check's workflow run: here for the panel's repository, there for any other. */
  openWorkflowRunFor(identity: { owner: string; repo: string }, runId: number): void {
    if (this.root.handlePrListAction.isPanelRepository(identity)) {
      this.openWorkflowRunFromCheck(runId)
      return
    }
    void openInBrowser(
      `https://github.com/${identity.owner}/${identity.repo}/actions/runs/${runId}`
    )
  }

  needsUpstreamPush = $derived(
    Boolean(this.status?.branch) && !this.status?.detached && this.status?.upstream === null
  )

  /**
   * Whether the remote already carries a branch under this name, read from the
   * last branch refresh. A branch without an upstream is not necessarily a
   * branch the remote has never seen, and the confirmation has to name which
   * of the two this push does: publish a new remote branch, or start tracking
   * the one that is already there.
   */
  remoteBranchExists = $derived(
    gitState.branches.some(
      (branch) =>
        branch.kind === 'remote' &&
        branch.name === this.status?.branch &&
        branch.remote === this.primaryRemote?.name
    )
  )

  /** Commits the remote does not have yet, according to the last fetch. */
  commitsAhead = $derived(this.status?.ahead ?? 0)

  /**
   * Whether the Push slot has anything to do. A branch whose upstream is simply
   * missing has no `ahead` count to show   the push is what creates the tracking
   * branch   so it qualifies as soon as the repository is known to have commits.
   * Rendering the button on an empty repository would only offer a push that git
   * must reject.
   */
  hasWorkToPush = $derived(
    this.commitsAhead > 0 || (this.needsUpstreamPush && this.commitHistory.length > 0)
  )

  /**
   * Push copy: a count when there is one, otherwise what the push sets up. While
   * a fetch is in flight it says why the button is unavailable, because Push is
   * the one control a fetch blocks and an unexplained disabled button reads as a
   * broken panel.
   */
  pushTitle = $derived(
    this.root.confirmPrMerge.fetching
      ? 'Push is waiting for the fetch in progress'
      : this.commitsAhead > 0
        ? `Push ${String(this.commitsAhead)} commit(s) to the remote`
        : 'Push this branch and track it on the remote'
  )

  worktreeScope = $derived(
    this.root.confirmAcceptAllConflicts.activeScopeBucket?.root.kind === 'worktree'
  )

  /** Commits waiting on the remote, according to the last fetch. */
  commitsBehind = $derived(this.status?.behind ?? 0)

  hasRemote = $derived(this.remotes.length > 0)

  /**
   * Which remote actions have work, and therefore whether the header's second row
   * exists at all. The row and its buttons read the same three flags, so they can
   * never disagree about whether there is anything to do.
   */
  showsPull = $derived(this.repoState === 'git' && this.hasRemote && this.commitsBehind > 0)

  showsPush = $derived(this.repoState === 'git' && this.hasRemote && this.hasWorkToPush)

  /**
   * Only a managed worktree scope gets the Sync control. Sync exists to trade
   * commits between two checkouts of the same repository, and a worktree is the
   * only scope that has a second checkout to trade with; from the project root
   * the worktree's own Git panel already offers the same move in the direction
   * that lands here, so an entry point on `main` would be a second door onto one
   * operation, with the receiver off screen.
   */
  showsSync = $derived(this.repoState === 'git' && this.worktreeScope)

  /**
   * Pull and Push are the only remote actions that earn the second row: they act
   * on the branch you are standing on, one each, and they fill the row between
   * them. Sync main is a menu, so it sits with the other header tools.
   *
   * The Deploys view reads runs and deployments, not the branch you are standing
   * on, so Pull and Push have nothing to say there and do not appear.
   */
  /**
   * The row's remote actions apply to the branch you are standing on, which is
   * what the Deploys view is not about.
   */
  remoteActionsApply = $derived(
    this.root.handlePrListAction.activeTab !== 'deployments' &&
      this.root.handlePrListAction.activeTab !== 'notifications'
  )

  /**
   * Unresolved conflicts hand the row to the controls that end them, so the
   * remote buttons step out of the way and reappear in the git actions menu.
   * Pushing or pulling a half-resolved integration is not a step forward.
   */
  conflictsOpen = $derived(this.conflicted.length > 0)

  /**
   * A worktree checkout keeps Pull and Push in the git actions menu beside
   * Fetch rather than handing them the row: the row is the panel's loudest
   * position, and a managed scope already owns the sync-to-main and
   * sync-from-main actions plus the pull request its branch exists for.
   */
  remoteActionsInMenu = $derived(
    this.remoteActionsApply && (this.conflictsOpen || this.worktreeScope)
  )

  showsRemoteActions = $derived(
    this.remoteActionsApply &&
      !this.conflictsOpen &&
      !this.worktreeScope &&
      (this.showsPull || this.showsPush)
  )

  /**
   * The working tree's staging controls: whatever the changes view can do to the
   * index right now. They used to sit in a bar of their own inside that view, and
   * they share this row with Pull and Push instead.
   */
  showsStageControls = $derived(
    this.conflictsOpen ||
      this.unstaged.length + this.untracked.length > 0 ||
      this.staged.length > 0 ||
      (this.changes.length > 0 &&
        this.root.handlePrListAction.workingTree.selectedPathList.length > 0)
  )

  /**
   * Working-tree state as the branch picker's leading glyph, in the order the
   * states ask for attention: conflicts first, then uncommitted changes, then
   * clean. Null while there is no status to describe.
   */
  worktreeState = $derived.by((): WorktreeState | null => {
    if (!this.status) return null
    if (this.conflicted.length > 0) return 'conflicted'
    return this.status.clean ? 'clean' : 'dirty'
  })

  closePullStrategy(): void {
    this.pullStrategyOpen = false
  }

  resolvePullTarget(): { remote: string; branch: string } | null {
    const currentStatus = this.status
    if (!currentStatus?.branch) return null
    const upstream = currentStatus.upstream
    if (upstream) {
      const trackedRemote = this.remotes.find((remote) => upstream.startsWith(`${remote.name}/`))
      if (trackedRemote) {
        return {
          remote: trackedRemote.name,
          branch: upstream.slice(trackedRemote.name.length + 1)
        }
      }
    }
    if (!this.primaryRemote) return null
    return { remote: this.primaryRemote.name, branch: currentStatus.branch }
  }

  /**
   * A pull leaves the panel as a background job the moment a strategy is chosen,
   * exactly like a sync between checkouts: the round trip and the integration
   * report in the docked run panel, so the chooser never holds the window and a
   * conflict is answered where the work continues.
   */
  startPull(strategy: GitPullStrategy): void {
    const target = this.resolvePullTarget()
    if (!target) {
      toast.error('No tracked branch is available to pull')
      return
    }

    this.root.confirmPrMerge.savePullPreference(strategy)
    this.pullStrategyOpen = false
    gitPullJobs.start({
      projectId: this.root.props.projectId,
      remote: target.remote,
      branch: target.branch,
      strategy,
      incoming: this.commitsBehind,
      onSettled: () => void this.root.handlePrListAction.refreshStatus()
    })
  }

  /** The wide half of the Pull control: the saved strategy, or the chooser. */
  pullAction(): void {
    const target = this.resolvePullTarget()
    if (!target) {
      toast.error('No tracked branch is available to pull')
      return
    }
    if (appConfigState.defaultPullStrategy === 'ask') {
      this.pullStrategyOpen = true
      return
    }
    this.startPull(appConfigState.defaultPullStrategy)
  }

  async performPush(remote: { name: string; url: string }): Promise<void> {
    if (!this.status?.branch) return
    const result = await gitState.push(this.root.props.projectId, false, remote.name)
    // A non-fast-forward rejection becomes the recovery dialog, not an error.
    if (result.status === 'rejected') this.pushDiverged = true
  }

  async pushAction(): Promise<void> {
    const remote = this.primaryRemote
    if (!remote || !this.status?.branch) {
      gitState.error = 'No remote is configured to push to'
      return
    }
    if (this.needsUpstreamPush) {
      this.pushConfirm = true
      return
    }
    // Known divergence from the last fetch   never attempt the doomed push.
    if (this.status.behind > 0) {
      this.pushDiverged = true
      return
    }
    await this.performPush(remote)
  }

  async confirmPushUpstream(): Promise<void> {
    this.pushConfirm = false
    if (!this.primaryRemote || !this.status?.branch) return
    const result = await gitState.push(
      this.root.props.projectId,
      true,
      this.primaryRemote.name,
      this.status.branch
    )
    if (result.status === 'rejected') this.pushDiverged = true
  }

  /** Pull the remote into the local branch, then push once integration is clean. */
  async recoverPush(mode: 'merge' | 'rebase'): Promise<void> {
    const remote = this.primaryRemote
    if (!remote || !this.status?.branch || this.pushRecoverMode) return
    this.pushDiverged = false
    this.pushRecoverMode = mode
    try {
      await gitState.pullIntegrate(this.root.props.projectId, remote.name, this.status.branch, mode)
      // Conflicts hand over to the conflict UI; never auto-push a half-merged
      // tree, and never push after a pull that never reached the remote either:
      // the push would fail with the very same verdict, which the panel is
      // already showing as its notice.
      if (
        !gitState.error &&
        !gitState.remoteIssueFor(this.root.props.projectId) &&
        gitState.conflicted.length === 0
      ) {
        await this.performPush(remote)
      }
    } finally {
      this.pushRecoverMode = null
    }
  }

  /** Open the Replace-origin modal, prefilled with the current primary remote URL. */
  openReplaceOrigin(): void {
    this.root.confirmPrMerge.originMode = 'replace'
    this.root.confirmPrMerge.originName = this.primaryRemote?.name ?? 'origin'
    this.root.confirmPrMerge.originUrl = this.primaryRemote?.url ?? ''
    this.root.confirmPrMerge.originReplaceConfirm = false
    this.root.confirmPrMerge.originModalOpen = true
  }

  /**
   * The temporary `pr-<n>` branch a PR conflict resolution is staged on, while
   * its session is still open. `preparePrResolve` records the session and the
   * store drops it once the branch is gone, so this names the branch the finish
   * step still has to delete.
   */
  prResolveBranch = $derived(
    gitState.prResolveSession ? `pr-${gitState.prResolveSession.pullNumber}` : null
  )

  /**
   * A merge is in progress (MERGE_HEAD exists) and every conflicted file has
   * been resolved and staged. Git is waiting for the merge commit, so the panel
   * surfaces the one next step   Complete merge   instead of leaving the user to
   * figure out that a normal commit finishes the merge.
   */
  mergePending = $derived(
    this.root.confirmPrMerge.conflictState === 'merge' && this.conflicted.length === 0
  )

  /**
   * Whether the integration still has a step left: the merge commit, or   when
   * that commit already exists on a temporary PR branch   the push back to the
   * pull request and the cleanup of that branch. Same next step, same control.
   * Held back while any conflict is still open: the row owns that state, and a
   * commit with unmerged paths would only be refused by git.
   */
  prResolvePending = $derived(this.prResolveBranch !== null && this.conflicted.length === 0)

  mergeAwaitsCompletion = $derived(this.mergePending || this.prResolvePending)

  /** Complete-merge modal state: optional title/description, defaults auto-generated. */
  completeMergeOpen = $state(false)

  mergeTitle = $state('')

  mergeDescription = $state('')

  openCompleteMerge(): void {
    // Acting from the sync modal closes it first, so the merge's own controls are
    // never behind an overlay.
    this.root.confirmPrMerge.syncMainOpen = false
    this.mergeTitle = ''
    this.mergeDescription = ''
    this.completeMergeOpen = true
  }

  /** The commit message actually used: user text when given, a generated default otherwise. */
  mergeCommitMessage(): string {
    const title = this.mergeTitle.trim()
    const description = this.mergeDescription.trim()
    const resolvedTitle =
      title || `Merge ${this.status?.upstream ? `branch '${this.status.upstream}'` : 'changes'}`
    return description ? `${resolvedTitle}\n\n${description}` : resolvedTitle
  }

  /**
   * Complete the merge: write the merge commit when it is still pending, then
   * finish a recorded PR-conflict session   push the resolution back to the PR's
   * head branch, check out the branch the user came from, and delete the
   * temporary `pr-<n>` branch. A plain local merge is complete once committed.
   */
  async confirmCompleteMerge(): Promise<void> {
    if (this.root.confirmAcceptAllConflicts.completeMergeBusy || !this.mergeAwaitsCompletion) return
    const temporaryBranch = this.prResolveBranch
    if (this.mergePending) {
      await gitState.commit(this.root.props.projectId, this.mergeCommitMessage())
      if (gitState.error) return
      if (!temporaryBranch) toast.success('Merge committed')
    }
    if (temporaryBranch) {
      const finished = await gitState.finishPrResolve(this.root.props.projectId)
      if (!finished) return
      toast.success(`Resolution pushed to the pull request; ${temporaryBranch} removed`)
    }
    this.completeMergeOpen = false
    this.mergeTitle = ''
    this.mergeDescription = ''
    void this.root.handlePrListAction.refreshStatus()
  }

  atRiskFiles = $derived(this.changes.length > 0 ? this.changes.map((change) => change.path) : [])

  fileSections: Array<{ title: string; files: GitFileChange[] }> = $derived.by(() => {
    const sections: Array<{ title: string; files: GitFileChange[] }> = []
    if (this.conflicted.length > 0) sections.push({ title: 'Conflicts', files: this.conflicted })
    if (this.staged.length > 0) sections.push({ title: 'Staged', files: this.staged })
    if (this.unstaged.length > 0) sections.push({ title: 'Unstaged', files: this.unstaged })
    if (this.untracked.length > 0) sections.push({ title: 'Untracked', files: this.untracked })
    return sections
  })
}
