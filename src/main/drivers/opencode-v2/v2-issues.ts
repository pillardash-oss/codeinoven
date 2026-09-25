import type { AgentProviderIssue } from '../../../lib/types'
import {
  classifyProviderIssue,
  extractProviderErrorEnvelope,
  parseUsageResetAt,
  presentProviderError
} from '../../../lib/provider-issue'
import { numberValue, recordValue, stringValue } from './v2-values'

/** Harness id every V2 issue is attributed to. */
const HARNESS_ID = 'opencode'

/**
 * Convert one V2 structured error into the shared provider issue.
 *
 * V2 reports failures as `Session.StructuredError` (`{type, message, status?}`)
 * on the SSE stream, on assistant messages, and inside tool state. The `type` is
 * an open string (`aborted`, `tool.execution`, `provider.no-route`, ...), so it
 * is only used for diagnostics; the classification comes from the message text
 * and the optional status code, exactly as every other driver's does.
 */
export function openCodeV2Issue(
  raw: unknown,
  fallback: string,
  overrides: Partial<Pick<AgentProviderIssue, 'attempt' | 'retryAt' | 'retryable'>> = {}
): AgentProviderIssue {
  const error = recordValue(raw)
  const rawMessage = stringValue(error?.['message']) ?? stringValue(raw) ?? fallback
  // An upstream provider's JSON error body sometimes arrives as the message
  // string itself; unwrap it so the UI never renders a JSON blob as the
  // friendly message.
  const envelope = extractProviderErrorEnvelope(rawMessage)
  const presentation = presentProviderError(rawMessage)
  const statusCode = numberValue(error?.['status'])
  const kind = classifyProviderIssue(rawMessage, statusCode)
  // A genuine reset date embedded in the message is authoritative over any
  // short-interval retry hint the caller passed in `overrides`.
  const usageResetAt =
    kind === 'quota' || kind === 'rate_limit' ? parseUsageResetAt(envelope.message) : undefined
  return {
    kind,
    message: presentation.message,
    ...(presentation.rawError === undefined ? {} : { rawError: presentation.rawError }),
    harnessId: HARNESS_ID,
    retryable: overrides.retryable ?? false,
    ...(statusCode === undefined ? {} : { statusCode }),
    ...overrides,
    ...(usageResetAt === undefined ? {} : { retryAt: usageResetAt })
  }
}

/** The structured error type V2 uses for a user-initiated interrupt. */
const ABORTED_ERROR_TYPE = 'aborted'

/**
 * True when a V2 error describes a deliberate interrupt rather than a failure.
 *
 * An interrupt ends the turn because the user asked it to: the engine already
 * knows, and surfacing it as a session error would put a scary banner on an
 * action the user performed on purpose.
 */
export function isOpenCodeV2AbortError(raw: unknown): boolean {
  const error = recordValue(raw)
  if (error?.['type'] === ABORTED_ERROR_TYPE) return true
  const message = stringValue(error?.['message']) ?? stringValue(raw) ?? ''
  return /operation was aborted|request aborted|stream aborted|aborted by user|step interrupted|user dismissed/iu.test(
    message
  )
}

/** The message text of a V2 structured error, when it carries one. */
export function openCodeV2ErrorMessage(raw: unknown): string | undefined {
  return stringValue(recordValue(raw)?.['message'])
}
