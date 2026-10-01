import type { AgentMessage, AgentPart, PromptAttachment } from './types'

/**
 * The user request a continuation turn has to carry.
 *
 * A retry (provider error, usage pause, harness restart) starts a turn on a
 * session that may hold nothing of the conversation: an account or harness
 * change replaces the session, a released session is gone, and a resumed native
 * transcript can be older than the thread. A bare "Continue" then reaches the
 * agent with no request to continue, and the user's message reads as delivered
 * in the app while the agent never saw it. These rules pick the request a
 * continuation must relay, and compose the prompt that carries it.
 *
 * The request is its prose AND the files the user attached to it. A relay that
 * keeps only the text leaves a pasted screenshot behind, and the agent answers
 * from a request it never fully saw.
 */

/** The request a continuation has to answer: its prose and its attached files. */
export interface PendingContinuationRequest {
  /** User prose, or the chip's action and body; empty when the files are the ask. */
  text: string
  /** Files the request carried, in the order the user attached them. */
  attachments: PromptAttachment[]
}

/**
 * User messages that only report app activity (compaction notices, sub-agent
 * envelopes). They ride mid-turn on the user role and are never user prose.
 */
function isActivityOnlyUserMessage(message: AgentMessage): boolean {
  return (
    message.parts.length > 0 &&
    message.parts.every((part) => part.type === 'compaction' || part.type === 'subagent')
  )
}

function presentationOf(
  message: AgentMessage
): Extract<AgentPart, { type: 'user-presentation' }> | undefined {
  return message.parts.find(
    (part): part is Extract<AgentPart, { type: 'user-presentation' }> =>
      part.type === 'user-presentation'
  )
}

/**
 * Whether the message is one of the app's own action chips, e.g. a previous
 * "Retry connection". A chip carries no body when the app alone produced it, so
 * it holds no user input: the request it was continuing sits further back.
 * Chips the user authored (a workflow action with a comment, the approved
 * answers to an agent question) carry a body and stay requests of their own.
 * Files on a chip stay the chip's too: a retry relays the attachments of the
 * request behind it, and a later retry reads them from there again.
 */
function isAppActionChip(message: AgentMessage): boolean {
  const presentation = presentationOf(message)
  if (!presentation || presentation.presentation.body?.trim()) return false
  return !message.parts.some((part) => part.type === 'text' && part.text.trim().length > 0)
}

/** The text a user message carries: its prose, or its presentation action and body. */
function userRequestText(message: AgentMessage): string {
  const presentation = presentationOf(message)
  if (presentation) {
    return [presentation.presentation.action, presentation.presentation.body]
      .filter(Boolean)
      .join('\n\n')
  }
  return message.parts
    .filter((part): part is Extract<AgentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
}

/** The files a user message carried, in the order the user attached them. */
function userRequestAttachments(message: AgentMessage): PromptAttachment[] {
  return message.parts
    .filter((part): part is Extract<AgentPart, { type: 'file' }> => part.type === 'file')
    .map((part) => ({
      mime: part.mime,
      url: part.url,
      ...(part.filename ? { filename: part.filename } : {})
    }))
}

/** Whether an assistant message shows the user a visible answer. */
function hasVisibleAnswer(message: AgentMessage): boolean {
  if (message.visibility === 'hidden') return false
  return message.parts.some((part) => part.type === 'text' && part.text.trim().length > 0)
}

/**
 * The newest user request whose turn ended without a visible answer, or
 * undefined when the last request was answered. Read newest first: an answer
 * retires the request behind it, while a turn that produced no answer (an
 * empty or tool-only record, a provider failure) leaves it pending. A request
 * that carries files but no prose counts: the files are the ask.
 */
export function pendingContinuationRequest(
  messages: readonly AgentMessage[]
): PendingContinuationRequest | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message) continue
    if (message.role === 'assistant') {
      if (hasVisibleAnswer(message)) return undefined
      continue
    }
    if (isActivityOnlyUserMessage(message) || isAppActionChip(message)) continue
    const text = userRequestText(message).trim()
    const attachments = userRequestAttachments(message)
    if (text || attachments.length > 0) return { text, attachments }
  }
  return undefined
}

/** Separator between the relay's parts, and its total cost for three parts. */
const JOIN_SEPARATOR = '\n\n'
const CONTINUATION_JOIN_CHARACTERS = JOIN_SEPARATOR.length * 2

/** Opens the prompt a continuation turn sends when it carries the request itself. */
export const CONTINUATION_REQUEST_PREAMBLE =
  'Your previous turn ended before you answered the request below. It still stands:'

/**
 * The prompt bound every send path enforces. A relayed request is cut to stay
 * inside it: a message at the composer's own limit plus the relay would
 * otherwise be rejected and the retry would fail instead of running.
 */
export const CONTINUATION_PROMPT_CHARACTER_LIMIT = 200_000

/**
 * Whether a prompt is the app's own continuation relay rather than user prose.
 * The relay opens with its fixed preamble, so a send path can recognize the
 * request it carries and treat its files as a replay of an older message.
 */
export function isContinuationRelayPrompt(text: string): boolean {
  return text.startsWith(CONTINUATION_REQUEST_PREAMBLE)
}

/**
 * The prompt for a continuation that carries its request, so the turn is
 * answerable on any session: a retry after a failed turn, or an automatic
 * resume the app issues on the user's behalf. The request's files travel as
 * send-path attachments beside this prompt; a request that is files alone
 * still relays, so the preamble marks the turn as a continuation.
 */
export function continuationRequestPrompt(
  request: PendingContinuationRequest,
  nudge = 'Continue'
): string {
  const relayed = request.text.trim()
  if (!relayed && request.attachments.length === 0) return nudge
  const room = Math.max(
    1,
    CONTINUATION_PROMPT_CHARACTER_LIMIT -
      CONTINUATION_REQUEST_PREAMBLE.length -
      nudge.length -
      CONTINUATION_JOIN_CHARACTERS
  )
  const bounded = relayed.length > room ? `${relayed.slice(0, room - 1).trimEnd()}…` : relayed
  return [CONTINUATION_REQUEST_PREAMBLE, bounded, nudge]
    .filter((part) => part.length > 0)
    .join(JOIN_SEPARATOR)
}
