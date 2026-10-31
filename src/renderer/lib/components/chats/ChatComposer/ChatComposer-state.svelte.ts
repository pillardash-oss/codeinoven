import { isMacPlatform } from '$lib/shortcut-display'
import type { ChatComposer } from './ChatComposer-board.svelte'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the ChatComposer board. */
export class ChatComposerState extends BoardUnit<ChatComposer> {
  constructor(root: ChatComposer) {
    super(root)
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
