// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { Thread, ThreadStatus } from '$shared/types'

// The grouping reads the workspace stores, which subscribe through the IPC
// bridge on import; a test of the heading rule has nothing to say to a bridge.
vi.mock('$lib/ipc.svelte', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/ipc.svelte')>()
  return { ...actual, invoke: vi.fn(async () => undefined), subscribe: vi.fn(() => () => {}) }
})

import { groupThreadsByStatus } from '$lib/components/workspace/workspace-thread-helpers'

/**
 * The heading a row is drawn under is chosen from the status it is *shown*
 * under, which is not always the one it carries. The Threads view hands over the
 * statuses of the arrangement on screen (see `ThreadOrderSettle.groupingStatuses`)
 * so a status change the settle is holding cannot move a row out of Working
 * before it moves out of its slot - the drop-then-rise a thread shows when it
 * settles into Done and starts its next turn a moment later.
 */
function makeThread(id: string, status: ThreadStatus): Thread {
  return {
    id,
    projectId: 'project-1',
    providerId: 'pi',
    title: `Thread ${id}`,
    titleSource: 'default',
    status,
    pinned: false,
    archived: false,
    read: true,
    createdAt: 0,
    updatedAt: 0,
    lastActivity: 0,
    workingDirectory: '/work'
  }
}

/** The group labels the list draws, in order, with their rows. */
function sections(threads: Thread[], statuses?: ReadonlyMap<string, ThreadStatus>) {
  return groupThreadsByStatus(threads, null, null, statuses).map((group) => ({
    label: group.label,
    ids: group.threads.map((thread) => thread.id)
  }))
}

describe('groupThreadsByStatus: the status a row is shown under', () => {
  it('groups a row by the status it carries when nothing overrides it', () => {
    const threads = [makeThread('a', 'working-paused'), makeThread('b', 'completed')]
    expect(sections(threads)).toEqual([
      { label: 'Working', ids: ['a'] },
      { label: 'Done', ids: ['b'] }
    ])
  })

  it('keeps a held row under the heading it is drawn in, in its own slot', () => {
    const threads = [makeThread('a', 'working-paused'), makeThread('b', 'completed')]
    // What the settle hands over while it holds b's descent: b still reads as
    // the row on screen, which is under Working.
    const statuses = new Map<string, ThreadStatus>([
      ['a', 'working-paused'],
      ['b', 'working-paused']
    ])
    expect(sections(threads, statuses)).toEqual([{ label: 'Working', ids: ['a', 'b'] }])
  })

  it('draws the live row, never the held copy of it', () => {
    const live = makeThread('b', 'completed')
    const statuses = new Map<string, ThreadStatus>([['b', 'working-paused']])
    const [working] = groupThreadsByStatus([live], null, null, statuses)
    // Same object: the heading is held, the badge is not.
    expect(working.threads[0]).toBe(live)
    expect(working.threads[0]?.status).toBe('completed')
  })

  it('groups by the live status again once the hold is over', () => {
    const threads = [makeThread('a', 'working-paused'), makeThread('b', 'completed')]
    expect(sections(threads, null)).toEqual([
      { label: 'Working', ids: ['a'] },
      { label: 'Done', ids: ['b'] }
    ])
  })
})
