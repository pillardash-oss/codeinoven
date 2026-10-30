import { type ComposerDropRegion } from '../chat-composer-drop'
import type { ChatComposer } from './ChatComposer-board.svelte'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the ChatComposer board. */
export class ChatComposerClearDropState extends BoardUnit<ChatComposer> {
  constructor(root: ChatComposer) {
    super(root)
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
