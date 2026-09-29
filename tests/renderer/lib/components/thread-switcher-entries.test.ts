import { describe, expect, it } from 'vitest'
import type { Thread } from '$shared/types'
import type { GlobalBrowserTab } from '$lib/stores/global-browser-types'
import {
  buildThreadSwitcherEntries,
  threadSwitcherEntryKey,
  type ThreadSwitcherEntry
} from '$lib/components/threads/thread-switcher-entries'
import { browserTabVisitKey, threadVisitKey } from '$lib/stores/recent-visits.svelte'

function makeThread(id: string, lastActivity = 0): Thread {
  return {
    id,
    projectId: 'p',
    providerId: 'pi',
    title: `Thread ${id}`,
    titleSource: 'default',
    status: 'created',
    pinned: false,
    archived: false,
    read: true,
    createdAt: lastActivity,
    updatedAt: lastActivity,
    lastActivity,
    workingDirectory: '/tmp'
  }
}

function makeTab(id: string, lastUsedAt = 0): GlobalBrowserTab {
  return {
    id,
    title: `Tab ${id}`,
    customTitle: null,
    url: `https://example.test/${id}`,
    favicon: null,
    groupId: null,
    boxId: null,
    createdAt: lastUsedAt,
    lastUsedAt,
    hibernated: false,
    pinned: false,
    pinnedAt: null,
    assistantThreadId: null,
    color: null,
    iconType: null,
    customSvg: null,
    imagePath: null
  }
}

/** The entry keys in list order, the same form the switcher compares against. */
function keys(entries: readonly ThreadSwitcherEntry[]): string[] {
  return entries.map(threadSwitcherEntryKey)
}

describe('buildThreadSwitcherEntries', () => {
  it('lists an open tab the visit order never named, before the threads padding the tail', () => {
    const threads = Array.from({ length: 20 }, (_, index) => makeThread(`t${index}`, 20 - index))
    const tab = makeTab('browser:1', 5)

    const entries = buildThreadSwitcherEntries({
      // A history that names threads only: the state the app was really in when
      // the tab could not be reached from the switcher.
      visits: threads.slice(0, 10).map(threadVisitKey),
      threads,
      tabs: [tab],
      currentBrowserTabId: null
    })

    expect(keys(entries)).toContain(browserTabVisitKey('browser:1'))
    expect(entries).toHaveLength(10)
  })

  it('lists every open tab, most recently used first, with no visit for any of them', () => {
    const threads = Array.from({ length: 20 }, (_, index) => makeThread(`t${index}`, 20 - index))

    const entries = buildThreadSwitcherEntries({
      visits: threads.map(threadVisitKey),
      threads,
      tabs: [makeTab('a', 1), makeTab('b', 9), makeTab('c', 5)],
      currentBrowserTabId: null
    })

    const browserIds = entries
      .filter((entry) => entry.kind === 'browser')
      .map((entry) => entry.tab.id)
    expect(browserIds).toEqual(['b', 'c', 'a'])
  })

  it('leads with the tab the user is looking at and leaves the next slot for where they came from', () => {
    const newer = makeThread('t0', 10)
    const older = makeThread('t1', 5)

    const entries = buildThreadSwitcherEntries({
      visits: [threadVisitKey(older), threadVisitKey(newer)],
      threads: [newer, older],
      tabs: [makeTab('browser:1', 9), makeTab('browser:2', 1)],
      currentBrowserTabId: 'browser:1'
    })

    expect(keys(entries).slice(0, 2)).toEqual([
      browserTabVisitKey('browser:1'),
      threadVisitKey(older)
    ])
  })

  it('keeps a thread within reach when there are more open tabs than the list is long', () => {
    const threads = Array.from({ length: 20 }, (_, index) => makeThread(`t${index}`, 20 - index))
    const tabs = Array.from({ length: 12 }, (_, index) => makeTab(`browser:${index}`, 12 - index))

    const entries = buildThreadSwitcherEntries({
      visits: threads.map(threadVisitKey),
      threads,
      tabs,
      currentBrowserTabId: null
    })

    expect(entries).toHaveLength(10)
    expect(entries.filter((entry) => entry.kind === 'thread')).toHaveLength(1)
    expect(
      entries.filter((entry) => entry.kind === 'browser').map((entry) => entry.tab.id)
    ).toEqual([
      'browser:0',
      'browser:1',
      'browser:2',
      'browser:3',
      'browser:4',
      'browser:5',
      'browser:6',
      'browser:7',
      'browser:8'
    ])
  })

  it('leads with the current tab even when it is the oldest of more tabs than slots', () => {
    // A restored session can make the tab it restored onto the oldest one, and
    // the surface the user is looking at may not drop out of the list.
    const oldest = makeTab('browser:old', 1)
    const newer = Array.from({ length: 11 }, (_, index) => makeTab(`browser:${index}`, 100 - index))

    const entries = buildThreadSwitcherEntries({
      visits: [browserTabVisitKey(oldest.id)],
      threads: [],
      tabs: [...newer, oldest],
      currentBrowserTabId: oldest.id
    })

    expect(keys(entries)[0]).toBe(browserTabVisitKey(oldest.id))
    expect(entries).toHaveLength(9)
  })

  it('keeps a recorded tab visit in its recency position, which is what makes Ctrl+Tab alternate', () => {
    const newer = makeThread('t0', 10)
    const older = makeThread('t1', 5)
    const tab = makeTab('browser:1', 9)

    const entries = buildThreadSwitcherEntries({
      visits: [threadVisitKey(newer), browserTabVisitKey(tab.id)],
      threads: [newer, older],
      tabs: [tab],
      currentBrowserTabId: null
    })

    expect(keys(entries).slice(0, 2)).toEqual([threadVisitKey(newer), browserTabVisitKey(tab.id)])
  })

  it('floors an unusable bound so a caller cannot starve the list of one kind', () => {
    const thread = makeThread('t0', 10)
    const tab = makeTab('browser:1', 5)

    for (const limit of [1, 0, -1, Number.NaN]) {
      const entries = buildThreadSwitcherEntries({
        visits: [threadVisitKey(thread), browserTabVisitKey(tab.id)],
        threads: [thread],
        tabs: [tab],
        currentBrowserTabId: null,
        limit
      })

      expect(keys(entries)).toContain(threadVisitKey(thread))
      expect(keys(entries)).toContain(browserTabVisitKey(tab.id))
      expect(entries.length).toBeLessThanOrEqual(2)
    }
  })
})
