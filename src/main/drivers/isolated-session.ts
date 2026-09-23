import type { AgentMessage } from '../../lib/types'
import type { HarnessDriver, SendPromptOptions, SteerPromptOptions } from './driver.interface'

/**
 * A disposable session that lives on its own transport instead of the
 * harness's pooled one.
 *
 * Some harnesses pool one shared server per application (the OpenCode family
 * does: a single `serve` process hosts every project and session), which means
 * a long-running background turn on that server serializes behind, and can
 * block, the work the user is actually waiting for. Thread-title generation,
 * voice transcription, transcript cleanup, image description, temporary
 * read-only chats, and the engineering offshoots (brainstorm, spec, assignment)
 * are all disposable: they need their own transport, and they must be torn down
 * when they end.
 *
 * The handle is opaque to callers. Only the driver that created it can resolve
 * it, and it is only ever handed back to that same driver.
 */
export interface IsolatedSessionHandle {
  /** Project the isolated transport was started for. */
  readonly projectPath: string
  /** Session created on the isolated transport. */
  readonly sessionId: string
}

/**
 * The optional driver contract behind {@link IsolatedSessionHandle}. A driver
 * that can host disposable sessions implements every member, so the chat engine
 * can route one turn, its history read, its abort, and its teardown to the
 * isolated transport without knowing which harness it is talking to.
 *
 * The signatures deliberately repeat `HarnessDriver`'s own methods with one
 * extra optional argument: an engine call site that holds a handle passes it,
 * and every other call site stays exactly as it was.
 */
export interface IsolatedSessionDriver {
  /** Create a session on a fresh transport that nothing else shares. */
  createIsolatedSession(projectPath: string, title: string): Promise<IsolatedSessionHandle>
  /** Delete the disposable session and tear its transport down. Idempotent. */
  disposeIsolatedSession(handle: IsolatedSessionHandle): void
  sendPrompt(
    projectPath: string,
    opts: SendPromptOptions,
    isolated?: IsolatedSessionHandle
  ): Promise<void>
  steerPrompt?(
    projectPath: string,
    opts: SteerPromptOptions,
    isolated?: IsolatedSessionHandle
  ): Promise<void>
  loadMessages(
    projectPath: string,
    sessionId: string,
    isolated?: IsolatedSessionHandle
  ): Promise<AgentMessage[]>
  abort(projectPath: string, sessionId: string, isolated?: IsolatedSessionHandle): Promise<void>
}

/**
 * Whether a driver can host disposable isolated sessions.
 *
 * This is the only supported gate for the isolated-session protocol. The chat
 * engine used to test the concrete v1 driver class, which silently excluded
 * every other harness that would have supported the same flows; a structural
 * check keeps the contract open to any driver that implements it.
 */
export function supportsIsolatedSessions(
  driver: HarnessDriver
): driver is HarnessDriver & IsolatedSessionDriver {
  const candidate: Partial<IsolatedSessionDriver> = driver
  return (
    typeof candidate.createIsolatedSession === 'function' &&
    typeof candidate.disposeIsolatedSession === 'function'
  )
}
