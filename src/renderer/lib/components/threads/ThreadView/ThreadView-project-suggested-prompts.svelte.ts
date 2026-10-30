import type { ThreadView } from './ThreadView-board.svelte'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the ThreadView board. */
export class ThreadViewProjectSuggestedPrompts extends BoardUnit<ThreadView> {
  constructor(root: ThreadView) {
    super(root)
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
