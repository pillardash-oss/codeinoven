import { describe, expect, it } from 'vitest'
import type { GitCommitInfo, GitRemoteUpdate } from '../../../src/lib/types'
import {
  assignGraphLanes,
  graphRemotePlacement,
  graphRowEdges,
  isMergeRow,
  type GitGraphRow
} from '../../../src/renderer/lib/git-graph'
import { gitHistoryGroups } from '../../../src/renderer/lib/git-history-groups'

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

describe('gitHistoryGroups', () => {
  const commits = [
    commit('a', ['b']),
    commit('b', ['c']),
    commit('c', ['d']),
    commit('d', ['e']),
    commit('e', [])
  ]
  const rows = assignGraphLanes(commits)

  it('opens the local-only run first, then one group per recorded movement', () => {
    const unpushedCount = 2
    const updates = [update('c', 'push', 1_700_000_100_000), update('e', 'push', 1_700_000_200_000)]
    const placement = graphRemotePlacement(rows, updates, unpushedCount)
    const groups = gitHistoryGroups({ rows, placement, unpushedCount, upstream: 'origin/main' })

    expect(groups.map((group) => group.kind)).toEqual(['unpushed', 'pushed', 'pushed'])
    expect(groups.map((group) => group.entries.length)).toEqual([2, 2, 1])
    expect(groups[1]?.update?.sha).toBe('c')
    expect(groups[2]?.update?.sha).toBe('e')
  })

  it('reads a fetched movement as received, not as something this checkout pushed', () => {
    const unpushedCount = 0
    const placement = graphRemotePlacement(rows, [update('a', 'received', 1_700_000_100_000)], 0)
    const groups = gitHistoryGroups({ rows, placement, unpushedCount, upstream: 'origin/main' })

    expect(groups).toHaveLength(1)
    expect(groups[0]?.kind).toBe('received')
  })

  it('keeps every row exactly once, in order, whatever the boundaries are', () => {
    const unpushedCount = 3
    const placement = graphRemotePlacement(
      rows,
      [update('d', 'push', 1_700_000_100_000), update('e', 'push', 1_700_000_200_000)],
      unpushedCount
    )
    const groups = gitHistoryGroups({ rows, placement, unpushedCount, upstream: 'origin/main' })
    const indexes = groups.flatMap((group) => group.entries.map((entry) => entry.index))

    expect(indexes).toEqual([0, 1, 2, 3, 4])
  })

  it('gives two movements of the same ref in the same second distinct keys', () => {
    const unpushedCount = 0
    const at = 1_700_000_100_000
    const updates = [update('a', 'push', at), update('c', 'push', at)]
    const placement = graphRemotePlacement(rows, updates, unpushedCount)
    const groups = gitHistoryGroups({ rows, placement, unpushedCount, upstream: 'origin/main' })

    const keys = groups.map((group) => group.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('never names a push for a repository with no upstream', () => {
    const placement = graphRemotePlacement(rows, [], 0)
    const groups = gitHistoryGroups({ rows, placement, unpushedCount: 0, upstream: null })

    expect(groups).toHaveLength(1)
    expect(groups[0]?.kind).toBe('pushed')
    // The view reads a null ref as "Local history": there is no remote to claim.
    expect(groups[0]?.ref).toBeNull()
    expect(groups[0]?.update).toBeNull()
  })
})
