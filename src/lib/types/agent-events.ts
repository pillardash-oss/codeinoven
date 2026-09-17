import type { PermissionReply } from './common'
import type {
  ImageDescriptorErrorRequest,
  ImageDescriptorReplyAction,
  PermissionRequest,
  ProviderCatalog
} from './agent'
import type {
  AgentBankedResets,
  AgentRateLimitWindow,
  AgentTokenUsage,
  AgentUsageCredits,
  NormalizedUsage
} from './usage'
import type {
  AgentMessage,
  AgentPart,
  AgentQuestion,
  AgentQuestionResolution
} from './agent-message'

/** Provider-neutral categories that let the UI offer an appropriate action. */
export type AgentProviderIssueKind =
  | 'rate_limit'
  | 'quota'
  | 'authentication'
  | 'billing'
  | 'provider_unavailable'
  | 'network'
  | 'unknown'

/** A structured provider or harness interruption surfaced by every driver. */
export interface AgentProviderIssue {
  kind: AgentProviderIssueKind
  message: string
  /** Original exception message for developer diagnostics; never includes the stack trace. */
  rawError?: string
  harnessId: string
  retryable: boolean
  retryAt?: number
  attempt?: number
  statusCode?: number
}

/**
 * Provider-neutral session lifecycle state.
 *
 * Drivers must emit `session.status` when a provider pauses and schedules a
 * retry so consumers never have to infer a stalled run from missing output.
 */
export type AgentSessionStatus =
  | {
      state: 'working'
      /** Authoritative start of the owning workflow, preserved across renderer reloads. */
      startedAt?: number
      /** Human-readable progress from an internal coordinator-owned worker. */
      activity?: {
        kind: 'spec_generation'
        label: string
        attempt: number
        maxAttempts: number
        updatedAt: number
      }
    }
  | { state: 'idle' }
  | { state: 'waiting'; issue: AgentProviderIssue }
  | { state: 'error'; issue: AgentProviderIssue }

export type BrainstormTraceUpdate =
  | { type: 'started'; messages: AgentMessage[] }
  | { type: 'part.updated'; messageId: string; part: AgentPart }
  | { type: 'part.delta'; messageId: string; partId: string; field: string; delta: string }
  | { type: 'completed'; messages: AgentMessage[] }
  | { type: 'refresh.started'; startedAt: number; phase?: 'create' | 'refresh'; version?: number }
  | { type: 'refresh.completed' }
  | { type: 'refresh.failed'; error: string; harnessId: string }

export type SpecGenerationTraceUpdate =
  | { type: 'started'; startedAt: number }
  | { type: 'part.updated'; part: AgentPart }
  | { type: 'part.delta'; partId: string; field: string; delta: string }
  | { type: 'completed' }

/** Live trace of an isolated offshoot run (shares the spec trace shape). */
export type AssignmentGenerationTraceUpdate = SpecGenerationTraceUpdate

export type AgentEvent =
  | { type: 'message.part.updated'; sessionId: string; part: AgentPart }
  | {
      type: 'checkpoint.updated'
      sessionId: string
      projectId: string
      threadId: string
      checkpointId: string
    }
  | {
      type: 'checkpoint.liveUpdated'
      sessionId: string
      projectId: string
      threadId: string
    }
  | {
      type: 'thread.error'
      sessionId: string
      projectId: string
      threadId: string
      issue: AgentProviderIssue
    }
  | {
      type: 'message.part.delta'
      sessionId: string
      messageId: string
      partId: string
      field: string
      delta: string
    }
  | {
      type: 'message.completed'
      sessionId: string
      messageId: string
      error?: string
      /** Full diagnostic detail (stderr tail, stack trace) kept out of the
       *  beautified `error` message; shown only in the Raw Error view. */
      rawError?: string
      issue?: AgentProviderIssue
      /** Structured result captured before a provider history read is required. */
      structuredOutput?: unknown
      /** Token accounting reported when the harness closes the turn. */
      tokens?: AgentTokenUsage
      normalizedUsage?: NormalizedUsage
      /** Effective model context window reported when the harness closes the turn. */
      contextWindow?: number
      /** Cumulative tokens currently occupying the model context, when available. */
      contextUsed?: number
      /** True when context occupancy was estimated from the composed request. */
      contextEstimated?: boolean
      /** Account quota windows reported after the harness refreshes usage. */
      rateLimits?: AgentRateLimitWindow[]
      /** Prepaid-credit balance reported alongside quota windows. */
      credits?: AgentUsageCredits
      /** Banked rate-limit resets available to redeem (currently Codex-only). */
      bankedResets?: AgentBankedResets
      /** The completed assistant message summarizes a compaction and is trace-only. */
      compaction?: boolean
      /** Driver-internal silent-continue marker; stripped before broadcast. */
      silentContinue?: AgentSilentContinueMarker
    }
  | {
      type: 'usage.updated'
      sessionId: string
      messageId: string
      tokens?: AgentTokenUsage
      normalizedUsage?: NormalizedUsage
      contextWindow?: number
      contextUsed?: number
      contextEstimated?: boolean
      cost?: number
      rateLimits?: AgentRateLimitWindow[]
      credits?: AgentUsageCredits
      /** Banked rate-limit resets available to redeem (currently Codex-only). */
      bankedResets?: AgentBankedResets
    }
  | { type: 'session.status'; sessionId: string; status: AgentSessionStatus }
  | { type: 'session.idle'; sessionId: string }
  | {
      type: 'session.error'
      sessionId: string
      error?: string
      /** Full diagnostic detail (stderr tail, stack trace) kept out of the
       *  beautified `error` message; shown only in the Raw Error view. */
      rawError?: string
      issue?: AgentProviderIssue
    }
  | {
      type: 'permission.asked'
      sessionId: string
      permission: PermissionRequest
    }
  | {
      type: 'permission.replied'
      sessionId: string
      requestId: string
      reply: PermissionReply
    }
  | {
      type: 'question.asked'
      sessionId: string
      requestId: string
      questions: AgentQuestion[]
      tool?: { messageID: string; callID: string }
      metadata?: Record<string, unknown>
    }
  | {
      type: 'question.updated'
      sessionId: string
      requestId: string
    }
  | {
      type: 'question.resolved'
      sessionId: string
      requestId: string
      resolution: AgentQuestionResolution
      answers?: string[][]
    }
  | {
      type: 'brainstorm.ready'
      sessionId: string
      projectId: string
      threadId: string
      brainstormId: string
      version: number
    }
  | {
      type: 'prd.ready'
      sessionId: string
      projectId: string
      threadId: string
      prdId: string
      version: number
    }
  | {
      type: 'brainstorm.trace'
      sessionId: string
      projectId: string
      threadId: string
      update: BrainstormTraceUpdate
    }
  | {
      type: 'spec.trace'
      sessionId: string
      projectId: string
      threadId: string
      update: SpecGenerationTraceUpdate
    }
  | {
      type: 'assignment.trace'
      sessionId: string
      projectId: string
      threadId: string
      update: AssignmentGenerationTraceUpdate
    }
  | {
      type: 'spec.ready'
      sessionId: string
      projectId: string
      threadId: string
      specId: string
      version: number
    }
  | {
      type: 'temporary-chat.started'
      sessionId: string
      temporaryChatId: string
      projectId: string
    }
  | {
      type: 'catalog.updated'
      harnessId: string
    }
  | {
      type: 'providerCatalog.updated'
      projectId: string
      catalogs: ProviderCatalog[]
    }
  | {
      type: 'imageDescriptor.error'
      sessionId: string
      projectId: string
      threadId: string
      request: ImageDescriptorErrorRequest
    }
  | {
      type: 'imageDescriptor.resolved'
      sessionId: string
      projectId: string
      threadId: string
      requestId: string
      action: ImageDescriptorReplyAction
    }
  | {
      /** A steered message is held by the chat engine until the harness's
       *  in-flight tool call ends; it has not reached the harness yet. */
      type: 'steer.held'
      sessionId: string
      userMessageId: string
    }
  | {
      /** A held steer was delivered to the harness (undo window closed). */
      type: 'steer.delivered'
      sessionId: string
      userMessageId: string
    }
  | {
      /** A held steer was discarded by the user; the harness never saw it. */
      type: 'steer.discarded'
      sessionId: string
      userMessageId: string
    }

/**
 * Agent events that are tied to a running session. Catalog events are app-level
 * and never belong to a session, so session-scoped handlers can rely on
 * `sessionId` being present.
 */
export type SessionAgentEvent = Exclude<
  AgentEvent,
  { type: 'catalog.updated' } | { type: 'providerCatalog.updated' }
>

/**
 * Driver-internal marker on a `message.completed` event: the turn hit a
 * recoverable finish-reason flake and the driver intends to silently continue
 * instead of surfacing the error. Never broadcast to renderers   drivers strip
 * it before emitting events to the engine.
 */
export interface AgentSilentContinueMarker {
  /** The original provider error text, kept for diagnostics when retries cap out. */
  error: string
}
