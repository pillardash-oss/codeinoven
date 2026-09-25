import type { ExpertDecisionInput, ThreadExpertState } from './expert'
import type { Contract } from './contract-helpers'

export const invokeExpertContract = {
  /**
   * The experts staffing a thread's design or video session, and the answer the
   * thread already gave about them.
   *
   * Read before a session's first send: the composer holds the message only when
   * this says there is still a question to ask, which is what keeps the card from
   * reappearing on every message of a session the user already answered for.
   */
  'experts:state': {} as Contract<[projectId: string, threadId: string], ThreadExpertState>,
  /**
   * Record what the user chose when the card appeared, and answer with the state
   * that choice produces so the caller never has to model the rule itself.
   */
  'experts:decide': {} as Contract<
    [projectId: string, threadId: string, input: ExpertDecisionInput],
    ThreadExpertState
  >
}
