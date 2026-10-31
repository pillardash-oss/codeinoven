import { SvelteSet } from 'svelte/reactivity'

import type { ThreadView } from './ThreadView-board.svelte'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the ThreadView board. */
export class ThreadViewExpandedMessageBodies extends BoardUnit<ThreadView> {
  constructor(root: ThreadView) {
    super(root)
  }
  /** The authored messages a reader has opened past the height clamp, by
   *  message id. Session-scoped on purpose: it survives the windowed
   *  transcript unmounting a row, and a fresh thread starts folded. */
  expandedMessageBodies = new SvelteSet<string>()

  toggleMessageBody(messageId: string, expanded: boolean): void {
    if (expanded) this.expandedMessageBodies.add(messageId)
    else this.expandedMessageBodies.delete(messageId)
  }
}
