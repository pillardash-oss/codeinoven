import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createTestDb, destroyTestDb } from '../../main/database/test-helper'
import { ProjectRepo } from '../../../src/main/database/repositories/project-repo'
import type { Database } from '../../../src/main/database/database'
import type { AgentMessage, ThreadSettings } from '../../../src/lib/types'
import { AllThreadsPinnedError, ThreadManager } from '../../../src/lib/engines/thread-manager'
import { ensureFeatureSlug } from '../../../src/lib/project-artifacts'
import { AgentMessageRepo } from '../../../src/main/database/repositories/agent-message-repo'

const temporaryDatabases: Database[] = []
const originalConfigRoot = process.env['CODEINOVEN_CONFIG_ROOT']
let temporaryConfigRoot = ''

beforeEach(() => {
  temporaryConfigRoot = mkdtempSync(join(tmpdir(), 'codeinoven-thread-manager-'))
  process.env['CODEINOVEN_CONFIG_ROOT'] = temporaryConfigRoot
})

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
  rmSync(temporaryConfigRoot, { force: true, recursive: true })
  temporaryConfigRoot = ''
  if (originalConfigRoot === undefined) delete process.env['CODEINOVEN_CONFIG_ROOT']
  else process.env['CODEINOVEN_CONFIG_ROOT'] = originalConfigRoot
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

  it('permanently deletes the oldest unpinned thread at the limit while preserving pinned threads', async () => {
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

    expect(await manager.getThread('project1', oldestUnpinned.id)).toBeNull()
    expect(await manager.getThread('project1', pinned.id)).not.toBeNull()
    expect(listed.map((thread) => thread.id)).toEqual([pinned.id, newest.id])
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
    expect(capacity).toMatchObject({ limit: 2, activeCount: 2, pinnedCount: 2, deletableCount: 0 })
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

  it('detects same-count/same-final-id transcript edits and appends only deltas', async () => {
    const { manager, db } = await createManager()
    const thread = await manager.createThread({
      projectId: 'project1',
      providerId: 'openai',
      title: 'Delta'
    })
    const repo = new AgentMessageRepo(db)

    const a1: AgentMessage = {
      id: 'delta-1',
      role: 'assistant',
      parts: [{ type: 'text', id: 'p1', messageID: 'delta-1', text: 'original' }],
      createdAt: 100
    }
    const b: AgentMessage = {
      id: 'delta-2',
      role: 'assistant',
      parts: [{ type: 'text', id: 'p2', messageID: 'delta-2', text: 'final' }],
      createdAt: 200
    }
    const first = await manager.upsertMessages('project1', thread.id, [a1, b], 'sess')
    expect(first.applied).toBe(2)
    expect(first.noop).toBe(false)
    const cursorAfterFirst = repo.getProviderCursor(thread.id, 'sess')
    expect(cursorAfterFirst?.lastMessageId).toBe('delta-2')

    // True noop: identical transcript → zero writes (cursor row untouched).
    const beforeNoop = repo.getProviderCursor(thread.id, 'sess')
    const noop = await manager.upsertMessages('project1', thread.id, [a1, b], 'sess')
    expect(noop.applied).toBe(0)
    expect(noop.skipped).toBe(2)
    expect(noop.noop).toBe(true)
    expect(noop.cursor).toBeNull()
    expect(repo.getProviderCursor(thread.id, 'sess')?.syncedAt).toBe(beforeNoop?.syncedAt)

    // Same count and same final id, but the first message was edited in place.
    const a1Edited: AgentMessage = {
      ...a1,
      parts: [{ type: 'text', id: 'p1', messageID: 'delta-1', text: 'edited' }]
    }
    const edited = await manager.upsertMessages('project1', thread.id, [a1Edited, b], 'sess')
    expect(edited.applied).toBe(1)
    expect(edited.skipped).toBe(1)
    expect(edited.noop).toBe(false)

    const persisted = await manager.loadMessages('project1', thread.id)
    expect(persisted.find((m) => m.id === 'delta-1')?.parts).toEqual([
      { type: 'text', id: 'p1', messageID: 'delta-1', text: 'edited' }
    ])
    expect(persisted.find((m) => m.id === 'delta-2')?.parts).toEqual(b.parts)
  })
})
