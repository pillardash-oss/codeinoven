import { isActivityOnlyUserMessage } from './thread-turn-parts'
import { messageText } from './thread-message-presentation'
import type { AgentMessage, UserMessageSummary } from '$shared/types'

/**
 * Conversation history rules: the size of one mounted window, how the history
 * panel's user-message list is assembled, and how far back a multi-page jump
 * has to reach. All of it is a plain function of the persisted messages.
 */

/** How many messages one history page mounts into the transcript. */
export const HISTORY_WINDOW_SIZE = 40

/**
 * The user-message list shown by the history panel: persisted summaries merged
 * with the user messages currently in the mirror. Messages present in both win
 * in favour of the mirror copy, because the mirror is the fresher snapshot of
 * the same row.
 */
export function mergedUserMessageSummaries(
  messages: readonly AgentMessage[],
  fullUserMessageHistory: readonly UserMessageSummary[]
): UserMessageSummary[] {
  const byId: Record<string, UserMessageSummary> = {}
  for (const entry of fullUserMessageHistory) byId[entry.id] = entry
  for (const message of messages) {
    if (message.role !== 'user') continue
    byId[message.id] = {
      id: message.id,
      content: messageText(message),
      createdAt: message.createdAt
    }
  }
  return Object.values(byId).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}

/**
 * The index `pages` real prompts before `fromIndex`, or -1 when the loaded
 * history does not reach that far. Activity-only user messages are skipped, so
 * a compaction notice or sub-agent envelope can never be counted as a prompt.
 */
export function promptPagesBefore(
  messages: readonly AgentMessage[],
  fromIndex: number,
  pages: number
): number {
  let cursor = fromIndex
  for (let page = 0; page < pages; page++) {
    let found = -1
    for (let i = cursor - 1; i >= 0; i--) {
      const message = messages[i]
      if (!message) return -1
      if (message.role !== 'user') continue
      if (isActivityOnlyUserMessage(message)) continue
      found = i
      break
    }
    if (found === -1) return -1
    cursor = found
  }
  return cursor
}
