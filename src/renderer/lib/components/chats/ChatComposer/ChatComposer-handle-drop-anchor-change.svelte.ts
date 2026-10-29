import type { ChatComposer } from './ChatComposer-board.svelte'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the ChatComposer board. */
export class ChatComposerHandleDropAnchorChange extends BoardUnit<ChatComposer> {
  constructor(root: ChatComposer) {
    super(root)
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
