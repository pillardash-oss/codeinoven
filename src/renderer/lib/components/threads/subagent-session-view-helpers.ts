import { appendPartDelta, mergeStreamedPart } from '$shared/agent-part-merge'
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

/** A sub-agent run folded into what the transcript and its trace each render. */
export interface SubagentSessionRun {
  /** Every renderable part of the run, in stream order, with the closing
   *  statement removed when the transcript is the one rendering it. */
  parts: AgentPart[]
  /** The run's closing statement, or null when there is none to move out. */
  closing: Extract<AgentPart, { type: 'text' }> | null
}

/**
 * Fold a sub-agent's whole transcript into one run: every assistant message's
 * parts in stream order, with the worker's closing statement separated out.
 *
 * A sub-agent session is one continuous piece of work, not a series of turns,
 * so it renders as a single working trace. Folding all of its messages into one
 * part list is what lets `groupTraceIntoChains` read that trace as chains of
 * thought exactly as a main-thread turn does, instead of stacking one trace per
 * message   and reprinting one running timer on each of them.
 *
 * `holdsClosingText` is true while the run is still busy, when its newest text
 * is commentary on work in flight and belongs in the trace with that work. Once
 * the run is over, the closing statement is the worker's answer, so it leaves
 * the trace for the transcript.
 */
export function subagentSessionRun(
  messages: readonly AgentMessage[],
  holdsClosingText: boolean
): SubagentSessionRun {
  const parts: AgentPart[] = []
  let closing: Extract<AgentPart, { type: 'text' }> | null = null
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const part of message.parts) {
      // A question part needs its own card, which this view does not render, so
      // it stays out of the trace instead of showing up as a step.
      if (part.type === 'question') continue
      if (part.type === 'text') {
        if (part.text.trim().length === 0) continue
        closing = part
      }
      parts.push(part)
    }
  }
  if (holdsClosingText || !closing) return { parts, closing: null }
  const closingId = closing.id
  return { parts: parts.filter((part) => part.id !== closingId), closing }
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
  return messages.map((message) => {
    if (message.id !== messageId) return message
    let touched = false
    const parts = message.parts.map((part) => {
      if (part.id !== partId) return part
      const updated = appendPartDelta(part, field, delta)
      if (updated === part) return part
      touched = true
      return updated
    })
    // Tool-argument deltas carry fields this fold does not own; leaving the
    // message identity untouched keeps the sub-agent view from re-rendering
    // its whole transcript for a delta that changed nothing.
    return touched ? { ...message, parts } : message
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

/**
 * How CodeInOven frames the primary agent's words before they reach a worker
 * session (see the pi spawn tool's worker prompt). The framing is app-owned
 * instruction, never conversation, so this view never renders it.
 */
const WORKER_PROMPT_FRAMING = 'You are a CodeInOven sub-agent spawned by the primary agent'
const WORKER_PROMPT_MARKER = 'Instructions from the primary agent:'

/** The primary agent's own instructions inside a framed worker prompt, or
 *  `undefined` when the text is not a framed worker prompt. */
export function unwrapWorkerPrompt(text: string): string | undefined {
  const trimmed = text.trim()
  if (!trimmed.startsWith(WORKER_PROMPT_FRAMING)) return undefined
  const marker = trimmed.lastIndexOf(WORKER_PROMPT_MARKER)
  if (marker === -1) return undefined
  return trimmed.slice(marker + WORKER_PROMPT_MARKER.length).trim()
}

/** Rewrite a framed worker prompt message to carry only the instructions. */
function withoutWorkerFraming(message: AgentMessage, instructions: string): AgentMessage {
  const parts: AgentPart[] = []
  let replaced = false
  for (const part of message.parts) {
    if (part.type !== 'text') {
      parts.push(part)
      continue
    }
    if (replaced) continue
    replaced = true
    parts.push({ ...part, text: instructions })
  }
  return { ...message, parts }
}

/** Drop the duplicated delegated prompt from the transcript: the view renders
 *  the task once, in its own bubble above the conversation. A worker session's
 *  first user message is the primary agent's instructions wrapped in the app's
 *  own worker framing, so it is recognized by that framing as well as by an
 *  exact match, instead of repeating the task with the internal prompt on show. */
export function filterVisibleMessages(
  messages: AgentMessage[],
  prompt: string | undefined
): AgentMessage[] {
  const trimmedPrompt = prompt?.trim()
  let skippedPrompt = false
  const visible: AgentMessage[] = []
  for (const message of messages) {
    if (skippedPrompt || message.role !== 'user') {
      visible.push(message)
      continue
    }
    const text = textParts(message)
      .map((part) => part.text.trim())
      .join('\n')
    const instructions = unwrapWorkerPrompt(text)
    if (text !== trimmedPrompt && instructions === undefined) {
      visible.push(message)
      continue
    }
    skippedPrompt = true
    // The task bubble above already carries the instructions.
    if (trimmedPrompt) continue
    visible.push(instructions === undefined ? message : withoutWorkerFraming(message, instructions))
  }
  return visible
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
