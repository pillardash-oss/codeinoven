import { GitStatusPanelHandlePrListAction } from './GitStatusPanel-handle-pr-list-action.svelte'
import { GitStatusPanelLoadRepoState } from './GitStatusPanel-load-repo-state.svelte'
import { GitStatusPanelConfirmPrMerge } from './GitStatusPanel-confirm-pr-merge.svelte'
import { GitStatusPanelConfirmAcceptAllConflicts } from './GitStatusPanel-confirm-accept-all-conflicts.svelte'
import { GitStatusPanelCloseFullscreenPullRequestTab } from './GitStatusPanel-close-fullscreen-pull-request-tab.svelte'
import { GitStatusPanelSyncPeerOpen } from './GitStatusPanel-sync-peer-open.svelte'
import { GitStatusPanelSaveIdentity } from './GitStatusPanel-save-identity.svelte'
import { GitStatusPanelScopeHealth } from './GitStatusPanel-scope-health.svelte'
import { GitStatusPanelRefreshAgentTurnState } from './GitStatusPanel-refresh-agent-turn-state.svelte'
import { GitStatusPanelState } from './GitStatusPanel-state.svelte'
import { GitStatusPanelEffects } from './GitStatusPanel-effects.svelte'
import type { GitStatusPanelSurfaceProps } from './GitStatusPanel-types'
/**
 * The GitStatusPanel board: one instance per concern, each holding this board.
 *
 * It is built during the component's own setup, so an `$effect` a unit registers
 * is owned by the component and tears down with it. A unit reads the props
 * through this board, so a prop that changes keeps every `$derived` live.
 */
export class GitStatusPanel {
  private readonly readProps: () => GitStatusPanelSurfaceProps
  readonly handlePrListAction = new GitStatusPanelHandlePrListAction(this)
  readonly loadRepoState = new GitStatusPanelLoadRepoState(this)
  readonly confirmPrMerge = new GitStatusPanelConfirmPrMerge(this)
  readonly confirmAcceptAllConflicts = new GitStatusPanelConfirmAcceptAllConflicts(this)
  readonly closeFullscreenPullRequestTab = new GitStatusPanelCloseFullscreenPullRequestTab(this)
  readonly syncPeerOpen = new GitStatusPanelSyncPeerOpen(this)
  readonly saveIdentity = new GitStatusPanelSaveIdentity(this)
  readonly scopeHealth = new GitStatusPanelScopeHealth(this)
  readonly refreshAgentTurnState = new GitStatusPanelRefreshAgentTurnState(this)
  readonly state = new GitStatusPanelState(this)
  readonly effects = new GitStatusPanelEffects(this)
  constructor(readProps: () => GitStatusPanelSurfaceProps) {
    this.readProps = readProps
    this.confirmAcceptAllConflicts.bindChangesView()
    this.confirmPrMerge.bindPrListState()
    this.handlePrListAction.bindSavedView()
    this.handlePrListAction.bindControllers()
    this.loadRepoState.bindControllers()
    this.effects.init()
  }
  get props(): GitStatusPanelSurfaceProps {
    return this.readProps()
  }
}
/** Build the board from the surface props. */
export function createGitStatusPanel(readProps: () => GitStatusPanelSurfaceProps): GitStatusPanel {
  return new GitStatusPanel(readProps)
}
