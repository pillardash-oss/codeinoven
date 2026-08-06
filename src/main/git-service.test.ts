import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { simpleGit } from 'simple-git'
import { GitService } from './git-service'

const temporaryPaths: string[] = []

async function temporaryDirectory(prefix = 'codeinoven-git-service'): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  temporaryPaths.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

async function commitAll(directory: string, message: string): Promise<void> {
  const repo = simpleGit(directory)
  await repo.add('.')
  await repo.commit(message)
}

describe('GitService', () => {
  it('reports a clean status for an initialized repository', async () => {
    const directory = await temporaryDirectory()
    const service = new GitService()

    const initial = await service.initialize(directory)
    expect(initial.clean).toBe(true)
    expect(initial.changes).toHaveLength(0)

    await writeFile(join(directory, 'file.txt'), 'hello\n', 'utf-8')
    const dirty = await service.getStatus(directory)
    expect(dirty.clean).toBe(false)
    expect(dirty.untrackedChanges).toBe(1)
    expect(dirty.changes[0]?.status).toBe('untracked')
  })

  it('stages, unstages, and commits files', async () => {
    const directory = await temporaryDirectory()
    const service = new GitService()
    await service.initialize(directory)

    await writeFile(join(directory, 'a.txt'), 'a\n', 'utf-8')
    await writeFile(join(directory, 'b.txt'), 'b\n', 'utf-8')

    const staged = await service.stage(directory, ['a.txt', 'b.txt'])
    expect(staged.stagedChanges).toBe(2)
    expect(staged.changes.every((change) => change.staged)).toBe(true)

    const unstaged = await service.unstage(directory, ['a.txt'])
    expect(unstaged.stagedChanges).toBe(1)

    const committed = await service.commit(directory, 'add files')
    expect(committed.stagedChanges).toBe(0)
    expect(committed.untrackedChanges).toBe(1)
    expect(committed.changes.find((change) => change.path === 'b.txt')).toBeUndefined()

    const log = await service.log(directory)
    expect(log[0]?.message).toBe('add files')
    expect(log[0]?.shortHash).toHaveLength(7)
  })

  it('reports a unified diff for a modified file', async () => {
    const directory = await temporaryDirectory()
    const service = new GitService()
    await service.initialize(directory)
    await writeFile(join(directory, 'diff.txt'), 'line one\nline two\n', 'utf-8')
    await commitAll(directory, 'initial')

    await writeFile(join(directory, 'diff.txt'), 'line one\nline two changed\n', 'utf-8')
    const diff = await service.getDiff(directory, 'diff.txt', false)
    expect(diff.content).toContain('-line two')
    expect(diff.content).toContain('+line two changed')
    expect(diff.additions).toBe(1)
    expect(diff.deletions).toBe(1)
  })

  it('lists branches and tracks the current branch', async () => {
    const directory = await temporaryDirectory()
    const service = new GitService()
    await service.initialize(directory)
    await writeFile(join(directory, 'file.txt'), 'hello\n', 'utf-8')
    await commitAll(directory, 'initial')

    await simpleGit(directory).checkoutLocalBranch('feature/x')
    const branches = await service.listBranches(directory)
    const names = branches.map((branch) => branch.name)
    expect(names).toContain('main')
    expect(names).toContain('feature/x')
    expect(branches.find((branch) => branch.name === 'feature/x')?.current).toBe(true)
  })

  it('rejects paths that escape the repository root', async () => {
    const directory = await temporaryDirectory()
    const service = new GitService()
    await service.initialize(directory)
    await expect(service.getDiff(directory, '../outside.txt', false)).rejects.toThrow(
      'Repository path escapes the project root'
    )
  })

  it('reads and writes a repo-local identity', async () => {
    const directory = await temporaryDirectory()
    const service = new GitService()
    await service.initialize(directory)

    const after = await service.setIdentity(directory, 'Test User', 'test@example.com')
    expect(after.configured).toBe(true)
    expect(after.name).toBe('Test User')
    expect(after.email).toBe('test@example.com')

    const reread = await service.getIdentity(directory)
    expect(reread.name).toBe('Test User')
    expect(reread.email).toBe('test@example.com')
  })

  it('surfaces a clear error when the directory is not a repository', async () => {
    const directory = await temporaryDirectory()
    const service = new GitService()
    await expect(service.getStatus(directory)).rejects.toThrow()
  })
})
