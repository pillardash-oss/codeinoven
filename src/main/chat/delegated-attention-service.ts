import type { DelegatedAttentionEntry } from '../../lib/delegated-attention'
import type { ChatEngine } from './chat-engine'
import { Logger } from '../system/logger'

/**
 * The attention a dispatched thread is asking for, mirrored into the conversation
 * that dispatched it.
 *
 * A dispatched thread never notifies the user and never waits to be found: its
 * question, secret or permission is drawn in the conversation that started the
 * work, as the very same card the child thread shows. That is deliberate: the card
 * is the app's own, so an answer given in either place settles the one request, and
 * no agent has to relay a decision on the user's behalf.
 *
 * The mirror is a read, never a copy. Nothing is duplicated and nothing is stored:
 * the pending request stays owned by the child thread, and this only answers which
 * of those requests belong to the conversation the user has open.
 */

/** How far a dispatch chain is walked, so a chain that loops can never hang a read. */
const MAX_CHAIN_HOPS = 5

/** The root of a dispatch chain: the conversation a person actually opened. */
async function chainRoot(
  engine: ChatEngine,
  projectId: string,
  threadId: string
): Promise<{ projectId: string; threadId: string } | null> {
  let currentProject = projectId
  let currentThread = threadId
  const seen = new Set<string>()
  for (let hop = 0; hop < MAX_CHAIN_HOPS; hop++) {
    const key = `${currentProject}:${currentThread}`
    if (seen.has(key)) return null
    seen.add(key)
    const thread = await engine.threadManager.getThread(currentProject, currentThread)
    if (!thread) return null
    const origin = thread.dispatchOrigin
    if (!origin) return { projectId: currentProject, threadId: currentThread }
    currentProject = origin.initiatorProjectId
    currentThread = origin.initiatorThreadId
  }
  return null
}

/**
 * Every request the threads dispatched from this conversation are waiting on.
 *
 * Reads the live pending maps rather than a registry, so what the card shows is
 * exactly what the driver is blocked on. A request whose thread is gone, or whose
 * chain does not lead to this conversation, is not part of the answer, and neither
 * is a request the conversation raised itself: its own card already sits in it.
 */
export async function listDelegatedAttention(
  engine: ChatEngine,
  projectId: string,
  threadId: string
): Promise<DelegatedAttentionEntry[]> {
  const entries: DelegatedAttentionEntry[] = []

  /** The blocked thread's own label, when its chain leads to this conversation. */
  const label = async (
    childProjectId: string,
    childThreadId: string
  ): Promise<{ title: string; assistantId?: string } | null> => {
    if (childProjectId === projectId && childThreadId === threadId) return null
    const root = await chainRoot(engine, childProjectId, childThreadId)
    if (!root || root.projectId !== projectId || root.threadId !== threadId) return null
    const thread = await engine.threadManager.getThread(childProjectId, childThreadId)
    if (!thread?.dispatchOrigin?.initiatorThreadId) return null
    return {
      title: thread.title,
      ...(thread.assistantId ? { assistantId: thread.assistantId } : {})
    }
  }

  for (const pending of engine.pendingQuestions.values()) {
    const child = await label(pending.request.projectId, pending.request.threadId)
    if (!child) continue
    entries.push({
      kind: pending.request.questions.some((question) => question.secretRequest === true)
        ? 'secret'
        : 'question',
      projectId: pending.request.projectId,
      threadId: pending.request.threadId,
      threadTitle: child.title,
      ...(child.assistantId ? { assistantId: child.assistantId } : {}),
      requestId: pending.request.requestId,
      question: pending.request
    })
  }

  // A dispatched thread parked on a provider wait is reported the same way: the
  // conversation that started the work has to know it is waiting, not running.
  for (const pending of engine.state.retryScheduler?.listPending() ?? []) {
    const child = await label(pending.projectId, pending.threadId)
    if (!child) continue
    entries.push({
      kind: 'retry',
      projectId: pending.projectId,
      threadId: pending.threadId,
      threadTitle: child.title,
      ...(child.assistantId ? { assistantId: child.assistantId } : {}),
      requestId: `retry-${pending.sessionId}`,
      retry: {
        ...(pending.retryAt !== undefined ? { retryAt: pending.retryAt } : {}),
        issueKind: pending.issueKind,
        message: pending.issueMessage
      }
    })
  }

  for (const pending of engine.state.pendingPermissions.values()) {
    const child = await label(pending.session.projectId, pending.session.threadId)
    if (!child) continue
    entries.push({
      kind: 'permission',
      projectId: pending.session.projectId,
      threadId: pending.session.threadId,
      threadTitle: child.title,
      ...(child.assistantId ? { assistantId: child.assistantId } : {}),
      requestId: pending.request.id,
      permission: pending.request
    })
  }

  return entries
}

/** A mirror read that failed, logged so a missing card is never a silent mystery. */
export function logDelegatedAttentionFailure(error: unknown): void {
  Logger.dev('Delegated attention read failed:', error)
}
