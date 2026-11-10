import { randomUUID } from 'node:crypto'
import type { ChatEngine } from '../chat-engine'
import type {
  AgentMessage,
  AgentPart,
  DirectReplyTarget,
  PromptAttachment,
  Thread
} from '../../../lib/types'
import { broadcastThreadMessagesChanged } from '../thread-events'
import { validateEntityId } from '../../ipc/ipc-validation'

/** How far a dispatch chain is walked, so a loop can never hang a reply. */
const MAX_CHAIN_HOPS = 5
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
    if (targetProjectId === fromProjectId && targetThreadId === fromThreadId) {
      throw new Error('That conversation is the one already open.')
    }

    const target = await this.host.threadManager.getThreadById(targetThreadId)
    // The id comes from a bubble in this conversation, so a target that is not a
    // child of it is a stale transcript or a fabricated id, never a thread the
    // user is looking at.
    if (!target || target.projectId !== targetProjectId) {
      throw new Error('That conversation no longer exists.')
    }
    await this.assertDispatchedFrom(target, fromProjectId, fromThreadId)
    if (!target.settings) {
      throw new Error('That conversation has no model yet, so it cannot take a message.')
    }

    // Delivery first: a failed send must not leave a user message in the group
    // claiming words the thread never received.
    await this.host.sendPrompt(
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

    const message = this.replyMessage(input, text)
    await this.host.threadManager.upsertMessages(fromProjectId, fromThreadId, [message])
    // The conversation may be open while this write lands, and the write does
    // not pass through a turn: push it the way any other message is pushed.
    broadcastThreadMessagesChanged(fromProjectId, fromThreadId)
    return message
  }

  /** The user's reply as the group conversation records it. */
  private replyMessage(input: DirectReplyInput, text: string): AgentMessage {
    const id = `direct-reply-${randomUUID()}`
    const createdAt = Date.now()
    const parts: AgentPart[] = [
      {
        type: 'reply',
        id: `${id}-reply`,
        messageID: id,
        projectId: input.target.projectId,
        threadId: input.target.threadId,
        title: input.target.title,
        speakerName: input.target.speakerName,
        repliedMessageId: input.target.messageId,
        excerpt: input.target.excerpt.slice(0, REPLY_EXCERPT_LIMIT)
      },
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

  /**
   * Refuse a thread this conversation did not start.
   *
   * A bubble only ever represents a thread dispatched from the conversation the
   * user is reading, so the same rule is enforced here: answering arbitrary
   * threads from a composer would be a second, weaker way to write into work the
   * conversation has no part in.
   */
  private async assertDispatchedFrom(
    target: Thread,
    fromProjectId: string,
    fromThreadId: string
  ): Promise<void> {
    let current: Thread | null = target
    const seen = new Set<string>()
    for (let hop = 0; hop < MAX_CHAIN_HOPS && current; hop += 1) {
      if (seen.has(current.id)) break
      seen.add(current.id)
      const origin = current.dispatchOrigin
      if (!origin) break
      if (
        origin.initiatorProjectId === fromProjectId &&
        origin.initiatorThreadId === fromThreadId
      ) {
        return
      }
      current = await this.host.threadManager.getThreadById(origin.initiatorThreadId)
    }
    throw new Error('That conversation was not started from this one.')
  }
}
