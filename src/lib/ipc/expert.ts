import type { ExpertSummary, ThreadExpertChoice, ThreadExpertDecision } from '../experts'
import type { AuthoredWorkKind } from './design'

/**
 * What a thread's expert settings are, as the card and the playbook read them.
 *
 * An "expert" is a design assignment: one named piece of work and the model the
 * user put on it. The state carries the expert list itself rather than leaving the
 * renderer to read it from its own config copy, because the same list decides
 * whether the card appears, what the card lists, and what the agent is told. One
 * answer for all three, read in the process that owns the config.
 */

/** Everything a surface needs about one thread's experts. */
export interface ThreadExpertState {
  threadId: string
  /** The thread's answer to the card, or null before it has ever been asked. */
  decision: ThreadExpertDecision | null
  /**
   * Digest of the experts as they are right now. The card compares it with the
   * signature the thread decided about to know whether its answer still applies.
   */
  signature: string
  /** Every expert the user staffed that can actually run, in their own order. */
  experts: ExpertSummary[]
  /**
   * The session this thread is already in, or null when it is in none.
   *
   * Read here rather than asked separately, because the card's whole question is
   * scoped to a session: "may this design or video session use my experts". A
   * thread whose session started before this card existed still has a question to
   * answer, and the composer has only this call to learn that from.
   */
  session: AuthoredWorkKind | null
}

/** The card's answer about a thread's experts. */
export interface ExpertDecisionInput {
  /** Whether the thread's session may delegate to its experts. */
  choice: ThreadExpertChoice
  /**
   * Also stop offering the card in this thread, even if the expert list changes.
   * This is what separates "Don't use experts" from "Disable for this thread".
   */
  silent?: boolean
}
