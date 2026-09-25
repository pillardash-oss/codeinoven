import type { AgentEvent, AgentMessage, AgentProviderIssue } from '../../../lib/types'
import { parseRankingGrade } from '../../chat/turn-grader-prompt'
import type {
  TitleAttemptAccounting,
  TitleAttemptUsage,
  TitleModelCandidate
} from './persistent-cli-types'

export const TITLE_GENERATION_TIMEOUT_MS = 180_000

interface TitleTurnWaiter {
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class TitleTurnProviderIssueError extends Error {
  constructor(readonly issue: AgentProviderIssue) {
    super(issue.message)
    this.name = 'TitleTurnProviderIssueError'
  }
}

/** Validate a one-shot grading response; returns the score digits for accounting. */
export function parseRankingGradeForAttempt(raw: string): string | null {
  const score = parseRankingGrade(raw)
  return score === null ? null : String(score)
}

/** Accept any non-empty auxiliary response, trimmed and length-bounded. */
export function sanitizeAuxiliaryText(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  return value.length > 16_000 ? value.slice(0, 16_000) : value
}

export function buildTitleAttempt(
  attempt: number,
  candidate: TitleModelCandidate,
  success: boolean,
  fallbackReason: string | null,
  response?: AgentMessage
): TitleAttemptAccounting {
  const usage: TitleAttemptUsage | null =
    response &&
    (response.tokens || response.cost !== undefined || response.costProvenance !== undefined)
      ? {
          tokens: response.tokens,
          cost: response.cost,
          costProvenance: response.costProvenance,
          durationMs:
            response.completedAt !== undefined
              ? Math.max(0, Math.floor(response.completedAt - response.createdAt))
              : 0
        }
      : null
  return {
    attempt,
    providerId: candidate.providerId,
    modelId: candidate.modelId,
    success,
    fallbackReason,
    usage
  }
}

export function describeTitleFailure(error: unknown): string {
  if (error instanceof TitleTurnProviderIssueError) return error.issue.message
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Tracks disposable auxiliary sessions and their completion waiters. Title,
 * grade, heartbeat, and cheap-model runs all register a session here so their
 * private events are intercepted instead of reaching the app event stream.
 */
export class TitleTurnRegistry {
  private readonly sessions = new Set<string>()
  private readonly waiters = new Map<string, TitleTurnWaiter>()

  register(sessionId: string): void {
    this.sessions.add(sessionId)
  }

  unregister(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  /** True for the disposable sessions owned by automatic title generation. */
  isTitleSession(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  wait(
    sessionId: string,
    driverName: string,
    timeoutMs: number = TITLE_GENERATION_TIMEOUT_MS
  ): { promise: Promise<void>; cancel: () => void } {
    let resolvePromise: () => void = () => undefined
    let rejectPromise: (error: Error) => void = () => undefined
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
    })
    // The rejection can fire while `sendPrompt` is still being awaited (the
    // harness process may emit its error `result` before the caller reaches
    // `await completion.promise`). Attach a no-op handler immediately so that
    // early rejection is never reported as an unhandled rejection; a later
    // `await` still observes it and the one-shot fallback runs normally.
    promise.catch(() => undefined)
    const timer = setTimeout(() => {
      this.clear(sessionId)
      rejectPromise(new Error(`${driverName} auxiliary completion timed out`))
    }, timeoutMs)
    this.waiters.set(sessionId, {
      resolve: resolvePromise,
      reject: rejectPromise,
      timer
    })
    return { promise, cancel: () => this.clear(sessionId) }
  }

  clear(sessionId: string): void {
    const waiter = this.waiters.get(sessionId)
    if (!waiter) return
    clearTimeout(waiter.timer)
    this.waiters.delete(sessionId)
  }

  /**
   * Route one event for a title session to its waiter. Returns true when the
   * event was consumed (the caller must not forward it to the app stream).
   */
  intercept(event: AgentEvent, driverName: string): boolean {
    if (!('sessionId' in event) || !this.sessions.has(event.sessionId)) return false
    const waiter = this.waiters.get(event.sessionId)
    if (event.type === 'session.error') {
      this.clear(event.sessionId)
      waiter?.reject(
        event.issue
          ? new TitleTurnProviderIssueError(event.issue)
          : new Error(event.error ?? `${driverName} title generation failed`)
      )
    } else if (event.type === 'message.completed' && event.issue) {
      this.clear(event.sessionId)
      waiter?.reject(new TitleTurnProviderIssueError(event.issue))
    } else if (
      event.type === 'session.idle' ||
      (event.type === 'session.status' && event.status.state === 'idle')
    ) {
      this.clear(event.sessionId)
      waiter?.resolve()
    }
    return true
  }

  /** Reject every outstanding waiter, for example while the driver shuts down. */
  rejectAll(driverName: string): void {
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error(`${driverName} is shutting down`))
    }
    this.waiters.clear()
    this.sessions.clear()
  }
}
