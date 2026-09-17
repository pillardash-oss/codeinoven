/** Classification of Pi provider failures the driver can recover from. */

/**
 * True when a Pi failure is a finish-reason flake the model can recover from by
 * simply being asked to continue. pi's provider adapter maps any unrecognized
 * provider `finish_reason` to `stopReason: "error"` with the message
 * `Provider finish_reason: <reason>`   a transient stream/provider issue, not a
 * terminal outcome. `content_filter` is the exception: re-prompting past a
 * moderation stop is wrong, so it stays a real error.
 */
export function isContinuableFinishReasonError(error: string): boolean {
  const match = error.match(/^Provider finish_reason: (.+)$/u)
  return match !== null && match[1] !== 'content_filter'
}

/**
 * True when a provider rejected the request because the serialized body exceeds
 * a hard byte limit (e.g. "Upstream request failed: [invalid_request_error]
 * Request body exceeds the 4.5 MiB limit."), or because it carries more media
 * parts than the provider accepts per request (e.g. "Too many images in
 * request: 31 > 30"). Token-based auto-compaction never sees either coming
 *   images and large tool results blow the byte budget or the media-part cap
 * long before the token window fills   so the driver recovers by compacting
 * the transcript (which replaces bulky history with a summary) and re-prompting
 * with the oversized-recovery armed, which strips image parts and oversized
 * text from the request copy only.
 */
export function isOversizedRequestError(error: string): boolean {
  return /request body exceeds[\w\s.]*limit|too many images in request/iu.test(error)
}
