import { SvelteSet } from 'svelte/reactivity'

import type { ThreadView } from './ThreadView-board.svelte'
/** One concern of the ThreadView board. */
export class ThreadViewExpandedMessageBodies {
  #root: ThreadView | undefined
  /** The board this unit belongs to; set before any member of it runs. */
  get root(): ThreadView {
    if (!this.#root)
      throw new Error('ThreadViewExpandedMessageBodies read its board before it was bound')
    return this.#root
  }
  constructor(root: ThreadView) {
    this.#root = root
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
