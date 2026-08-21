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

interface Fixture {
  service: ScopeWorktreeService
  scopes: ScopeManager
  bucketA: string
  bucketB: string
}

async function setup(
  options: { setupCommands?: { executable: string; args: string[] }[] } = {}
): Promise<Fixture> {
  const db = await createTestDb()
  temporaryDatabases.push(db)
  repoPath = await createRepo()
  const scopes = new ScopeManager(db)
  if (options.setupCommands) {
    scopes.setWorktreeDefaults('p1', {
      setupCommands: options.setupCommands,
      runSetupByDefault: true,
      environmentMode: 'copy'
    })
  }
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

describe('ScopeWorktreeService', () => {
  it('creates a managed worktree on a cio/ branch beneath the config root', async () => {
    const { service, scopes, bucketA } = await setup()
    const descriptor = await service.createManagedWorktree(
      { projectId: 'p1', scopeBucketId: bucketA },
      { title: 'My Cool Feature', runSetup: true, environmentMode: 'copy' }
    )
    expect(descriptor.directoryName).toBe('my-cool-feature')
    expect(descriptor.branch).toBe('cio/my-cool-feature')
    expect(descriptor.baseBranch).toBe('main')
    expect(descriptor.baseCommit).toMatch(/^[0-9a-f]+$/)

    const bucket = scopes.getBoard('p1').buckets.find((candidate) => candidate.id === bucketA)
    expect(bucket?.root.kind).toBe('worktree')

    const worktreePath = getScopeRootPath('p1', descriptor.directoryName)
    expect(existsSync(worktreePath)).toBe(true)
    const registrations = await service.listWorktrees(repoPath)
    expect(
      registrations.some(
        (entry) => entry.path === worktreePath && entry.head === 'refs/heads/cio/my-cool-feature'
      )
    ).toBe(true)
  }, 60_000)

  it('uses deterministic collision suffixes for repeated titles', async () => {
    const { service, scopes, bucketA, bucketB } = await setup()
    const first = await service.createManagedWorktree(
      { projectId: 'p1', scopeBucketId: bucketA },
      { title: 'Feature', runSetup: false, environmentMode: 'copy' }
    )
    const second = await service.createManagedWorktree(
      { projectId: 'p1', scopeBucketId: bucketB },
      { title: 'Feature', runSetup: false, environmentMode: 'copy' }
    )
    expect(first.directoryName).toBe('feature')
    expect(second.directoryName).toBe('feature-2')
    expect(second.branch).toBe('cio/feature-2')

    const c = scopes.createBucket('p1', { name: 'C' })
    const third = await service.createManagedWorktree(
      { projectId: 'p1', scopeBucketId: c.bucket.id },
      { title: 'Feature', runSetup: false, environmentMode: 'copy' }
    )
    expect(third.directoryName).toBe('feature-3')
  }, 60_000)

  it('blocks tracked submodules before any mutation', async () => {
    const { service, bucketA } = await setup()
    // Create a real gitlink (mode 160000) by adding a nested repository.
    const nested = mkdtempSync(join(tmpdir(), 'codeinoven-wt-nested-'))
    temporaryPaths.push(nested)
    const nestedGit = simpleGit(nested)
    await nestedGit.init()
    await nestedGit.addConfig('user.email', 't@e.c')
    await nestedGit.addConfig('user.name', 't')
    writeFileSync(join(nested, 'lib.txt'), 'lib\n')
    await nestedGit.add('.')
    await nestedGit.commit('init')

    const git = simpleGit(repoPath)
    // Register a real gitlink (mode 160000) in the index — the authoritative
    // "tracked submodule" signal — plus a matching .gitmodules entry.
    const nestedHead = (await nestedGit.revparse(['HEAD'])).trim()
    await git.raw(['update-index', '--add', '--cacheinfo', `160000,${nestedHead},lib`])
    writeFileSync(
      join(repoPath, '.gitmodules'),
      `[submodule "lib"]\n\tpath = lib\n\turl = ${nested}\n`
    )
    await git.add('.gitmodules')
    await git.commit('add submodule', undefined, { '--allow-empty': undefined as never })

    await expect(
      service.createManagedWorktree(
        { projectId: 'p1', scopeBucketId: bucketA },
        { title: 'Sub', runSetup: true, environmentMode: 'copy' }
      )
    ).rejects.toThrow(/submodules/iu)

    const registrations = await service.listWorktrees(repoPath)
    expect(registrations.some((entry) => entry.head?.includes('cio/sub'))).toBe(false)
  }, 60_000)

  it('copies eligible env files and never overwrites existing target files', async () => {
    const { service, bucketA } = await setup()
    // Env files are untracked in the root so the checkout cannot contain them.
    writeFileSync(join(repoPath, '.env'), 'SECRET=value\n')
    writeFileSync(join(repoPath, '.env.local'), 'LOCAL=1\n')
    writeFileSync(join(repoPath, '.env.example'), '# template\n')

    const descriptor = await service.createManagedWorktree(
      { projectId: 'p1', scopeBucketId: bucketA },
      { title: 'Env', runSetup: false, environmentMode: 'copy' }
    )
    const worktreePath = getScopeRootPath('p1', descriptor.directoryName)
    expect(readFileSync(join(worktreePath, '.env'), 'utf8')).toContain('SECRET=value')
    expect(readFileSync(join(worktreePath, '.env.local'), 'utf8')).toContain('LOCAL=1')
    expect(existsSync(join(worktreePath, '.env.example'))).toBe(false)

    // Root files are untouched.
    expect(readFileSync(join(repoPath, '.env'), 'utf8')).toContain('SECRET=value')
  }, 60_000)

  it('symlinks environment files when selected', async () => {
    const { service, scopes, bucketA } = await setup()
    writeFileSync(join(repoPath, '.env'), 'SECRET=value\n')
    const descriptor = await service.createManagedWorktree(
      { projectId: 'p1', scopeBucketId: bucketA },
      { title: 'SymlinkEnv', runSetup: false, environmentMode: 'symlink' }
    )
    const worktreePath = getScopeRootPath('p1', descriptor.directoryName)
    const { lstat } = await import('fs/promises')
    const meta = await lstat(join(worktreePath, '.env'))
    expect(meta.isSymbolicLink()).toBe(true)
    const bucket = scopes.getBoard('p1').buckets.find((candidate) => candidate.id === bucketA)
    if (bucket?.root.kind === 'worktree') expect(bucket.root.environmentMode).toBe('symlink')
  }, 60_000)

  it('runs ordered setup commands sequentially, preserving the worktree on failure', async () => {
    const { service, scopes, bucketA } = await setup({
      setupCommands: [
        { executable: 'sh', args: ['-c', 'echo first; printf x >> .order'] },
        { executable: 'sh', args: ['-c', 'echo "boom" >&2; exit 7'] }
      ]
    })
    await expect(
      service.createManagedWorktree(
        { projectId: 'p1', scopeBucketId: bucketA },
        { title: 'Failing', runSetup: true, environmentMode: 'copy' }
      )
    ).rejects.toThrow(/Setup command 2 failed/)

    const bucket = scopes.getBoard('p1').buckets.find((candidate) => candidate.id === bucketA)
    expect(bucket?.root.kind).toBe('worktree')
    if (bucket?.root.kind !== 'worktree') return
    expect(bucket.root.setup.state).toBe('failed')
    expect(bucket.root.setup.commands[0]?.state).toBe('succeeded')
    expect(bucket.root.setup.commands[1]?.state).toBe('failed')
    expect(bucket.root.setup.commands[1]?.exitCode).toBe(7)

    // The worktree persists for retry and remains healthy.
    const worktreePath = getScopeRootPath('p1', bucket.root.directoryName)
    expect(existsSync(worktreePath)).toBe(true)
    expect(readFileSync(join(worktreePath, '.order'), 'utf8')).toBe('x')
    const health = await service.health({ projectId: 'p1', scopeBucketId: bucketA })
    expect(health.category).toBe('healthy')
  }, 60_000)

  it('reports typed health and treats a missing directory as unhealthy', async () => {
    const { service, bucketA } = await setup()
    const descriptor = await service.createManagedWorktree(
      { projectId: 'p1', scopeBucketId: bucketA },
      { title: 'Health', runSetup: false, environmentMode: 'copy' }
    )
    expect((await service.health({ projectId: 'p1', scopeBucketId: bucketA })).category).toBe(
      'healthy'
    )

    rmSync(getScopeRootPath('p1', descriptor.directoryName), { recursive: true, force: true })
    expect((await service.health({ projectId: 'p1', scopeBucketId: bucketA })).category).toBe(
      'missing'
    )
  }, 60_000)

  it('guards removal behind single-use confirmations and dirty-state checks', async () => {
    const { service, scopes, bucketA } = await setup()
    const descriptor = await service.createManagedWorktree(
      { projectId: 'p1', scopeBucketId: bucketA },
      { title: 'Guard', runSetup: false, environmentMode: 'copy' }
    )
    const worktreePath = getScopeRootPath('p1', descriptor.directoryName)

    // Stale tokens never work.
    await expect(
      service.confirmRemoveWorktree({ projectId: 'p1', scopeBucketId: bucketA }, 'bogus', false)
    ).rejects.toThrow(/Confirmation token is stale/)

    // Dirty state blocks normal removal even with a fresh token.
    writeFileSync(join(worktreePath, 'dirty.txt'), 'x\n')
    const preflight = await service.preflight('remove-worktree', {
      projectId: 'p1',
      scopeBucketId: bucketA
    })
    expect(preflight.dirtyFiles.length).toBeGreaterThan(0)
    await expect(
      service.confirmRemoveWorktree(
        { projectId: 'p1', scopeBucketId: bucketA },
        preflight.confirmationId,
        false
      )
    ).rejects.toThrow(/dirty or unpushed/)

    // Force removal needs a fresh token and a separate confirmation.
    const forced = await service.preflight('remove-worktree', {
      projectId: 'p1',
      scopeBucketId: bucketA
    })
    await service.confirmRemoveWorktree(
      { projectId: 'p1', scopeBucketId: bucketA },
      forced.confirmationId,
      true
    )
    expect(scopes.getBoard('p1').buckets.some((candidate) => candidate.id === bucketA)).toBe(false)
    expect(existsSync(worktreePath)).toBe(false)
  }, 60_000)
})
