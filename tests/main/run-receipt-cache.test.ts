import { describe, expect, it } from 'vitest'
import { RunReceiptCache } from '../../src/main/chat/run-receipt/run-receipt-cache'
import { shapeRunReceipt } from '../../src/lib/run-receipt'
import type { RunReceipt } from '../../src/lib/types'

/**
 * The cache is what makes re-rendering a settled receipt free.
 *
 * Its contract is small and has to hold exactly: a hit for an unchanged range, a
 * miss for a new head, bounded size, and expiry on read rather than on a timer,
 * because an idle app must not own a clock for receipts.
 */

function receipt(headSha: string, readAt = 1): RunReceipt {
  return shapeRunReceipt({
    state: 'ready',
    projectId: 'project1',
    threadId: 'thread1',
    scope: {
      projectId: 'project1',
      scopeBucketId: 'default',
      scopeName: 'Default',
      branch: 'dev'
    },
    baseSha: 'base1',
    headSha,
    readAt
  })
}

describe('RunReceiptCache', () => {
  it('keys a range by project, scope, base and head', () => {
    const key = RunReceiptCache.key('project1', 'default', 'base1', 'head1')
    expect(key).toBe('project1\u0000default\u0000base1\u0000head1')
    // An absent base or head is distinct from another absent one only by the
    // range, which is exactly what the placeholder keeps.
    expect(RunReceiptCache.key('project1', 'default', null, null)).toBe(
      'project1\u0000default\u0000-\u0000-'
    )
    expect(key).not.toBe(RunReceiptCache.key('project1', 'default', 'base1', 'head2'))
  })

  it('returns a stored receipt for an unchanged range', () => {
    const cache = new RunReceiptCache()
    const key = RunReceiptCache.key('project1', 'default', 'base1', 'head1')
    cache.set(key, receipt('head1'))
    expect(cache.get(key)?.headSha).toBe('head1')
  })

  it('misses a new head, so a commit costs one new read', () => {
    const cache = new RunReceiptCache()
    cache.set(RunReceiptCache.key('project1', 'default', 'base1', 'head1'), receipt('head1'))
    expect(cache.get(RunReceiptCache.key('project1', 'default', 'base1', 'head2'))).toBeNull()
  })

  it('expires on read once the window passes, and the next read re-stores', () => {
    let now = 1_000
    const cache = new RunReceiptCache(4, 60_000, () => now)
    const key = RunReceiptCache.key('project1', 'default', 'base1', 'head1')
    cache.set(key, receipt('head1'))
    now += 59_000
    expect(cache.get(key)).not.toBeNull()
    now += 2_000
    expect(cache.get(key)).toBeNull()
    cache.set(key, receipt('head1'))
    expect(cache.get(key)).not.toBeNull()
    expect(cache.size).toBe(1)
  })

  it('bounds its size by evicting the oldest entry', () => {
    const cache = new RunReceiptCache(2)
    for (const head of ['head1', 'head2', 'head3']) {
      cache.set(RunReceiptCache.key('project1', 'default', 'base1', head), receipt(head))
    }
    expect(cache.size).toBe(2)
    expect(cache.get(RunReceiptCache.key('project1', 'default', 'base1', 'head1'))).toBeNull()
    expect(cache.get(RunReceiptCache.key('project1', 'default', 'base1', 'head3'))).not.toBeNull()
  })

  it('drops an entry by key and everything on clear', () => {
    const cache = new RunReceiptCache()
    const key = RunReceiptCache.key('project1', 'default', 'base1', 'head1')
    cache.set(key, receipt('head1'))
    cache.delete(key)
    expect(cache.get(key)).toBeNull()
    cache.set(key, receipt('head1'))
    cache.clear()
    expect(cache.size).toBe(0)
  })
})
