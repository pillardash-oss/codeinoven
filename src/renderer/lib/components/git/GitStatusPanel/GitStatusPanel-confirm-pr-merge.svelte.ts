import { invoke } from '$lib/ipc.svelte'
import { findPanelPrimaryAction } from '$lib/modal-primary-action.svelte'
import { openInBrowser } from '$lib/open-in-browser'
import { appConfigState } from '$lib/stores/app-config.svelte'
import { gitState, GitState } from '$lib/stores/git.svelte'
import { githubNotifications } from '$lib/stores/github-notifications.svelte'
import { diagnoseWorkflowJob } from '../git-status-panel-agent-actions'
import type {
  GitDiff,
  GitFileChange,
  GitPullStrategy,
  GitPullPreference,
  GitSyncDirection,
  GitRebaseAction,
  GitHubDeploymentJob,
  GitHubDeploymentJobLog,
  GitHubAuthStatus,
  GitHubWorkflowRun,
  GitResetMode,
  GitRemoteUpdate
} from '$shared/types'
import { gitSyncJobs } from '$lib/stores/git-sync-jobs.svelte'
import { isFailedJob } from '$shared/github-job-log'
import { PR_DETAIL_VIEWS, prViewCount } from '../pr-view'
import {
  notificationIssueSummary,
  notificationPullRequestSummary,
  notificationTargetFor
} from '../notification-view'
import { reportErrorWithDetails } from '$lib/stores/app-errors.svelte'
import type {
  PrListFilter,
  PrListSort,
  PrMergeMethod,
  PrState,
  PullRequestBundle,
  PullRequestSummary
} from '$shared/types'
import type { GitStatusPanel } from './GitStatusPanel-board.svelte'
/** One concern of the GitStatusPanel board. */
export class GitStatusPanelConfirmPrMerge {
  #root: GitStatusPanel | undefined
  /** The board this unit belongs to; set before any member of it runs. */
  get root(): GitStatusPanel {
    if (!this.#root)
      throw new Error('GitStatusPanelConfirmPrMerge read its board before it was bound')
    return this.#root
  }
  constructor(root: GitStatusPanel) {
    this.#root = root
  }

  /** Restores the pull request view, once the sibling that stores it is bound. */
  bindPrListState(): void {
    const saved = this.root.handlePrListAction.savedView
    this.prListState = saved.prListState
    this.prListFilter = saved.prListFilter
    this.prListSort = saved.prListSort
  }
  /**
   * Whether this panel's Git state comes from an Oven, and which one. The store
   * resolves it from the active scope it already reads against, so the panel
   * never has to re-derive the thread's Oven at render time.
   */
  ovenTarget = $derived(gitState.remoteTarget)

  /**
   * Main-sync strategy chooser, opened by the `ask` preference, a failure, or
   * always when sending commits out of this checkout (that mutates a branch the
   * user is not looking at).
   */
  syncMainOpen = $state(false)

  /** Which direction the chooser and its actions apply to. */
  syncDirection = $state<GitSyncDirection>('from')

  showIntegrateModal = $state(false)

  mergeTarget = $state('')

  pendingOperation = $state<{ kind: 'merge' | 'rebase'; target: string } | null>(null)

  /** Add/Replace Git Origin modal on the branch picker. */
  originModalOpen = $state(false)

  originMode = $state<'add' | 'replace'>('add')

  originName = $state('origin')

  originUrl = $state('')

  originBusy = $state(false)

  /** Destructive confirmation that a replace-origin is intended. */
  originReplaceConfirm = $state(false)

  acknowledgeActiveTurn = $state(false)

  /**
   * Where each batch of commits reached the upstream, newest first, read from
   * the upstream ref's reflog. Empty when the branch has no remote-tracking
   * upstream or git kept no reflog for it, in which case the graph falls back to
   * its single unpushed boundary.
   */
  remoteUpdates = $state.raw<GitRemoteUpdate[]>([])

  /** Invalidates an in-flight reflog read whose drift has already moved on. */
  remoteUpdatesRequestId = 0

  /**
   * Which pull requests the PR view lists, and where its paging stands. Both are
   * panel state rather than list state because the panel draws the filter in its
   * own action row, beside Push and Pull.
   */
  /** Set by `bind()`: the pull request view the panel was left on. */
  prListState = $state<PrState>('open')

  /** Set by `bind()`: the pull request filter the panel was left on. */
  prListFilter = $state<PrListFilter>('all')

  /** Set by `bind()`: the pull request sort the panel was left on. */
  prListSort = $state<PrListSort>('updated')

  prListPage = $state(1)

  /**
   * Which rows of the PR list are selected.
   *
   * Panel state, like the filter and the page, because the list is mounted twice
   * (dock and full screen reader) and both mounts draw the same listing: a selection
   * held inside the list would let the two disagree about what a batch acts on.
   */
  prListSelection = $state<Record<number, boolean>>({})

  /** The merge a row menu asked for, with the method the user chose. */
  prMerge = $state<{ pr: PullRequestSummary; method: PrMergeMethod } | null>(null)

  prMergeOpen = $state(false)

  prMergeTitle = $state('')

  prMergeMessage = $state('')

  prMergeBusy = $state(false)

  /**
   * The GitHub accounts, as one status.
   *
   * One state rather than a derived boolean, a configured flag and a user: the
   * panel also has to hand the account list to the account menu, and three loose
   * copies of one answer is how they end up disagreeing.
   */
  githubStatus = $state<GitHubAuthStatus | null>(null)

  commitDiffs = $state<Record<string, GitDiff>>({})

  commitExpanded = $state<Record<string, boolean>>({})

  loadingCommitDiffFile = $state<Record<string, boolean>>({})

  commitDiffErrors = $state<Record<string, string | null>>({})

  resetConfirm = $state<{ mode: GitResetMode; target: string } | null>(null)

  async loadGitHubAuth(): Promise<void> {
    this.applyGitHubStatus(await gitState.githubAuthStatus())
  }

  /** Adopt a GitHub status, and the active account's data with it. */
  async applyGitHubStatus(status: GitHubAuthStatus): Promise<void> {
    const previousAccountId = this.githubStatus?.activeAccountId ?? null
    this.githubStatus = status
    // Notifications are account-wide, so they are the one view whose data belongs
    // to the account rather than to the repository the panel is standing in. A
    // view that was never opened is left alone: it loads when it is opened.
    // An open thread was read as the account that just left, so a different
    // account closes it; the same account signing in again keeps it, which is
    // what an unchecked remount does when the sidebar is hidden and shown.
    if (previousAccountId !== status.activeAccountId) githubNotifications.closeNotification()
    if (githubNotifications.hasLoaded) await githubNotifications.load()
  }

  /**
   * Make another signed-in account the one GitHub calls run as.
   *
   * The view is reloaded afterwards: everything on screen was read with the
   * previous account's token, so leaving it up would present one account's pull
   * requests, issues or deployments as another's.
   */
  async switchGitHubAccount(accountId: string): Promise<void> {
    await this.applyGitHubStatus(await gitState.switchGitHubAccount(accountId))
    await this.root.handlePrListAction.refreshFocusedView()
  }

  /** Route a failed workflow run job to a fresh diagnosis thread. */
  startWorkflowDiagnosis(
    run: GitHubWorkflowRun,
    job: GitHubDeploymentJob,
    log: GitHubDeploymentJobLog | null
  ): void {
    diagnoseWorkflowJob(this.root.props.projectId, run, job, log)
  }

  /** Re-read the open run after a cancel or a re-run changed its state. */
  async reloadOpenRun(): Promise<void> {
    const run = this.root.handlePrListAction.selectedRun
    const identity = this.root.handlePrListAction.githubIdentity
    if (!run || !identity) return
    await gitState
      .ensureWorkflowRunDetail(
        this.root.props.projectId,
        identity.owner,
        identity.repo,
        run.id,
        true
      )
      .catch(() => null)
  }

  async signOutGitHub(): Promise<void> {
    // Signing out of the active account hands GitHub calls to the next one, so
    // the panel adopts the status that comes back rather than assuming none is
    // signed in.
    await this.applyGitHubStatus(await gitState.logoutGitHub())
    await this.root.handlePrListAction.refreshFocusedView()
  }

  /**
   * Read the upstream ref's reflog: git stamps every movement of that ref, which
   * is the only native record of when commits actually reached the remote.
   * `remoteUpdatesRequestId` drops an answer whose drift has already moved on.
   */
  async loadRemoteUpdates(): Promise<void> {
    const request = ++this.remoteUpdatesRequestId
    const updates = await gitState.getRemoteUpdates(this.root.props.projectId)
    if (request !== this.remoteUpdatesRequestId) return
    this.remoteUpdates = updates
  }

  /**
   * Take the branch trigger's status badge to the work it names: the Changes view
   * with any commit that was open closed, so the click lands on the working tree
   * instead of the commit sheet the view would otherwise still be showing. The
   * click itself is left to bubble to the trigger, which closes a picker that
   * was already open before the view beneath it changes.
   */
  openWorkingChanges(): void {
    this.root.handlePrListAction.clearSelectedCommit()
    this.root.handlePrListAction.selectTab('changes')
  }

  /**
   * Switch which pull requests the PR view lists. The filter is the panel's, so
   * the page it belonged to goes with it: page 4 of the closed list has nothing
   * to do with page 4 of the open one. The selection goes with it for the same
   * reason: "close 5 selected" must never mean five rows the user can no longer see.
   */
  selectPrListState(next: PrState): void {
    if (next === this.prListState) return
    this.prListState = next
    this.prListPage = 1
    this.prListSelection = {}
  }

  /**
   * Switch which relationship the PR view keeps, or how it orders the result.
   * Both are the panel's, so the page goes with them: page 4 of "everything" has
   * nothing to do with page 4 of "authored by me".
   */
  selectPrListFilter(next: PrListFilter): void {
    if (next === this.prListFilter) return
    this.prListFilter = next
    this.prListPage = 1
    this.prListSelection = {}
  }

  selectPrListSort(next: PrListSort): void {
    if (next === this.prListSort) return
    this.prListSort = next
    this.prListPage = 1
    this.prListSelection = {}
  }

  /** A different page is a different set of rows, so the selection goes with it. */
  selectPrListPage(next: number): void {
    if (next === this.prListPage) return
    this.prListPage = next
    this.prListSelection = {}
  }

  async confirmPrMerge(): Promise<void> {
    const pending = this.prMerge
    const identity = this.root.handlePrListAction.githubIdentity
    if (!pending || !identity) return
    this.prMergeBusy = true
    try {
      const merged = await gitState.mergePullRequest(
        this.root.props.projectId,
        identity.owner,
        identity.repo,
        pending.pr.number,
        pending.method,
        pending.method === 'rebase' ? undefined : this.prMergeTitle.trim() || undefined,
        pending.method === 'rebase' ? undefined : this.prMergeMessage.trim() || undefined
      )
      if (merged) {
        // The row has left every open listing, so the selection it may have been
        // part of no longer describes anything on screen.
        this.prListSelection = {}
        this.prMerge = null
      }
    } finally {
      this.prMergeBusy = false
      this.prMergeOpen = false
    }
  }

  /**
   * Open one commit named from outside the history list, addressed by its hash.
   *
   * An issue's history knows a referenced commit only by hash, and `git log` resolves
   * a hash-like query against the object database rather than the commit message, so
   * a commit that was fetched but never checked out still opens. A commit this
   * checkout has never fetched is a miss worth saying out loud: a click that silently
   * does nothing reads as a broken link.
   */
  async openCommitByHash(hash: string): Promise<void> {
    const [commit] = await gitState.getLog(this.root.props.projectId, 1, 0, hash)
    // The pin above any message matches is what makes the hash trustworthy, so a
    // result that is not the hash itself is a commit whose message happens to
    // contain it, which is not the commit the reader asked for.
    if (!commit || !commit.hash.startsWith(hash)) {
      reportErrorWithDetails(
        `Commit ${hash.slice(0, 7)} is not in this repository. Fetch the branch it was pushed to, then open it again.`
      )
      return
    }
    void this.root.handlePrListAction.selectCommit(commit)
  }

  async toggleCommitDiff(change: GitFileChange): Promise<void> {
    const commit = this.root.handlePrListAction.selectedCommit
    if (!commit) return
    if (this.commitExpanded[change.path]) {
      this.commitExpanded = { ...this.commitExpanded, [change.path]: false }
      return
    }
    this.commitExpanded = { ...this.commitExpanded, [change.path]: true }
    this.commitDiffErrors = { ...this.commitDiffErrors, [change.path]: null }
    if (this.commitDiffs[change.path]) return
    this.loadingCommitDiffFile = { ...this.loadingCommitDiffFile, [change.path]: true }
    try {
      const diff = await gitState.getCommitFileDiff(
        this.root.props.projectId,
        commit.hash,
        change.path
      )
      this.commitDiffs = { ...this.commitDiffs, [change.path]: diff }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'The diff could not be loaded'
      this.commitDiffErrors = { ...this.commitDiffErrors, [change.path]: message }
    } finally {
      this.loadingCommitDiffFile = { ...this.loadingCommitDiffFile, [change.path]: false }
    }
  }

  requestReset(mode: GitResetMode, target: string): void {
    this.resetConfirm = { mode, target }
    this.acknowledgeActiveTurn = false
  }

  /**
   * The open deployment's state, read from the same store record the detail body
   * renders, so the action row and the page below it cannot disagree.
   */
  openDeploymentState = $derived.by(() => {
    const deployment = this.root.handlePrListAction.selectedDeployment
    const identity = this.root.handlePrListAction.githubIdentity
    if (!deployment || !identity) return 'unknown'
    const cached =
      gitState.deploymentDetails[
        GitState.deploymentDetailKey(identity.owner, identity.repo, deployment.id)
      ]
    return (
      cached?.detail.deployment.latestStatus?.state ?? deployment.latestStatus?.state ?? 'unknown'
    )
  })

  /** A run's state is its conclusion once it is done, its status until then. */
  openRunState = $derived.by(() => {
    const selected = this.root.handlePrListAction.selectedRun
    const identity = this.root.handlePrListAction.githubIdentity
    if (!selected || !identity) return 'unknown'
    const run =
      gitState.deploymentRunDetails[
        GitState.workflowRunKey(identity.owner, identity.repo, selected.id)
      ]?.detail.run ?? selected
    return run.status === 'completed' ? (run.conclusion ?? 'completed') : run.status
  })

  /**
   * The open run's loaded jobs, so the header can count them and name the job
   * that failed. Empty until the detail read lands, which is why the count and
   * the failed-job control appear a beat after the run itself.
   */
  openRunJobs = $derived.by(() => {
    const selected = this.root.handlePrListAction.selectedRun
    const identity = this.root.handlePrListAction.githubIdentity
    if (!selected || !identity) return []
    return (
      gitState.deploymentRunDetails[
        GitState.workflowRunKey(identity.owner, identity.repo, selected.id)
      ]?.detail.jobs ?? []
    )
  })

  openRunFailedJob = $derived(this.openRunJobs.find(isFailedJob) ?? null)

  /**
   * The notification the Notifications view has open, and what it points at.
   *
   * A notification names a thread by repository and number, which is exactly how
   * the panel's own pull request and issue readers address one, so what is open
   * here is read by those readers rather than by a surface built for
   * notifications alone. The thread's repository need not be the one the panel is
   * standing in, which is why the readers are handed their own identity.
   */
  notificationStackSelection = $state<{
    notificationId: string
    pr: PullRequestSummary
  } | null>(null)

  openNotification = $derived(githubNotifications.openNotification)

  notificationTarget = $derived(
    this.openNotification ? notificationTargetFor(this.openNotification) : null
  )

  notificationIdentity = $derived(
    this.notificationTarget
      ? { owner: this.notificationTarget.owner, repo: this.notificationTarget.repo }
      : null
  )

  notificationPullRequest = $derived(
    this.openNotification && this.notificationTarget?.kind === 'pull-request'
      ? this.notificationStackSelection?.notificationId === this.openNotification.id
        ? this.notificationStackSelection.pr
        : notificationPullRequestSummary(this.openNotification, this.notificationTarget)
      : null
  )

  notificationIssue = $derived(
    this.openNotification && this.notificationTarget?.kind === 'issue'
      ? notificationIssueSummary(this.openNotification, this.notificationTarget)
      : null
  )

  notificationBundle = $derived(
    this.pullRequestBundleFor(this.notificationIdentity, this.notificationPullRequest)
  )

  notificationPrDetailViews = $derived(
    this.prDetailViewsFor(this.notificationBundle, this.notificationPullRequest)
  )

  /**
   * The open pull request's fetched record. The reader reads the same bundle
   * from the store, so the panel's identity row and its pills cannot show one
   * thing while the reader shows another.
   */
  pullRequestBundle = $derived(
    this.pullRequestBundleFor(
      this.root.handlePrListAction.githubIdentity,
      this.root.handlePrListAction.selectedPullRequest
    )
  )

  prDetailViewsFor(bundle: PullRequestBundle | undefined, summary: PullRequestSummary | null) {
    return PR_DETAIL_VIEWS.filter(
      (view) => view.id !== 'stacks' || (bundle?.stack?.length ?? 0) > 1
    ).map((view) => ({
      ...view,
      count: prViewCount(
        view.id,
        bundle,
        summary ? (gitState.prAgentReports[String(summary.number)]?.length ?? 0) : 0
      )
    }))
  }

  /**
   * One pull request's fetched record, for whoever is reading it.
   *
   * A function rather than a second derived value because two readers ask for it:
   * the Pulls view for the pull request it has open, and the Notifications view for
   * the one a notification names, which lives in the repository the notification
   * came from. The store keys bundles by repository and number, so the same call
   * serves both.
   */
  pullRequestBundleFor(
    identity: { owner: string; repo: string } | null,
    summary: PullRequestSummary | null
  ): PullRequestBundle | undefined {
    return identity && summary
      ? gitState.prBundles[GitState.bundleKey(identity.owner, identity.repo, summary.number)]
      : undefined
  }

  /** Open a commit a thread names: in the panel's own history, or on github.com. */
  openCommitFor(identity: { owner: string; repo: string }, hash: string): void {
    if (this.root.handlePrListAction.isPanelRepository(identity)) {
      void this.openCommitByHash(hash)
      return
    }
    void openInBrowser(`https://github.com/${identity.owner}/${identity.repo}/commit/${hash}`)
  }

  /**
   * Whether a fetch is in flight.
   *
   * Fetch has its own lane in main (`GitService.enqueueRemote`), so it holds up
   * nothing local: staging, committing, stashing, checking a branch out and
   * reading a diff all keep working while the network answers. It only gates
   * what a fetch can actually make stale, which is Push.
   */
  fetching = $derived(gitState.isBusy('fetch'))

  /**
   * The branch actions that publish or integrate. Each one reads what a fetch
   * writes, so they stand aside while another is running. Fetch itself is not in
   * this set; see `fetching`.
   */
  branchSyncBusy = $derived(gitState.isBusy(['pull', 'push', 'sync']))

  /**
   * Push waits for an in-flight fetch. It decides from the remote-tracking refs
   * whether it is a fast-forward and whether there is anything to send at all,
   * and both answers change the moment the fetch lands.
   */
  pushBlocked = $derived(this.branchSyncBusy || this.fetching)

  /**
   * Remember the preference the user just chose, so the next pull uses it without
   * asking. `ask` is a preference too: it puts the chooser back.
   */
  savePullPreference(preference: GitPullPreference): void {
    if (appConfigState.defaultPullStrategy === preference) return
    void invoke('config:update', { defaultPullStrategy: preference }).catch(() => undefined)
  }

  /**
   * Sync this worktree with the project's main worktree branch, in either
   * direction. The strategy chooser follows the same `ask` preference as the
   * Pull button; folding work into main always asks first, because it mutates a
   * branch the user is not looking at and pushes nothing.
   *
   * The run itself leaves as a background job (`gitSyncJobs`): a refusal or a
   * conflicted integration is answered in the docked panel, never in a modal the
   * user has to dismiss, and a run they started still reports after they have
   * navigated away.
   */
  performSyncMain(direction: GitSyncDirection, strategy: GitPullStrategy): void {
    this.syncMainOpen = false
    // "Main" is the project root, so the peer is named rather than chosen.
    gitSyncJobs.start({
      projectId: this.root.props.projectId,
      scopeBucketId: this.root.props.scopeBucketId,
      direction,
      strategy,
      peer: { kind: 'root' },
      peerLabel: 'the project root',
      // A sync adds commits to this checkout's history, which the panel keeps
      // rendered client-side, so the list is re-read when the run settles.
      onSettled: () => void this.root.handlePrListAction.refreshStatus()
    })
  }

  openSyncMain(direction: GitSyncDirection): void {
    this.syncDirection = direction
    this.syncMainOpen = true
  }

  syncMainAction(direction: GitSyncDirection): void {
    if (direction === 'to' || appConfigState.defaultPullStrategy === 'ask') {
      this.openSyncMain(direction)
      return
    }
    this.performSyncMain(direction, appConfigState.defaultPullStrategy)
  }

  closeSyncMain(): void {
    this.syncMainOpen = false
  }

  /** Open the Add-origin modal (no remote configured yet). */
  openAddOrigin(): void {
    this.originMode = 'add'
    this.originName = 'origin'
    this.originUrl = ''
    this.originReplaceConfirm = false
    this.originModalOpen = true
  }

  closeOriginModal(): void {
    if (this.originBusy) return
    this.originModalOpen = false
    this.originReplaceConfirm = false
  }

  /** First step of the save button: Replace routes through a destructive
   *  confirmation first; add commits immediately. */
  requestSetOrigin(): void {
    if (!this.originUrl.trim() || this.originBusy) return
    if (this.originMode === 'replace') {
      this.originReplaceConfirm = true
      return
    }
    void this.runSetOrigin()
  }

  /** `git remote add <name> <url>` or `git remote set-url <name> <url>`. */
  async runSetOrigin(): Promise<void> {
    const name = this.originName.trim()
    const url = this.originUrl.trim()
    if (!url || !name || this.originBusy) return
    this.originBusy = true
    const mode = this.originMode
    try {
      if (mode === 'replace') {
        await gitState.setRemoteUrl(this.root.props.projectId, name, url)
      } else {
        await gitState.addRemote(this.root.props.projectId, name, url)
      }
      if (!gitState.error) {
        this.originModalOpen = false
        this.originReplaceConfirm = false
        this.originUrl = ''
        void this.root.handlePrListAction.refreshStatus()
      }
    } finally {
      this.originBusy = false
    }
  }

  conflictState = $derived(gitState.conflictState)

  /**
   * Whether an integration is open in this worktree. While it is, nothing else
   * can move the branch: no sync strategy, and no remote action worth offering.
   */
  integrationOpen = $derived(this.conflictState !== 'none')

  /**
   * The Changes view's action row already renders this integration's Abort while
   * it is on screen, so the notice above it never offers the same destructive
   * button twice. The row keeps it wherever it shows: that is where the
   * resolution decisions live (Resolve all, the agent, the accept pair).
   */
  conflictRowAborts = $derived(
    this.root.handlePrListAction.activeTab === 'changes' &&
      this.root.handlePrListAction.selectedCommit === null &&
      this.root.loadRepoState.conflictsOpen
  )

  requestMergeOrRebase(kind: 'merge' | 'rebase'): void {
    const target = this.mergeTarget.trim()
    if (!target) return
    this.showIntegrateModal = false
    this.pendingOperation = { kind, target }
    this.acknowledgeActiveTurn = false
  }

  async confirmPendingOperation(): Promise<void> {
    const operation = this.pendingOperation
    if (!operation) return
    this.pendingOperation = null
    const summary =
      operation.kind === 'merge'
        ? await gitState.merge(this.root.props.projectId, operation.target)
        : await gitState.rebase(this.root.props.projectId, operation.target)
    if (summary && summary.conflicted.length > 0) {
      this.mergeTarget = ''
    }
  }

  /** Abort is destructive   always ask before discarding the whole merge/rebase. */
  abortConfirmOpen = $state(false)

  requestAbortConflict(): void {
    this.syncMainOpen = false
    this.abortConfirmOpen = true
  }

  async confirmAbortConflict(): Promise<void> {
    this.abortConfirmOpen = false
    if (this.conflictState === 'merge') {
      await gitState.abortMerge(this.root.props.projectId)
    } else if (this.conflictState === 'rebase') {
      await gitState.abortRebase(this.root.props.projectId)
    }
  }

  /**
   * Move a stopped rebase along. A rebase can stop again on the next commit's
   * conflict, which is a normal state rather than an error, so the refreshed
   * status is what the panel renders next.
   */
  async runRebaseAction(action: GitRebaseAction): Promise<void> {
    this.syncMainOpen = false
    this.rebaseActionRunning = action
    try {
      await gitState.rebaseAction(this.root.props.projectId, action)
    } finally {
      this.rebaseActionRunning = null
    }
    if (gitState.error) return
    void this.root.handlePrListAction.refreshStatus()
  }

  /** Which rebase strategy is in flight, so each button spins for its own click. */
  rebaseActionRunning = $state<GitRebaseAction | null>(null)

  /**
   * Hand focus to the integration's forward action when the sync modal swaps the
   * strategies out for it. The buttons the modal opened with are removed at that
   * moment   the worktree turned out to be mid-integration   and the one holding
   * focus goes with them, which would leave focus on the body. The same buttons
   * render in the panel's notice, so this acts inside an open modal only, and
   * only on whichever of them the modal's own ⌘+Enter pipeline would pick.
   */
  focusSyncModalAction(node: HTMLElement): void {
    if (!this.syncMainOpen) return
    const dialog = node.closest<HTMLElement>('[role="dialog"]')
    if (!dialog || findPanelPrimaryAction(dialog) !== node) return
    node.focus({ preventScroll: true })
  }
}
