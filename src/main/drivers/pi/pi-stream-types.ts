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
   * Set while pi backs off for its own provider retry, between
   * `auto_retry_start` and `auto_retry_end`.
   *
   * Pi retries a failed request inside the same turn, so the run is alive but
   * deliberately not streaming for the whole gap. Every liveness question the
   * driver answers (`isSessionBusy`, may a prompt be dispatched, may a finished
   * turn's transport be torn down) has to answer "working" while this is set: a
   * retry gap reported as idle made the app finalize a live turn, which cleared
   * the utility gateway handoff the resumed run was still calling `cio_util_*`
   * through.
   */
  providerRetry?: boolean
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
  /**
   * Terminal tool results this turn already published, keyed by call id and
   * their `status|outputLength|errorLength` signature.
   *
   * `turn_end` repeats every tool result after `tool_execution_end` already
   * published it, the same repeat `usageSignature` guards on the usage channel.
   * Without this the durable stream log held two copies of every tool result,
   * which for a screenshot was two ~50KB base64 records per call.
   */
  publishedToolResults?: Set<string>
  /**
   * Id of the message that owns the answer the task-list reconcile nudge must
   * not replace.
   *
   * The core-tools extension stops a run that is about to settle on a lagging
   * task list and continues the same turn with one instruction to publish the
   * corrected list. Everything after that nudge is a bookkeeping exchange, not a
   * new answer, unless it did work of its own. The driver hands this id to the
   * chat engine so it can tell those two cases apart in the transcript.
   */
  reconcileAnswerMessageId?: string
}
