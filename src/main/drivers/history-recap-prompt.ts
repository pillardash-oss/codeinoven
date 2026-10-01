/**
 * Deliver a rebuilt session's restored history in the user channel.
 *
 * The recap is a delimited block (built by `formatHistoryRecap`) that frames the
 * replay as prior conversation and background data. It must ride the user
 * channel, never the system prompt, because the transcript mixes the user's
 * words, tool output, and file contents; the system role would grant all of it
 * system authority.
 *
 * Drivers call this at send time only, on the text they hand the harness, and
 * never with the text they persist to their session's message list or the app
 * mirror. Keeping it out of the mirror's transport is what stops a later recap
 * from being built out of a transcript that already contains one.
 */
export function prependHistoryRecap(text: string, recap: string | undefined): string {
  const block = recap?.trim()
  if (!block) return text
  const message = text.trim()
  return message ? `${block}\n\n${message}` : block
}
