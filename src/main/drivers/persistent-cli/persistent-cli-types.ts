import type {
  AgentMessage,
  AgentTokenUsage,
  SessionAgentEvent,
  UsagePricingProvenance
} from '../../../lib/types'

export interface TitleModelCandidate {
  providerId: string
  modelId: string
}

/** Provider-reported usage for one title-candidate attempt, when available. */
export interface TitleAttemptUsage {
  tokens?: AgentTokenUsage
  cost?: number
  costProvenance?: UsagePricingProvenance
  durationMs?: number
}

/** Outcome of one title-candidate attempt, for event-level ledger integration. */
export interface TitleAttemptAccounting {
  /** 1-based position of this attempt in the candidate sequence. */
  attempt: number
  /** Model/provider asked to produce the title. */
  providerId: string
  modelId: string
  /** Whether this attempt produced a usable title. */
  success: boolean
  /** Why this attempt fell back, or null when it succeeded. */
  fallbackReason: string | null
  /** Provider-reported usage retained from this attempt, or null when absent. */
  usage: TitleAttemptUsage | null
}

/** Result of one auxiliary one-shot completion sequence over the candidates. */
export interface OneShotOutcome {
  /** Usable validated value produced by the first successful candidate, or null. */
  value: string | null
  /** True when an authentication issue stopped further attempts. */
  authFailed: boolean
  /** Per-candidate accounting entries gathered across the sequence. */
  attempts: TitleAttemptAccounting[]
}

/** Durable state for a logical CodeInOven session backed by a turn-based CLI. */
export interface PersistentCliSession {
  id: string
  title: string
  projectPathHash: string
  nativeSessionId?: string
  /** Owning thread, stamped by the engine so sessions survive harness switches. */
  threadId?: string
  messages: AgentMessage[]
  createdAt: number
  updatedAt: number
}

/** Process invocation constructed by a provider-specific CLI driver. */
export interface CliTurnCommand {
  command: string
  args: string[]
  input?: string
  /** Keep stdin writable until the provider reports the turn result. */
  keepInputOpen?: boolean
  env?: NodeJS.ProcessEnv
  /** Display model that produced the turn when it differs from the selected base model. */
  provenanceModelId?: string
  /** Called for each parsed provider record before provider-specific mapping. */
  onJsonRecord?: (value: unknown) => void
  /** Parse JSON records written to stderr by providers using JSON output mode. */
  parseStderrJson?: boolean
  /**
   * Load provider records that only become available after the process exits
   * (for example, interaction details from a retained session export).
   */
  loadTrailingRecords?: () => Promise<unknown[]>
  /** Keep the logical turn paused when trailing records surfaced a blocking interaction. */
  suppressIdle?: () => boolean
  /** Treat a provider-specific, deliberately requested process stop as a successful exit. */
  isExpectedExit?: (code: number | null, signal: NodeJS.Signals | null) => boolean
  /** Called when spawning fails or the child exits. Must be safe to call more than once. */
  onProcessExit?: () => void
}

/** Output of parsing one provider JSONL record. */
export interface CliLineParseResult {
  /** Parsed events are always tied to the active session. */
  events?: SessionAgentEvent[]
  messages?: AgentMessage[]
  nativeSessionId?: string
}

/** Context supplied to provider parsers without leaking transport state. */
export interface CliLineParseContext {
  session: PersistentCliSession
  sessionId: string
  projectPath?: string
}
