import { describe, expect, it } from 'vitest'
import {
  belongsOnProjectBoard,
  boardThreadsFor
} from '../../src/renderer/lib/components/threads/thread-dispatch-badge'
import {
  assistantRowScopeLabel,
  parkedRunLine
} from '../../src/renderer/lib/components/threads/bound-scope-label'
import type { Thread } from '../../src/lib/types'
import { ASSISTANT_SPACE_ID } from '../../src/lib/types'

/**
 * One transcript appears on exactly one board.
 *
 * A bound assistant task works in a project's checkout but keeps its home on the
 * Assistant view, so the project board lists project threads only. These cases
 * build a mixed thread set and assert that rule directly, rather than trusting
 * two listings to stay in step by convention.
 */

function thread(overrides: Partial<Thread> & { id: string }): Thread {
  return {
    projectId: 'project1',
    providerId: 'pi',
    title: overrides.id,
    titleSource: 'manual',
    status: 'created',
    pinned: false,
    archived: false,
    read: true,
    createdAt: 1,
    updatedAt: 1,
    lastActivity: 1,
    workingDirectory: '/tmp/project',
    ...overrides
  }
}

describe('project board thread set', () => {
  const projectThread = thread({ id: 'project-thread' })
  const dispatched = thread({
    id: 'dispatched',
    dispatchOrigin: {
      initiatorProjectId: ASSISTANT_SPACE_ID,
      initiatorThreadId: 'initiator',
      at: 1,
      assistantName: 'Scout'
    }
  })
  const boundTask = thread({
    id: 'bound-task',
    projectId: ASSISTANT_SPACE_ID,
    boundScope: { projectId: 'project1', scopeBucketId: 'default' }
  })

  it('lists a project thread and a dispatched project thread, and no bound task', () => {
    const rows = boardThreadsFor([projectThread, dispatched, boundTask], 'project1')
    expect(rows.map((row) => row.id)).toEqual(['project-thread', 'dispatched'])
  })

  it('never lists the same transcript twice', () => {
    const rows = boardThreadsFor([projectThread, projectThread, dispatched], 'project1')
    expect(rows.filter((row) => row.id === 'project-thread')).toHaveLength(1)
    expect(rows).toHaveLength(2)
  })

  it('rejects a bound task even when its binding names this project', () => {
    expect(belongsOnProjectBoard(boundTask, 'project1')).toBe(false)
    // Its own board never lists it either: it has no board of its own.
    expect(belongsOnProjectBoard(boundTask, ASSISTANT_SPACE_ID)).toBe(false)
  })

  it('rejects a thread from another project', () => {
    expect(belongsOnProjectBoard(projectThread, 'project2')).toBe(false)
  })
})

describe('assistant row scope line', () => {
  it('shows the short scope name and never the project name', () => {
    const label = assistantRowScopeLabel({
      boundScope: { projectId: 'project1', scopeBucketId: 'default' },
      bucketName: 'Achievement: Admin Dashboard Requirements for User Roles'
    })
    expect(label).toBe('Achievement: Admin…')
    expect(label).not.toContain('Project')
  })

  it('shows nothing at all for an unbound task', () => {
    expect(assistantRowScopeLabel({ bucketName: 'Default' })).toBeNull()
  })

  it('falls back to the scope id when the board has not loaded', () => {
    expect(
      assistantRowScopeLabel({
        boundScope: { projectId: 'project1', scopeBucketId: 'scope-mw0ou46n' }
      })
    ).toBe('scope-mw0ou46n')
  })

  it('uses the app scope wording for a parked run line', () => {
    expect(parkedRunLine('The managed checkout directory is gone')).toBe(
      'Parked: The managed checkout directory is gone'
    )
  })
})
