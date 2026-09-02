// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The Profile settings tab is exercised through a real DOM mount so the
// audit-required assertions run against rendered output: one-shot/multi-shot
// ranking columns must appear and no rubric or judge wording may leak into
// the document. IPC is stubbed at the preload boundary.
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('$lib/ipc.svelte', () => ({
  invoke: invokeMock,
  subscribe: vi.fn(() => () => {})
}))

import { mount, unmount } from 'svelte'
import ProfileSettingsTab from '$lib/components/settings/ProfileSettingsTab.svelte'
import type { LocalProfileAnalytics } from '$shared/types'

function analytics(): LocalProfileAnalytics {
  const now = Date.now()
  const range = { startAt: now - 365 * 24 * 3_600_000, endAt: now }
  return {
    range,
    activityRange: range,
    messageCount: 0,
    costUsd: 0,
    tokens: 0,
    durationMs: 0,
    responseDurationMs: 0,
    topHarnessId: null,
    topProviderId: null,
    topModelId: null,
    harnesses: [],
    providers: [],
    models: [],
    thinkingLevels: [],
    utilities: [],
    projects: [],
    activityDays: [],
    dailyUsage: [],
    hourlyUsage: [],
    modelRankings: [
      {
        harnessId: 'pi',
        providerId: 'openai',
        modelId: 'gpt-5',
        thinkingLevel: 'high',
        rubricVersion: 'ranking-0to10-v1',
        oneShot: { averageScore: 8, samples: 2, averageDurationMs: 45_000, costUsd: 0.04 },
        multiShot: { averageScore: 9, samples: 1, averageDurationMs: 120_000, costUsd: 0.03 },
        updatedAt: now
      }
    ],
    gradingSpend: { costUsd: 0.07 },
    generatedAt: now
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('ProfileSettingsTab model-ranking DOM presentation', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === 'account:getLocalUsage') return analytics()
      if (channel === 'account:getProfile') return { status: 'signed-out', profile: null }
      return null
    })
  })

  it('renders the one-shot and multi-shot ranking columns with data', async () => {
    const target = document.createElement('div')
    document.body.append(target)
    const component = mount(ProfileSettingsTab, { target })
    try {
      await flush()
      await flush()

      const text = target.textContent ?? ''
      expect(text).toContain('Model rankings')
      expect(text).toContain('One-shot')
      expect(text).toContain('Multi-shot')
      expect(text).toContain('Configuration')
      expect(text).toContain('gpt-5')
      expect(text).toContain('8.0/10')
      expect(text).toContain('9.0/10')
      expect(text).toContain('2 conversations')
      expect(text).toContain('1 conversation')
      // The rubric version tag is surfaced per row.
      expect(text).toContain('ranking-0to10-v1')
      // The grading-spend line renders.
      expect(text).toContain('spent')
    } finally {
      unmount(component)
      target.remove()
    }
  })

  it('leaks no rubric descriptors, judge instructions, or delimiter names into the DOM', async () => {
    const target = document.createElement('div')
    document.body.append(target)
    const component = mount(ProfileSettingsTab, { target })
    try {
      await flush()
      await flush()

      const text = target.textContent ?? ''
      expect(text).not.toMatch(/flawless/u)
      expect(text).not.toMatch(/very successful/u)
      expect(text).not.toMatch(/partially helpful/u)
      expect(text).not.toMatch(/actively harmful/u)
      expect(text).not.toMatch(/judge/iu)
      expect(text).not.toMatch(/USER_MESSAGE|AGENT_OUTPUT|USER_FOLLOW_UP/u)
      expect(text).not.toMatch(/0-10 scale/u)
    } finally {
      unmount(component)
      target.remove()
    }
  })
})
