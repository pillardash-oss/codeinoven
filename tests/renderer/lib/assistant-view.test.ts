import { describe, expect, it } from 'vitest'
import {
  UNGROUPED_MISSED_RUNS,
  extractHowToDraft,
  groupMissedRunsByRoutine,
  latestHowToDraft,
  missedTabVisible,
  taskHasMissed,
  taskRowIconKey,
  taskRunLine
} from '$lib/components/assistant/assistant-view'
import { STATUS_TONE_COLORS } from '$lib/stores/scope-board'
import { STATUS_TONE_COLORS as STATUS_TONE_COLORS_VIA_SCOPE } from '$lib/stores/scope.svelte'
import { THREAD_STATUS_POLICY } from '$shared/thread-status-policy'
import type { MissedRun } from '$shared/types'

function missedRun(overrides: Partial<MissedRun> = {}): MissedRun {
  return {
    id: 't1:123',
    threadId: 't1',
    dueAt: 123,
    detectedAt: 456,
    title: 'Task',
    status: 'pending',
    ...overrides
  }
}

describe('assistant-view presentation helpers', () => {
  it('shows the Missed runs tab only when a run was missed', () => {
    expect(missedTabVisible([])).toBe(false)
    expect(missedTabVisible([missedRun()])).toBe(true)
    expect(taskHasMissed([])).toBe(false)
    expect(taskHasMissed([missedRun()])).toBe(true)
  })

  it('groups missed runs per routine, keeping routine-less runs separate', () => {
    const runs = [
      missedRun({ id: 'a:1', threadId: 'a', routineId: 'r1', title: 'A' }),
      missedRun({ id: 'b:1', threadId: 'b', routineId: 'r2', title: 'B' }),
      missedRun({ id: 'c:1', threadId: 'c', title: 'C' }),
      missedRun({ id: 'a:2', threadId: 'a', routineId: 'r1', title: 'A again' })
    ]
    const groups = groupMissedRunsByRoutine(
      runs,
      new Map([
        ['r1', 'Daily PR triage'],
        ['r2', 'Morning inbox report']
      ])
    )
    expect(groups.map((group) => group.key)).toEqual(['r1', 'r2', UNGROUPED_MISSED_RUNS])
    expect(groups.map((group) => group.label)).toEqual([
      'Daily PR triage',
      'Morning inbox report',
      'Tasks without a routine'
    ])
    // Runs of one routine stay together, in store order.
    expect(groups[0].runs.map((run) => run.id)).toEqual(['a:1', 'a:2'])
  })

  it('falls back to a neutral routine label when the routine name is unknown', () => {
    const [group] = groupMissedRunsByRoutine(
      [missedRun({ id: 'x:1', threadId: 'x', routineId: 'missing' })],
      new Map()
    )
    expect(group.label).toBe('Routine')
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

describe('how-to draft extraction', () => {
  it('reads a bare fence whose body starts with a how-to title line', () => {
    const message = [
      'Here is the exact instruction set for the routine.',
      '',
      '```',
      'how-to: Slack checkup drain',
      '',
      'GOAL',
      'Twice a day, sweep every Slack conversation.',
      '```',
      '',
      'Send /save-how-to to commit this.'
    ].join('\n')
    expect(extractHowToDraft(message)).toBe('GOAL\nTwice a day, sweep every Slack conversation.')
  })

  it('reads a fence tagged how-to with or without a trailing title', () => {
    expect(extractHowToDraft('```how-to\nCheck email at 08:30.\n```')).toBe('Check email at 08:30.')
    expect(extractHowToDraft('```how-to: Morning mail\nCheck email at 08:30.\n```')).toBe(
      'Check email at 08:30.'
    )
    expect(extractHowToDraft('```howto\nCheck email.\n```')).toBe('Check email.')
    expect(extractHowToDraft('```How-To - Morning mail\nCheck email.\n```')).toBe('Check email.')
  })

  it('strips the marker line when the fence carries both a tag and a title line', () => {
    expect(extractHowToDraft('```how-to\nhow-to: Morning mail\n\nCheck email at 08:30.\n```')).toBe(
      'Check email at 08:30.'
    )
  })

  it('ignores blocks and messages that carry no how-to', () => {
    expect(extractHowToDraft('No code block here at all.')).toBeNull()
    expect(extractHowToDraft('```ts\nconst x = 1\n```')).toBeNull()
    expect(extractHowToDraft('```json\n{"how-to": "not a block"}\n```')).toBeNull()
    expect(extractHowToDraft('```\nhow-to: title only\n```')).toBeNull()
  })

  it('takes the newest how-to block in a message', () => {
    const message = ['```how-to\nFirst draft.\n```', '```how-to\nSecond draft.\n```'].join('\n')
    expect(extractHowToDraft(message)).toBe('Second draft.')
  })

  it('keeps a nested command fence inside the draft instead of truncating at it', () => {
    const message = [
      '```how-to',
      'GOAL',
      '',
      'Run this:',
      '```bash',
      'gh pr list --state open',
      '```',
      '',
      'Then summarise the result.',
      '```'
    ].join('\n')
    expect(extractHowToDraft(message)).toBe(
      [
        'GOAL',
        '',
        'Run this:',
        '```bash',
        'gh pr list --state open',
        '```',
        '',
        'Then summarise the result.'
      ].join('\n')
    )
  })

  it('keeps nested fences in a four-backtick block and excludes trailing prose', () => {
    const message = [
      '````how-to',
      'GOAL',
      '```bash',
      'ls',
      '```',
      '````',
      '',
      'Send /save-how-to to commit this.'
    ].join('\n')
    expect(extractHowToDraft(message)).toBe(['GOAL', '```bash', 'ls', '```'].join('\n'))
  })

  it('stops at the how-to block even when a later fenced block follows it', () => {
    const message = [
      '```how-to',
      'GOAL',
      '```',
      '',
      'Send /save-how-to.',
      '',
      '```bash',
      'ls',
      '```'
    ].join('\n')
    expect(extractHowToDraft(message)).toBe('GOAL')
  })

  it('takes the newest message that holds a draft', () => {
    const texts = [
      '```how-to\nOlder draft.\n```',
      'Still discussing the tools.',
      '```\nhow-to: Slack digest\n\nNewer draft.\n```'
    ]
    expect(latestHowToDraft(texts)).toBe('Newer draft.')
    expect(latestHowToDraft(['No draft yet.', '```ts\nconst x = 1\n```'])).toBeNull()
  })
})
