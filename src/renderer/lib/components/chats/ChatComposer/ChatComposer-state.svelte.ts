import { isMacPlatform } from '$lib/shortcut-display'
import type { ChatComposer } from './ChatComposer-board.svelte'
/** One concern of the ChatComposer board. */
export class ChatComposerState {
  #root: ChatComposer | undefined
  /** The board this unit belongs to; set before any member of it runs. */
  get root(): ChatComposer {
    if (!this.#root) throw new Error('ChatComposerState read its board before it was bound')
    return this.#root
  }
  constructor(root: ChatComposer) {
    this.#root = root
  }
  /** macOS shows ⌘; Windows/Linux show Ctrl   matches the global send shortcut. */
  sendModifierLabel = isMacPlatform() ? '⌘' : 'Ctrl+'

  speechScope = $derived(
    this.root.props.projectId
      ? ({
          kind: 'project',
          projectId: this.root.props.projectId,
          ...(this.root.props.threadId ? { threadId: this.root.props.threadId } : {})
        } as const)
      : ({
          kind: 'inbox',
          ...(this.root.props.threadId ? { threadId: this.root.props.threadId } : {})
        } as const)
  )

  runUsageCredits(): void {
    if (!this.root.props.usageCreditsCommandId || !this.root.props.onSlashCommand) return
    void this.root.props.onSlashCommand(this.root.props.usageCreditsCommandId, '')
  }
}
