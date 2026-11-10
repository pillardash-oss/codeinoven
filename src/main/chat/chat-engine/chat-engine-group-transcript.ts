import type { AgentMessage, Thread } from '../../../lib/types'
import { isGroupThread } from '../../../lib/types'

/**
 * The conversation one assistant actually had in a group thread.
 *
 * A group chat is one transcript on screen, but it is several conversations
 * under it: the host answers the user, and each peer reports what it did. When
 * the host's provider history is rebuilt or seeded, only the host's own exchange
 * belongs in it. A peer's report was never said to the host, and a reply the
 * user delivered to a peer was answered there, so replaying either one would put
 * words in the conversation that the host did not have.
 *
 * A thread that is not a group keeps every message, so this is safe to apply on
 * every history path.
 */
export function groupConversationTranscript(
  thread: Pick<Thread, 'id' | 'groupParticipants'> | null | undefined,
  messages: AgentMessage[]
): AgentMessage[] {
  if (!thread || !isGroupThread(thread)) return messages
  return messages.filter((message) => {
    if (message.role === 'assistant') {
      // A report written into the group names the thread that spoke it. The
      // host's own rows carry no author thread, and are what the host said.
      const authorThreadId = message.author?.threadId
      return !authorThreadId || authorThreadId === thread.id
    }
    // A reply addressed to a peer belongs to that peer's conversation, not to
    // the host's. A reply to the host itself carries this thread's id.
    return !message.parts.some((part) => part.type === 'reply' && part.threadId !== thread.id)
  })
}
