import { randomUUID } from 'node:crypto'
import type { ChatEngine } from '../chat-engine'
import type {
  AgentMessage,
  AgentPart,
  DirectReplyTarget,
  PromptAttachment
} from '../../../lib/types'
import { broadcastThreadMessagesChanged } from '../thread-events'
import { validateEntityId } from '../../ipc/ipc-validation'

/** Longest excerpt a reply bubble keeps of the message it answers. */
const REPLY_EXCERPT_LIMIT = 280

/** One direct reply from the conversation the user has open into another thread. */
export interface DirectReplyInput {
  /** The conversation the user is reading: where the reply is recorded. */
  fromProjectId: string
  fromThreadId: string
  target: DirectReplyTarget
  text: string
  attachments: PromptAttachment[]
}

/**
 * Answering a thread from inside the conversation that collected it.
 *
 * A group chat shows the replies several threads produced, so the user answers
 * what they are reading rather than opening another conversation. The message
 * goes to the thread that spoke: it is the user's own prompt there, delivered
 * through the same send path any typed message takes, so it clears a stop latch,
 * steers a running turn, or starts the next turn exactly as it would there.
 *
 * The group keeps a record of it, because a reply the user made has to read as
 * part of the conversation they made it in: a user message carrying the quote it
 * answered and the words that were delivered. The quote is a snapshot, so it
 * keeps reading as the reply it was even after the other thread is renamed.
 */
export class ChatEngineDirectReply {
  constructor(private readonly host: ChatEngine) {}

  async send(input: DirectReplyInput): Promise<AgentMessage> {
    const fromProjectId = validateEntityId(input.fromProjectId, 'Project ID')
    const fromThreadId = validateEntityId(input.fromThreadId, 'Thread ID')
    const targetProjectId = validateEntityId(input.target.projectId, 'Project ID')
    const targetThreadId = validateEntityId(input.target.threadId, 'Thread ID')
    const text = input.text.trim()
    if (text.length === 0 && input.attachments.length === 0) {
      throw new Error('A reply needs something to say.')
    }
    // Answering the conversation the user is already in means chatting with its
    // own assistant: the words are delivered there like any typed message, and
    // only the quote that says which reply they answered is added on top.
    const sameThread = targetProjectId === fromProjectId && targetThreadId === fromThreadId

    const target = await this.host.threadManager.getThreadById(targetThreadId)
    // The id comes from a bubble in this conversation, so a thread that no
    // longer exists is a stale transcript or a fabricated id.
    if (!target || target.projectId !== targetProjectId) {
      throw new Error('That conversation no longer exists.')
    }
    if (!target.settings) {
      throw new Error('That conversation has no model yet, so it cannot take a message.')
    }

    // Delivery first: a failed send must not leave a user message in the group
    // claiming words the thread never received. A reply to one of the group's
    // dispatched runs is answered in that run's own thread, so its settle is
    // not reported back into the group as a fresh handoff.
    if (!sameThread) this.host.don?.delegations.markDirectReply(targetThreadId)
    const delivered = await this.host.sendPrompt(
      target.projectId,
      target.id,
      target.settings,
      text,
      input.attachments,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'user'
    )

    // The same conversation already recorded the words as its own user message.
    // Re-recording them would double the turn, so the quote is merged into that
    // message instead, and the answer reads in place.
    if (sameThread) {
      const message: AgentMessage = {
        ...delivered,
        parts: [
          this.replyPart(input, `direct-reply-${delivered.id}`, delivered.id),
          ...delivered.parts
        ]
      }
      await this.host.threadManager.upsertMessages(fromProjectId, fromThreadId, [message])
      broadcastThreadMessagesChanged(fromProjectId, fromThreadId)
      return message
    }

    const message = this.replyMessage(input, text)
    await this.host.threadManager.upsertMessages(fromProjectId, fromThreadId, [message])
    // The conversation may be open while this write lands, and the write does
    // not pass through a turn: push it the way any other message is pushed.
    broadcastThreadMessagesChanged(fromProjectId, fromThreadId)
    return message
  }

  /** The quote that names the reply these words answered. */
  private replyPart(input: DirectReplyInput, id: string, messageId = id): AgentPart {
    return {
      type: 'reply',
      id: `${id}-reply`,
      messageID: messageId,
      projectId: input.target.projectId,
      threadId: input.target.threadId,
      title: input.target.title,
      speakerName: input.target.speakerName,
      repliedMessageId: input.target.messageId,
      excerpt: input.target.excerpt.slice(0, REPLY_EXCERPT_LIMIT)
    }
  }

  /** The user's reply as the group conversation records it. */
  private replyMessage(input: DirectReplyInput, text: string): AgentMessage {
    const id = `direct-reply-${randomUUID()}`
    const createdAt = Date.now()
    const parts: AgentPart[] = [
      this.replyPart(input, id),
      { type: 'text', id: `${id}-text`, messageID: id, text },
      ...input.attachments.map((attachment, index): AgentPart => ({
        type: 'file',
        id: `${id}-file-${index}`,
        messageID: id,
        mime: attachment.mime,
        url: attachment.url,
        ...(attachment.filename ? { filename: attachment.filename } : {})
      }))
    ]
    // The reply names the thread the words went to so opening the quote lands
    // where they were read.
    return {
      id,
      role: 'user',
      origin: 'user',
      visibility: 'conversation',
      parts,
      createdAt,
      completedAt: createdAt
    }
  }
}
