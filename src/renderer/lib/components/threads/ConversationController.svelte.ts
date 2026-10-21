import type {
  AgentMessage,
  AgentProviderIssue,
  AgentSessionStatus,
  PromptAttachment,
  PromptAssignmentTaskReference,
  PromptProjectReference,
  SpecActionIntent,
  ThreadSettings,
  UserMessagePresentation
} from '$shared/types'
import type { ResponseReferenceAnchor } from '$lib/stores/response-references.svelte'

export interface SendPayload {
  text: string
  attachments: PromptAttachment[]
  /** Thread-only: action intent such as spec/brainstorm requests. */
  specAction?: SpecActionIntent
  promptContext?: string
  promptReferences?: ResponseReferenceAnchor[]
  projectReferences?: PromptProjectReference[]
  presentation?: UserMessagePresentation
  taskReferences?: PromptAssignmentTaskReference[]
  /** True when the user force-sends while the agent is already working. */
  direct?: boolean
  /** Optional backend text that differs from the visible `text` (used by
   *  temporary chats to show a short action label while sending the full
   *  instruction to the agent). */
  transportText?: string
}

/**
 * A passage a conversation attached to its composer.
 *
 * A thread resolves these against its own reference store, which rebuilds the
 * highlight from the message and its character range; a side chat keeps them on
 * its tab. Both need the range so the highlight survives a re-render, and both
 * carry the comment the user wrote on the passage.
 */
export interface SelectionAttachment {
  text: string
  messageId?: string
  startOffset?: number
  endOffset?: number
}

/**
 * Minimal contract that ThreadView needs from any conversation backend.
 *
 * ThreadView's default path still uses `threadMessages` / `agentRuns` directly;
 * this interface is only required when rendering a conversation that does not
 * follow the regular thread lifecycle (e.g. temporary chats).
 */
export interface ConversationController {
  readonly kind: 'thread' | 'temporary-chat'
  readonly projectId: string
  readonly conversationId: string
  /** Durable thread the conversation hangs off (temporary side chats only).
   *  Capability discovery for a side chat resolves project scope against this
   *  thread, because the side chat itself owns no Thread row. */
  readonly parentThreadId?: string
  readonly settings: ThreadSettings
  /** Persist updated composer settings back to the conversation's store. */
  updateSettings(updated: ThreadSettings): void

  /** Reactive message list. */
  readonly messages: AgentMessage[]
  /** Whether the initial set of messages has been resolved. */
  readonly loaded: boolean
  /** Whether a non-blocking load is in progress. */
  readonly loading: boolean
  /** Whether older messages can be paged in. */
  readonly hasOlder: boolean
  /** Whether the agent is currently working on a turn. */
  readonly busy: boolean
  /** Provider-level error, if any. */
  readonly error: string
  /** Terminal run failure, if any. */
  readonly runIssue: AgentProviderIssue | null
  /** Waiting/error provider status card, if any. */
  readonly status: AgentSessionStatus | null
  /** Authoritative start time of the current busy turn (ms). */
  readonly activeTurnStartTime: number | undefined

  /** Lifecycle hook called by ThreadView when the conversation surface mounts. */
  mount(): void
  /** Lifecycle hook called by ThreadView when the conversation surface unmounts. */
  unmount(): void
  /** Send a new user message. */
  send(payload: SendPayload): Promise<void>
  /** Send an intervention while the agent is working. */
  steer(payload: SendPayload): Promise<void>
  /** Abort the active turn. */
  abort(): Promise<void>
  /** Load the conversation from scratch (used on mount / refresh). */
  load(): Promise<void>
  /** Load the next older page of history. */
  loadOlder(): Promise<void>
  /** Clear transient error/status banners. */
  clearError(): void
  /** Clear a provider status card. */
  clearStatus(): void

  /** Optional composer-level selection references (used by temporary chats). */
  readonly references?: readonly ResponseReferenceAnchor[]
  /** Remove a single composer selection reference (used by temporary chats). */
  removeReference?(id: string): void
  /** Remove all composer selection references (used by temporary chats). */
  clearReferences?(): void
  /** Attach a response selection to the composer, and name the reference it
   *  became so its comment can be written on it (temporary chats). */
  addSelection?(selection: SelectionAttachment): string | null
  /** Save or clear the comment attached to one composer selection. */
  updateReferenceComment?(id: string, comment: string): void

  /** Drop a message and everything after it (message editing). Temporary
   *  chats implement this against their own backend; threads use the
   *  `threadMessages` store directly. */
  truncateBefore?(messageId: string): Promise<AgentMessage[]>
  /** Delete history around a message (`down` / `single` / `up`). */
  removeAround?(messageId: string, mode: 'down' | 'single' | 'up'): Promise<AgentMessage[]>
}
