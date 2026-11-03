import type { AgentPart, RunReceiptBounds, RunReceiptCheck } from '../../../lib/types'
import { DEFAULT_RUN_RECEIPT_BOUNDS } from '../../../lib/types'
import { checksFromToolCalls, type RunReceiptToolCall } from '../../../lib/run-receipt'

/**
 * The checks a run actually executed, read from its own tool calls.
 *
 * A check is a command that ran, with the status it ended on. Nothing here reads
 * prose: a turn that only wrote words produces no checks, and a command whose
 * tool call never reached a terminal state is not a check either. That is what
 * keeps the receipt from ever claiming a test passed on the strength of a
 * sentence.
 *
 * The read is bounded twice: at the query (a capped page of the thread's tool
 * messages and a capped slice of each row's JSON) and at the shaping (a capped
 * list and a capped output tail). Parsing a large transcript on the main process
 * is exactly the kind of work the app must not do, so the bounds are part of the
 * contract rather than an afterthought.
 */

/** The narrow port this unit needs: a bounded read of one thread's parts rows. */
export interface RunChecksReader {
  /**
   * Parts JSON for the messages in one thread that carry tool parts, newest
   * last, bounded by the implementation. Never the whole transcript.
   */
  listToolMessageParts(threadId: string): Promise<string[]>
}

/** Message rows the checks read asks for at most. */
export const RUN_CHECKS_MESSAGE_LIMIT = 120

/** Whether one persisted part is a terminal or in-flight tool call. */
function isToolPart(part: AgentPart): part is Extract<AgentPart, { type: 'tool' }> {
  return part.type === 'tool'
}

/** Decode one parts JSON row into the calls a receipt can report. */
export function toolCallsFromParts(partsJson: string): RunReceiptToolCall[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(partsJson)
  } catch {
    // A row that cannot be parsed names no command. Dropping it is honest;
    // guessing at it would put an invented check on the receipt.
    return []
  }
  if (!Array.isArray(parsed)) return []
  const calls: RunReceiptToolCall[] = []
  for (const candidate of parsed) {
    if (!candidate || typeof candidate !== 'object') continue
    const part = candidate as AgentPart
    if (!isToolPart(part)) continue
    const state = part.state
    if (!state || typeof state.input !== 'object' || state.input === null) continue
    calls.push({
      tool: part.tool,
      status: state.status,
      input: state.input,
      ...(state.output === undefined ? {} : { output: state.output }),
      ...(state.error === undefined ? {} : { error: state.error }),
      ...(state.metadata === undefined ? {} : { metadata: state.metadata })
    })
  }
  return calls
}

/** Shape the checks for one run from the rows the reader returned. */
export async function readRunChecks(
  reader: RunChecksReader,
  threadId: string,
  bounds: RunReceiptBounds = DEFAULT_RUN_RECEIPT_BOUNDS
): Promise<{ checks: RunReceiptCheck[]; truncated: boolean }> {
  const rows = await reader.listToolMessageParts(threadId)
  const calls = rows.flatMap(toolCallsFromParts)
  const shaped = checksFromToolCalls(calls, bounds)
  return { checks: shaped.checks, truncated: shaped.truncated }
}
