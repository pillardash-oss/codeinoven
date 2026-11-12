import { SvelteMap } from 'svelte/reactivity'
import { ASSISTANT_SPACE_ID, type Thread } from '$shared/types'

/**
 * Which thread of each assistant the user last had open.
 *
 * An assistant is a place with several threads, so opening it again should
 * return to the conversation the user was last in rather than to whichever task
 * happened to move most recently. The memory is the thread id per assistant, and
 * a thread the user has never seen before falls back to the assistant's latest.
 *
 * It is deliberately session state: this is navigation, not a stored preference,
 * so it is not written to the database.
 */
const lastViewed = new SvelteMap<string, string>()

/** Remember the thread on screen, for the assistant it belongs to. */
export function rememberAssistantThread(thread: Thread | null | undefined): void {
  if (!thread || thread.projectId !== ASSISTANT_SPACE_ID || !thread.assistantId) return
  lastViewed.set(thread.assistantId, thread.id)
}

/** The thread id the user last had open in an assistant, if any. */
export function lastViewedAssistantThreadId(assistantId: string): string | null {
  return lastViewed.get(assistantId) ?? null
}
