// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The rail's badge composition, in isolation from the stores it is fed by.
 *
 * The two facts pinned here are the ones the rail exists for: a thread waiting
 * on the user must wear the pill even while its family is producing work, and a
 * wait the durable notices know about must light the rail even when the
 * renderer's bounded thread slice no longer carries that thread.
 */
const rail = vi.hoisted(() => ({
  attention: null as { count: number; label: string } | null,
  unread: null as {
    count: number
    threadIds: string[]
    label: string
    colors: string[]
  } | null
}))

vi.mock('$lib/ipc.svelte', () => ({ invoke: vi.fn(), subscribe: vi.fn() }))
vi.mock('$lib/stores/notification-panel.svelte', () => ({
  notificationPanelState: {
    attentionRailSummary: () => rail.attention,
    unreadRailSummary: () => rail.unread
  }
}))

vi.mock('$lib/stores/agent-runs.svelte', () => ({
  agentRuns: { hasPendingRetry: false, retryAt: () => null }
}))
vi.mock('$lib/stores/browser-downloads.svelte', () => ({
  browserDownloads: { outstandingCounts: () => ({ running: 0, paused: 0 }) }
}))
vi.mock('$lib/stores/browser-assistant.svelte', () => ({ browserAssistant: { threads: [] } }))
vi.mock('$lib/stores/browser-audio.svelte', () => ({
  browserAudio: { familiesPlaying: () => new Set(), globalIsPlaying: () => false }
}))
vi.mock('$lib/speech/speech-controller.svelte', () => ({
  speechController: { recordingScope: null, speakingScope: null }
}))
vi.mock('$lib/stores/scope.svelte', () => ({ scopeState: { allScopeThreads: [] } }))
vi.mock('$lib/thread-state-counts', () => ({
  emptyThreadStateCounts: () => ({
    working: 0,
    unread: 0,
    unreadThreadIds: new Set<string>(),
    attention: 0,
    spec: 0,
    retry: 0,
    error: 0
  }),
  countThreadStatesByGroup: () => new Map(),
  countThreadStates: () => ({
    working: 0,
    unread: 0,
    unreadThreadIds: new Set<string>(),
    attention: 0,
    spec: 0,
    retry: 0,
    error: 0
  })
}))

import { emptyThreadStateCounts } from '$lib/thread-state-counts'
import {
  viewBadgesFor,
  type ViewActivityCounts
} from '$lib/components/layout/view-rail-activity.svelte'

type FamilyCounts = Partial<ReturnType<typeof emptyThreadStateCounts>>

/** Every family's counts, with one family overridden by the case under test. */
function counts(
  overrides: FamilyCounts,
  family: 'projects' | 'assistant' | 'chats' = 'projects'
): ViewActivityCounts {
  return {
    projects: { ...emptyThreadStateCounts(), ...(family === 'projects' ? overrides : {}) },
    chats: { ...emptyThreadStateCounts(), ...(family === 'chats' ? overrides : {}) },
    assistant: { ...emptyThreadStateCounts(), ...(family === 'assistant' ? overrides : {}) }
  }
}

const NO_TRANSFERS = { running: 0, stopped: 0 }

beforeEach(() => {
  rail.attention = null
  rail.unread = null
})

describe('the rail badge for a view', () => {
  it('reports a wait even while the family is producing work', () => {
    const badges = viewBadgesFor(
      'assistant',
      null,
      counts({ working: 3, attention: 1 }, 'assistant'),
      NO_TRANSFERS
    )
    expect(badges.activity?.tone).toBe('attention')
    expect(badges.activity?.count).toBe(1)
    expect(badges.activity?.label).toBe(
      '3 assistant threads working, 1 assistant thread needs attention'
    )
  })

  it('lights the pill from a durable notice the thread slice no longer carries', () => {
    rail.attention = { count: 2, label: '2 assistant runs need attention' }
    const badges = viewBadgesFor('assistant', null, counts({}, 'assistant'), NO_TRANSFERS)
    expect(badges.activity?.tone).toBe('attention')
    expect(badges.activity?.count).toBe(2)
    expect(badges.activity?.label).toBe('2 assistant threads need attention')
  })

  it('never reports a smaller wait than the notices count', () => {
    rail.attention = { count: 3, label: '3 project threads need attention' }
    const badges = viewBadgesFor('projects', 'projects', counts({ attention: 1 }), NO_TRANSFERS)
    expect(badges.activity?.count).toBe(3)
  })

  it('stays quiet when neither source has anything for the family', () => {
    const badges = viewBadgesFor('projects', 'projects', counts({}), NO_TRANSFERS)
    expect(badges.activity).toBeNull()
    expect(badges.unread).toBeNull()
  })

  it('reports working when nothing is waiting on the user', () => {
    const badges = viewBadgesFor('projects', 'projects', counts({ working: 4 }), NO_TRANSFERS)
    expect(badges.activity?.tone).toBe('working')
    expect(badges.activity?.count).toBe(4)
  })

  it('counts an unread thread once when a notice and a row report the same thread', () => {
    rail.unread = {
      count: 1,
      threadIds: ['thread-1'],
      label: '1 unread project',
      colors: ['var(--color-chat-success)', 'var(--color-success)']
    }
    const badges = viewBadgesFor(
      'projects',
      'projects',
      counts({ unread: 1, unreadThreadIds: new Set(['thread-1']) }),
      NO_TRANSFERS
    )
    expect(badges.unread?.count).toBe(1)
  })

  it('counts two unread threads when each source knows one the other does not', () => {
    rail.unread = {
      count: 1,
      threadIds: ['thread-2'],
      label: '1 unread project',
      colors: ['var(--color-success)']
    }
    const badges = viewBadgesFor(
      'projects',
      'projects',
      counts({ unread: 1, unreadThreadIds: new Set(['thread-1']) }),
      NO_TRANSFERS
    )
    expect(badges.unread?.count).toBe(2)
  })

  it('wears the canonical unread tone on the assistant item, never the space brand colour', () => {
    rail.unread = {
      count: 1,
      threadIds: ['thread-1'],
      label: '1 unread assistant',
      colors: ['#8b5cf6']
    }
    const badges = viewBadgesFor(
      'assistant',
      null,
      counts({ unread: 1, unreadThreadIds: new Set(['thread-1']) }, 'assistant'),
      NO_TRANSFERS
    )
    expect(badges.unread?.colors).toEqual(['var(--color-thread-unread)'])
  })

  it('keeps the project badge on one option only', () => {
    const badges = viewBadgesFor('threads', 'projects', counts({ attention: 1 }), NO_TRANSFERS)
    expect(badges.activity).toBeNull()
  })
})
