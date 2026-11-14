import type { ThreadStatus } from '../../../lib/types'

/** What one settle owes the reader's attention. */
export interface CompletionAnnouncement {
  /** False when this settle repeats an answer the reader was already told about. */
  notify: boolean
  /** True when this settle becomes the prompt whose answer is now announced. */
  record: boolean
}

/**
 * One user prompt earns one completion announcement.
 *
 * A harness can end a turn and then continue the same turn with its own internal
 * instruction: pi's task-list reconcile stops the run that is about to settle and
 * asks the model to publish the corrected list inside that same turn, which
 * settles it a second time tens of seconds later. Both settles answer one prompt,
 * so the row is announced both times while the reader is interrupted only by the
 * first: two alerts for one response is what that looks like from the outside.
 *
 * Keyed by the newest user message, never by the session: a steer, a retry the
 * user asked for, or the next prompt all arrive as a new message and earn their
 * own announcement. A turn that settled `failed` records nothing, so a later
 * success for the same prompt still speaks.
 */
export function completionAnnouncement(
  announcedPromptByThread: ReadonlyMap<string, string>,
  threadId: string,
  promptId: string | undefined,
  status: ThreadStatus
): CompletionAnnouncement {
  if (status !== 'completed' || promptId === undefined) return { notify: true, record: false }
  const alreadyAnnounced = announcedPromptByThread.get(threadId) === promptId
  return { notify: !alreadyAnnounced, record: !alreadyAnnounced }
}
