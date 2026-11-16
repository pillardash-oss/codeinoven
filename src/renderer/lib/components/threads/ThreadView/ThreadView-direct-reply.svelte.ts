import { tick } from 'svelte'
import { invoke } from '$lib/ipc.svelte'
import { BoardUnit } from '$lib/components/board-unit'
import type {
  DirectReplyTarget,
  PromptAttachment,
  PromptAssignmentTaskReference,
  PromptProjectReference
} from '$shared/types'
import type { ThreadView } from './ThreadView-board.svelte'

/**
 * Answering one conversation from inside the conversation that collected it.
 *
 * A group chat shows the replies several threads produced, so the bubble a user
 * is reading is a door back into the thread that spoke it: attaching it to the
 * composer addresses their next words to that thread, and the message they send
 * is recorded here as a reply carrying the quote they answered.
 *
 * The target lives on the board rather than in the conversation or the composer,
 * because both need it: the bubble attaches it and the composer shows it, and a
 * value either side owned would have to be copied to the other.
 */
export class ThreadViewDirectReply extends BoardUnit<ThreadView> {
  /** The conversation the composer is replying into, when the user attached one. */
  target = $state<DirectReplyTarget | null>(null)
  /** True while the reply is being delivered, so the composer cannot send twice. */
  sending = $state(false)
  /** Why the last reply could not be delivered, shown beside the attached chip. */
  error = $state('')

  constructor(root: ThreadView) {
    super(root)
  }

  /** Point the composer at one conversation. */
  attach(target: DirectReplyTarget): void {
    this.target = target
    this.error = ''
    // Attaching a quote is the user saying what they want to answer, so the
    // words are next: the composer takes the caret instead of the reply control
    // keeping it, which left the reader typing into a focused icon button.
    void tick().then(() => this.root.state.composer?.focusComposerAtSavedCaret())
  }

  /** Detach the conversation, so the next message goes to the open one again. */
  clear(): void {
    this.target = null
    this.error = ''
  }

  /**
   * Deliver the composer's message to the attached conversation.
   *
   * Returns false when the delivery failed, so the caller keeps the draft in the
   * composer instead of dropping words the thread never received. On success the
   * attachment is dropped: it applied to exactly that one message.
   */
  async send(input: {
    text: string
    attachments: PromptAttachment[]
    projectReferences: PromptProjectReference[]
    taskReferences: PromptAssignmentTaskReference[]
  }): Promise<boolean> {
    const target = this.target
    if (!target || this.sending) return false
    if (input.text.trim().length === 0 && input.attachments.length === 0) return false
    this.sending = true
    this.error = ''
    try {
      await invoke(
        'agent:replyToThread',
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id,
        target,
        input.text,
        input.attachments
      )
      this.target = null
      return true
    } catch (error) {
      this.error =
        error instanceof Error ? error.message : 'The reply could not reach that conversation.'
      return false
    } finally {
      this.sending = false
    }
  }

  /** Scroll the conversation to the reply that was answered, and mark it. */
  async reveal(messageId: string): Promise<void> {
    // A quoted reply is usually far outside the mounted window, and asking the
    // transcript for it through the jump path is what loads the window around it
    // and detaches the live tail: without that detach the smooth scroll was
    // pulled straight back to the latest message, so the quote looked inert.
    await this.root.loadOlderMessages.jumpToMessage(messageId)
    const element = document.getElementById(`msg-${messageId}`)
    if (!element) return
    // The quote is a link back to the words it answered, so the reply lands on
    // screen with a mark on it rather than leaving the reader to find the spot.
    element.animate(
      [{ outline: '2px solid var(--color-accent)' }, { outline: '2px solid transparent' }],
      { duration: 1100, easing: 'ease-out' }
    )
  }
}
