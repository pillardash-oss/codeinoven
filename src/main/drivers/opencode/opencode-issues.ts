import type { AgentProviderIssue } from '../../../lib/types'
import {
  classifyProviderIssue,
  extractProviderErrorEnvelope,
  parseUsageResetAt,
  presentProviderError
} from '../../../lib/provider-issue'
import { numberValue, recordValue, stringValue } from './opencode-values'

export function openCodeIssue(
  raw: unknown,
  fallback: string,
  overrides: Partial<Pick<AgentProviderIssue, 'attempt' | 'retryAt' | 'retryable'>> = {}
): AgentProviderIssue {
  const error = recordValue(raw)
  const data = recordValue(error?.['data'])
  const rawMessage =
    stringValue(data?.['message']) ??
    stringValue(error?.['message']) ??
    stringValue(raw) ??
    fallback
  // OpenCode (and upstream providers it proxies) sometimes hands back a raw
  // JSON error body as the message string itself (e.g.
  // `429: {"message":"...weekly usage limit...","type":"rate_limit_error",
  // "code":"RATE_LIMITED"}`) instead of a plain sentence. Unwrap it so the UI
  // never has to render the JSON blob as the "friendly" message.
  const envelope = extractProviderErrorEnvelope(rawMessage)
  // A crash inside OpenCode's own runtime is reported as the exception text,
  // trace and all. `presentProviderError` keeps the header line as the card
  // body and hands the trace to the Raw Error view only.
  const presentation = presentProviderError(rawMessage)
  const statusCode = numberValue(data?.['statusCode']) ?? numberValue(error?.['statusCode'])
  const kind = classifyProviderIssue(rawMessage, statusCode)
  // A genuine usage/quota reset date embedded in the message is authoritative
  // over any short-interval retry hint the caller passed in `overrides` (e.g.
  // OpenCode's own internal retry backoff, which fires every few seconds and
  // is meaningless against a multi-day weekly cap).
  const usageResetAt =
    kind === 'quota' || kind === 'rate_limit' ? parseUsageResetAt(envelope.message) : undefined
  return {
    kind,
    message: presentation.message,
    ...(presentation.rawError === undefined ? {} : { rawError: presentation.rawError }),
    harnessId: 'opencode',
    retryable:
      overrides.retryable ??
      (typeof data?.['isRetryable'] === 'boolean' ? data['isRetryable'] : false),
    ...(statusCode === undefined ? {} : { statusCode }),
    ...overrides,
    ...(usageResetAt === undefined ? {} : { retryAt: usageResetAt })
  }
}

/**
 * True when the error is a provider/stream abort rather than a real failure.
 *
 * OpenCode converts any `AbortError`/`DOMException` from the model layer into
 * `MessageAbortedError` ("The operation was aborted."). For a compaction
 * summary this is transient maintenance noise   the conversation is intact,
 * it simply wasn't compacted   so it must never be surfaced as a session
 * error or "aborted" banner. The same abort error also arrives via the
 * `session.error` event (from `SessionProcessor.halt`), which is dropped here.
 */
export function isOpenCodeAbortError(raw: unknown): boolean {
  const error = recordValue(raw)
  const data = recordValue(error?.['data'])
  const name = stringValue(error?.['name']) ?? stringValue(data?.['name']) ?? ''
  const message =
    stringValue(data?.['message']) ?? stringValue(error?.['message']) ?? stringValue(raw) ?? ''
  return (
    name === 'MessageAbortedError' ||
    name === 'AbortError' ||
    name === 'DOMException' ||
    /operation was aborted|request aborted|stream aborted|aborted by user/iu.test(message)
  )
}

export async function errorFromResponse(res: Response, fallback: string): Promise<Error> {
  const body = await res.text().catch(() => '')
  const detail = body ? `: ${body.slice(0, 500)}` : ''
  return new Error(`${fallback} (${res.status})${detail}`)
}
