import type { AgentProviderIssue } from '../../../lib/types'
import { APP_NAME } from '../../../lib/brand'

export const HISTORY_MIRROR_ERROR_DETAIL_LIMIT = 240

export function rawErrorMessage(error: unknown): string {
  const fallback = 'The harness did not provide a readable error.'
  if (error instanceof Error) return error.message.trim() || fallback
  if (typeof error === 'string') return error.trim() || fallback
  return fallback
}

/** Full diagnostic error text for the error card's Raw Error view: the stack
 *  trace when a real Error object reached us, otherwise the message string
 *  as-is. Drivers may attach the raw process output (stderr tail, crash trace)
 *  to an Error's `cause` while keeping `message` short and user-facing, so the
 *  cause chain is walked and appended here. Deliberately separate from
 *  `rawErrorMessage`, which must stay a short single-line message for logging
 *  and report fields. */
export function rawErrorDetail(error: unknown): string {
  if (error instanceof Error) {
    const parts = [error.stack?.trim() || error.message.trim()]
    const cause = error.cause
    if (typeof cause === 'string' && cause.trim()) {
      parts.push(cause.trim())
    } else if (cause instanceof Error) {
      const nested = rawErrorDetail(cause)
      if (nested) parts.push(nested)
    }
    return parts.filter((part) => part.length > 0).join('\n\nCaused by: ')
  }
  return rawErrorMessage(error)
}

export function historyMirrorFailureMessage(rawError: string): string {
  let detail = rawError
  const structuredPayloadStart = detail.indexOf(': {')
  if (structuredPayloadStart > 0) detail = detail.slice(0, structuredPayloadStart)
  detail = detail.replace(/\s+/g, ' ')
  if (detail.length > HISTORY_MIRROR_ERROR_DETAIL_LIMIT) {
    detail = `${detail.slice(0, HISTORY_MIRROR_ERROR_DETAIL_LIMIT - 1)}…`
  }

  return `The agent finished, but ${APP_NAME} could not sync the conversation history. ${detail} Retry the connection to load the latest messages.`
}

export function historyMirrorIssue(error: unknown, harnessId: string): AgentProviderIssue {
  const message = rawErrorMessage(error)
  return {
    kind: 'unknown',
    message: historyMirrorFailureMessage(message),
    rawError: rawErrorDetail(error),
    harnessId,
    retryable: true
  }
}

export function isStructuredOutputHistoryDecodeError(error: unknown): boolean {
  return rawErrorMessage(error).includes('Expected OutputFormatJsonSchema')
}

/**
 * Expected cancellation of an in-flight temporary chat turn   the user closed
 * or expired the chat, or pressed stop. Settles the in-flight prompt without
 * surfacing an error to the UI or the IPC layer.
 */
export class TemporaryChatCancelledError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TemporaryChatCancelledError'
  }
}

export class ImageDescriptorInactivityError extends Error {
  constructor(
    readonly timeoutMs: number,
    readonly attempt: number,
    readonly nextTimeoutMs?: number
  ) {
    super('Image upload or vision-model response timed out')
  }
}

export class GeneratedJsonParseError extends Error {
  constructor(
    message: string,
    readonly rawOutput: string
  ) {
    super(message)
    this.name = 'GeneratedJsonParseError'
  }
}

export class GeneratedSpecOutputError extends Error {
  constructor(
    readonly diagnostic: string,
    readonly rejectedOutput: string,
    readonly repairArtifactPath?: string
  ) {
    super(repairArtifactPath ? `${diagnostic} Repair artifact: ${repairArtifactPath}` : diagnostic)
    this.name = 'GeneratedSpecOutputError'
  }
}

export class GeneratedBrainstormOutputError extends Error {
  constructor(
    readonly diagnostic: string,
    readonly rejectedOutput: string,
    readonly repairArtifactPath?: string
  ) {
    super(repairArtifactPath ? `${diagnostic} Repair artifact: ${repairArtifactPath}` : diagnostic)
    this.name = 'GeneratedBrainstormOutputError'
  }
}

export class AssignmentApiRequestError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message)
    this.name = 'AssignmentApiRequestError'
  }
}
