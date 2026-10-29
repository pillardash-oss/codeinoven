import type { DesignBoard } from './DesignCoordinatorPanel-board.svelte'
/** One concern of the DesignBoard board. */
export class DesignBoardHistoryActions {
  #root: DesignBoard | undefined
  /** The board this unit belongs to; set before any member of it runs. */
  get root(): DesignBoard {
    if (!this.#root) throw new Error('DesignBoardHistoryActions read its board before it was bound')
    return this.#root
  }
  constructor(root: DesignBoard) {
    this.#root = root
  }
  /**
   * Undo and Redo for the folder in front, published by the history pane.
   *
   * The pane owns the history read; the board only shows the two steps, so the
   * checkpoint is one click away without opening the pane. A design and a
   * composition share this, which is the point: the same control, the same place.
   */
  historyActions = $state<{
    canUndo: boolean
    canRedo: boolean
    undo: () => void
    redo: () => void
  } | null>(null)

  /** The history pane's Undo and Redo, mirrored into the board header. */
  handleHistoryActions(state: {
    canUndo: boolean
    canRedo: boolean
    undo: () => void
    redo: () => void
  }): void {
    this.historyActions = state
  }
}
