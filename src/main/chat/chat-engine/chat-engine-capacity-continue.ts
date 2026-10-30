import {
  CAPACITY_CONTINUE_MAX_ATTEMPTS,
  isCapacityContinueError
} from '../../../lib/capacity-continue'
import { Logger } from '../../system/logger'
import type { ChatEngine } from '../chat-engine'

/** What one session's automatic capacity recovery currently holds. */
export interface CapacityContinueState {
  /** Continuations already sent for consecutive capacity failures. */
  attempts: number
  /** The provider error a continuation is still owed for. */
  owed?: string
}

/**
 * ChatEngine capacity-continue: one concern, the harness-neutral recovery for a
 * provider that answered "model at capacity".
 *
 * Every harness reports that refusal in its own words, through its own event
 * (Codex `turn.failed`, pi's errored completion, a driver's `session.error`),
 * and every one of them has the same cure: ask the same session to continue.
 * The engine owns the mechanism instead of each driver, so a harness that is
 * added tomorrow heals without touching this list.
 *
 * The failure is claimed before it becomes the turn's verdict, which keeps the
 * error card off the thread. The continuation itself is issued by the idle
 * finalization, the same place the app's other self-issued prompts (Mermaid
 * repair, utility-search nudge) come from: the failed attempt has to finish
 * tearing down before the same session can be asked anything.
 *
 * The budget is consecutive, not cumulative: a successful assistant completion,
 * a user prompt, or a session teardown clears it. After
 * {@link CAPACITY_CONTINUE_MAX_ATTEMPTS} refusals in a row the failure is
 * surfaced as a real error, so a provider that is genuinely down still reaches
 * the user instead of looping.
 */
export class ChatEngineCapacityContinue {
  constructor(private readonly host: ChatEngine) {}

  /**
   * Claim a harness-reported failure as a capacity refusal worth continuing.
   * Returns true when a continuation is owed, and the caller must not surface
   * that failure as a session error.
   */
  claim(driverId: string, sessionId: string, error: string | undefined): boolean {
    if (!isCapacityContinueError(error)) return false
    const info = this.host.sessionRegistry.get(sessionId)
    // An ephemeral session (title generation, descriptors, temporary chats)
    // belongs to its own caller, which owns its retry policy. A child session
    // is driven by the agent that spawned it: re-prompting it behind that
    // agent's back would interleave answers into work it thinks it controls.
    if (!info || info.ephemeral || this.host.state.childSessionOwners.has(sessionId)) return false
    // A deliberate stop outranks every automatic resume: the user ended this
    // run, so a failure it reported on the way out is not a reason to start it
    // again. A stopped worker's session carries its own stop mark.
    if (
      this.host.state.userAbortedSessions.has(sessionId) ||
      this.host.state.stoppedAssignmentSessions.has(sessionId)
    ) {
      return false
    }
    const current = this.host.state.capacityContinues.get(sessionId)
    // One refusal is frequently reported more than once: a harness emits the
    // structured error and then closes the same failed request with an errored
    // completion. The continuation already owed answers all of them, so a
    // repeat must not spend a second attempt from the budget.
    if (current?.owed) return true
    const attempts = current?.attempts ?? 0
    if (attempts >= CAPACITY_CONTINUE_MAX_ATTEMPTS) {
      Logger.info('Capacity continue budget exhausted; surfacing the provider failure', {
        projectId: info.projectId,
        threadId: info.threadId,
        harnessId: driverId,
        attempts
      })
      return false
    }
    const message = error?.trim() || 'The model was at capacity.'
    this.host.state.capacityContinues.set(sessionId, { attempts: attempts + 1, owed: message })
    Logger.info('Capacity failure claimed; a continuation is owed', {
      projectId: info.projectId,
      threadId: info.threadId,
      harnessId: driverId,
      attempt: attempts + 1,
      maxAttempts: CAPACITY_CONTINUE_MAX_ATTEMPTS
    })
    return true
  }

  /**
   * The error a continuation is still owed for, without consuming it. The idle
   * finalization reads this before it decides the turn's verdict, and clears it
   * only once the continuation was actually admitted.
   */
  owed(sessionId: string): string | undefined {
    return this.host.state.capacityContinues.get(sessionId)?.owed
  }

  /**
   * The claimed failure was answered: the continuation is being issued (or the
   * failure is being surfaced instead). The marker must not linger, or a later
   * unrelated idle would re-prompt for it. The attempts stay counted until the
   * provider demonstrably recovered.
   */
  clearOwed(sessionId: string): void {
    const current = this.host.state.capacityContinues.get(sessionId)
    if (!current?.owed) return
    this.host.state.capacityContinues.set(sessionId, { attempts: current.attempts })
  }

  /** The provider recovered: the next capacity failure starts a fresh budget. */
  succeed(sessionId: string): void {
    this.host.state.capacityContinues.delete(sessionId)
  }

  /** Forget a session's budget (user prompt, stop, session teardown, deletion). */
  clear(sessionId: string): void {
    this.host.state.capacityContinues.delete(sessionId)
  }
}
