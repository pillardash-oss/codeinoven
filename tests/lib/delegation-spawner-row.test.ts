import { describe, expect, it } from 'vitest'
import { delegationSpawnerRow, type Thread } from '$shared/types'

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'child-1',
    projectId: 'project-b',
    title: 'A delegated thread',
    status: 'completed',
    read: true,
    createdAt: 0,
    updatedAt: 0,
    settings: { harnessId: 'pi', providerId: 'cio-opendesign', modelId: 'm' },
    ...overrides
  } as Thread
}

describe('delegationSpawnerRow', () => {
  it('answers null for a thread the user started', () => {
    expect(delegationSpawnerRow(thread())).toBeNull()
    expect(delegationSpawnerRow(null)).toBeNull()
  })

  it('names the spawner of a pawn in the pawn’s own project', () => {
    expect(
      delegationSpawnerRow(
        thread({
          projectId: 'project-a',
          coordinatorThreadId: 'spawner-1',
          userInputLocked: true
        })
      )
    ).toEqual({ projectId: 'project-a', threadId: 'spawner-1' })
  })

  it('names a dispatched run’s initiator, which lives in another project', () => {
    expect(
      delegationSpawnerRow(
        thread({
          projectId: 'project-b',
          dispatchOrigin: {
            initiatorProjectId: 'project-a',
            initiatorThreadId: 'spawner-1',
            at: 0
          }
        })
      )
    ).toEqual({ projectId: 'project-a', threadId: 'spawner-1' })
  })

  it('prefers a recorded coordinator over a stale dispatch origin', () => {
    expect(
      delegationSpawnerRow(
        thread({
          projectId: 'project-a',
          coordinatorThreadId: 'spawner-2',
          dispatchOrigin: {
            initiatorProjectId: 'project-a',
            initiatorThreadId: 'spawner-1',
            at: 0
          }
        })
      )
    ).toEqual({ projectId: 'project-a', threadId: 'spawner-2' })
  })

  it('refuses a dispatch origin that names no initiator', () => {
    expect(
      delegationSpawnerRow(
        thread({
          dispatchOrigin: { initiatorProjectId: '', initiatorThreadId: '', at: 0 }
        })
      )
    ).toBeNull()
  })
})
