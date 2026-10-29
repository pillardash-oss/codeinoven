import { scopeState } from '$lib/stores/scope.svelte'
import type { GitStatusPanel } from './GitStatusPanel-board.svelte'
/** One concern of the GitStatusPanel board. */
export class GitStatusPanelScopeHealth {
  #root: GitStatusPanel | undefined
  /** The board this unit belongs to; set before any member of it runs. */
  get root(): GitStatusPanel {
    if (!this.#root) throw new Error('GitStatusPanelScopeHealth read its board before it was bound')
    return this.#root
  }
  constructor(root: GitStatusPanel) {
    this.#root = root
  }
  /**
   * Health of the scope this panel is attached to. A managed checkout that is
   * gone (or otherwise unhealthy) is why every Git operation here fails, so the
   * panel offers the repair instead of the raw failure text.
   */
  scopeHealth = $derived(
    scopeState.healthFor(this.root.props.scopeBucketId, this.root.props.projectId)
  )

  scopeUnhealthy = $derived(
    this.scopeHealth !== undefined && this.scopeHealth.category !== 'healthy'
  )
}
