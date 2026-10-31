import { subscribe } from '$lib/ipc.svelte'
import { gitState } from '$lib/stores/git.svelte'
import { githubSignIn } from '$lib/stores/github-sign-in.svelte'
import { cachedHasDeployments } from '$lib/git-deployments-cache'
import type { ThreadStatus } from '$shared/types'
import { onMount } from 'svelte'
import { browserVisibility } from '$lib/stores/browser-visibility.svelte'
import { gitPanelView } from '$lib/stores/git-panel-view.svelte'
import { findNavState } from '$lib/stores/find-nav.svelte'
import { scopeState } from '$lib/stores/scope.svelte'
import type { GitStatusPanel } from './GitStatusPanel-board.svelte'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the GitStatusPanel board. */
export class GitStatusPanelEffects extends BoardUnit<GitStatusPanel> {
  constructor(root: GitStatusPanel) {
    super(root)
  }
  /**
   * The work the surface used to do as it set itself up: effects, the
   * subscriptions it opened and the first load it kicked off. It runs from
   * the board's constructor, which the component calls during its own setup,
   * so every effect here is owned by the component.
   */
  init(): void {
    // A full window DOM surface covers the workspace, so the browser's native view
    // has to detach underneath it. This is the same contract the fullscreen
    // terminal and the fullscreen file editor publish.
    $effect(() =>
      browserVisibility.hideWhile(
        'git-pr-reader-fullscreen',
        'fullscreen-surface',
        this.root.closeFullscreenPullRequestTab.fullscreenPullRequestId !== null
      )
    )

    $effect(() => {
      gitPanelView.set(this.root.props.projectId, this.root.props.threadId, {
        activeTab: this.root.handlePrListAction.activeTab,
        changesView: this.root.confirmAcceptAllConflicts.changesView,
        selectedCommit: this.root.handlePrListAction.selectedCommit,
        selectedPullRequest: this.root.handlePrListAction.selectedPullRequest,
        selectedStash: this.root.handlePrListAction.stashes.selectedStash,
        prListState: this.root.confirmPrMerge.prListState,
        prListFilter: this.root.confirmPrMerge.prListFilter,
        prListSort: this.root.confirmPrMerge.prListSort
      })
    })

    $effect(() => {
      // Claim this project+scope before anything else reads/writes shared state
      // so a previous target's data can never be shown or overwrite this view.
      // Runs for scope swaps too   the shared git store targets exactly one
      // worktree at a time, so switching threads must retarget it even though
      // this component stays mounted.
      gitState.activate(this.root.props.projectId, this.root.props.scopeBucketId)
      // Attaching the panel to a scope is an interaction with it, so re-read the
      // checkout's live state (throttled) for the banner below.
      void scopeState
        .revalidateWorktreeHealth(this.root.props.projectId, this.root.props.scopeBucketId)
        .catch(() => undefined)
    })

    // A Git failure in a scope-backed panel usually means the checkout is gone:
    // re-read the scope's health so the repair banner replaces the bare error.
    $effect(() => {
      if (!gitState.error) return
      void scopeState.revalidateWorktreeHealth(
        this.root.props.projectId,
        this.root.props.scopeBucketId,
        { force: true }
      )
    })

    /** Project-scope bootstrap. Runs on mount and when the panel is aimed at a
     *  different project. Deliberately NOT re-run when only the scope bucket
     *  changes: repo/git availability is a property of the project path, and
     *  re-running it would flash the full-panel loading state on every scoped
     *  thread switch. */
    $effect(() => {
      this.root.loadRepoState.hasDeployments =
        cachedHasDeployments(this.root.props.projectId) ?? null
      void this.root.loadRepoState.loadRepoState()
    })

    $effect(() => {
      if (this.root.state.appliedProjectId === '') {
        // First run   the bootstrap effect above owns initial loading.
        this.root.state.appliedProjectId = this.root.props.projectId
        this.root.state.appliedScopeBucketId = this.root.props.scopeBucketId
        return
      }
      if (this.root.props.projectId !== this.root.state.appliedProjectId) {
        // Project change   full reload is handled by the bootstrap effect.
        this.root.state.appliedProjectId = this.root.props.projectId
        this.root.state.appliedScopeBucketId = this.root.props.scopeBucketId
        return
      }
      if (this.root.props.scopeBucketId === this.root.state.appliedScopeBucketId) return
      this.root.state.appliedScopeBucketId = this.root.props.scopeBucketId
      // Scope-only change (thread switch between worktrees): reset scope-local
      // view state in place, then refetch status/history against the new bucket.
      this.root.handlePrListAction.resetForScopeSwap()
    })

    $effect(() => {
      void this.root.refreshAgentTurnState.refreshAgentTurnState()
    })

    $effect(() => {
      // Loaded eagerly (not just when the History tab opens) so the composer
      // knows whether there's a commit to amend before the user gets there.
      if (
        this.root.loadRepoState.repoState === 'git' ||
        this.root.handlePrListAction.activeTab === 'history'
      )
        void this.root.loadRepoState.loadHistory()
    })

    $effect(() => {
      // The graph's push boundaries lag behind the repository until this re-reads,
      // and this effect is what re-reads: `remoteUpdatesKey` is the panel's drift
      // with its upstream, which only a push or a fetch moves.
      if (
        this.root.loadRepoState.repoState !== 'git' ||
        this.root.loadRepoState.remoteUpdatesKey === null
      )
        return
      void this.root.confirmPrMerge.loadRemoteUpdates()
    })

    $effect(() => {
      void this.root.confirmPrMerge.loadGitHubAuth()
    })

    $effect(() => {
      // When the user is signed in and the repo points at GitHub, probe for
      // deployment activity in the background and surface the view if found.
      if (
        this.root.loadRepoState.repoState === 'git' &&
        this.root.handlePrListAction.githubConnected &&
        this.root.loadRepoState.hasDeployments !== true &&
        this.root.handlePrListAction.githubIdentity
      ) {
        void this.root.handlePrListAction.detectDeployments()
      }
    })

    $effect(() => {
      // The Deployments view only exists while the flag does   fall back to
      // Changes when it is *known* to be gone (e.g. after switching to a project
      // without them). While it is still unknown the view stays put: the project
      // row has not answered yet, and that is not the same as "none".
      if (
        this.root.handlePrListAction.activeTab === 'deployments' &&
        this.root.loadRepoState.hasDeployments === false
      )
        this.root.handlePrListAction.activeTab = 'changes'
    })

    onMount(() => {
      gitState.ensureProjectEvents(this.root.props.projectId)
      // The sign-in panel is app-level (it keeps polling while the user authorizes
      // in a browser), so its result reaches this panel as a report rather than as
      // a callback on the panel's own control.
      const unsubscribeGitHubSignIn = githubSignIn.onAuthorized(
        () => void this.root.confirmPrMerge.loadGitHubAuth()
      )
      const unsubscribePullRequestOpen = gitPanelView.onPullRequestOpen(
        (requestedProjectId, requestedThreadId, pullRequest) => {
          if (
            requestedProjectId !== this.root.props.projectId ||
            requestedThreadId !== this.root.props.threadId
          )
            return
          this.root.handlePrListAction.selectedPullRequest = pullRequest
          this.root.handlePrListAction.activeTab = 'pulls'
        }
      )
      // Agent-turn state is event-driven: main broadcasts `thread:updated` on
      // every status transition (planning/executing/completed/failed), so the
      // panel reacts to those instead of polling. The one-shot fetch of the
      // current status lives in the `refreshAgentTurnState` $effect above.
      const unsubscribeThreadUpdates = subscribe('thread:updated', (...args: unknown[]) => {
        const thread = args[0] as
          { projectId?: string; id?: string; status?: ThreadStatus } | undefined
        if (
          thread &&
          thread.projectId === this.root.props.projectId &&
          thread.id === this.root.props.threadId
        ) {
          this.root.refreshAgentTurnState.agentTurnActive =
            thread.status === 'executing' || thread.status === 'planning'
        }
      })
      return () => {
        unsubscribePullRequestOpen()
        unsubscribeThreadUpdates()
        unsubscribeGitHubSignIn()
        if (findNavState.gitFindOpen) this.root.handlePrListAction.find.close()
      }
    })

    $effect(() => {
      // The board may not be in memory yet when the panel mounts first (remote
      // shell, deep link). Loading it is idempotent and never blocks rendering.
      void scopeState.ensureBoardLoaded(this.root.props.projectId)
    })
  }
}
