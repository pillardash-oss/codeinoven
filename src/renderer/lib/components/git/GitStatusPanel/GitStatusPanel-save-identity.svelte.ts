import { gitState } from '$lib/stores/git.svelte'
import type { GitStatusPanel } from './GitStatusPanel-board.svelte'
/** One concern of the GitStatusPanel board. */
export class GitStatusPanelSaveIdentity {
  #root: GitStatusPanel | undefined
  /** The board this unit belongs to; set before any member of it runs. */
  get root(): GitStatusPanel {
    if (!this.#root)
      throw new Error('GitStatusPanelSaveIdentity read its board before it was bound')
    return this.#root
  }
  constructor(root: GitStatusPanel) {
    this.#root = root
  }
  showIdentityForm = $state(false)

  identityName = $state('')

  identityEmail = $state('')

  async saveIdentity(): Promise<void> {
    await gitState.setIdentity(this.root.props.projectId, this.identityName, this.identityEmail)
    if (!gitState.error) this.showIdentityForm = false
  }
}
