import { assistantDisplayText } from '$lib/components/assistant/assistant-view'
import { assistantResultText, stripAssistantEnvelope } from '$shared/assistant-result'

/**
 * How a transcript reads the text a run left behind.
 *
 * A run writes its answer inside the app's own `<assistant_result>` boundary, and
 * a group conversation holds several speakers whose replies all arrive that way.
 * Every surface that draws such a text reads it through these rules, so the
 * boundary can never reach the reader through one path while another strips it.
 */
export interface ConversationTextScope {
  /** True for the assistant space, where a message is a run's report. */
  assistantMode: boolean
  /** True for a group conversation, where several assistants share a transcript. */
  groupThread: boolean
  /** True while the assistant itself is being authored, so its text carries drafts. */
  authoringThread: boolean
}

/**
 * The text a finished answer shows.
 *
 * The run's marked update is the answer; anything around it is working notes. A
 * conversation that is neither the assistant space nor a group keeps its plain
 * transcript, but the transport tags are removed there too rather than shown as
 * words: they are the app's wire format, never something a person wrote.
 */
export function conversationAnswerText(
  scope: ConversationTextScope,
  raw: string,
  streaming = false
): string {
  if (scope.authoringThread) return assistantDisplayText(stripAssistantEnvelope(raw))
  if (scope.assistantMode || scope.groupThread)
    return stripAssistantEnvelope(assistantResultText(raw, streaming))
  return stripAssistantEnvelope(raw)
}

/**
 * The text a trace step or the live activity line shows while a turn is working.
 *
 * Same rule as the answer, read while streaming: a run that has not opened its
 * result yet says nothing here, so its boundary is never flashed as prose.
 */
export function conversationProseText(scope: ConversationTextScope, raw: string): string {
  if (scope.authoringThread) return assistantDisplayText(stripAssistantEnvelope(raw))
  if (scope.assistantMode || scope.groupThread)
    return stripAssistantEnvelope(assistantResultText(raw, true))
  return stripAssistantEnvelope(raw)
}

/** Longest preview a reply quote keeps of the message it answers. */
const QUOTE_EXCERPT_LIMIT = 180

/**
 * The one-line preview a reply quote shows of the message it answers.
 *
 * A quote has no renderer of its own: it is a line of prose cut out of a
 * message, so it must read as words and never as source. The recorded excerpt
 * was taken from the message's raw text, which put the run's own transport
 * boundary in front of every quote of an assistant answer (`<assistant_result>`
 * showed up as the first thing the reader saw), and left markdown decorators,
 * code fences and line breaks inside a span that cannot render them. Both sides
 * of the quote go through here: the excerpt is built with it, and a snapshot
 * written before that rule is read back with it.
 */
export function conversationQuoteExcerpt(raw: string, limit = QUOTE_EXCERPT_LIMIT): string {
  const prose = stripAssistantEnvelope(raw)
    .replace(/```[^\n]*\n?/gu, ' ')
    .replace(/`([^`]*)`/gu, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d{1,9}[.)])\s+/gmu, '')
    .replace(/\*\*|__|~~|\*/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
  if (prose.length <= limit) return prose
  const cut = prose.slice(0, limit)
  const boundary = cut.lastIndexOf(' ')
  const kept = boundary > limit * 0.6 ? cut.slice(0, boundary) : cut
  return `${kept.trimEnd()}\u2026`
}
