import { invoke } from '$lib/ipc.svelte'
import type { GitStatusPanel } from './GitStatusPanel-board.svelte'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the GitStatusPanel board. */
export class GitStatusPanelRefreshAgentTurnState extends BoardUnit<GitStatusPanel> {
  constructor(root: GitStatusPanel) {
    super(root)
  }
  agentTurnActive = $state(false)

  async refreshAgentTurnState(): Promise<void> {
    if (!this.root.props.threadId) return
    const thread = await invoke(
      'thread:get',
      this.root.props.projectId,
      this.root.props.threadId
    ).catch(() => null)
    this.agentTurnActive = thread?.status === 'executing' || thread?.status === 'planning'
  }
}
