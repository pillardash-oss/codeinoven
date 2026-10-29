import { resetPanelModule } from '$lib/lazy-panel'
import type { ThreadView } from './ThreadView-board.svelte'
/** One concern of the ThreadView board. */
export class ThreadViewStudioReloadNonce {
  #root: ThreadView | undefined
  /** The board this unit belongs to; set before any member of it runs. */
  get root(): ThreadView {
    if (!this.#root)
      throw new Error('ThreadViewStudioReloadNonce read its board before it was bound')
    return this.#root
  }
  constructor(root: ThreadView) {
    this.#root = root
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
