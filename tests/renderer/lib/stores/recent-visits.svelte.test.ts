import { describe, expect, it } from 'vitest'
import {
  browserTabVisitKey,
  capRecentVisits,
  threadVisitKey
} from '$lib/stores/recent-visits.svelte'

function threadKey(id: string): string {
  return threadVisitKey({ projectId: 'p', id })
}

describe('capRecentVisits', () => {
  it('keeps one bound for every kind, so newer thread visits evict an older browser tab', () => {
    const tabKey = browserTabVisitKey('browser:old')
    // The tab was used first, then sixty distinct threads. A per-kind budget kept
    // the tab key forever, which is what left old browser tabs in the switcher
    // after the user had long since moved on to threads.
    const entries = [...Array.from({ length: 60 }, (_, index) => threadKey(`t${index}`)), tabKey]

    const capped = capRecentVisits(entries)

    expect(capped).toHaveLength(50)
    expect(capped).not.toContain(tabKey)
  })

  it('keeps the newest visits in order, whichever kind they are', () => {
    const entries = [
      threadKey('a'),
      browserTabVisitKey('browser:1'),
      threadKey('b'),
      browserTabVisitKey('browser:2')
    ]

    expect(capRecentVisits(entries)).toEqual(entries)
  })
})
