/**
 * Threads the user deliberately marked unread from a thread actions menu.
 *
 * The app otherwise auto-settles a thread to read as soon as it is the selected
 * thread, the window has focus, and a `thread:updated` arrives (a turn finishing
 * while the user watches it). That rule must not instantly undo a deliberate
 * "Mark as unread", so the intent is remembered here: `requestThreadRead`
 * consults it, and it is cleared the moment the thread is opened or selected
 * again, read by any path, or deleted.
 *
 * The set is intentionally not reactive: it only gates an imperative
 * read request. The row's own badge already reflects the backend's `read`
 * flag, so no template reads this.
 */
const explicitUnread = new Set<string>()

export const threadUnreadIntent = {
  /** Remember that the user just marked this thread unread. */
  mark(threadId: string): void {
    explicitUnread.add(threadId)
  },
  /** Whether the user's explicit unread mark still stands for this thread. */
  has(threadId: string): boolean {
    return explicitUnread.has(threadId)
  },
  /** Drop the mark: the thread was opened, selected, read, or deleted. */
  clear(threadId: string): void {
    explicitUnread.delete(threadId)
  }
}
