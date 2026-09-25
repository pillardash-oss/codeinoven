import type { ChildProcess } from 'child_process'
import type { AgentPart, AgentProviderIssue, AgentQuestion } from '../../../lib/types'
import type { PersistentCliSession } from '../persistent-cli-driver'
import type { mapCodexUsage } from './codex-usage'

/** Resident Codex app-server transport types and request timeouts. */

export const CODEX_COMPACTION_TIMEOUT_MS = 180_000
export const CODEX_USAGE_TIMEOUT_MS = 15_000
export const CODEX_APP_SERVER_REQUEST_TIMEOUT_MS = 30_000

export interface CodexAppServerHost {
  child: ChildProcess
  nextRequestId: number
  stdoutBuffer: string
  stderrBuffer: string
  stopped: boolean
  pending: Map<
    number,
    {
      resolve: (value: Record<string, unknown>) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >
}

export interface CodexAppServerTurn {
  host: CodexAppServerHost
  session: PersistentCliSession
  startParams?: Record<string, unknown>
  nativeThreadId?: string
  turnId?: string
  failure?: string
  /** Structured failure captured before `turn/completed` so terminal errors
   *  such as usage limits keep their retry scheduling even when the completing
   *  event only echoes the raw message. */
  failureIssue?: AgentProviderIssue
  summaryFallbackAttempted?: boolean
  waitingForRetry?: boolean
  finished: boolean
}

export interface CodexCompactionRun {
  host: CodexAppServerHost
  session: PersistentCliSession
  messageId: string
  basePart: Extract<AgentPart, { type: 'compaction' }>
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface CodexContextUsageWaiter {
  host: CodexAppServerHost
  resolve: (usage: ReturnType<typeof mapCodexUsage>) => void
  timer: ReturnType<typeof setTimeout>
}

export interface CodexServerRequest {
  id: string | number
  host: CodexAppServerHost
  sessionId: string
  method: string
  params: Record<string, unknown>
  questions?: AgentQuestion[]
}
