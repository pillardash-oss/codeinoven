/**
 * Tags a model wraps its own reasoning in. A harness normally splits that
 * reasoning out of the reply, but when the split fails the opening or closing
 * tag arrives as ordinary assistant text. The tag carries no meaning in a
 * message body and reads as noise to a person, so a lone one is a streaming
 * artifact rather than something the model meant to say.
 */
const THINKING_ARTIFACT_PATTERN = /<\/?think(?:ing)?>/giu

/**
 * Remove leaked thinking tags from model-authored text.
 *
 * A leaked tag marks where the model's reasoning ended and its reply began, so
 * it becomes a paragraph break: deleting it outright would glue the last line
 * of the reasoning onto the first line of the reply. A tag that already sat on
 * its own line leaves a run of newlines, and that run collapses to one break.
 *
 * Only assistant text passes through here. Tool output and user input keep
 * whatever tags they hold, because there a tag is genuine content.
 */
export function stripThinkingArtifacts(text: string): string {
  if (!text.includes('<')) return text
  return text.replace(THINKING_ARTIFACT_PATTERN, '\n\n').replace(/\n{3,}/gu, '\n\n')
}
