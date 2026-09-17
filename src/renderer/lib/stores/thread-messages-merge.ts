import type { AgentMessage, AgentPart, AgentProviderIssue } from '$shared/types'

/**
 * Pure message-merging rules for the thread-messages cache:
 * reconciliation of a server snapshot with local optimistic state, bounded
 * history-page merging, and the never-downgrade part/message merge. Keeping
 * these stateless lets the cache controller stay a thin state machine.
 */
export interface ThreadMessagesEntry {
  messages: AgentMessage[]
  /** Monotonic renderer revision for stream-driven DOM effects such as tailing. */
  revision: number
  loaded: boolean
  loading: boolean
  hasOlder: boolean
  error: string
  runIssue: AgentProviderIssue | null
  /** User messages held by the chat engine before delivery to the harness,
   *  the steer-undo window. Keyed by user message id. */
  heldSteerIds: Set<string>
}

/** Bounded latest-message window warmed for navigation. Keeping this smaller
 *  than a history page lets a selected thread mount once without blocking the
 *  renderer or growing the conversation across several visible frames. */
export const THREAD_MESSAGE_PRELOAD_WINDOW = 12

export const EMPTY_MESSAGES: AgentMessage[] = []

export function threadKey(projectId: string, threadId: string): string {
  return `${projectId}:${threadId}`
}

/** Whether the newest turn's user prompt is inside this page. Activity-only
 *  envelopes (compaction notices, sub-agent reports) ride the user role
 *  mid-turn and do not count as the turn's prompt. */
export function containsNewestTurnPrompt(messages: AgentMessage[]): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!message) return false
    if (message.role !== 'user') continue
    const activityOnly =
      message.parts.length > 0 &&
      message.parts.every((part) => part.type === 'compaction' || part.type === 'subagent')
    if (!activityOnly) return true
  }
  return false
}

export function messageText(msg: AgentMessage): string {
  return msg.parts
    .filter((p): p is Extract<AgentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
}

export function mergePartSnapshot(cached: AgentPart, incoming: AgentPart): AgentPart {
  if (
    cached.type === incoming.type &&
    (cached.type === 'text' || cached.type === 'reasoning') &&
    (incoming.type === 'text' || incoming.type === 'reasoning') &&
    cached.text.length > incoming.text.length &&
    cached.text.startsWith(incoming.text)
  ) {
    return { ...incoming, text: cached.text }
  }
  return incoming
}

/** A disk/provider snapshot may trail the live event stream; never downgrade cached parts. */
export function mergeMessageSnapshot(cached: AgentMessage, incoming: AgentMessage): AgentMessage {
  const incomingParts = new Map(incoming.parts.map((part) => [part.id, part]))
  const cachedPartIds = new Set(cached.parts.map((part) => part.id))
  return {
    ...cached,
    ...incoming,
    parts: [
      ...cached.parts.map((part) => {
        const replacement = incomingParts.get(part.id)
        return replacement ? mergePartSnapshot(part, replacement) : part
      }),
      ...incoming.parts.filter((part) => !cachedPartIds.has(part.id))
    ]
  }
}

/** Messages sort by createdAt, stable by id. */
export function compareMessages(a: AgentMessage, b: AgentMessage): number {
  const timeDiff = a.createdAt - b.createdAt
  if (timeDiff !== 0) return timeDiff
  return a.id.localeCompare(b.id)
}

export function sortMessages(messages: AgentMessage[]): AgentMessage[] {
  return [...messages].sort(compareMessages)
}

/**
 * Merge a server snapshot with the local cache. Stable renderer-generated IDs
 * are forwarded through every driver, so local optimistic messages are kept
 * until the server confirms that exact ID, and live assistant messages from
 * the active turn are retained while the provider or disk snapshot catches up
 * with the event stream.
 */
export function mergeReconciledMessages(
  local: AgentMessage[],
  serverMessages: AgentMessage[],
  activeTurnUserMessageId: string | null | undefined
): AgentMessage[] {
  const serverById = new Map(serverMessages.map((m) => [m.id, m]))
  const localById = new Map(local.map((message) => [message.id, message]))
  const activeTurnStartedAt = activeTurnUserMessageId
    ? localById.get(activeTurnUserMessageId)?.createdAt
    : undefined
  const keptLocal = local.filter(
    (message) =>
      !serverById.has(message.id) &&
      (message.role === 'user' ||
        (activeTurnStartedAt !== undefined && message.createdAt >= activeTurnStartedAt))
  )
  return sortMessages([
    ...serverMessages.map((message) => {
      const cached = localById.get(message.id)
      return cached ? mergeMessageSnapshot(cached, message) : message
    }),
    ...keptLocal
  ])
}

/** Merge a bounded history page without discarding pages already loaded for the thread. */
export function mergePageMessages(
  local: AgentMessage[],
  pageMessages: AgentMessage[]
): AgentMessage[] {
  // This accumulator is deliberately plain data, not renderer state. A
  // reactive map here would add proxy tracking to every history-page load and
  // wake unrelated dependents while a live trace is streaming.
  const mergedById: Record<string, AgentMessage> = Object.fromEntries(
    local.map((message) => [message.id, message])
  )
  for (const message of pageMessages) {
    const cached = mergedById[message.id]
    mergedById[message.id] = cached ? mergeMessageSnapshot(cached, message) : message
  }
  return sortMessages(Object.values(mergedById))
}
