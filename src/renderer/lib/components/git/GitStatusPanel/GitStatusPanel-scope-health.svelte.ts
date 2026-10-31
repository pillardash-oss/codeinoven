import { scopeState } from '$lib/stores/scope.svelte'
import type { GitStatusPanel } from './GitStatusPanel-board.svelte'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the GitStatusPanel board. */
export class GitStatusPanelScopeHealth extends BoardUnit<GitStatusPanel> {
  constructor(root: GitStatusPanel) {
    super(root)
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
