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
}
