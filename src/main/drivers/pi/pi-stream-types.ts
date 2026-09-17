import type { AgentMessage } from '../../../lib/types'

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
  /** Set while a driver-initiated compaction runs. The compaction is part of
   *  the working trace but produces no assistant response of its own, so its
   *  `agent_settled` must not finalize the outer turn. */
  compacting?: boolean
}
