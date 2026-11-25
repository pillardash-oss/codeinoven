import { describe, expect, it } from 'vitest'
import type { GitCommitInfo } from '../../../src/lib/types'
import { mergeHistoryPage } from '../../../src/renderer/lib/git-history-paging'

function commit(hash: string): GitCommitInfo {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    author: 'Ada Lovelace',
    date: 1_700_000_000_000,
    message: `subject ${hash}`,
    body: '',
    parents: [],
    refs: []
  }
}

const PAGE_SIZE = 3

describe('mergeHistoryPage', () => {
  it('appends older commits under the ones already loaded', () => {
    const merged = mergeHistoryPage(
      [commit('a'), commit('b')],
      [commit('c'), commit('d')],
      PAGE_SIZE
    )
    expect(merged.commits.map((entry) => entry.hash)).toEqual(['a', 'b', 'c', 'd'])
    expect(merged.hasMore).toBe(false)
  })

  it('drops a commit the previous page already had, so the list stays keyable', () => {
    // The offset window moved: an agent committed while the page was in flight,
    // so page two repeats the newest commit of page one.
    const merged = mergeHistoryPage(
      [commit('a'), commit('b'), commit('c')],
      [commit('c'), commit('d'), commit('e')],
      PAGE_SIZE
    )
    expect(merged.commits.map((entry) => entry.hash)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(merged.hasMore).toBe(true)
  })

  it('stops paging when a full page adds nothing, instead of refetching it forever', () => {
    const loaded = [commit('a'), commit('b'), commit('c')]
    const merged = mergeHistoryPage(loaded, [commit('a'), commit('b'), commit('c')], PAGE_SIZE)
    expect(merged.commits).toHaveLength(3)
    expect(merged.hasMore).toBe(false)
  })

  it('drops a hash the page itself repeats', () => {
    // One page is one `git log` call, so this should not happen, but a keyed
    // list dies on it and the dedupe costs nothing.
    const merged = mergeHistoryPage([], [commit('a'), commit('b'), commit('a')], PAGE_SIZE)
    expect(merged.commits.map((entry) => entry.hash)).toEqual(['a', 'b'])
  })

  it('reports the end of history on a short page', () => {
    const merged = mergeHistoryPage([commit('a')], [commit('b')], PAGE_SIZE)
    expect(merged.hasMore).toBe(false)
  })
})
