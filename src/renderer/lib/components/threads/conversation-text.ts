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
