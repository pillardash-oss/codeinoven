import type { PendingAgentQuestionRequest, PermissionRequest } from './types'

/**
 * The attention a dispatched thread is asking for, as the conversation that
 * dispatched it sees it.
 *
 * A dispatched thread never notifies the user and never waits to be found: its
 * question, secret or permission is drawn in the conversation that started the
 * work, as the same card the child thread shows. The card is the app's own, so an
 * answer given in either place settles the one request, and no agent has to relay
 * a decision on the user's behalf.
 *
 * The mirror is a read, never a copy: `projectId` and `threadId` are the blocked
 * thread's, and every card submits against them, which is what makes the two
 * surfaces one request instead of two.
 */
export interface DelegatedAttentionEntry {
  kind: 'question' | 'secret' | 'permission'
  /** The blocked thread that owns the request. Answers go to these ids. */
  projectId: string
  threadId: string
  /** The blocked thread's title, which is the label the card wears. */
  threadTitle: string
  /** Who the blocked thread works as, so the label can wear its mark. */
  assistantId?: string
  requestId: string
  /** Set for `question` and `secret`: the question card's own payload, untouched. */
  question?: PendingAgentQuestionRequest
  /** Set for `permission`: the permission card's own payload, untouched. */
  permission?: PermissionRequest
}
