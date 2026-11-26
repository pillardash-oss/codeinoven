import type { ChildSessionInfo } from './chat-engine-types'

/**
 * Whether a provider wait may be scheduled on this session.
 *
 * A pawn runs inside a child session, but that session IS its own thread's
 * session, so the app can park and resume that thread exactly like a normal
 * one. A nested sub-agent is different: its child session belongs to the
 * parent's thread and turn, so resuming the child would resume the parent.
 * Only a child session that owns its thread qualifies for its own retry.
 */
export function retryResumesOwnThread(
  owner: Pick<ChildSessionInfo, 'threadId' | 'parentSessionId'> | undefined,
  sessionThreadId: string
): boolean {
  if (owner === undefined) return true
  return owner.parentSessionId === undefined && owner.threadId === sessionThreadId
}
