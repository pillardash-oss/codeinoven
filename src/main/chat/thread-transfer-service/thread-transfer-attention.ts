/**
 * Attention that rides a thread transfer: the card the departing instance was
 * holding when the move stopped its turn.
 *
 * A question card is not part of a thread's persisted state. It lives in the
 * owning process's memory (`ChatEngine.pendingQuestions`), keyed by a request id
 * the harness dialog itself generated, and the transfer stop clears it. Without
 * this module the move silently throws the decision away and the adopting
 * instance resumes the session with a generic `Continue`, so the agent keeps
 * working past a question the user still owed it an answer to.
 *
 * What travels is the card as data: the questions, the options, what the user
 * had already filled in, and the deadline. What cannot travel is the dialog
 * behind it, because that dialog belongs to the process being left behind. The
 * adopting instance therefore re-raises the card and lets the answer start the
 * continuation turn, exactly as the engine already does for a question whose
 * provider process exited while the card was open.
 *
 * Not every card moves, and that is deliberate. A gate whose answer is consumed
 * by the departing process has nothing to continue: a `cio_ask_secret` value, a
 * capability suggestion, an MCP sign-in, a permission for a tool call that was
 * just cancelled, and an image-descriptor decision all settle or die with the
 * run that asked for them. A secret card is excluded for a second reason: its
 * draft is a value, and a value must never travel to another process to be
 * written into a conversation. A brainstorm document approval is keyed to
 * in-memory alignment state of the departing instance, so it is re-asked by the
 * loop there instead of being replayed here.
 */

import type { PendingAgentQuestionRequest } from '../../../lib/types'
import { isBrainstormDocumentQuestion } from '../../../lib/brainstorm/brainstorm-alignment'
import { isMcpSignInQuestion } from '../../../lib/mcp-sign-in'
import { isUtilitySuggestionQuestion } from '../../../lib/utility-suggestion'
import { isSecretQuestion } from '../chat-engine/chat-engine-pure'

/**
 * One question card a release hands to the adopting instance.
 *
 * The request is the same contract the renderer draws, so the adopting instance
 * can re-register it unchanged instead of rebuilding a card from a summary.
 */
export interface HandedOffQuestion {
  request: PendingAgentQuestionRequest
}

/**
 * The part of a pending question the transfer rule reads.
 *
 * Structural rather than the engine's own `PendingQuestionInfo`, so the rule
 * stays a pure decision a test can exercise without a chat engine behind it.
 */
export interface HandOffQuestionCandidate {
  request: PendingAgentQuestionRequest
  /** Present on an app-owned `cio_ask_secret` card whose gateway call is waiting. */
  settleSecret?: unknown
  /** Present on an app-owned `cio_util_suggest` card. */
  settleUtilitySuggestion?: unknown
  /** Present on an app-owned MCP sign-in card. */
  settleMcpSignIn?: unknown
}

/**
 * Whether this card can be re-raised on another instance at all.
 *
 * Everything excluded here has an answer that is consumed by the process being
 * left behind, so moving the card would put a decision in front of the user that
 * nothing can act on.
 */
export function canHandOffQuestion(candidate: HandOffQuestionCandidate): boolean {
  if (candidate.settleSecret || candidate.settleUtilitySuggestion || candidate.settleMcpSignIn) {
    return false
  }
  return !candidate.request.questions.some(
    (question) =>
      isSecretQuestion(question) ||
      isUtilitySuggestionQuestion(question) ||
      isMcpSignInQuestion(question) ||
      isBrainstormDocumentQuestion(question.prompt)
  )
}

/**
 * The cards of one thread that a release carries, in the order they were asked.
 *
 * Only the thread's own card moves: a worker's or a pawn's question belongs to a
 * turn the release stops for good, and the adopting instance has no continuation
 * for it.
 */
export function handedOffQuestions(
  candidates: Iterable<HandOffQuestionCandidate>,
  scope: { projectId: string; threadId: string }
): HandedOffQuestion[] {
  const handed: HandedOffQuestion[] = []
  for (const candidate of candidates) {
    const request = candidate.request
    if (request.projectId !== scope.projectId || request.threadId !== scope.threadId) continue
    if (!canHandOffQuestion(candidate)) continue
    handed.push({ request: requireJsonSafeRequest(request) })
  }
  handed.sort((left, right) => left.request.createdAt - right.request.createdAt)
  return handed
}

/**
 * The request as it will exist in another process.
 *
 * It crosses a filesystem hop as JSON, so it is copied rather than aliased: the
 * departing instance keeps resolving the live request while the copy is written,
 * and a shared object would let one side's bookkeeping move the other's card.
 */
function requireJsonSafeRequest(request: PendingAgentQuestionRequest): PendingAgentQuestionRequest {
  return {
    requestId: request.requestId,
    sessionId: request.sessionId,
    questions: request.questions,
    projectId: request.projectId,
    threadId: request.threadId,
    createdAt: request.createdAt,
    activeQuestionIndex: request.activeQuestionIndex,
    answers: request.answers.map((answer) => [...answer]),
    interactedQuestionIndexes: [...request.interactedQuestionIndexes],
    ...(request.tool ? { tool: request.tool } : {}),
    ...(request.metadata ? { metadata: request.metadata } : {}),
    ...(request.expiresAt !== undefined ? { expiresAt: request.expiresAt } : {})
  }
}
