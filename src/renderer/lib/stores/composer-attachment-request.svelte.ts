import { SvelteMap } from 'svelte/reactivity'

/**
 * A request for a thread's composer to re-read what is attached to it.
 *
 * Attaching a side chat hands its durable worker thread to the parent's
 * composer, which may already be mounted with its attachment row built: the
 * composer seeds that row once, from the persisted recovery entry, and owns it
 * from then on. Writing the attachment is therefore not enough to make it
 * appear on screen, so the surface that made the attachment asks the view that
 * owns the composer to re-seed it.
 *
 * A counter per conversation, not a flag: two attachments made in one gesture
 * must both arrive, and the view answers each request exactly once.
 */
class ComposerAttachmentRequests {
  #requests = new SvelteMap<string, number>()

  /** Ask the conversation's mounted composer to re-read its attachments. */
  request(projectId: string, threadId: string): void {
    const key = keyOf(projectId, threadId)
    this.#requests.set(key, (this.#requests.get(key) ?? 0) + 1)
  }

  /** How many requests this conversation has received; 0 when none. */
  countFor(projectId: string, threadId: string): number {
    return this.#requests.get(keyOf(projectId, threadId)) ?? 0
  }
}

function keyOf(projectId: string, threadId: string): string {
  return `${projectId}/${threadId}`
}

export const composerAttachmentRequests = new ComposerAttachmentRequests()
