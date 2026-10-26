/**
 * The task-list reconcile nudge, read back out of pi's record stream.
 *
 * The core-tools extension stops a run that is about to settle on a lagging task
 * list and continues the same turn with one instruction to publish the corrected
 * list. That nudge is invisible to the reader and, until this module existed, to
 * the app as well: the model's answer to it landed in the same turn as the answer
 * the user had already read, so it became the turn's closing statement and pushed
 * the real answer into the working trace, where nothing can be annotated.
 *
 * The app can only tell the two apart if it knows where the exchange starts, and
 * that is what the nudge carries: the id of the message that owns the answer it
 * is not allowed to replace.
 */
import { CIO_TODO_RECONCILE_MESSAGE_TYPE } from '../../../lib/core-tools'
import type { AgentMessage } from '../../../lib/types'
import { record, stringValue } from './pi-values'

/**
 * Whether one pi custom message or custom-message session entry is the
 * extension's task-list reconcile nudge.
 *
 * The nudge reaches the app in either shape, depending on how the extension
 * raised it: a custom message record (`role: 'custom'`) when the extension sent
 * it, or the session entry the settle boundary appended (`type:
 * 'custom_message'`). Both carry the same `customType`.
 */
export function isTaskReconcileNudge(value: unknown): boolean {
  return stringValue(record(value)?.['customType']) === CIO_TODO_RECONCILE_MESSAGE_TYPE
}

/**
 * Id of the message that owns the answer the nudge must not replace: the last
 * assistant message of the turn so far, which is the answer the agent had just
 * finished writing when the extension stopped it from settling.
 *
 * `undefined` when the transcript holds no assistant message yet, which leaves
 * the nudge with nothing to protect.
 */
export function reconcileAnswerMessageId(
  messages: readonly AgentMessage[]
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role === 'assistant') return message.id
  }
  return undefined
}
