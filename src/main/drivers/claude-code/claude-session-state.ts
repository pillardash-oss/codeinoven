import type { AgentQuestion } from '../../../lib/types'

/** Per-session interaction and background-agent lifetime types. */

/**
 * How long a turn process with unfinished background agents may keep stdin
 * open after a result before it is closed so the CLI can exit. Any stdout
 * record (for example the agent's task-notification turn) resets this timer.
 */
export const CLAUDE_ASYNC_AGENT_CLOSE_GRACE_MS = 10 * 60_000

/**
 * Absolute ceiling on how long a turn process may be held open by unfinished
 * background agents after its result, regardless of stdout activity. The
 * inactivity grace above resets on every stdout record   including forwarded
 * sub-agent text   so a sub-agent that keeps trickling output (or a CLI that
 * never finishes its background wait) could otherwise keep the turn process
 * (and the parent turn) alive forever. When this cap fires, stdin is closed
 * unconditionally so the CLI can exit; a still-live agent's task-notification
 * then arrives via a resumed process instead of wedging the parent turn.
 */
export const CLAUDE_ASYNC_AGENT_MAX_HOLD_MS = 30 * 60_000

export interface ClaudeUsageProbe {
  usageRequestId: string
  contextRequestId: string
  rateLimitsPayload: Record<string, unknown> | null
  rateLimitsResponded: boolean
  contextPayload: Record<string, unknown> | null
  contextResponded: boolean
  timer: ReturnType<typeof setTimeout>
  promise: Promise<Record<string, unknown> | null>
  resolve: (value: Record<string, unknown> | null) => void
}

export interface ClaudeAuthenticationReadiness {
  promise: Promise<boolean>
  resolve: (authenticated: boolean) => void
  settled: boolean
}

export type ClaudeQuestionRequest =
  | {
      sessionId: string
      questions: AgentQuestion[]
      transport: 'control'
      input: Record<string, unknown>
      controlRequestId: string
    }
  | {
      sessionId: string
      questions: AgentQuestion[]
      transport: 'tool_result'
      callId: string
    }

export interface ClaudePermissionRequest {
  sessionId: string
  input: Record<string, unknown>
}

export function sameClaudeQuestions(left: AgentQuestion[], right: AgentQuestion[]): boolean {
  return (
    left.length === right.length &&
    left.every((question, index) => question.prompt === right[index]?.prompt)
  )
}
