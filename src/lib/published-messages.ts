/**
 * Identity of the conversation rows the app publishes itself.
 *
 * A message row has no `inlineArtifact` column, and these rows are not part of an
 * agent turn: they are drawn on their own, and a turn's closing statement must
 * never pick them up. The flag is therefore inferred from the row id on every
 * read, which makes the id prefix part of the storage contract: an app-published
 * row must be created with one of these prefixes, or it reloads as a textless
 * assistant message that renders as nothing at all.
 */

/** Message-id prefixes owned by the app's own published rows. */
const APP_PUBLISHED_MESSAGE_PREFIXES: readonly string[] = [
  /** An artifact the agent asked the app to render inline. */
  'cio-artifact-',
  /** The work a settled turn cited, drawn as one card per entry. */
  'cio-cited-work-'
]

/** Whether a message row was published by the app rather than produced by a turn. */
export function isAppPublishedMessageId(id: string): boolean {
  return APP_PUBLISHED_MESSAGE_PREFIXES.some((prefix) => id.startsWith(prefix))
}

/** The message id a cited row is stored under, so its prefix and id agree. */
export function citedWorkMessageId(threadId: string, at: number): string {
  return `cio-cited-work-${threadId}-${at}`
}
