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
  kind: 'question' | 'secret' | 'permission' | 'retry'
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
  /**
   * Set for `retry`: a thread parked on a provider wait. It is not a question
   * anyone has to answer, so it carries the moment the thread resumes by itself
   * and why, which is what the conversation has to know to stop assuming the work
   * is running.
   */
  retry?: {
    /** When the wait is admitted again. Absent for a wait only a person ends. */
    retryAt?: number
    /** Provider-neutral failure kind, for the notice's wording. */
    issueKind: string
    /** The provider's own message, already trimmed for display. */
    message: string
  }
}
