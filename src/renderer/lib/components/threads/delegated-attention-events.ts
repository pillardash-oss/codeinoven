import type { AgentEvent } from '$shared/types'

/**
 * Whether one streamed event can change the attention a conversation's dispatched
 * threads are waiting on.
 *
 * The mirrored cards are read from the main process's live pending requests, so the
 * list only ever needs re-reading when one of those is raised or settled. The event
 * stream is app-wide and carries every thread's traffic, so this decides nothing
 * about *whose* request it was: a cheap re-read is the price of a card that can
 * never be stale, and the stream is silent most of the time.
 */
export function isThreadRequestEvent(event: AgentEvent): boolean {
  return (
    event.type === 'question.asked' ||
    event.type === 'question.updated' ||
    event.type === 'question.resolved' ||
    event.type === 'permission.asked' ||
    event.type === 'permission.replied'
  )
}
