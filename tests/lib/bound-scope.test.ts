import { describe, expect, it } from 'vitest'
import {
  isBoundAssistantTask,
  resolveThreadBoundScope,
  threadEvidenceProjectId,
  threadMountsAppWorkspace,
  threadScopeTarget
} from '../../src/lib/bound-scope'
import type { Thread } from '../../src/lib/types'
import {
  ASSISTANT_SPACE_ID,
  GLOBAL_BROWSER_PROJECT_ID,
  INBOX_PROJECT_ID
} from '../../src/lib/types'

/** The smallest thread each case needs: identity, home, and an optional binding. */
function thread(home: string, extra: Partial<Thread> = {}): Thread {
  return {
    id: 'thread1',
    projectId: home,
    providerId: 'pi',
    title: 'A thread',
    titleSource: 'default',
    status: 'created',
    pinned: false,
    archived: false,
    read: true,
    createdAt: 1,
    updatedAt: 1,
    lastActivity: 1,
    workingDirectory: '',
    ...extra
  }
}

describe('resolveThreadBoundScope', () => {
  it('resolves a project thread to its own project and scope', () => {
    const scope = resolveThreadBoundScope(thread('project1', { scopeBucketId: 'feature-a' }))
    expect(scope).toEqual({ projectId: 'project1', scopeBucketId: 'feature-a' })
  })

  it('resolves a project thread with no bucket to the Default scope', () => {
    const scope = resolveThreadBoundScope(thread('project1'))
    expect(scope).toEqual({ projectId: 'project1', scopeBucketId: 'default' })
  })

  it('resolves an assistant task to the scope it is bound to', () => {
    const scope = resolveThreadBoundScope(
      thread(ASSISTANT_SPACE_ID, {
        assistantId: 'assistant1',
        boundScope: { projectId: 'project9', scopeBucketId: 'worktree-3' }
      })
    )
    expect(scope).toEqual({ projectId: 'project9', scopeBucketId: 'worktree-3' })
  })

  it('resolves nothing for an unbound assistant task, so no checkout is invented', () => {
    expect(resolveThreadBoundScope(thread(ASSISTANT_SPACE_ID, { assistantId: 'assistant1' }))).toBe(
      null
    )
    expect(threadEvidenceProjectId(thread(ASSISTANT_SPACE_ID))).toBeNull()
  })

  it('resolves nothing for a standalone chat or a browser conversation', () => {
    expect(resolveThreadBoundScope(thread(INBOX_PROJECT_ID))).toBeNull()
    expect(resolveThreadBoundScope(thread(GLOBAL_BROWSER_PROJECT_ID))).toBeNull()
  })

  it('resolves nothing for no thread at all', () => {
    expect(resolveThreadBoundScope(null)).toBeNull()
    expect(resolveThreadBoundScope(undefined)).toBeNull()
  })

  it('follows an orchestration child thread to its own project', () => {
    const child = thread('project2', { scopeBucketId: 'default', coordinatorThreadId: 'parent' })
    expect(threadScopeTarget(child)).toEqual({ projectId: 'project2', scopeBucketId: 'default' })
  })
})

describe('threadMountsAppWorkspace', () => {
  it('is true for an unbound assistant task, which mounts its own directory', () => {
    expect(threadMountsAppWorkspace(thread(ASSISTANT_SPACE_ID))).toBe(true)
  })

  it('is false for a bound assistant task, which mounts the project checkout', () => {
    expect(
      threadMountsAppWorkspace(
        thread(ASSISTANT_SPACE_ID, {
          boundScope: { projectId: 'project9', scopeBucketId: 'default' }
        })
      )
    ).toBe(false)
  })

  it('is false for a project thread', () => {
    expect(threadMountsAppWorkspace(thread('project1'))).toBe(false)
  })
})

describe('isBoundAssistantTask', () => {
  it('is only true for an assistant task that carries a binding', () => {
    expect(
      isBoundAssistantTask(
        thread(ASSISTANT_SPACE_ID, {
          boundScope: { projectId: 'project9', scopeBucketId: 'default' }
        })
      )
    ).toBe(true)
    expect(isBoundAssistantTask(thread(ASSISTANT_SPACE_ID))).toBe(false)
    expect(
      isBoundAssistantTask(
        thread('project1', { boundScope: { projectId: 'project9', scopeBucketId: 'default' } })
      )
    ).toBe(false)
  })
})
