import { WorkspaceCreateThreadInProject } from './Workspace-create-thread-in-project.svelte'
import { WorkspaceOpenThreadFromSwitcher } from './Workspace-open-thread-from-switcher.svelte'
import { WorkspaceMarkThreadReadAndApply } from './Workspace-mark-thread-read-and-apply.svelte'
import { WorkspaceMergeThreadsInList } from './Workspace-merge-threads-in-list.svelte'
import { WorkspaceSwitcherPanelTabs } from './Workspace-switcher-panel-tabs.svelte'
import { WorkspacePanelExitMs } from './Workspace-panel-exit-ms.svelte'
import { WorkspaceAppBackgroundPanelKinds } from './Workspace-app-background-panel-kinds.svelte'
import { WorkspaceOpenThreadScopeView } from './Workspace-open-thread-scope-view.svelte'
import { WorkspaceTemporaryChatTabs } from './Workspace-temporary-chat-tabs.svelte'
import { WorkspaceEnsureRecentScopeBoards } from './Workspace-ensure-recent-scope-boards.svelte'
import { WorkspaceFocusSubagent } from './Workspace-focus-subagent.svelte'
import { WorkspaceContextPanelRows } from './Workspace-context-panel-rows.svelte'
import { WorkspaceJumpToHistoryMessage } from './Workspace-jump-to-history-message.svelte'
import { WorkspaceContextPanelColumns } from './Workspace-context-panel-columns.svelte'
import { WorkspaceState } from './Workspace-state.svelte'
import { WorkspaceEffects } from './Workspace-effects.svelte'
import type { WorkspaceSurfaceProps } from './Workspace-types'
/**
 * The Workspace board: one instance per concern, each holding this board.
 *
 * It is built during the component's own setup, so an `$effect` a unit registers
 * is owned by the component and tears down with it. A unit reads the props
 * through this board, so a prop that changes keeps every `$derived` live.
 */
export class Workspace {
  private readonly readProps: () => WorkspaceSurfaceProps
  readonly createThreadInProject = new WorkspaceCreateThreadInProject(this)
  readonly openThreadFromSwitcher = new WorkspaceOpenThreadFromSwitcher(this)
  readonly markThreadReadAndApply = new WorkspaceMarkThreadReadAndApply(this)
  readonly mergeThreadsInList = new WorkspaceMergeThreadsInList(this)
  readonly switcherPanelTabs = new WorkspaceSwitcherPanelTabs(this)
  readonly panelExitMs = new WorkspacePanelExitMs(this)
  readonly appBackgroundPanelKinds = new WorkspaceAppBackgroundPanelKinds(this)
  readonly openThreadScopeView = new WorkspaceOpenThreadScopeView(this)
  readonly temporaryChatTabs = new WorkspaceTemporaryChatTabs(this)
  readonly ensureRecentScopeBoards = new WorkspaceEnsureRecentScopeBoards(this)
  readonly focusSubagent = new WorkspaceFocusSubagent(this)
  readonly contextPanelRows = new WorkspaceContextPanelRows(this)
  readonly jumpToHistoryMessage = new WorkspaceJumpToHistoryMessage(this)
  readonly contextPanelColumns = new WorkspaceContextPanelColumns(this)
  readonly state = new WorkspaceState(this)
  readonly effects = new WorkspaceEffects(this)
  constructor(readProps: () => WorkspaceSurfaceProps) {
    this.readProps = readProps
    this.state.bind()
    this.effects.init()
  }
  get props(): WorkspaceSurfaceProps {
    return this.readProps()
  }
}
/** Build the board from the surface props. */
export function createWorkspace(readProps: () => WorkspaceSurfaceProps): Workspace {
  return new Workspace(readProps)
}
