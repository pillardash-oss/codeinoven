/**
 * The text rule every turn-trace surface reads its work through.
 *
 * An assistant run wraps its update in the app's `<assistant_result>` boundary.
 * The closing answer already reads only the text inside it; a step's text in the
 * working trace must read the same way, or the envelope itself shows up in a
 * chat that is meant to be readable.
 *
 * One helper serves the live trace, the settled trace and the sliced trace of a
 * turn the reader answered, so the same step can never print three ways. The
 * scope is read inside the returned closure, which is what keeps it reactive:
 * the caller is a trace rendering during a turn, not a one-time snapshot.
 */

import { conversationProseText } from '../../conversation-text'
import { isGroupThread } from '$shared/types'
import type { ThreadView as ThreadViewBoard } from '../ThreadView-board.svelte'

/** The transcript's `formatOutput` for a turn's work, bound to this board. */
export function conversationTraceOutput(board: () => ThreadViewBoard): (text: string) => string {
  return (text) =>
    conversationProseText(
      {
        assistantMode: board().props.assistantMode,
        groupThread: isGroupThread(board().handleAgentEvent.thread),
        authoringThread: board().abortRun.assistantAuthoringThread
      },
      text
    )
}
