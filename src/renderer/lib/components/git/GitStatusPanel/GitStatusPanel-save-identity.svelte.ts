import { gitState } from '$lib/stores/git.svelte'
import type { GitStatusPanel } from './GitStatusPanel-board.svelte'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the GitStatusPanel board. */
export class GitStatusPanelSaveIdentity extends BoardUnit<GitStatusPanel> {
  constructor(root: GitStatusPanel) {
    super(root)
  }
  showIdentityForm = $state(false)

  identityName = $state('')

  identityEmail = $state('')

  async saveIdentity(): Promise<void> {
    await gitState.setIdentity(this.root.props.projectId, this.identityName, this.identityEmail)
    if (!gitState.error) this.showIdentityForm = false
  }
}
