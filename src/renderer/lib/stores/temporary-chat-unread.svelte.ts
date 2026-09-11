import { SvelteMap } from 'svelte/reactivity'

/**
 * Tracks temporary (side) chats whose completed response the user has not seen
 * yet, grouped by their parent thread. A side chat finishes while the user is
 * away from its thread → the parent thread's row shows the unread dot until
 * the side-chat panel is focused (or the chat expires, is closed, or the
 * thread is deleted). Regular thread unread state (the persisted `thread.read`
 * flag) is untouched: the parent thread's own status never changes when a side
 * chat completes, so this store exists purely for the row badge.
 *
 * Each entry also records when the unread state was marked, so the row can
 * apply "last action wins" between a side chat landing and the parent
 * thread's own turn settling (see ThreadRow).
 */
class TemporaryChatUnreadState {
  #unreadByThread = new SvelteMap<string, SvelteMap<string, number>>()

  markUnread(projectId: string, threadId: string, temporaryChatId: string): void {
    const key = threadKey(projectId, threadId)
    let chats = this.#unreadByThread.get(key)
    if (!chats) {
      chats = new SvelteMap<string, number>()
      this.#unreadByThread.set(key, chats)
    }
    chats.set(temporaryChatId, Date.now())
  }

  clear(projectId: string, threadId: string, temporaryChatId: string): void {
    const key = threadKey(projectId, threadId)
    const chats = this.#unreadByThread.get(key)
    if (!chats) return
    chats.delete(temporaryChatId)
    if (chats.size === 0) this.#unreadByThread.delete(key)
  }

  clearThread(projectId: string, threadId: string): void {
    this.#unreadByThread.delete(threadKey(projectId, threadId))
  }

  /** Whether any side chat of this thread is still waiting to be read. */
  hasUnread(projectId: string, threadId: string): boolean {
    return (this.#unreadByThread.get(threadKey(projectId, threadId))?.size ?? 0) > 0
  }

  /** When the most recent unread side chat of this thread landed, or 0 when
   *  none is waiting. Used for "last action wins" badge ordering. */
  lastUnreadAt(projectId: string, threadId: string): number {
    let latest = 0
    for (const markedAt of this.#unreadByThread.get(threadKey(projectId, threadId))?.values() ??
      []) {
      if (markedAt > latest) latest = markedAt
    }
    return latest
  }
}

function threadKey(projectId: string, threadId: string): string {
  return `${projectId}:${threadId}`
}

export const temporaryChatUnread = new TemporaryChatUnreadState()
