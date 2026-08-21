import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({
  BrowserWindow: class {
    getAllWindows(): unknown[] {
      return []
    }
  },
  app: { isPackaged: false, getPath: () => tmpdir() },
  ipcMain: { handle: () => undefined }
}))

import { createTestDb, destroyTestDb } from './database/test-helper'
import type { Database } from '../../src/main/database/database'
import { ProjectRepo } from '../../src/main/database/repositories/project-repo'
import { ScopeManager } from '../../src/lib/engines/scope-manager'
import { StorageEngine } from '../../src/main/storage/storage-engine'
import { ChatEngine } from '../../src/main/chat/chat-engine'
import {
  ScopeRootResolver,
  scopeRootProvider,
  type ManagedWorktreeInspector,
  type WorktreeRegistration
} from '../../src/main/workspaces/scope-root-resolver'
import { getScopeRootPath } from '../../src/lib/utils'

const temporaryDatabases: Database[] = []
const originalConfigRoot = process.env['CODEINOVEN_CONFIG_ROOT']
const originalSmokeFlag = process.env['CODEINOVEN_PACKAGED_SMOKE_OUTPUT']
let temporaryConfigRoot = ''
let projectDir = ''

beforeEach(() => {
  temporaryConfigRoot = mkdtempSync(join(tmpdir(), 'codeinoven-chat-engine-root-'))
  projectDir = mkdtempSync(join(tmpdir(), 'codeinoven-chat-engine-repo-'))
  process.env['CODEINOVEN_CONFIG_ROOT'] = temporaryConfigRoot
  process.env['CODEINOVEN_PACKAGED_SMOKE_OUTPUT'] = '1'
})

afterEach(() => {
  temporaryDatabases.splice(0).forEach(destroyTestDb)
  rmSync(temporaryConfigRoot, { force: true, recursive: true })
  rmSync(projectDir, { force: true, recursive: true })
  temporaryConfigRoot = ''
  projectDir = ''
  if (originalConfigRoot === undefined) delete process.env['CODEINOVEN_CONFIG_ROOT']
  else process.env['CODEINOVEN_CONFIG_ROOT'] = originalConfigRoot
  if (originalSmokeFlag === undefined) delete process.env['CODEINOVEN_PACKAGED_SMOKE_OUTPUT']
  else process.env['CODEINOVEN_PACKAGED_SMOKE_OUTPUT'] = originalSmokeFlag
})

class StaticInspector implements ManagedWorktreeInspector {
  constructor(private registrations: WorktreeRegistration[]) {}
  listWorktrees(): Promise<WorktreeRegistration[]> {
    return Promise.resolve(this.registrations)
  }
}

async function setup(options?: {
  healthy?: boolean
}): Promise<{ engine: ChatEngine; bucketId: string; worktreePath: string; scopes: ScopeManager }> {
  const healthy = options?.healthy ?? true
  const db = await createTestDb()
  temporaryDatabases.push(db)
  new ProjectRepo(db).upsert({
    id: 'p1',
    name: 'Project',
    path: projectDir,
    source: 'local',
    providerId: 'openai',
    workflowId: 'default',
    threadLimit: 10,
    changeTrackingMode: 'manual',
    createdAt: Date.now(),
    updatedAt: Date.now()
  })
  const scopes = new ScopeManager(db)
  const created = scopes.createBucket('p1', { name: 'Feature' })
  const worktreePath = getScopeRootPath('p1', 'feature')
  scopes.attachManagedRoot('p1', created.bucket.id, {
    kind: 'worktree',
    directoryName: 'feature',
    branch: 'cio/feature',
    baseBranch: 'main',
    baseCommit: 'abc1234',
    createdAt: Date.now(),
    environmentMode: 'copy',
    setup: { state: 'not_run', commands: [] }
  })
  if (healthy) mkdirSync(worktreePath, { recursive: true })

  const projects = {
    getProject: (projectId: string) =>
      Promise.resolve(
        projectId === 'p1'
          ? {
              id: 'p1',
              name: 'Project',
              path: projectDir,
              source: 'local' as const,
              providerId: 'openai',
              workflowId: 'default',
              threadLimit: 10,
              createdAt: Date.now(),
              updatedAt: Date.now()
            }
          : null
      )
  }
  const resolver = new ScopeRootResolver(
    projects,
    scopes,
    new StaticInspector(
      healthy
        ? [{ path: worktreePath, head: 'refs/heads/cio/feature', locked: false, prunable: false }]
        : []
    )
  )
  const storage = new StorageEngine(temporaryConfigRoot)
  const engine = new ChatEngine(
    storage,
    db,
    undefined,
    undefined,
    undefined,
    undefined,
    scopeRootProvider(resolver)
  )
  return { engine, bucketId: created.bucket.id, worktreePath, scopes }
}

function resolveThreadPathFn(
  engine: ChatEngine
): (projectId: string, threadId: string) => Promise<string> {
  const candidate = (engine as unknown as Record<string, unknown>)['resolveThreadPath']
  if (typeof candidate !== 'function') throw new Error('resolveThreadPath missing')
  return candidate.bind(engine) as (projectId: string, threadId: string) => Promise<string>
}

function threadCreator(engine: ChatEngine): {
  createThread(input: {
    projectId: string
    providerId: string
    title: string
    scopeBucketId?: string
    workingDirectory?: string
  }): Promise<{ id: string }>
} {
  return (
    engine as unknown as {
      threadManager: {
        createThread(input: {
          projectId: string
          providerId: string
          title: string
          scopeBucketId?: string
          workingDirectory?: string
        }): Promise<{ id: string }>
      }
    }
  ).threadManager
}

describe('ChatEngine scope-owned roots', () => {
  it('resolves harness paths through the managed worktree for scoped threads', async () => {
    const { engine, bucketId, worktreePath } = await setup({ healthy: true })
    const resolve = resolveThreadPathFn(engine)
    const threads = threadCreator(engine)

    // A thread in a healthy managed scope resolves to the worktree root —
    // the same funnel drivers, session registries, change tracking, and
    // checkpoints all use.
    const scoped = await threads.createThread({
      projectId: 'p1',
      providerId: 'openai',
      title: 'Scoped',
      scopeBucketId: bucketId
    })
    await expect(resolve('p1', scoped.id)).resolves.toBe(worktreePath)

    // A stale persisted directory never wins over the authoritative root.
    await threads.createThread({
      projectId: 'p1',
      providerId: 'openai',
      title: 'Stale',
      scopeBucketId: bucketId,
      workingDirectory: '/stale/path'
    })
    await expect(resolve('p1', scoped.id)).resolves.toBe(worktreePath)
  }, 30_000)

  it('fails closed instead of operating on the project root when unhealthy', async () => {
    const { engine, bucketId, worktreePath } = await setup({ healthy: true })
    const resolve = resolveThreadPathFn(engine)
    const threads = threadCreator(engine)

    const scoped = await threads.createThread({
      projectId: 'p1',
      providerId: 'openai',
      title: 'Becomes unhealthy',
      scopeBucketId: bucketId,
      workingDirectory: '/stale/compatibility/path'
    })

    // The managed checkout disappears from disk: resolution must fail closed
    // instead of silently returning the project directory.
    rmSync(worktreePath, { recursive: true, force: true })
    await expect(resolve('p1', scoped.id)).rejects.toThrow(/Managed scope root unavailable/)
  }, 30_000)
})
