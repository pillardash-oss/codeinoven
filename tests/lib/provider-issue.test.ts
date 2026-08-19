import { describe, expect, it } from 'vitest'
import {
  classifyProviderIssue,
  isUsageResetWaitIssue
} from '../../src/lib/provider-issue'
import type { AgentProviderIssue } from '../../src/lib/types'

function issue(kind: AgentProviderIssue['kind'], retryable = true): AgentProviderIssue {
  return { kind, message: 'test', harnessId: 'test', retryable }
}

describe('isUsageResetWaitIssue', () => {
  it('treats quota and rate-limit issues as reset waits regardless of the retryable flag', () => {
    expect(isUsageResetWaitIssue(issue('quota', true))).toBe(true)
    expect(isUsageResetWaitIssue(issue('quota', false))).toBe(true)
    expect(isUsageResetWaitIssue(issue('rate_limit', true))).toBe(true)
    expect(isUsageResetWaitIssue(issue('rate_limit'))).toBe(true)
  })

  it('treats provider_unavailable as a reset wait only when explicitly retryable', () => {
    expect(isUsageResetWaitIssue(issue('provider_unavailable', true))).toBe(true)
    expect(isUsageResetWaitIssue(issue('provider_unavailable', false))).toBe(false)
  })

  it('rejects genuine terminal failures, authentication, and missing issues', () => {
    expect(isUsageResetWaitIssue(issue('unknown', true))).toBe(false)
    expect(isUsageResetWaitIssue(issue('network', true))).toBe(false)
    expect(isUsageResetWaitIssue(issue('authentication', true))).toBe(false)
    expect(isUsageResetWaitIssue(issue('billing', false))).toBe(false)
    expect(isUsageResetWaitIssue(undefined)).toBe(false)
    expect(isUsageResetWaitIssue(null)).toBe(false)
  })
})

describe('classifyProviderIssue usage-limit detection', () => {
  it('classifies usage-limit wording as quota', () => {
    expect(classifyProviderIssue('You have hit your usage limit')).toBe('quota')
    expect(classifyProviderIssue('Your quota is exhausted')).toBe('quota')
  })

  it('classifies rate-limit wording and 429 status as rate_limit', () => {
    expect(classifyProviderIssue('Rate limit exceeded', 429)).toBe('rate_limit')
    expect(classifyProviderIssue('Too many requests')).toBe('rate_limit')
  })
})
