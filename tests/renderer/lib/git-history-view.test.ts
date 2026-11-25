import { describe, expect, it } from 'vitest'
import type { GitCommitInfo, GitRemoteUpdate } from '../../../src/lib/types'
import {
  assignGraphLanes,
  graphPushBatches,
  graphRemotePlacement,
  graphRowEdges,
  isMergeRow,
  type GitGraphRow
} from '../../../src/renderer/lib/git-graph'

/**
 * A commit with only the fields the graph reads, took from git's own record:
 * newest first, `parents` first-parent first.
 */
function commit(
  hash: string,
  parents: string[],
  options: { author?: string; refs?: GitCommitInfo['refs'] } = {}
): GitCommitInfo {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    author: options.author ?? 'Ada Lovelace',
    date: 1_700_000_000_000,
    message: `subject ${hash}`,
    body: '',
    parents,
    refs: options.refs ?? []
  }
}

function update(sha: string, kind: GitRemoteUpdate['kind'], at: number): GitRemoteUpdate {
  return { ref: 'origin/main', sha, at, kind, message: kind }
}

describe('assignGraphLanes', () => {
  it('keeps a side branch on its own lane and collapses it back at the merge', () => {
    // main:    A  (merge of B and C)
    // branch:  C  off B, merged back into A
    const rows = assignGraphLanes([
      commit('a', ['b', 'c']),
      commit('b', ['d']),
      commit('c', ['d']),
      commit('d', [])
    ])

    // The merge opens the second lane for the branch it brings in.
    expect(rows[0]?.lane).toBe(0)
    expect(isMergeRow(rows[0] as GitGraphRow)).toBe(true)
    expect(rows[0]?.parentLanes).toEqual([0, 1])

    // The branch keeps its lane down to the fork point, next to main.
    expect(rows[1]?.lane).toBe(0)
    expect(rows[2]?.lane).toBe(1)
    expect(rows[2]?.passingLanes).toEqual([0])

    // At the fork point the branch lane ends: its lane folds into the commit
    // that both histories share, and nothing continues below it.
    expect(rows[3]?.lane).toBe(0)
    expect(rows[3]?.mergingLanes).toEqual([1])
    expect(rows[3]?.parentLanes).toEqual([])
  })

  it('draws a merge as an elbow from the arriving lane into the merge node', () => {
    const rows = assignGraphLanes([
      commit('a', ['b', 'c']),
      commit('b', ['d']),
      commit('c', ['d']),
      commit('d', [])
    ])
    const mergeEdges = graphRowEdges(rows[0] as GitGraphRow)
    // One straight line down the first parent's lane, one elbow from the
    // second parent's lane, and the branch's lane passes through the next row.
    expect(mergeEdges).toHaveLength(2)
    expect(mergeEdges[1]?.path).toContain('Q')
  })

  it('places one row per commit when the list repeats a hash', () => {
    // A keyed list cannot hold the same commit twice, so the walk drops the
    // repeat instead of handing the view a key that would freeze it.
    const rows = assignGraphLanes([commit('a', ['b']), commit('b', []), commit('a', ['b'])])
    expect(rows.map((row) => row.commit.hash)).toEqual(['a', 'b'])
  })

  it('never reuses a lane for two commits that are both still open', () => {
    const rows = assignGraphLanes([
      commit('a', ['b', 'c']),
      commit('b', ['e']),
      commit('c', ['d']),
      commit('d', ['e']),
      commit('e', [])
    ])
    for (const row of rows) {
      expect(row.lane).toBeLessThan(row.laneCount)
      for (const lane of [...row.mergingLanes, ...row.passingLanes, ...row.parentLanes]) {
        expect(lane).toBeLessThan(row.laneCount)
      }
    }
  })
})

describe('graphPushBatches', () => {
  // history:  d (newest), c, b, a    two pushes recorded, at d and at b
  const rows = assignGraphLanes([
    commit('d', ['c']),
    commit('c', ['b']),
    commit('b', ['a']),
    commit('a', [])
  ])

  it('counts the commits that sit below each divider', () => {
    const placement = graphRemotePlacement(
      rows,
      [update('d', 'push', 1_700_000_100_000), update('b', 'push', 1_700_000_200_000)],
      0
    )
    const batches = graphPushBatches(rows.length, placement.boundaries, false)

    expect(batches.get(0)).toEqual({ count: 2, partial: false })
    expect(batches.get(2)).toEqual({ count: 2, partial: false })
  })

  it('marks the oldest batch as a floor while older commits are unfetched', () => {
    const placement = graphRemotePlacement(rows, [update('c', 'push', 1_700_000_100_000)], 0)
    const batches = graphPushBatches(rows.length, placement.boundaries, true)

    // The divider sits on `c`, so the batch is c, b, a, and paging can still
    // bring more of it: the count is a floor, never presented as the total.
    expect(batches.get(1)).toEqual({ count: 3, partial: true })
  })

  it('counts nothing for a boundary the loaded rows do not reach', () => {
    const placement = graphRemotePlacement(rows, [update('gone', 'push', 1_700_000_100_000)], 0)
    const batches = graphPushBatches(rows.length, placement.boundaries, false)

    expect(batches.size).toBe(0)
  })
})
