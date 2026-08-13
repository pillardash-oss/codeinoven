import type { AgentProviderIssueKind } from './types'

/**
 * Classify a provider/harness failure message and optional HTTP status code into
 * a provider-neutral kind so every driver and the chat engine agree on how the
 * failure is presented (title, retry affordance, raw-error visibility).
 */
export function classifyProviderIssue(
  message: string,
  statusCode?: number
): AgentProviderIssueKind {
  const normalized = message.toLowerCase()
  if (
    statusCode === 429 ||
    normalized.includes('rate limit') ||
    normalized.includes('too many requests')
  ) {
    return 'rate_limit'
  }
  if (
    normalized.includes('quota') ||
    normalized.includes('session limit') ||
    normalized.includes('exhausted') ||
    normalized.includes('window exceeded')
  ) {
    return 'quota'
  }
  if (
    statusCode === 401 ||
    statusCode === 403 ||
    normalized.includes('unauthorized') ||
    normalized.includes('authentication') ||
    normalized.includes('authenticate') ||
    normalized.includes('oauth') ||
    normalized.includes('sign in') ||
    normalized.includes('login required') ||
    normalized.includes('session expired') ||
    normalized.includes('api key')
  ) {
    return 'authentication'
  }
  if (
    normalized.includes('billing') ||
    normalized.includes('credit') ||
    normalized.includes('payment')
  ) {
    return 'billing'
  }
  if (
    statusCode === 503 ||
    normalized.includes('overloaded') ||
    normalized.includes('unavailable')
  ) {
    return 'provider_unavailable'
  }
  if (
    normalized.includes('network') ||
    normalized.includes('connection') ||
    normalized.includes('disconnected') ||
    normalized.includes('timeout') ||
    normalized.includes('timed out') ||
    normalized.includes('econnreset') ||
    normalized.includes('econnrefused') ||
    normalized.includes('enotfound') ||
    normalized.includes('socket hang up') ||
    normalized.includes('fetch failed') ||
    normalized.includes('dns') ||
    normalized.includes('offline')
  ) {
    return 'network'
  }
  return 'unknown'
}
