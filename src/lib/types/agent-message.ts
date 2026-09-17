import type { ThinkingLevel } from './common'
import type { PromptProjectReference, PromptReference } from './agent'
import type {
  AgentMessageOrigin,
  AgentMessageVisibility,
  AgentSubagentActivity,
  AgentToolState,
  UserMessagePresentation
} from './agent-parts'
import type {
  AgentBankedResets,
  AgentRateLimitWindow,
  AgentTokenUsage,
  AgentUsageCredits,
  NormalizedUsage,
  UsagePricingProvenance
} from './usage'

/** A selectable option within an agent question. */
export interface AgentQuestionOption {
  label: string
  description?: string
  /** Explicit provider recommendation, or inferred from a “(Recommended)” label. */
  recommended?: boolean
}

/** A structured question the agent is asking the user. */
export interface AgentQuestion {
  /** OpenCode question request id (used to submit the answer via the question API). */
  requestId?: string
  /** The question text. */
  prompt: string
  /** Very short label (max 30 chars) shown as a header. */
  header?: string
  /** Optional context or description providing background for the question. */
  description?: string
  /** Predefined answer options the user can pick from. */
  options?: string[]
  /** Predefined answer options with descriptions (richer format from OpenCode). */
  richOptions?: AgentQuestionOption[]
  /** Allow the user to select multiple options. */
  multiple?: boolean
  /** Allow the user to type a custom answer (default: true). */
  custom?: boolean
  /** The question asks the user to share files; offer composer-style file attachment. */
  fileRequest?: boolean
  /** The question asks for a secret value; render a password input instead of options. */
  secretRequest?: boolean
  /** Stable id of one secret in a `cio_ask_secret` request. */
  secretId?: string
  /** Environment variable the collected value is exposed under. */
  secretEnvironmentVariable?: string
  /** Utility this secret is bound to as a credential, when the agent named one. */
  secretUtilityId?: string
  /** The user's submitted answer text. */
  answer?: string
  /** Raw tool input payload, preserved for debugging schema drift. */
  rawInput?: string
}

/** One provider-native question request, preserving ordered question batches. */
export interface AgentQuestionRequest {
  requestId: string
  sessionId: string
  questions: AgentQuestion[]
  tool?: { messageID: string; callID: string }
  /** Provider transport details needed to answer the blocked native request. */
  metadata?: Record<string, unknown>
}

/** Authoritative pending request metadata owned by the main process. */
export interface PendingAgentQuestionRequest extends AgentQuestionRequest {
  projectId: string
  threadId: string
  createdAt: number
  activeQuestionIndex: number
  answers: string[][]
  interactedQuestionIndexes: number[]
  expiresAt?: number
}

export type AgentQuestionResolution = 'answered' | 'dismissed' | 'timed_out'

/**
 * One secret value the user pasted into a `cio_ask_secret` card. The value is
 * transient: it is consumed by the main process (vault + harness environment)
 * and never persisted in the thread transcript or returned to the renderer.
 */
export interface AgentSecretSubmission {
  /** Id of the secret question the value answers. */
  secretId: string
  value: string
}

/** A renderable piece of an agent message. */
export type AgentPart =
  | {
      type: 'text'
      id: string
      messageID: string
      text: string
      /** Codex can emit user-visible progress before its final answer. */
      phase?: 'commentary' | 'final_answer'
    }
  | {
      type: 'reasoning'
      id: string
      messageID: string
      text: string
      /** Provider-reported concise thinking summary, when available. */
      summary?: string
      time?: { start?: number; end?: number }
    }
  | {
      type: 'tool'
      id: string
      messageID: string
      callID: string
      tool: string
      state: AgentToolState
    }
  | {
      type: 'subagent'
      id: string
      messageID: string
      callID?: string
      activity: AgentSubagentActivity
    }
  | {
      type: 'file'
      id: string
      messageID: string
      mime: string
      url: string
      filename?: string
    }
  | {
      type: 'question'
      id: string
      messageID: string
      callID?: string
      question: AgentQuestion
    }
  | { type: 'step-start'; id: string; messageID: string }
  | {
      type: 'step-finish'
      id: string
      messageID: string
      reason: string
      cost?: number
      tokens?: AgentTokenUsage
      normalizedUsage?: NormalizedUsage
    }
  | {
      type: 'compaction'
      id: string
      messageID: string
      auto: boolean
      overflow?: boolean
      /** Completed compaction output, attached by the presentation layer. */
      summary?: string
      /** Pi retains recent context before the compaction record. */
      firstKeptEntryId?: string
      firstKeptCreatedAt?: number
    }
  | {
      type: 'compaction-summary'
      id: string
      messageID: string
      text: string
    }
  | {
      type: 'user-presentation'
      id: string
      messageID: string
      presentation: UserMessagePresentation
    }

/** A generated image that can be previewed from a conversation or its context sidebar. */
export interface AgentArtifact {
  id: string
  kind: 'image'
  filename: string
  mime: string
  path: string
  url: string
  messageId: string
  createdAt: number
  scope: 'chat' | 'project'
  /** Project-relative path when the artifact lives inside the active project. */
  relativePath?: string
}

/** A message in the agent conversation. */
export interface AgentMessage {
  id: string
  role: 'user' | 'assistant'
  /** Who produced the display-facing record. */
  origin?: AgentMessageOrigin
  /** Which UI channel may load this record. */
  visibility?: AgentMessageVisibility
  parts: AgentPart[]
  /** Exact provider-facing payload, deliberately separate from display parts. */
  transportParts?: AgentPart[]
  /** Who assembled the provider-facing payload when it differs from `origin`. */
  transportOrigin?: AgentMessageOrigin
  /** Assistant-response excerpts visibly attached to this user message. */
  references?: PromptReference[]
  /** Project-relative files and directories visibly attached to this user message. */
  projectReferences?: PromptProjectReference[]
  modelId?: string
  providerId?: string
  /** Agent harness that produced this message, e.g. opencode or claude-code. */
  harnessId?: string
  /** Credential container that produced this message. */
  accountId?: string
  /** Historical label snapshot. Renaming an account does not rewrite old turns. */
  accountLabel?: string
  /** Reasoning effort in effect when this message's turn ran, when known. */
  thinkingLevel?: ThinkingLevel
  /** Duration in milliseconds from the first streamed output part (the model's
   *  first token) to turn end   excludes pre-generation tool/setup time, so a
   *  tokens/second rate derived from it reflects actual generation. */
  generationMs?: number
  createdAt: number
  completedAt?: number
  /** Cost and token accounting reported for this assistant message. */
  cost?: number
  /** Provenance of `cost` when it was derived from a pricing table rather than
   *  reported verbatim by the provider (kept transient; not persisted). */
  costProvenance?: UsagePricingProvenance
  tokens?: AgentTokenUsage
  /** Canonical accounting payload; raw provider evidence and semantics are preserved. */
  normalizedUsage?: NormalizedUsage
  /** Effective model context window reported by the harness, when available. */
  contextWindow?: number
  /** Cumulative tokens currently occupying the model context, when available. */
  contextUsed?: number
  /** True when context occupancy was estimated from the composed request. */
  contextEstimated?: boolean
  /** Optional account quota windows when the provider exposes them. */
  rateLimits?: AgentRateLimitWindow[]
  /** Prepaid-credit balance reported alongside quota windows. */
  credits?: AgentUsageCredits
  /** Banked rate-limit resets available to redeem (currently Codex-only). */
  bankedResets?: AgentBankedResets
  /** Present on assistant messages that ended with an error. */
  error?: string
  /** Validated JSON-schema result returned by a harness structured-output tool. */
  structuredOutput?: unknown
}

/** Stable cursor for loading messages older than the first item in a transcript page. */
export interface ThreadMessageCursor {
  createdAt: number
  id: string
}

/** One bounded page of display-facing thread history, ordered oldest to newest. */
export interface ThreadMessagePage {
  messages: AgentMessage[]
  hasOlder: boolean
  /** True when newer messages exist beyond this page (set by centered loads). */
  hasNewer?: boolean
}

/**
 * Trace entries the working trace mounts when it opens, and the size of each
 * older page it pulls in on inner scroll. A live trace streams unbounded into
 * the durable log, but the renderer only ever mounts one bounded window: a long
 * running thread must open instantly, and while the reader stays on the thread
 * nothing already mounted is ever evicted.
 */
export const WORKING_TRACE_PAGE_SIZE = 15

/**
 * Bounded window request over a thread's durable working-trace stream.
 *
 * The stream log folds to one ordered, first-seen list of parts for the newest
 * logical turn, so a window is expressed as a slice of that list rather than a
 * timestamp cursor: `beforeId` walks back through older entries, and
 * `changedSince` reports what the log touched since a previous read.
 */
export interface TurnStreamPartsQuery {
  /** Return up to `limit` parts immediately older than this part id. */
  beforeId?: string
  /**
   * Return every part the log touched after this cursor: entries that appeared
   * AND entries updated in place (a tool call completing, a sub-agent reporting
   * progress). A growth-only cursor would leave an already mounted entry frozen
   * at its stale snapshot, which is what a second app instance watching the same
   * thread would see, so a live poll reads changes instead of growth.
   */
  changedSince?: number
  /** Maximum parts in a window request. Defaults to `WORKING_TRACE_PAGE_SIZE`.
   *  Ignored by a change request, whose size is whatever the log streamed
   *  between the two reads and is never silently truncated. */
  limit?: number
}

/** One bounded page of a thread's durable working-trace parts. */
export interface TurnStreamPartsPage {
  kind: 'window'
  /** The page, ordered oldest to newest. Task-list tool parts are excluded:
   *  they drive the task card (`todoParts`), never the trace window. */
  parts: AgentPart[]
  /** Total trace parts the durable log currently folds for the turn. */
  total: number
  /** Index of `parts[0]` inside that full folded list. */
  start: number
  /** True when the fold holds trace parts older than this page. */
  hasOlder: boolean
  /** Stream events consumed so far, to pass back as `changedSince`. */
  cursor: number
  /** Newest durable task-list tool parts for the turn, so the task card never
   *  depends on which trace page happens to be mounted. */
  todoParts: AgentPart[]
}

/**
 * Everything the durable working-trace log touched since a change cursor.
 *
 * A change is not a window: it carries no fold coordinates, because its parts
 * are simply the ones that moved (appeared or were updated in place) since the
 * previous read. Counts and cursors stay on it so a live reader can tell that
 * the fold was replaced under it and remount a window.
 */
export interface TurnStreamPartsChange {
  kind: 'change'
  /** Touched parts, in fold order. */
  parts: AgentPart[]
  /** Total trace parts the durable log currently folds for the turn. */
  total: number
  /** Stream events consumed so far, to pass back as `changedSince`. */
  cursor: number
  /** Newest durable task-list tool parts for the turn. */
  todoParts: AgentPart[]
}

/** Lightweight user-authored message summary for the header history jump list. */
export interface UserMessageSummary {
  id: string
  content: string
  createdAt: number
}

/** Options controlling how a conversation transcript is serialized. */
export interface TranscriptExportOptions {
  /** Whether the working trace (reasoning, tool calls, sub-agents) is included. */
  includeTrace: boolean
}

/** Absolute location of a written transcript and where it was stored. */
export interface TranscriptExportResult {
  /** Absolute path of the written Markdown file. */
  path: string
  /** Where the transcript was stored   project scratch vs. chat temp dir. */
  location: 'project' | 'chat'
}

/** The subset of an assistant message that usage accounting reads.
 *
 * Usage recording and harness-total accumulation accept this instead of a full
 * `AgentMessage`, so a mirrored turn can be accounted from a narrow row
 * projection without reading, transferring, or parsing its message parts.
 */
export interface UsageBearingMessage {
  id: string
  role: 'user' | 'assistant'
  createdAt: number
  completedAt?: number
  cost?: number
  costProvenance?: UsagePricingProvenance
  tokens?: AgentTokenUsage
  normalizedUsage?: NormalizedUsage
  error?: string
  harnessId?: string
  providerId?: string
  modelId?: string
  thinkingLevel?: ThinkingLevel
  accountId?: string
  parts?: AgentPart[]
}
