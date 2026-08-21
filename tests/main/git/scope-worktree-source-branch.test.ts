import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { simpleGit } from 'simple-git'
import { createTestDb, destroyTestDb } from '../database/test-helper'
import type { Database } from '../../../src/main/database/database'
import { ScopeManager } from '../../../src/lib/engines/scope-manager'
import { ScopeWorktreeService } from '../../../src/main/git/scope-worktree-service'
import { getScopeRootPath } from '../../../src/lib/utils'

const temporaryDatabases: Database[] = []
const temporaryPaths: string[] = []
const originalConfigRoot = process.env['CODEINOVEN_CONFIG_ROOT']
const originalSmokeFlag = process.env['CODEINOVEN_PACKAGED_SMOKE_OUTPUT']
let configRoot = ''
let repoPath = ''

beforeEach(() => {
  configRoot = mkdtempSync(join(tmpdir(), 'codeinoven-wt-config-'))
  temporaryPaths.push(configRoot)
  process.env['CODEINOVEN_CONFIG_ROOT'] = configRoot
  process.env['CODEINOVEN_PACKAGED_SMOKE_OUTPUT'] = '1'
})

afterEach(() => {
  temporaryDatabases.splice(0).forEach(destroyTestDb)
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true })
  configRoot = ''
  if (originalConfigRoot === undefined) delete process.env['CODEINOVEN_CONFIG_ROOT']
  else process.env['CODEINOVEN_CONFIG_ROOT'] = originalConfigRoot
  if (originalSmokeFlag === undefined) delete process.env['CODEINOVEN_PACKAGED_SMOKE_OUTPUT']
  else process.env['CODEINOVEN_PACKAGED_SMOKE_OUTPUT'] = originalSmokeFlag
})

async function createRepo(): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), 'codeinoven-wt-repo-'))
  temporaryPaths.push(repo)
  const git = simpleGit(repo)
  await git.init()
  await git.addConfig('user.email', 'test@example.com')
  await git.addConfig('user.name', 'Test')
  writeFileSync(join(repo, 'README.md'), '# repo\n')
  await git.add('.')
  await git.commit('initial')
  return repo
}

async function setup(): Promise<{
  service: ScopeWorktreeService
  scopes: ScopeManager
  bucketA: string
  bucketB: string
}> {
  const db = await createTestDb()
  temporaryDatabases.push(db)
  repoPath = await createRepo()
  const scopes = new ScopeManager(db)
  const a = scopes.createBucket('p1', { name: 'A' })
  const b = scopes.createBucket('p1', { name: 'B' })
  const projectStub = {
    getProject: async (id: string) =>
      id === 'p1'
        ? {
            id: 'p1',
            name: 'Project',
            path: repoPath,
            source: 'local' as const,
            providerId: 'openai',
            workflowId: 'default',
            threadLimit: 10,
            createdAt: Date.now(),
            updatedAt: Date.now()
          }
        : null
  }
  const service = new ScopeWorktreeService(scopes, projectStub)
  return { service, scopes, bucketA: a.bucket.id, bucketB: b.bucket.id }
}

describe('ScopeWorktreeService source branch', () => {
  it('defaults to the currently checked-out branch when no baseBranch is supplied', async () => {
    const { service, bucketA } = await setup()
    const git = simpleGit(repoPath)
    const current = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim()
    const descriptor = await service.createManagedWorktree(
      { projectId: 'p1', scopeBucketId: bucketA },
      { title: 'DefaultSource', runSetup: false, environmentMode: 'copy' }
    )
    // The worktree always forks from the current branch unless one is given.
    expect(descriptor.baseBranch).toBe(current)
    expect(descriptor.baseCommit).toMatch(/^[0-9a-f]+$/)
  }, 60_000)

  it('forks from an explicitly supplied source branch', async () => {
    const { service, bucketA } = await setup()
    const git = simpleGit(repoPath)
    const current = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim()
    await git.checkoutLocalBranch('release-2')
    writeFileSync(join(repoPath, 'feature.txt'), 'release\n')
    await git.add('.')
    await git.commit('release work')
    await git.checkout(current)

    const descriptor = await service.createManagedWorktree(
      { projectId: 'p1', scopeBucketId: bucketA },
      { title: 'FromRelease', runSetup: false, environmentMode: 'copy', baseBranch: 'release-2' }
    )
    expect(descriptor.baseBranch).toBe('release-2')

    const worktreePath = getScopeRootPath('p1', descriptor.directoryName)
    expect(existsSync(worktreePath)).toBe(true)
    // The worktree contains the release branch's file, proving the fork source.
    expect(readFileSync(join(worktreePath, 'feature.txt'), 'utf8')).toContain('release')
  }, 60_000)

  it('rejects a source branch that does not exist', async () => {
    const { service, bucketA } = await setup()
    await expect(
      service.createManagedWorktree(
        { projectId: 'p1', scopeBucketId: bucketA },
        {
          title: 'Missing',
          runSetup: false,
          environmentMode: 'copy',
          baseBranch: 'no-such-branch'
        }
      )
    ).rejects.toThrow(/Source branch does not exist/)
  }, 60_000)
})
