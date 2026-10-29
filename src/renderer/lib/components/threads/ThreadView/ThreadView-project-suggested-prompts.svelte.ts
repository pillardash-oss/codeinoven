import type { ThreadView } from './ThreadView-board.svelte'
/** One concern of the ThreadView board. */
export class ThreadViewProjectSuggestedPrompts {
  #root: ThreadView | undefined
  /** The board this unit belongs to; set before any member of it runs. */
  get root(): ThreadView {
    if (!this.#root)
      throw new Error('ThreadViewProjectSuggestedPrompts read its board before it was bound')
    return this.#root
  }
  constructor(root: ThreadView) {
    this.#root = root
  }
  projectSuggestedPrompts = [
    'Summarize this project: architecture, key modules, and entry points',
    'Review the codebase and list the top improvement opportunities',
    'Find and fix a bug   explain the root cause as you go'
  ]

  chatSuggestedPrompts = [
    'Research a question using my device',
    'Run a task for me on this computer',
    'Brainstorm ideas with me'
  ]

  suggestedPrompts = $derived(
    this.root.props.promptSuggestions ??
      (this.root.props.chatMode ? this.chatSuggestedPrompts : this.projectSuggestedPrompts)
  )
}
