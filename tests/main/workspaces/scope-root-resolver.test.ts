import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createTestDb, destroyTestDb } from '../../main/database/test-helper'
import type { Database } from '../../../src/main/database/database'
import { ProjectRepo } from '../../../src/main/database/repositories/project-repo'
import { ProjectManager } from '../../../src/lib/engines/project-manager'
import { ScopeManager } from '../../../src/lib/engines/scope-manager'
import {
  ScopeRootResolver,
  ScopeRootUnavailableError,
  scopeRootProvider,
  type ManagedWorktreeInspector,
  type WorktreeRegistration
} from '../../../src/main/workspaces/scope-root-resolver'
import { getScopeRootPath } from '../../../src/lib/utils'

const temporaryDatabases: Database[] = []
const originalConfigRoot = process.env['CODEINOVEN_CONFIG_ROOT']
const originalSmokeFlag = process.env['CODEINOVEN_PACKAGED_SMOKE_OUTPUT']
let temporaryConfigRoot = ''
let projectDir = ''

beforeEach(() => {
  temporaryConfigRoot = mkdtempSync(join(tmpdir(), 'codeinoven-scope-resolver-'))
  projectDir = mkdtempSync(join(tmpdir(), 'codeinoven-scope-repo-'))
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

async function setup(options?: { inspector?: ManagedWorktreeInspector }): Promise<{
  resolver: ScopeRootResolver
  scopes: ScopeManager
  bucketId: string
}> {
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
  const projects = new ProjectManager(db)
  const scopes = new ScopeManager(db)
  const resolver = new ScopeRootResolver(
    projects,
    scopes,
    options?.inspector ?? {
      listWorktrees: () => Promise.resolve([])
    }
  )
  const created = scopes.createBucket('p1', { name: 'Feature' })
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
  return { resolver, scopes, bucketId: created.bucket.id }
}

function registration(overrides: Partial<WorktreeRegistration> = {}): WorktreeRegistration {
  return {
    path: getScopeRootPath('p1', 'feature'),
    head: 'refs/heads/cio/feature',
    locked: false,
    prunable: false,
    ...overrides
  }
}

describe('ScopeRootResolver', () => {
  it('resolves the Default scope to the registered project directory', async () => {
    const { resolver } = await setup()
    const resolution = await resolver.resolve({ projectId: 'p1', scopeBucketId: 'default' })
    expect(resolution).toEqual({
      ok: true,
      root: projectDir,
      rootDescriptor: { kind: 'project' }
    })
  })

  it('resolves a healthy managed scope to its config-root worktree path', async () => {
    const expected = getScopeRootPath('p1', 'feature')
    mkdirSync(expected, { recursive: true })
    const { resolver, bucketId } = await setup({
      inspector: { listWorktrees: () => Promise.resolve([registration()]) }
    })
    const resolution = await resolver.resolve({ projectId: 'p1', scopeBucketId: bucketId })
    expect(resolution.ok).toBe(true)
    if (resolution.ok) expect(resolution.root).toBe(expected)
  })

  it('fails closed with typed health categories instead of falling back', async () => {
    const { resolver, bucketId } = await setup()

    // Missing directory.
    const missing = await resolver.resolve({ projectId: 'p1', scopeBucketId: bucketId })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.health.category).toBe('missing')

    // Directory exists but Git does not register it.
    mkdirSync(getScopeRootPath('p1', 'feature'), { recursive: true })
    const unregistered = await resolver.resolve({ projectId: 'p1', scopeBucketId: bucketId })
    expect(unregistered.ok).toBe(false)
    if (!unregistered.ok) expect(unregistered.health.category).toBe('unregistered')

    // Locked registration.
    const lockedResolverSetup = await setup({
      inspector: { listWorktrees: () => Promise.resolve([registration({ locked: true })]) }
    })
    const locked = await lockedResolverSetup.resolver.resolve({
      projectId: 'p1',
      scopeBucketId: lockedResolverSetup.bucketId
    })
    expect(locked.ok).toBe(false)
    if (!locked.ok) expect(locked.health.category).toBe('locked')

    // Branch mismatch.
    const mismatchSetup = await setup({
      inspector: {
        listWorktrees: () => Promise.resolve([registration({ head: 'refs/heads/other-branch' })])
      }
    })
    const mismatch = await mismatchSetup.resolver.resolve({
      projectId: 'p1',
      scopeBucketId: mismatchSetup.bucketId
    })
    expect(mismatch.ok).toBe(false)
    if (!mismatch.ok) expect(mismatch.health.category).toBe('branch-mismatch')

    // Path mismatch.
    const pathMatchSetup = await setup({
      inspector: {
        listWorktrees: () => Promise.resolve([registration({ path: '/somewhere/else' })])
      }
    })
    const pathMatch = await pathMatchSetup.resolver.resolve({
      projectId: 'p1',
      scopeBucketId: pathMatchSetup.bucketId
    })
    expect(pathMatch.ok).toBe(false)
    if (!pathMatch.ok) expect(pathMatch.health.category).toBe('path-mismatch')

    // Prunable stale registration.
    const prunableSetup = await setup({
      inspector: {
        listWorktrees: () => Promise.resolve([registration({ prunable: true })])
      }
    })
    const prunable = await prunableSetup.resolver.resolve({
      projectId: 'p1',
      scopeBucketId: prunableSetup.bucketId
    })
    expect(prunable.ok).toBe(false)
    if (!prunable.ok) expect(prunable.health.category).toBe('prunable')

    // Repository discovery failure.
    const failingSetup = await setup({
      inspector: { listWorktrees: () => Promise.reject(new Error('git unavailable')) }
    })
    const failing = await failingSetup.resolver.resolve({
      projectId: 'p1',
      scopeBucketId: failingSetup.bucketId
    })
    expect(failing.ok).toBe(false)
    if (!failing.ok) expect(failing.health.category).toBe('repository-unavailable')
  })

  it('never resolves an unhealthy managed target to the project directory', async () => {
    const { resolver, bucketId } = await setup()
    const resolution = await resolver.resolve({ projectId: 'p1', scopeBucketId: bucketId })
    expect(resolution.ok).toBe(false)
    await expect(
      resolver.requireRoot({ projectId: 'p1', scopeBucketId: bucketId })
    ).rejects.toThrow(ScopeRootUnavailableError)
  })

  it('reports unknown scopes as unregistered', async () => {
    const { resolver } = await setup()
    const resolution = await resolver.resolve({ projectId: 'p1', scopeBucketId: 'nope' })
    expect(resolution.ok).toBe(false)
    if (!resolution.ok) expect(resolution.health.category).toBe('unregistered')
  })

  it('exposes a fail-closed ThreadScopeRootProvider adapter', async () => {
    const expected = getScopeRootPath('p1', 'feature')
    mkdirSync(expected, { recursive: true })
    const { resolver, bucketId } = await setup({
      inspector: { listWorktrees: () => Promise.resolve([registration()]) }
    })
    const provider = scopeRootProvider(resolver)
    await expect(provider.resolveCompatibilityRoot('p1', 'default')).resolves.toBe(projectDir)
    await expect(provider.resolveCompatibilityRoot('p1', bucketId)).resolves.toBe(expected)
    await expect(provider.resolveCompatibilityRoot('p1', 'missing')).rejects.toThrow(
      ScopeRootUnavailableError
    )
    await expect(provider.resolveCompatibilityRoot('p1', undefined)).resolves.toBeNull()
  })
})
