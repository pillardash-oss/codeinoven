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
  it('lists only the surfaces the visit order names, never a tab the user did not open', () => {
    const thread = makeThread('t0', 10)
    const opened = makeTab('browser:opened', 9)
    // A tab that is open in the strip but was never used this session. It may
    // exist, but the switcher is a recency list and must not invent a row for it.
    const neverUsed = makeTab('browser:never', 8)

    const entries = buildThreadSwitcherEntries({
      visits: [browserTabVisitKey(opened.id), threadVisitKey(thread)],
      threads: [thread],
      tabs: [opened, neverUsed],
      currentBrowserTabId: null
    })

    expect(keys(entries)).toEqual([browserTabVisitKey(opened.id), threadVisitKey(thread)])
  })

  it('interleaves threads and browser tabs in one recency order', () => {
    const thread = makeThread('t0', 1)
    const tabs = [makeTab('browser:1', 3), makeTab('browser:2', 2), makeTab('browser:3', 1)]
    // Separate sessions, so each tab is its own row and they compete with the
    // thread on the same terms.
    const visits = [
      browserTabVisitKey(tabs[0].id),
      threadVisitKey(thread),
      browserTabVisitKey(tabs[1].id),
      browserTabVisitKey(tabs[2].id)
    ]

    const entries = buildThreadSwitcherEntries({
      visits,
      threads: [thread],
      tabs,
      currentBrowserTabId: null,
      limit: 10
    })

    // The last two tabs are one session, so they collapse to the newer one.
    expect(keys(entries)).toEqual([
      browserTabVisitKey(tabs[0].id),
      threadVisitKey(thread),
      browserTabVisitKey(tabs[1].id)
    ])
  })

  it('claims one row for a browsing session, so the thread it left stays next in line', () => {
    const thread = makeThread('t0', 10)
    // The user was on the thread, opened the browser, then stepped through three
    // tabs. One Control+Tab out of the browser must land on the thread, not on a
    // sibling browser tab: the session is one surface.
    const tabs = [makeTab('browser:1', 9), makeTab('browser:2', 8), makeTab('browser:3', 7)]
    const visits = [
      browserTabVisitKey(tabs[2].id),
      browserTabVisitKey(tabs[1].id),
      browserTabVisitKey(tabs[0].id),
      threadVisitKey(thread)
    ]

    for (const [currentBrowserTabId, expected] of [
      [null, tabs[2].id],
      [tabs[2].id, tabs[2].id],
      // The tab on screen represents the session she is in, so the row she
      // leaves the browser through is the tab she is looking at.
      [tabs[0].id, tabs[0].id]
    ] as const) {
      const entries = buildThreadSwitcherEntries({
        visits,
        threads: [thread],
        tabs,
        currentBrowserTabId,
        limit: 10
      })

      expect(keys(entries)).toEqual([browserTabVisitKey(expected), threadVisitKey(thread)])
    }
  })

  it('reaches a session through the newest tab of its run that still exists', () => {
    const thread = makeThread('t0', 10)
    const live = makeTab('browser:live', 8)
    // The newest tab of the session was closed: the row falls to the next tab of
    // the same session instead of the session disappearing.
    const visits = [
      browserTabVisitKey('browser:gone'),
      browserTabVisitKey(live.id),
      threadVisitKey(thread)
    ]

    const entries = buildThreadSwitcherEntries({
      visits,
      threads: [thread],
      tabs: [live],
      currentBrowserTabId: null,
      limit: 10
    })

    expect(keys(entries)).toEqual([browserTabVisitKey(live.id), threadVisitKey(thread)])
  })

  it('gives the browser its own row again after another surface was used', () => {
    const first = makeThread('t0', 10)
    const second = makeThread('t1', 9)
    const tabs = [makeTab('browser:1', 8), makeTab('browser:2', 7), makeTab('browser:3', 6)]
    const visits = [
      browserTabVisitKey(tabs[0].id),
      browserTabVisitKey(tabs[1].id),
      threadVisitKey(first),
      browserTabVisitKey(tabs[2].id),
      threadVisitKey(second)
    ]

    const entries = buildThreadSwitcherEntries({
      visits,
      threads: [first, second],
      tabs,
      currentBrowserTabId: null,
      limit: 10
    })

    expect(keys(entries)).toEqual([
      browserTabVisitKey(tabs[0].id),
      threadVisitKey(first),
      browserTabVisitKey(tabs[2].id),
      threadVisitKey(second)
    ])
  })

  it('lets newer thread visits push older browser tabs off the end of the one list', () => {
    const tabs = [makeTab('browser:1', 100), makeTab('browser:2', 99)]
    const threads = Array.from({ length: 10 }, (_, index) => makeThread(`t${index}`, 90 - index))
    // Two tabs were used, then ten threads after them. There is no separate tab
    // budget, so the ten newer threads take every slot and the old tabs fall off.
    const visits = [
      ...threads.map(threadVisitKey),
      browserTabVisitKey(tabs[1].id),
      browserTabVisitKey(tabs[0].id)
    ]

    const entries = buildThreadSwitcherEntries({
      visits,
      threads,
      tabs,
      currentBrowserTabId: null,
      limit: 10
    })

    expect(entries).toHaveLength(10)
    expect(entries.every((entry) => entry.kind === 'thread')).toBe(true)
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

  it('never pads the tail with a browser tab the order did not name', () => {
    const threads = Array.from({ length: 20 }, (_, index) => makeThread(`t${index}`, 20 - index))

    const entries = buildThreadSwitcherEntries({
      visits: threads.slice(0, 4).map(threadVisitKey),
      threads,
      tabs: [makeTab('browser:1', 30)],
      currentBrowserTabId: null,
      limit: 10
    })

    expect(entries).toHaveLength(10)
    expect(entries.some((entry) => entry.kind === 'browser')).toBe(false)
  })

  it('floors an unusable bound so a caller cannot starve the list', () => {
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
