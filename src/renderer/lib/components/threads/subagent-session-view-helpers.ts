import { mergeStreamedPart } from '$shared/agent-part-merge'
import type {
  AgentMessage,
  AgentPart,
  AgentProviderIssue,
  AgentSessionStatus,
  AgentSubagentActivity,
  AgentToolStatus,
  ProviderCatalog
} from '$shared/types'
import { SUBAGENT_STATUS_TONE, subagentStatusLabel } from '$lib/subagent-presentation'

/** How close to the transcript scroller's bottom counts as "at the bottom". */
export const SCROLL_AT_BOTTOM_THRESHOLD = 60
/** How often a polled (non-streaming) child session reloads its transcript. */
export const TRANSCRIPT_POLL_INTERVAL_MS = 3_000
/** How long a transcript load may wait before the provider is called slow. */
const TRANSCRIPT_LOAD_TIMEOUT_MS = 15_000

/** A provider connection state the header and status card can render. */
export type SubagentProviderStatus = Extract<AgentSessionStatus, { state: 'waiting' | 'error' }>

/** The sub-agent lifecycle as this view describes it: the worker vocabulary
 *  plus `waiting`, which only a paused provider connection produces. */
export type SubagentEffectiveStatus = AgentToolStatus | 'waiting'

/** A connection recovery the view can announce, with when it happened. */
export interface SubagentRecoveryNotice {
  message: string
  recoveredAt: number
}

export function isAtBottom(el: HTMLDivElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_AT_BOTTOM_THRESHOLD
}

export function textParts(message: AgentMessage): Extract<AgentPart, { type: 'text' }>[] {
  return message.parts.filter(
    (part): part is Extract<AgentPart, { type: 'text' }> => part.type === 'text'
  )
}

export function workingParts(message: AgentMessage): AgentPart[] {
  return message.parts.filter((part) => part.type !== 'text' && part.type !== 'question')
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit'
  })
}

/** Provider-neutral issue for a failure reported without any structured detail. */
export function unknownProviderIssue(message: string, harnessId = 'agent'): AgentProviderIssue {
  return {
    kind: 'unknown',
    message,
    rawError: message,
    harnessId,
    retryable: true
  }
}

/** Keep the live transcript as the newer half of a raced load. */
export function mergeTranscript(loaded: AgentMessage[], streamed: AgentMessage[]): AgentMessage[] {
  if (streamed.length === 0) return loaded
  const merged = loaded.map(
    (message) => streamed.find((candidate) => candidate.id === message.id) ?? message
  )
  for (const message of streamed) {
    if (!loaded.some((candidate) => candidate.id === message.id)) merged.push(message)
  }
  return merged.sort((left, right) => left.createdAt - right.createdAt)
}

/** Fold one streamed part snapshot into the transcript, creating the message
 *  it belongs to when the harness streams parts before the message itself. */
export function upsertStreamedPart(messages: AgentMessage[], part: AgentPart): AgentMessage[] {
  const messageIndex = messages.findIndex((message) => message.id === part.messageID)
  if (messageIndex < 0) {
    return [
      ...messages,
      {
        id: part.messageID,
        role: 'assistant',
        parts: [part],
        createdAt: Date.now()
      }
    ]
  }
  const message = messages[messageIndex]
  const partIndex = message.parts.findIndex((candidate) => candidate.id === part.id)
  const parts =
    partIndex < 0
      ? [...message.parts, part]
      : message.parts.map((candidate, index) =>
          // A snapshot shorter than what already streamed must never wipe the
          // streamed text (see mergeStreamedPart).
          index === partIndex ? mergeStreamedPart(candidate, part) : candidate
        )
  return messages.map((candidate, index) =>
    index === messageIndex ? { ...message, parts } : candidate
  )
}

/** Append one streamed text delta to the part it belongs to. */
export function applyStreamedDelta(
  messages: AgentMessage[],
  messageId: string,
  partId: string,
  field: string,
  delta: string
): AgentMessage[] {
  if (field !== 'text') return messages
  return messages.map((message) => {
    if (message.id !== messageId) return message
    return {
      ...message,
      parts: message.parts.map((part) => {
        if (part.id !== partId) return part
        if (part.type === 'text' || part.type === 'reasoning') {
          return { ...part, text: part.text + delta }
        }
        return part
      })
    }
  })
}

/** Stamp one message as completed, recording the error when the run failed. */
export function markMessageCompleted(
  messages: AgentMessage[],
  messageId: string,
  error?: string
): AgentMessage[] {
  return messages.map((message) =>
    message.id === messageId ? { ...message, completedAt: Date.now(), error } : message
  )
}

/** Drop the duplicated delegated prompt from the transcript: the view renders
 *  the task once, in its own bubble above the conversation. */
export function filterVisibleMessages(
  messages: AgentMessage[],
  prompt: string | undefined
): AgentMessage[] {
  const trimmedPrompt = prompt?.trim()
  if (!trimmedPrompt) return messages
  let skippedPrompt = false
  return messages.filter((message: AgentMessage) => {
    if (skippedPrompt || message.role !== 'user') return true
    const text = textParts(message)
      .map((part) => part.text.trim())
      .join('\n')
    if (text !== trimmedPrompt) return true
    skippedPrompt = true
    return false
  })
}

/** True when the loaded transcript already carries assistant prose to render. */
export function transcriptHasAssistantText(messages: AgentMessage[]): boolean {
  return [...messages]
    .reverse()
    .some(
      (message) =>
        message.role === 'assistant' && textParts(message).some((part) => part.text.trim())
    )
}

/** The captured output is a fallback for when the transcript itself is not
 *  renderable   never a companion to it. While the sub-agent works,
 *  activity.output is an accumulating preview that concatenates every
 *  assistant message (capped, possibly cut mid-line), so substring checks
 *  against the last assistant message fail and the raw wall of text would
 *  duplicate the live working trace at the bottom of the view. Only surface
 *  it when the loaded transcript carries no assistant text to cover it and
 *  the session is no longer streaming. */
export function shouldShowCapturedOutput(
  finalOutput: string,
  busy: boolean,
  loading: boolean,
  loadError: string,
  messages: AgentMessage[]
): boolean {
  return (
    finalOutput.length > 0 &&
    !busy &&
    !loading &&
    (loadError !== '' || messages.length === 0 || !transcriptHasAssistantText(messages))
  )
}

/** Load a child session's transcript, failing after a bounded wait so a silent
 *  provider can never leave the view loading forever. */
export async function loadSessionTranscript(
  loader: () => Promise<AgentMessage[]>
): Promise<AgentMessage[]> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      loader(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('The provider took too long to load this session.')),
          TRANSCRIPT_LOAD_TIMEOUT_MS
        )
      })
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

/** The failure a worker's own activity recorded, when it recorded one. */
export function subagentFallbackIssue(activity: AgentSubagentActivity): AgentProviderIssue | null {
  const message = activity.error?.trim()
  if (!message) return null
  return unknownProviderIssue(message)
}

/** The provider connection issue worth surfacing, or null while it is healthy. */
export function subagentProviderStatus(
  liveStatus: AgentSessionStatus | null,
  fallbackIssue: AgentProviderIssue | null
): SubagentProviderStatus | null {
  if (liveStatus?.state === 'waiting' || liveStatus?.state === 'error') return liveStatus
  if (liveStatus) return null
  return fallbackIssue ? { state: 'error', issue: fallbackIssue } : null
}

export function subagentEffectiveStatus(
  visibleStatus: SubagentProviderStatus | null,
  liveStatus: AgentSessionStatus | null,
  activity: AgentSubagentActivity
): SubagentEffectiveStatus {
  if (visibleStatus?.state === 'error') return 'error'
  if (liveStatus?.state === 'working') return 'running'
  if (liveStatus?.state === 'waiting') return 'waiting'
  if (liveStatus?.state === 'error') return 'error'
  // A child session reports a plain `idle` once its run ends; a worker the
  // user stopped must not be described as completed.
  if (liveStatus?.state === 'idle') {
    return activity.status === 'aborted' ? 'aborted' : 'completed'
  }
  return activity.status
}

/** Lifecycle view for the header chip: 'waiting' is a paused provider
 *  connection, which the sub-agent status vocabulary has no state for. */
export function subagentHeaderStatus(status: SubagentEffectiveStatus): {
  icon: AgentToolStatus
  label: string
  tone: string
} {
  if (status === 'waiting') {
    return { icon: 'pending', label: 'Paused', tone: SUBAGENT_STATUS_TONE.pending }
  }
  return {
    icon: status,
    label: subagentStatusLabel(status),
    tone: SUBAGENT_STATUS_TONE[status]
  }
}

/** Display name of the model that runs this worker, from the provider catalog. */
export function catalogModelLabel(
  activity: AgentSubagentActivity,
  providers: ProviderCatalog[]
): string | null {
  const modelId = activity.modelId
  if (!modelId) return null
  const models = providers.flatMap((p) => p.models)
  const model =
    models.find(
      (m) => m.id === modelId && (!activity.providerId || m.providerId === activity.providerId)
    ) ??
    // Harnesses that report `provider/model` (pi) still resolve to the
    // catalog's display name.
    models.find((m) => modelId.endsWith(`/${m.id}`))
  return model?.name ?? modelId
}

/** Display name of the provider that runs this worker, when the catalog has it. */
export function catalogProviderName(
  activity: AgentSubagentActivity,
  providers: ProviderCatalog[]
): string | undefined {
  return providers.find((p) => p.id === activity.providerId)?.name ?? undefined
}
