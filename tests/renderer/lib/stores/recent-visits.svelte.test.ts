import { describe, expect, it } from 'vitest'
import {
  browserTabVisitKey,
  capRecentVisits,
  isBrowserTabVisitKey,
  threadVisitKey
} from '$lib/stores/recent-visits.svelte'

function threadKey(id: string): string {
  return threadVisitKey({ projectId: 'p', id })
}

describe('capRecentVisits', () => {
  it('keeps a browser tab visit when a long history of threads is recorded after it', () => {
    const tabKey = browserTabVisitKey('browser:abc')
    // The tab was the first surface used, then sixty distinct threads were
    // opened. The flat cap this replaced filled every slot with threads and
    // evicted the tab key, which is what left the Ctrl+Tab switcher with no row
    // for the tab the user was working in.
    const entries = [tabKey, ...Array.from({ length: 60 }, (_, index) => threadKey(`t${index}`))]

    const capped = capRecentVisits(entries)

    expect(capped).toContain(tabKey)
    expect(capped.filter((key) => isBrowserTabVisitKey(key))).toEqual([tabKey])
  })

  it('bounds each kind on its own and keeps the interleaved visit order', () => {
    const entries = [
      threadKey('a'),
      browserTabVisitKey('browser:1'),
      ...Array.from({ length: 60 }, (_, index) => threadKey(`t${index}`)),
      ...Array.from({ length: 20 }, (_, index) => browserTabVisitKey(`browser:x${index}`))
    ]

    const capped = capRecentVisits(entries)

    expect(capped.slice(0, 3)).toEqual([
      threadKey('a'),
      browserTabVisitKey('browser:1'),
      threadKey('t0')
    ])
    expect(capped.filter((key) => isBrowserTabVisitKey(key))).toHaveLength(10)
    expect(capped.filter((key) => !isBrowserTabVisitKey(key))).toHaveLength(50)
  })
})
