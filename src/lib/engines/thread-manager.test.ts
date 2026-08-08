import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestDb, destroyTestDb } from '../../main/database/test-helper'
import { ProjectRepo } from '../../main/database/repositories/project-repo'
import type { Database } from '../../main/database/database'
import type { AgentMessage, ThreadSettings } from '../types'
import { AllThreadsPinnedError, ThreadManager } from './thread-manager'
import { ensureFeatureSlug } from '../project-artifacts'

const temporaryDatabases: Database[] = []

async function createManager(threadLimit = 70): Promise<{
  manager: ThreadManager
  db: Database
}> {
  const db = await createTestDb()
  temporaryDatabases.push(db)
  new ProjectRepo(db).upsert({
    id: 'project1',
    name: 'Test project',
    path: '/tmp/project1',
    source: 'local',
    providerId: 'openai',
    workflowId: 'default',
    threadLimit,
    changeTrackingMode: 'manual',
    createdAt: Date.now(),
    updatedAt: Date.now()
  })
  return { manager: new ThreadManager(db), db }
}

afterEach(async () => {
  vi.useRealTimers()
  temporaryDatabases.splice(0).forEach(destroyTestDb)
})

describe('ThreadManager', () => {
  it('persists the complete thread lifecycle and messages across a manager restart', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-26T10:00:00.000Z'))
    const { manager, db } = await createManager()
    const initialSettings: ThreadSettings = {
      harnessId: 'opencode',
      providerId: 'anthropic',
      modelId: 'claude-sonnet',
      thinkingLevel: 'medium',
      permissionLevel: 'auto_review',
      engineeringMode: true
    }
    const thread = await manager.createThread({
      projectId: 'project1',
      providerId: 'anthropic',
      title: 'Initial title',
      workingDirectory: '/work/initial',
      settings: initialSettings
    })

    const persistedInitial = { ...thread, userInputLocked: false }
    expect(await manager.getThread('project1', thread.id)).toMatchObject(persistedInitial)
    expect(await manager.listThreads('project1')).toMatchObject([persistedInitial])

    vi.setSystemTime(new Date('2026-07-26T10:01:00.000Z'))
    const updated = await manager.updateThread('project1', thread.id, {
      title: 'Updated title',
      providerId: 'openai',
      workingDirectory: '/work/updated'
    })
    expect(updated).toMatchObject({
      title: 'Updated title',
      providerId: 'openai',
      workingDirectory: '/work/updated'
    })

    const updatedSettings: ThreadSettings = {
      harnessId: 'codex',
      providerId: 'openai',
      modelId: 'gpt-5',
      thinkingLevel: 'high',
      permissionLevel: 'auto_review',
      engineeringMode: false
    }
    await manager.updateSettings('project1', thread.id, updatedSettings)
    await manager.setSessionId('project1', thread.id, 'session-123')
    await manager.setStatus('project1', thread.id, 'interrupted')

    const messages: AgentMessage[] = [
      {
        id: 'message-1',
        role: 'user',
        parts: [
          {
            type: 'text',
            id: 'part-1',
            messageID: 'message-1',
            text: 'Continue the build'
          }
        ],
        createdAt: Date.now()
      },
      {
        id: 'message-2',
        role: 'assistant',
        parts: [
          {
            type: 'text',
            id: 'part-2',
            messageID: 'message-2',
            text: 'Checkpoint restored'
          }
        ],
        modelId: 'gpt-5',
        providerId: 'openai',
        createdAt: Date.now(),
        completedAt: Date.now()
      }
    ]
    await manager.saveMessages('project1', thread.id, messages)

    const restartedManager = new ThreadManager(db)
    const persisted = await restartedManager.getThread('project1', thread.id)

    expect(persisted).toMatchObject({
      id: thread.id,
      title: 'Updated title',
      providerId: 'openai',
      workingDirectory: '/work/updated',
      status: 'interrupted',
      settings: updatedSettings,
      sessionId: 'session-123'
    })
    expect(await restartedManager.listThreads('project1')).toEqual([persisted])
    expect(await restartedManager.loadMessages('project1', thread.id)).toEqual(messages)
  })

  it('archives the oldest unpinned thread at the limit while preserving pinned threads', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-26T11:00:00.000Z'))
    const { manager } = await createManager(2)
    const pinned = await manager.createThread({
      projectId: 'project1',
      providerId: 'openai',
      title: 'Pinned'
    })
    await manager.setPinned('project1', pinned.id, true)

    vi.setSystemTime(new Date('2026-07-26T11:01:00.000Z'))
    const oldestUnpinned = await manager.createThread({
      projectId: 'project1',
      providerId: 'openai',
      title: 'Oldest unpinned'
    })

    vi.setSystemTime(new Date('2026-07-26T11:02:00.000Z'))
    const newest = await manager.createThread({
      projectId: 'project1',
      providerId: 'openai',
      title: 'Newest'
    })
    const listed = await manager.listThreads('project1')

    // The evicted thread is archived, never silently deleted.
    expect(await manager.getThread('project1', oldestUnpinned.id)).toMatchObject({
      id: oldestUnpinned.id,
      archived: true
    })
    expect(await manager.getThread('project1', pinned.id)).not.toBeNull()
    expect(listed.map((thread) => thread.id)).toEqual([pinned.id, newest.id, oldestUnpinned.id])
  })

  it('refuses to exceed the limit when every active thread is pinned', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-26T12:00:00.000Z'))
    const { manager } = await createManager(2)
    const first = await manager.createThread({
      projectId: 'project1',
      providerId: 'openai',
      title: 'First'
    })
    const second = await manager.createThread({
      projectId: 'project1',
      providerId: 'openai',
      title: 'Second'
    })
    await manager.setPinned('project1', first.id, true)
    await manager.setPinned('project1', second.id, true)

    await expect(
      manager.createThread({
        projectId: 'project1',
        providerId: 'openai',
        title: 'Cannot fit'
      })
    ).rejects.toThrow(AllThreadsPinnedError)

    const capacity = await manager.getThreadCapacity('project1')
    expect(capacity).toMatchObject({ limit: 2, activeCount: 2, pinnedCount: 2, archivableCount: 0 })
  })

  it('keeps a stable feature slug across renames and forks', async () => {
    const { manager, db } = await createManager()
    const parent = await manager.createThread({
      projectId: 'project1',
      providerId: 'openai',
      title: 'Markdown Rendering'
    })
    const featureSlug = await ensureFeatureSlug(db, 'project1', parent.id)
    await manager.updateThread('project1', parent.id, { title: 'Renamed conversation' })

    const fork = await manager.forkThread('project1', parent.id, 'Renamed conversation (fork)')

    expect(featureSlug).toBe('markdown-rendering')
    expect(fork.featureSlug).toBe(featureSlug)
    expect((await manager.getThread('project1', parent.id))?.featureSlug).toBe(featureSlug)
  })

  it('uses readable suffixes when unrelated features have the same title', async () => {
    const { manager, db } = await createManager()
    const first = await manager.createThread({
      projectId: 'project1',
      providerId: 'openai',
      title: 'Shared title'
    })
    const second = await manager.createThread({
      projectId: 'project1',
      providerId: 'openai',
      title: 'Shared title'
    })

    expect(await ensureFeatureSlug(db, 'project1', first.id)).toBe('shared-title')
    expect(await ensureFeatureSlug(db, 'project1', second.id)).toBe('shared-title-2')
  })
})
