/**
 * How a settled read flag reaches the thread the conversation is showing.
 *
 * Opening a thread clears its unread badge a moment after the click, and that
 * answer used to be pushed through the store's `updateThread`: the same thread,
 * republished as a new object, which every derivation reading the open thread
 * treated as a different thread. On the real app that rebuild was a third of a
 * second of blocking script landing between the click and the first frame of the
 * conversation, for a flag the conversation does not even draw.
 *
 * The rule is small enough to state in one place: settle the flag only when the
 * row being settled is the open thread and the flag actually moves. Identity of
 * the row is never replaced.
 */
export function settleSelectedThreadRead(
  selected: { readonly id: string; read: boolean } | null,
  threadId: string,
  read: boolean
): boolean {
  if (selected === null) return false
  if (selected.id !== threadId) return false
  if (selected.read === read) return false
  selected.read = read
  return true
}
