import type { ChatComposer } from './ChatComposer-board.svelte'
/** One concern of the ChatComposer board. */
export class ChatComposerHandleDropAnchorChange {
  #root: ChatComposer | undefined
  /** The board this unit belongs to; set before any member of it runs. */
  get root(): ChatComposer {
    if (!this.#root)
      throw new Error('ChatComposerHandleDropAnchorChange read its board before it was bound')
    return this.#root
  }
  constructor(root: ChatComposer) {
    this.#root = root
  }
  /** 0x0 out-of-flow element sitting beside the drop overlay. Its viewport
   *  position is the origin the overlay's `position: fixed` resolves against. */
  dropAnchorProbe = $state<HTMLElement | null>(null)

  /** Reports the DropZone's mounted measurement anchor back to this composer so
   *  the overlay resolves its fixed-position origin against it. */
  handleDropAnchorChange(element: HTMLElement | null): void {
    this.dropAnchorProbe = element
  }
}
