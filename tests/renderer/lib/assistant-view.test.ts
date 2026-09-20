import { describe, expect, it } from 'vitest'
import {
  missedTabVisible,
  taskHasMissed,
  taskRowIconKey,
  taskRunLine
} from '$lib/components/assistant/assistant-view'
import { STATUS_TONE_COLORS } from '$lib/stores/scope-board'
import { STATUS_TONE_COLORS as STATUS_TONE_COLORS_VIA_SCOPE } from '$lib/stores/scope.svelte'
import { THREAD_STATUS_POLICY } from '$shared/thread-status-policy'
import type { MissedRun } from '$shared/types'

function missedRun(): MissedRun {
  return {
    id: 't1:123',
    threadId: 't1',
    dueAt: 123,
    detectedAt: 456,
    title: 'Task',
    status: 'pending'
  }
}

describe('assistant-view presentation helpers', () => {
  it('shows the Missed runs tab only when a run was missed', () => {
    expect(missedTabVisible([])).toBe(false)
    expect(missedTabVisible([missedRun()])).toBe(true)
    expect(taskHasMissed([])).toBe(false)
    expect(taskHasMissed([missedRun()])).toBe(true)
  })

  it('renders next-run first, then last-run, then Not scheduled', () => {
    const now = new Date(2026, 2, 10, 10, 0).getTime()
    const anHourLater = now + 60 * 60 * 1000
    expect(taskRunLine({ lastRunAt: now - 1000 }, anHourLater, now)).toBe('Next run in 1h')
    expect(taskRunLine({ lastRunAt: now - 60 * 60 * 1000 }, null, now)).toBe('Last run 1h ago')
    expect(taskRunLine({}, null, now)).toBe('Not scheduled')
  })

  it('uses a custom task icon only when one is set', () => {
    expect(taskRowIconKey({ assistantIconType: 'code' })).toBe('custom')
    expect(taskRowIconKey({})).toBe('bot')
  })
})

describe('missed status tone', () => {
  it('maps the missed tone to its dedicated token in both scope-board and the scope barrel', () => {
    expect(STATUS_TONE_COLORS.missed).toBe('var(--color-missed)')
    expect(STATUS_TONE_COLORS_VIA_SCOPE.missed).toBe('var(--color-missed)')
  })

  it('never maps a thread status to the missed tone', () => {
    for (const policy of Object.values(THREAD_STATUS_POLICY)) {
      expect(policy.tone).not.toBe('missed')
    }
  })

  it('does not reuse the warning token for missed', () => {
    expect(STATUS_TONE_COLORS.missed).not.toBe(STATUS_TONE_COLORS.attention)
  })
})
