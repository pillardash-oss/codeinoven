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
 * True when a provider rejected the request for exceeding a hard request limit:
 * a serialized-body byte cap (e.g. "Upstream request failed:
 * [invalid_request_error] Request body exceeds the 4.5 MiB limit."), more media
 * parts than it accepts per request (e.g. "Too many images in request: 31 >
 * 30"), or the model's token window itself (e.g. "This model's maximum context
 * length is 1048576 tokens. However, you requested 1307638 tokens (923638 in
 * the messages, 384000 in the completion). Please reduce the length of the
 * messages or completion.").
 *
 * The token form matters because a provider that bills the completion budget
 * against the same window can reject a request long before the harness's own
 * token accounting reaches its threshold   one base64 tool result is enough   so
 * the driver recovers by compacting the transcript (which replaces bulky
 * history with a summary) and re-prompting with the oversized-recovery armed,
 * which strips image parts and oversized text from the request copy only.
 */
export function isOversizedRequestError(error: string): boolean {
  return /request body exceeds[\w\s.]*limit|too many images in request|maximum context length|context_length_exceeded|reduce the length of the messages/iu.test(
    error
  )
}
