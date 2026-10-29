import { resetPanelModule } from '$lib/lazy-panel'
import type { ThreadView } from './ThreadView-board.svelte'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the ThreadView board. */
export class ThreadViewStudioReloadNonce extends BoardUnit<ThreadView> {
  constructor(root: ThreadView) {
    super(root)
  }
  /**
   * Bumped by a studio's Retry to rebuild its `{#key}` and re-run its `{#await}`.
   * The studio documents are Engineering-only surfaces, so their chunks load on
   * the first open instead of with the first screen, and a chunk that failed to
   * load must be retryable rather than leaving the studio blank.
   */
  studioReloadNonce = $state(0)

  retryStudio(key: string): void {
    resetPanelModule(key)
    this.studioReloadNonce += 1
  }
}
