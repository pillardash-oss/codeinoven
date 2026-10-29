import { type ComposerDropRegion } from '../chat-composer-drop'
import type { ChatComposer } from './ChatComposer-board.svelte'
/** One concern of the ChatComposer board. */
export class ChatComposerClearDropState {
  #root: ChatComposer | undefined
  /** The board this unit belongs to; set before any member of it runs. */
  get root(): ChatComposer {
    if (!this.#root)
      throw new Error('ChatComposerClearDropState read its board before it was bound')
    return this.#root
  }
  constructor(root: ChatComposer) {
    this.#root = root
  }
  isDragging = $state(false)

  /** Viewport geometry of the conversation region while files are in flight, so
   *  the overlay covers exactly that region (never the sidebars). */
  dropRegion = $state<ComposerDropRegion | null>(null)

  /** Hide the drop overlay when the DropZone reports a drop. */
  clearDropState(): void {
    this.isDragging = false
    this.dropRegion = null
  }
}
