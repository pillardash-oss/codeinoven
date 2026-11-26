import { describe, expect, it, vi } from 'vitest'
import type { Thread } from '$shared/types'

// The store module reaches the IPC bridge at import time; nothing here calls it,
// but the bridge has to exist for the module graph to load.
vi.mock('$lib/ipc.svelte', () => ({
  invoke: vi.fn(async () => undefined),
  invokeAtOvenRoot: vi.fn(async () => undefined),
  invokeGit: vi.fn(async () => undefined),
  subscribe: vi.fn(() => () => {}),
  subscribeGuarded: vi.fn(() => () => {}),
  waitForFeatures: vi.fn(async () => {})
}))

const { isTimelinePinned, splitTimelineThreads } = await import('$lib/stores/workspace.svelte')

function makeThread(id: string, patch: Partial<Thread> = {}): Thread {
  return {
    id,
    projectId: 'project-1',
    providerId: 'pi',
    title: `Thread ${id}`,
    titleSource: 'default',
    status: 'executing',
    pinned: false,
    archived: false,
    read: true,
    createdAt: 0,
    updatedAt: 0,
    lastActivity: 0,
    workingDirectory: '/work',
    ...patch
  }
}

/**
 * A plain pin is the one the user made with the pin action, and it is the one
 * the Threads view's pinned block draws. A bookmark is pinned in the database
 * only to survive cleanup: it stays at the head of its own status group.
 *
 * The workspace's single-pass list builder once classified these backwards and
 * dropped every plain pin from the Threads timeline, so the predicate and the
 * split are pinned down here together.
 */
describe('a thread on the Threads timeline', () => {
  it('draws a plain pin in the pinned block', () => {
    const plainPin = makeThread('plain', { pinned: true, bookmarked: false })
    expect(isTimelinePinned(plainPin)).toBe(true)
    expect(splitTimelineThreads([plainPin])).toEqual({ pinned: [plainPin], statusListed: [] })
  })

  it('keeps a bookmarked pin in its status group', () => {
    const bookmark = makeThread('bookmark', { pinned: true, bookmarked: true })
    expect(isTimelinePinned(bookmark)).toBe(false)
    expect(splitTimelineThreads([bookmark])).toEqual({ pinned: [], statusListed: [bookmark] })
  })

  it('treats a thread with no bookmark flag as a plain pin', () => {
    const legacyPin = makeThread('legacy', { pinned: true })
    expect(isTimelinePinned(legacyPin)).toBe(true)
  })

  it('keeps an unpinned thread in its status group', () => {
    const row = makeThread('row')
    expect(isTimelinePinned(row)).toBe(false)
    expect(splitTimelineThreads([row])).toEqual({ pinned: [], statusListed: [row] })
  })

  it('sorts the pinned block by pin time, newest pin first', () => {
    const older = makeThread('older', { pinned: true, pinnedAt: 100 })
    const newer = makeThread('newer', { pinned: true, pinnedAt: 200 })
    const split = splitTimelineThreads([older, newer])
    expect(split.pinned.map((thread) => thread.id)).toEqual(['newer', 'older'])
  })
})
