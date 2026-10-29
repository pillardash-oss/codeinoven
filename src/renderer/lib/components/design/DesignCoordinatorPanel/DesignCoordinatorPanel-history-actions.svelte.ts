import type { DesignBoard } from './DesignCoordinatorPanel-board.svelte'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the DesignBoard board. */
export class DesignBoardHistoryActions extends BoardUnit<DesignBoard> {
  constructor(root: DesignBoard) {
    super(root)
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
