import { invoke } from '$lib/ipc.svelte'
import type { GitStatusPanel } from './GitStatusPanel-board.svelte'
/** One concern of the GitStatusPanel board. */
export class GitStatusPanelRefreshAgentTurnState {
  #root: GitStatusPanel | undefined
  /** The board this unit belongs to; set before any member of it runs. */
  get root(): GitStatusPanel {
    if (!this.#root)
      throw new Error('GitStatusPanelRefreshAgentTurnState read its board before it was bound')
    return this.#root
  }
  constructor(root: GitStatusPanel) {
    this.#root = root
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
