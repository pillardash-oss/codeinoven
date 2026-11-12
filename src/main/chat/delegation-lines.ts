import { ASSISTANT_SPACE_ID, type MessageAuthor, type Thread } from '../../lib/types'
import type { ChatEngine } from './chat-engine'
import { broadcastThreadMessagesChanged } from './thread-events'

/**
 * One line an assistant writes into a conversation it did not open.
 *
 * Delegated work speaks in the conversation that asked for it: the row carries the
 * speaker as a snapshot and names the thread it spoke from, so a routed question,
 * the announcement of a hire and the answer to a run all read as the same teammate
 * talking in Don's one group chat instead of as app status lines.
 */

/** The speaker a delegated line is written under: the teammate that owns the thread. */
export function teammateAuthor(thread: Thread): MessageAuthor | null {
  const origin = thread.dispatchOrigin
  if (origin?.author) return origin.author
  const assistantId = thread.assistantId ?? origin?.assistantId
  const name = origin?.assistantName?.trim() ?? thread.title.trim()
  if (!assistantId || name.length === 0) return null
  return { assistantId, name }
}

/**
 * Write one app-owned assistant line into a conversation, under the speaker's own
 * name and naming the thread it spoke from.
 *
 * Best effort: the caller's own path (a run's report, a parked question) stays
 * authoritative, so a line that cannot land never fails the work behind it.
 */
export async function writeTeammateLine(
  engine: ChatEngine,
  input: {
    author: MessageAuthor
    thread: Thread
    id: string
    text: string
    /** The conversation the line lands in. Defaults to Don's own thread when the
     *  thread carries a dispatch origin. */
    projectId?: string
    threadId?: string
  }
): Promise<void> {
  const projectId = input.projectId ?? input.thread.dispatchOrigin?.initiatorProjectId
  const threadId = input.threadId ?? input.thread.dispatchOrigin?.initiatorThreadId
  if (!projectId || !threadId) return
  const author = {
    ...input.author,
    projectId: ASSISTANT_SPACE_ID,
    threadId: input.thread.id
  }
  await engine.threadManager.upsertMessages(projectId, threadId, [
    {
      id: input.id,
      role: 'assistant',
      origin: 'assistant',
      visibility: 'conversation',
      author,
      parts: [{ type: 'text', id: `${input.id}-text`, messageID: input.id, text: input.text }],
      createdAt: Date.now(),
      completedAt: Date.now()
    }
  ])
  broadcastThreadMessagesChanged(projectId, threadId)
}
