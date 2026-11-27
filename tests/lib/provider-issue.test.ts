import { describe, expect, it } from 'vitest'
import {
  classifyProviderIssue,
  isUsageLimitNoticeText,
  isUsageResetWaitIssue,
  RATE_LIMIT_COOLDOWN_MAX_ATTEMPTS,
  rateLimitCooldownMs
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

describe('rateLimitCooldownMs', () => {
  it('backs off 1s, 3s, 5s, 10s, 30s, then 60s', () => {
    expect([1, 2, 3, 4, 5, 6].map((attempt) => rateLimitCooldownMs(attempt))).toEqual([
      1_000, 3_000, 5_000, 10_000, 30_000, 60_000
    ])
  })

  it('stops after the sixth retry instead of hammering the provider forever', () => {
    expect(RATE_LIMIT_COOLDOWN_MAX_ATTEMPTS).toBe(6)
    expect(rateLimitCooldownMs(7)).toBeUndefined()
    expect(rateLimitCooldownMs(0)).toBeUndefined()
    expect(rateLimitCooldownMs(1.5)).toBeUndefined()
  })
})

describe('classifyProviderIssue usage-limit detection', () => {
  it('classifies usage-limit wording as quota', () => {
    expect(classifyProviderIssue('You have hit your usage limit')).toBe('quota')
    expect(classifyProviderIssue('Your quota is exhausted')).toBe('quota')
  })

  it('classifies window-scoped cap wording as quota', () => {
    // The exact notice Claude Code sent when the reported failure was the
    // process exit code instead of the weekly cap.
    expect(classifyProviderIssue("You've hit your weekly limit · resets 6am (Africa/Lagos)")).toBe(
      'quota'
    )
    expect(classifyProviderIssue("You've hit your 5-hour limit")).toBe('quota')
    expect(classifyProviderIssue('You have hit your five hour limit')).toBe('quota')
    expect(classifyProviderIssue('five hours limit reached')).toBe('quota')
    expect(classifyProviderIssue('Your daily limit resets at midnight')).toBe('quota')
    expect(classifyProviderIssue('monthly_limit_reached')).toBe('quota')
  })

  it('leaves a window word that does not describe the cap unclassified', () => {
    expect(classifyProviderIssue('The weekly report shows a limit on imports')).toBe('unknown')
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
      'Good catch   the gap was real. '.repeat(20) +
      'Root cause: Pi reports its exhausted usage window as a terminal status, so the usage limit card rendered a countdown but no scheduler record was tracked.'
    expect(isUsageLimitNoticeText(agentAnswer)).toBe(false)
  })

  it('rejects markdown-formatted agent answers regardless of length', () => {
    const markdownAnswer =
      '**Root cause:** the usage limit was hit mid-turn.\n\n- The card rendered a countdown\n- No scheduler record was tracked'
    expect(isUsageLimitNoticeText(markdownAnswer)).toBe(false)
    expect(
      isUsageLimitNoticeText('## Usage limit reached\n\nSee the [docs](https://example.com).')
    ).toBe(false)
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

  it('accepts window-scoped cap notices', () => {
    expect(isUsageLimitNoticeText("You've hit your weekly limit · resets 6am (Africa/Lagos)")).toBe(
      true
    )
    expect(isUsageLimitNoticeText('5-hour limit reached. Resets in 1hr 53min.')).toBe(true)
    expect(isUsageLimitNoticeText('You have hit your five hour limit')).toBe(true)
    expect(isUsageLimitNoticeText('Weekly limit reached. Resets Monday.')).toBe(true)
  })

  it('rejects a window word that does not describe the cap', () => {
    expect(isUsageLimitNoticeText('The weekly report explains the import limit')).toBe(false)
  })

  it('rejects empty input', () => {
    expect(isUsageLimitNoticeText('')).toBe(false)
    expect(isUsageLimitNoticeText('   ')).toBe(false)
  })
})
