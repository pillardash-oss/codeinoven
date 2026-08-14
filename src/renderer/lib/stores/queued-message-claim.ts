/**
 * Atomic ownership of a persisted queued message.
 *
 * A queued message can be delivered by two independent paths — the background
 * QueuedMessageDispatcher and a mounted ThreadView. Each previously decided
 * independently to send and only cleared the shared recovery entry afterwards,
 * so concurrent idle transitions could double/triple-send the same message.
 *
 * This module is the single source of truth for who currently owns a queued
 * message. Both delivery paths claim synchronously (before any await) and only
 * the claim holder proceeds to send. Because the claim lives here at module
 * scope, it coordinates across every instance of either path.
 */
const claimed = new Set<string>()

function claimKey(projectId: string, threadId: string): string {
  return `${projectId}:${threadId}`
}

/**
 * Attempt to take ownership of a queued message. Returns true only for the
 * first caller; every concurrent caller gets false and must not send.
 */
export function claimQueuedMessage(projectId: string, threadId: string): boolean {
  const key = claimKey(projectId, threadId)
  if (claimed.has(key)) return false
  claimed.add(key)
  return true
}

/** Release ownership once delivery completes, fails, or is deferred. */
export function releaseQueuedMessage(projectId: string, threadId: string): void {
  claimed.delete(claimKey(projectId, threadId))
}
