import { describe, expect, it } from 'vitest'
import {
  classifyProviderIssue,
  isUsageLimitNoticeText,
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

  it('classifies machine-style underscore/hyphen limit strings as quota', () => {
    expect(classifyProviderIssue('usage_limit_exceeded')).toBe('quota')
    expect(classifyProviderIssue('session_limit_reached')).toBe('quota')
    expect(classifyProviderIssue('error-max-usage-limit')).toBe('quota')
    expect(classifyProviderIssue('rate_limit_error')).toBe('rate_limit')
  })

  it('classifies rate-limit wording and 429 status as rate_limit', () => {
    expect(classifyProviderIssue('Rate limit exceeded', 429)).toBe('rate_limit')
    expect(classifyProviderIssue('Too many requests')).toBe('rate_limit')
  })
})

describe('isUsageLimitNoticeText', () => {
  it('accepts short plain-text harness usage notices', () => {
    expect(isUsageLimitNoticeText('5-hour usage limit reached. Resets in 1hr 53min.')).toBe(true)
    expect(isUsageLimitNoticeText('Rate limit exceeded. Retry in 30s.')).toBe(true)
    expect(isUsageLimitNoticeText('Monthly quota exhausted. Resets Aug 4.')).toBe(true)
  })

  it('rejects long agent prose that merely discusses usage limits', () => {
    const agentAnswer =
      'Good catch — the gap was real. '.repeat(20) +
      'Root cause: Pi reports its exhausted usage window as a terminal status, so the usage limit card rendered a countdown but no scheduler record was tracked.'
    expect(isUsageLimitNoticeText(agentAnswer)).toBe(false)
  })

  it('rejects markdown-formatted agent answers regardless of length', () => {
    const markdownAnswer =
      '**Root cause:** the usage limit was hit mid-turn.\n\n- The card rendered a countdown\n- No scheduler record was tracked'
    expect(isUsageLimitNoticeText(markdownAnswer)).toBe(false)
    expect(isUsageLimitNoticeText('## Usage limit reached\n\nSee the [docs](https://example.com).')).toBe(
      false
    )
  })

  it('rejects text whose limit phrasing only appears mid-prose', () => {
    const midProse =
      'The scheduler now fires on any retryAt once it passes, so a usage limit reached mid-run still auto-resumes without leaving the thread stuck on an error state forever.'
    expect(isUsageLimitNoticeText(midProse)).toBe(false)
  })

  it('rejects large structured payloads (assignment plans, JSON blobs)', () => {
    const planBlob =
      '{ "problem": "The audit identifies release blockers, security flaws, oversized modules, duplicated command handling, performance risks, and CI gaps.", "resolutionSummary": "Use one master Assignment divided into seven implementation phases.", "phases": [ { "id": "phase-1-release", "title": "Restore release health", "objective": "Fix the usage limit message not parsed as a retryable wait." } ] }'
    expect(isUsageLimitNoticeText(planBlob)).toBe(false)
  })

  it('accepts notices whose lead phrasing sits in a longer opening line', () => {
    expect(isUsageLimitNoticeText("You've reached your usage limit for this window")).toBe(true)
  })

  it('rejects empty input', () => {
    expect(isUsageLimitNoticeText('')).toBe(false)
    expect(isUsageLimitNoticeText('   ')).toBe(false)
  })
})
