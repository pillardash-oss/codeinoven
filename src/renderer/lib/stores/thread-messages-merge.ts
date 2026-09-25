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

/** Whether two messages carry the same parts, by id and position. */
function samePartIds(cached: AgentMessage, incoming: AgentMessage): boolean {
  if (cached.parts.length !== incoming.parts.length) return false
  for (let index = 0; index < cached.parts.length; index++) {
    if (cached.parts[index]?.id !== incoming.parts[index]?.id) return false
  }
  return true
}

/** Linear merge of two lists that are each already ordered by `compareMessages`. */
function mergeOrderedMessages(
  local: readonly AgentMessage[],
  additions: readonly AgentMessage[]
): AgentMessage[] {
  const merged: AgentMessage[] = []
  let left = 0
  let right = 0
  while (left < local.length && right < additions.length) {
    const fromLocal = local[left]
    const fromAdditions = additions[right]
    if (compareMessages(fromLocal, fromAdditions) <= 0) {
      merged.push(fromLocal)
      left += 1
    } else {
      merged.push(fromAdditions)
      right += 1
    }
  }
  for (; left < local.length; left++) merged.push(local[left])
  for (; right < additions.length; right++) merged.push(additions[right])
  return merged
}

/** Result of a page merge: the messages plus whether the transcript's shape
 *  changed, which is what a structure-keyed reader needs to know. */
export interface MergePageResult {
  messages: AgentMessage[]
  /**
   * True when the merge changed message identity, order, or turn-level state
   * (role, timestamps, part membership, or a user message's text). A part that
   * only grew does not set it, so the transcript index can be reused across
   * streamed refreshes.
   */
  structural: boolean
}

/**
 * Merge a bounded history page without discarding pages already loaded for the
 * thread.
 *
 * Both inputs are already ordered   a history page is a contiguous window of the
 * server's ordered set, a refresh re-sends rows the cache already holds, and the
 * local list is a previous result of this function   so the merge walks them
 * instead of rebuilding a record of every message and re-sorting the union. That
 * mattered: the old form ran `Object.fromEntries` + `Object.values` + a
 * comparator sort over the whole transcript on every `thread:updated` refresh.
 */
export function mergePageMessages(
  local: AgentMessage[],
  pageMessages: AgentMessage[]
): MergePageResult {
  if (pageMessages.length === 0) return { messages: local, structural: false }

  const indexById = new Map<string, number>()
  for (let index = 0; index < local.length; index++) {
    indexById.set(local[index].id, index)
  }

  let merged: AgentMessage[] | null = null
  let structural = false
  let reordered = false
  const additions = new Map<string, AgentMessage>()

  for (const message of pageMessages) {
    const index = indexById.get(message.id)
    if (index === undefined) {
      additions.set(message.id, message)
      structural = true
      continue
    }
    const cached = local[index]
    if (cached.createdAt !== message.createdAt) reordered = true
    if (
      cached.role !== message.role ||
      cached.createdAt !== message.createdAt ||
      cached.completedAt !== message.completedAt ||
      !samePartIds(cached, message) ||
      // User messages never stream, so a text difference on one is a real
      // change of content rather than a part this turn is still growing.
      (message.role === 'user' && messageText(cached) !== messageText(message))
    ) {
      structural = true
    }
    if (merged === null) merged = [...local]
    merged[index] = mergeMessageSnapshot(cached, message)
  }

  const base = merged ?? local
  if (additions.size === 0) {
    if (!reordered) return { messages: base, structural }
    return { messages: sortMessages(base), structural: true }
  }
  return {
    messages: mergeOrderedMessages(base, sortMessages([...additions.values()])),
    structural: true
  }
}
