import type { AgentMessage, AgentTokenUsage } from '../../../lib/types'

/** Shared stream-mapping context and per-turn state for the Pi record mapper. */

export interface PiStreamContext {
  sessionId: string
  session: { messages: AgentMessage[] }
}

/** Turn-scoped state kept so parts of one assistant message can be correlated. */
export interface PiTurnState {
  assistantMessageId: string | null
  turnIndex: number
  /** Streamed part ids already announced with a placeholder
   *  `message.part.updated`, so their first delta only needs the delta. */
  announcedStreamParts?: Set<string>
  /** Tool calls currently streaming, keyed by their content index, so the
   *  argument deltas `toolcall_delta` emits can be attributed to their call. */
  streamToolCalls?: Map<string, { callId: string; tool: string }>
  /** Set while a driver-initiated compaction runs. The compaction is part of
   *  the working trace but produces no assistant response of its own, so its
   *  `agent_settled` must not finalize the outer turn. */
  compacting?: boolean
  /**
   * The turn's reported usage summed across its requests, guarded against the
   * repeat `turn_end` emits for the final request. Pi opens a turn per request,
   * so this normally equals that request's own usage; it matters when several
   * requests share a turn, where carrying only the last would under-report the
   * turn and make its tokens/second rate divide one request's output by the
   * whole turn's generation time.
   */
  usageTotals?: AgentTokenUsage
  /** Signature of the last accumulated usage payload. `turn_end` repeats the
   *  final request's usage after that request's own `message_end`, so an
   *  unchanged signature marks a repeat rather than a new request. A new
   *  assistant `message_start` clears it, arming the next request. */
  usageSignature?: string
}
