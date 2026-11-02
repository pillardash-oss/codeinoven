import { SvelteMap } from 'svelte/reactivity'
import { invoke } from '$lib/ipc.svelte'
import type { ThreadContextReference } from '$lib/thread-context'

/**
 * The thread each fork was copied from, cached per thread for the session.
 *
 * A fork's parent is a fact about the thread, not a choice the user made, so it
 * is not stored as a composer attachment: it cannot be detached, it must survive
 * a reload, and it must never make an untouched fork read as a draft. Resolving it
 * once here lets every composer draw it exactly the way an attached thread is
 * drawn, while the send path keeps telling the agent where its context came from
 * (see `firstTurnForkNotice`).
 *
 * One read per opened thread, cached for the rest of the session: a thread's
 * origin never changes, and a thread that was not forked never becomes one.
 */
class ForkOriginStore {
  /** Resolved references by `projectId/threadId`; a resolved null means "not a fork". */
  #references = new SvelteMap<string, ThreadContextReference | null>()
  /**
   * Keys already resolved or in flight. A plain Set on purpose: the effect that
   * asks for an origin must not subscribe to the map it writes, or every resolved
   * reference would re-run that effect for nothing.
   */
  #settled = new Set<string>()

  /** The parent a fork shows above its composer, or null. */
  referenceFor(projectId: string, threadId: string): ThreadContextReference | null {
    return this.#references.get(`${projectId}/${threadId}`) ?? null
  }

  /** Resolve one thread's fork origin, once. Safe to call on every open. */
  ensure(projectId: string, threadId: string): void {
    const key = keyOf(projectId, threadId)
    if (this.#settled.has(key)) return
    this.#settled.add(key)
    void invoke('thread:forkOrigin', projectId, threadId)
      .then((origin) => {
        this.#references.set(
          key,
          origin
            ? {
                projectId: origin.parentProjectId,
                threadId: origin.parentThreadId,
                title: origin.parentTitle
              }
            : null
        )
      })
      .catch(() => {
        // A failed read leaves the answer unknown, so the next open asks again
        // instead of caching a fork as an ordinary thread for the session.
        this.#settled.delete(key)
      })
  }
}

function keyOf(projectId: string, threadId: string): string {
  return `${projectId}/${threadId}`
}

export const forkOrigins = new ForkOriginStore()
