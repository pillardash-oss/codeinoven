import type { GitSyncDirection } from '$shared/types'
import type { GitStatusPanel } from './GitStatusPanel-board.svelte'
/** One concern of the GitStatusPanel board. */
export class GitStatusPanelSyncPeerOpen {
  #root: GitStatusPanel | undefined
  /** The board this unit belongs to; set before any member of it runs. */
  get root(): GitStatusPanel {
    if (!this.#root)
      throw new Error('GitStatusPanelSyncPeerOpen read its board before it was bound')
    return this.#root
  }
  constructor(root: GitStatusPanel) {
    this.#root = root
  }
  /**
   * Peer chooser, opened from the Sync menu's branch entries. It owns the other
   * end's selection and the sync itself, so the panel only says which direction
   * the user started from.
   */
  syncPeerOpen = $state(false)

  syncPeerDirection = $state<GitSyncDirection>('from')

  /** The peer chooser has to be opened: the other end is the whole choice. */
  openSyncPeer(direction: GitSyncDirection): void {
    this.syncPeerDirection = direction
    this.syncPeerOpen = true
  }

  closeSyncPeer(): void {
    this.syncPeerOpen = false
  }

  /** The chooser is gone the moment a strategy is chosen: the run has its own panel. */
  syncPeerStarted(): void {
    this.syncPeerOpen = false
  }
}
