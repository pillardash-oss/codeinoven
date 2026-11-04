import { describe, expect, it } from 'vitest'
import type {
  DesignHistoryState,
  DesignRevisionSummary,
  DesignPageHistoryState
} from '../../../src/lib/ipc/design'
import {
  HISTORY_CAPABILITY_PAGE,
  resolveDesignRevisionId,
  summarizeDesignHistory
} from '../../../src/main/design/design-history-capability'

function revision(sequence: number): DesignRevisionSummary {
  return {
    id: `rev-${sequence}`,
    sequence,
    cause: 'agent',
    ...(sequence === 3 ? { label: 'Hero title updated', checkpointEntry: 'index.html' } : {}),
    createdAt: sequence * 1_000,
    changedFiles: 1,
    changedPaths: [`page-${sequence}.html`],
    fileCount: sequence,
    totalBytes: sequence * 100
  }
}

function stateOf(count: number, cursorIndex: number): DesignHistoryState {
  const revisions = Array.from({ length: count }, (_unused, index) => revision(index + 1))
  return {
    directory: '.cio/designs/hero',
    gitBacked: false,
    revisions,
    cursorId: revisions[cursorIndex]?.id ?? null,
    cursorIndex,
    modified: false,
    files: [],
    canUndo: cursorIndex > 0,
    canRedo: cursorIndex < revisions.length - 1
  }
}

describe('resolveDesignRevisionId', () => {
  const revisions = [revision(1), revision(2), revision(3)]

  it('accepts a revision number, its numeric string, and a revision id', () => {
    expect(resolveDesignRevisionId(revisions, 2)).toBe('rev-2')
    expect(resolveDesignRevisionId(revisions, '3')).toBe('rev-3')
    expect(resolveDesignRevisionId(revisions, 'rev-1')).toBe('rev-1')
  })

  it('answers nothing for a point the timeline does not hold', () => {
    expect(resolveDesignRevisionId(revisions, 9)).toBeNull()
    expect(resolveDesignRevisionId(revisions, 'nope')).toBeNull()
    expect(resolveDesignRevisionId(revisions, undefined)).toBeNull()
    expect(resolveDesignRevisionId(revisions, null)).toBeNull()
  })
})

describe('summarizeDesignHistory', () => {
  it('marks where the folder sits and keeps the newest page of points', () => {
    const count = HISTORY_CAPABILITY_PAGE + 5
    const summary = summarizeDesignHistory(stateOf(count, count - 6))

    expect(summary.revisions).toHaveLength(HISTORY_CAPABILITY_PAGE)
    expect(summary.totalRevisions).toBe(count)
    expect(summary.omittedOlderRevisions).toBe(5)
    // Oldest points are dropped, the newest are kept, and exactly one is current.
    expect(summary.revisions[0]?.revision).toBe(6)
    expect(summary.revisions.at(-1)?.revision).toBe(count)
    expect(summary.currentRevision).toBe(count - 5)
    expect(summary.revisions.filter((point) => point.current)).toHaveLength(1)
    expect(summary.note).toContain('Rewind with restore')
  })

  it('carries a checkpoint label and the screen it was taken on', () => {
    const summary = summarizeDesignHistory(stateOf(3, 2))
    expect(summary.revisions[2]).toMatchObject({
      revision: 3,
      label: 'Hero title updated',
      entry: 'index.html',
      current: true
    })
  })

  it('says Git owns a folder Git already tracks, and that an empty timeline has no points', () => {
    const tracked = summarizeDesignHistory({ ...stateOf(0, -1), gitBacked: true })
    expect(tracked.gitBacked).toBe(true)
    expect(tracked.note).toContain('Git')

    const fresh = summarizeDesignHistory(stateOf(0, -1))
    expect(fresh.currentRevision).toBeNull()
    expect(fresh.note).toContain('no history yet')
  })

  it("carries one page's own line when the caller named that page", () => {
    const page: DesignPageHistoryState = {
      gitBacked: false,
      directory: '.cio/designs/hero',
      path: 'index.html',
      revisions: [
        { revisionId: 'rev-1', sequence: 1, createdAt: 1_000, present: true },
        { revisionId: 'rev-3', sequence: 3, createdAt: 3_000, present: true }
      ],
      cursorIndex: 1,
      modified: false,
      canUndo: true,
      canRedo: false
    }
    const summary = summarizeDesignHistory(stateOf(3, 2), page)

    expect(summary.page).toMatchObject({ path: 'index.html', currentRevision: 3, canUndo: true })
    expect(summary.page?.revisions.map((point) => point.current)).toEqual([false, true])
    expect(summary.note).toContain('only that page')
  })
})
