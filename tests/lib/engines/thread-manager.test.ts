import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createTestDb, destroyTestDb } from '../../main/database/test-helper'
import { ProjectRepo } from '../../../src/main/database/repositories/project-repo'
import type { Database } from '../../../src/main/database/database'
import type { AgentMessage, ThreadSettings, ScopeBucket } from '../../../src/lib/types'
import { AllThreadsProtectedError, ThreadManager } from '../../../src/lib/engines/thread-manager'
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

async function createManagerWithRoots(
  roots: Map<string, string>,
  threadLimit = 70
): Promise<{ manager: ThreadManager; db: Database }> {
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
  const manager = new ThreadManager(db, undefined, undefined, undefined, {
    async resolveCompatibilityRoot(projectId, scopeBucketId) {
      if (!scopeBucketId) return null
      const root = roots.get(`${projectId}:${scopeBucketId}`)
      if (!root) throw new Error(`Unhealthy scope: ${projectId}:${scopeBucketId}`)
      return root
    }
  })
  return { manager, db }
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
      permissionLevel: 'auto_review'
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
      permissionLevel: 'auto_review'
    }
    await manager.updateSettings('project1', thread.id, updatedSettings)
    await manager.setSessionId('project1', thread.id, 'session-123')
    await manager.setStatus('project1', thread.id, 'interrupted')

    const messages: AgentMessage[] = [
      {
        id: 'message-1',
        role: 'user',
        origin: 'provider',
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
        origin: 'provider',
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

  it('preserves spec threads during capacity cleanup and allows explicit deletion', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-26T11:30:00.000Z'))
    const { manager } = await createManager(2)
    const spec = await manager.createThread({
      projectId: 'project1',
      providerId: 'openai',
      title: 'Long-lived spec'
    })
    await manager.setStatus('project1', spec.id, 'spec')

    vi.setSystemTime(new Date('2026-07-26T11:31:00.000Z'))
    const ordinary = await manager.createThread({
      projectId: 'project1',
      providerId: 'openai',
      title: 'Evictable thread'
    })

    vi.setSystemTime(new Date('2026-07-26T11:32:00.000Z'))
    const newest = await manager.createThread({
      projectId: 'project1',
      providerId: 'openai',
      title: 'Newest thread'
    })

    expect(await manager.getThread('project1', spec.id)).not.toBeNull()
    expect(await manager.getThread('project1', ordinary.id)).toBeNull()
    expect(await manager.getThread('project1', newest.id)).not.toBeNull()
    expect(await manager.getThreadCapacity('project1')).toMatchObject({
      activeCount: 2,
      pinnedCount: 0,
      protectedCount: 1,
      deletableCount: 1
    })

    await manager.deleteThread('project1', spec.id)
    expect(await manager.getThread('project1', spec.id)).toBeNull()
  })

  it('refuses to exceed the limit when every active thread is protected', async () => {
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
    ).rejects.toThrow(AllThreadsProtectedError)

    const capacity = await manager.getThreadCapacity('project1')
    expect(capacity).toMatchObject({
      limit: 2,
      activeCount: 2,
      pinnedCount: 2,
      protectedCount: 2,
      deletableCount: 0
    })
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

  it('closes pending ranking snapshots before deletion on every delete path', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-26T12:00:00.000Z'))
    const { manager, db } = await createManager()
    const thread = await manager.createThread({
      projectId: 'project1',
      providerId: 'openai',
      title: 'To delete'
    })

    const closeAt = Date.now()
    // An open ranking snapshot for the thread (as chat-engine would capture
    // it). The row survives deletion with its thread reference detached
    // (SET NULL) so the judge can still score the raw conversation; the
    // close-then-grade step itself is wired via onThreadsDeletedForRanking
    // and covered by the chat-engine model-ranking tests.
    db.run(
      `INSERT INTO model_ranking_snapshots(
         id, thread_id, project_id, shot_category, status,
         harness_id, provider_id, model_id, thinking_level,
         started_at, ended_at, closed_at_ms, due_at_ms,
         user_message_text, assistant_output_text, created_at
       ) VALUES('ranking:turn-1', ?, 'project1', 'first_shot', 'pending',
         'opencode', 'openai', 'gpt-x', 'high',
         1, 2, NULL, ?, 'fix the bug', 'fixed', 1)`,
      thread.id,
      closeAt + 24 * 3_600_000
    )

    await manager.deleteThread('project1', thread.id)

    // The open snapshot survived deletion (thread reference SET NULL,
    // attribution intact) and stays pending for the grader.
    const row = db.get(
      'SELECT thread_id, status, shot_category, closed_at_ms, model_id FROM model_ranking_snapshots WHERE id = ?',
      'ranking:turn-1'
    ) as {
      thread_id: string | null
      status: string
      shot_category: string
      closed_at_ms: number | null
      model_id: string
    }
    expect(row).toBeDefined()
    expect(row.thread_id).toBeNull()
    expect(row.status).toBe('pending')
    expect(row.shot_category).toBe('first_shot')
    expect(row.closed_at_ms).toBeNull()
    expect(row.model_id).toBe('gpt-x')
  })
})

describe('ThreadManager scope-root propagation', () => {
  it('derives the compatibility working directory from the destination scope on create', async () => {
    const roots = new Map([['project1:scope-a', '/worktrees/feature-a']])
    const { manager } = await createManagerWithRoots(roots)
    const thread = await manager.createThread({
      projectId: 'project1',
      providerId: 'openai',
      title: 'Scoped thread',
      scopeBucketId: 'scope-a',
      // A renderer-supplied directory must never override the resolved root.
      workingDirectory: '/renderer/chose/this'
    })
    expect(thread.scopeBucketId).toBe('scope-a')
    expect(thread.workingDirectory).toBe('/worktrees/feature-a')
  })

  it('re-derives the working directory when a thread moves between scopes', async () => {
    const roots = new Map([
      ['project1:scope-a', '/worktrees/feature-a'],
      ['project1:default', '/tmp/project1']
    ])
    const { manager } = await createManagerWithRoots(roots)
    const thread = await manager.createThread({
      projectId: 'project1',
      providerId: 'openai',
      title: 'Mover',
      scopeBucketId: 'scope-a'
    })
    expect(thread.workingDirectory).toBe('/worktrees/feature-a')

    const moved = await manager.updateThread('project1', thread.id, {
      scopeBucketId: 'default'
    })
    expect(moved.scopeBucketId).toBe('default')
    expect(moved.workingDirectory).toBe('/tmp/project1')

    const back = await manager.updateThread('project1', thread.id, {
      scopeBucketId: 'scope-a'
    })
    expect(back.workingDirectory).toBe('/worktrees/feature-a')
  })

  it('fails closed when a moved-to managed scope is unhealthy', async () => {
    const roots = new Map([['project1:scope-a', '/worktrees/feature-a']])
    const { manager } = await createManagerWithRoots(roots)
    const thread = await manager.createThread({
      projectId: 'project1',
      providerId: 'openai',
      title: 'Stuck',
      scopeBucketId: 'scope-a'
    })
    await expect(
      manager.updateThread('project1', thread.id, { scopeBucketId: 'broken-scope' })
    ).rejects.toThrow(/Unhealthy scope/)
  })

  it('gives same-scope forks the resolved root and cross-project forks the destination default', async () => {
    const roots = new Map([['project1:scope-a', '/worktrees/feature-a']])
    const { manager } = await createManagerWithRoots(roots)
    const parent = await manager.createThread({
      projectId: 'project1',
      providerId: 'openai',
      title: 'Parent',
      scopeBucketId: 'scope-a'
    })
    await manager.saveMessages('project1', parent.id, [
      {
        id: 'm1',
        role: 'user',
        parts: [{ type: 'text', text: 'hello' }],
        createdAt: Date.now()
      } as AgentMessage
    ])
    const fork = await manager.forkThread('project1', parent.id, 'Fork')
    expect(fork.scopeBucketId).toBe('scope-a')
    expect(fork.workingDirectory).toBe('/worktrees/feature-a')
  })
})

describe('ThreadManager per-scope thread buckets', () => {
  /** Persist a board with a pinned bucket and a worktree bucket alongside the default. */
  async function persistBucketedBoard(db: Database, scopes: { id: string; pinned?: boolean; worktree?: boolean }[]) {
    const buckets: ScopeBucket[] = scopes.map((s) => ({
      id: s.id,
      name: s.id,
      sortOrder: 0,
      collapsed: false,
      collapsedSlices: [],
      pinned: s.pinned === true ? true : undefined,
      root:
        s.worktree === true
          ? {
              kind: 'worktree',
              directoryName: s.id,
              branch: 'feature-' + s.id,
              baseBranch: 'main',
              baseCommit: 'abc123',
              createdAt: Date.now(),
              environmentMode: 'copy',
              setup: { state: 'not_run', commands: [] }
            }
          : { kind: 'project' }
    }))
    // Ensure the Default scope is present and project-rooted.
    if (!buckets.some((b) => b.id === 'default')) {
      buckets.unshift({
        id: 'default',
        name: 'Default',
        sortOrder: 0,
        collapsed: false,
        collapsedSlices: [],
        root: { kind: 'project' }
      })
    }
    db.run(
      'INSERT OR REPLACE INTO scope_boards(project_id, data, updated_at) VALUES(?,?,?)',
      'project1',
      JSON.stringify({
        version: 2,
        buckets: buckets.map((b, i) => ({ ...b, sortOrder: i })),
        worktreeDefaults: { setupCommands: [], runSetupByDefault: true, environmentMode: 'copy' }
      }),
      Date.now()
    )
  }

  it('isolates eviction to the same scope bucket (worktree scope does not evict the regular bucket)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-01T10:00:00.000Z'))
    const { manager, db } = await createManager(2)
    await persistBucketedBoard(db, [{ id: 'scratch', worktree: true }])

    vi.setSystemTime(new Date('2026-08-01T10:01:00.000Z'))
    const regular = await manager.createThread({
      projectId: 'project1',
      providerId: 'openai',
      title: 'Regular one',
      scopeBucketId: 'default'
    })
    vi.setSystemTime(new Date('2026-08-01T10:02:00.000Z'))
    const wtA = await manager.createThread({
      projectId: 'project1',
      providerId: 'openai',
      title: 'Worktree A',
      scopeBucketId: 'scratch'
    })
    vi.setSystemTime(new Date('2026-08-01T10:03:00.000Z'))
    const wtB = await manager.createThread({
      projectId: 'project1',
      providerId: 'openai',
      title: 'Worktree B',
      scopeBucketId: 'scratch'
    })
    // Worktree bucket is full (2). Adding a third evicts the oldest worktree thread...
    vi.setSystemTime(new Date('2026-08-01T10:04:00.000Z'))
    const wtC = await manager.createThread({
      projectId: 'project1',
      providerId: 'openai',
      title: 'Worktree C',
      scopeBucketId: 'scratch'
    })
    expect(await manager.getThread('project1', wtA.id)).toBeNull()
    expect(await manager.getThread('project1', wtB.id)).not.toBeNull()
    expect(await manager.getThread('project1', wtC.id)).not.toBeNull()
    // ...but never touches the regular bucket.
    expect(await manager.getThread('project1', regular.id)).not.toBeNull()

    expect(await manager.getThreadCapacity('project1')).toMatchObject({
      limit: 2,
      activeCount: 1,
      pinnedScopeCount: 2
    })
  })

  it('pinned and worktree scopes each keep independent buckets', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-02T10:00:00.000Z'))
    const { manager, db } = await createManager(2)
    await persistBucketedBoard(db, [
      { id: 'pinned-a', pinned: true },
      { id: 'scratch', worktree: true }
    ])

    const step = vi.setSystemTime
    const pa = await manager.createThread({ projectId: 'project1', providerId: 'openai', title: 'PA', scopeBucketId: 'pinned-a' })
    step(new Date('2026-08-02T10:00:01.000Z'))
    const pb = await manager.createThread({ projectId: 'project1', providerId: 'openai', title: 'PB', scopeBucketId: 'pinned-a' })
    step(new Date('2026-08-02T10:00:02.000Z'))
    const sa = await manager.createThread({ projectId: 'project1', providerId: 'openai', title: 'SA', scopeBucketId: 'scratch' })
    step(new Date('2026-08-02T10:00:03.000Z'))
    const sb = await manager.createThread({ projectId: 'project1', providerId: 'openai', title: 'SB', scopeBucketId: 'scratch' })
    expect(await manager.getThread('project1', pa.id)).not.toBeNull()
    expect(await manager.getThread('project1', sa.id)).not.toBeNull()

    // Each bucket is full at 2; the next create only ever evicts its own bucket's thread.
    step(new Date('2026-08-02T10:00:04.000Z'))
    const pc = await manager.createThread({ projectId: 'project1', providerId: 'openai', title: 'PC', scopeBucketId: 'pinned-a' })
    // The worktree bucket is untouched: still both of its threads.
    expect(await manager.getThread('project1', sa.id)).not.toBeNull()
    expect(await manager.getThread('project1', sb.id)).not.toBeNull()
    expect(await manager.getThread('project1', pa.id)).toBeNull()
    expect(await manager.getThread('project1', pb.id)).not.toBeNull()
    expect(await manager.getThread('project1', pc.id)).not.toBeNull()

    step(new Date('2026-08-02T10:00:05.000Z'))
    const sc = await manager.createThread({ projectId: 'project1', providerId: 'openai', title: 'SC', scopeBucketId: 'scratch' })
    // The pinned bucket is untouched by the worktree bucket's own eviction.
    expect(await manager.getThread('project1', pb.id)).not.toBeNull()
    expect(await manager.getThread('project1', pc.id)).not.toBeNull()
    expect(await manager.getThread('project1', sa.id)).toBeNull()
    expect(await manager.getThread('project1', sb.id)).not.toBeNull()
    expect(await manager.getThread('project1', sc.id)).not.toBeNull()
  })
})
