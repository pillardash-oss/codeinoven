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

  it('adds a remote, pushes with upstream, and reports ahead/behind', async () => {
    const working = await temporaryDirectory('codeinoven-git-remote-working')
    const bare = await temporaryDirectory('codeinoven-git-remote-bare')
    const service = new GitService()

    await service.initialize(working)
    await writeFile(join(working, 'feature.txt'), 'feature\n', 'utf-8')
    await service.stage(working, ['feature.txt'])
    await service.commit(working, 'feature commit')

    await simpleGit(bare).init(true)
    const remotes = await service.addRemote(working, 'origin', bare)
    expect(remotes[0]?.name).toBe('origin')

    const branchName = (await simpleGit(working).revparse(['--abbrev-ref', 'HEAD'])).trim()
    await service.push(working, { setUpstream: true, remote: 'origin', branch: branchName })

    const status = await service.getStatus(working)
    expect(status.ahead).toBe(0)

    const clone = await temporaryDirectory('codeinoven-git-remote-clone')
    await simpleGit().clone(bare, clone)
    const cloneService = new GitService()
    const cloneStatus = await cloneService.getStatus(clone)
    expect(cloneStatus.filesChanged ?? cloneStatus.changes).toHaveLength(0)
  })

  it('computes ahead/behind after a divergent push', async () => {
    const working = await temporaryDirectory('codeinoven-git-ahead-working')
    const bare = await temporaryDirectory('codeinoven-git-ahead-bare')
    const service = new GitService()

    await service.initialize(working)
    await writeFile(join(working, 'a.txt'), 'a\n', 'utf-8')
    await service.stage(working, ['a.txt'])
    await service.commit(working, 'first')
    await simpleGit(bare).init(true)
    await service.addRemote(working, 'origin', bare)
    const branchName = (await simpleGit(working).revparse(['--abbrev-ref', 'HEAD'])).trim()
    await service.push(working, { setUpstream: true, remote: 'origin', branch: branchName })

    await writeFile(join(working, 'b.txt'), 'b\n', 'utf-8')
    await service.stage(working, ['b.txt'])
    await service.commit(working, 'second')

    const ahead = await service.getStatus(working)
    expect(ahead.ahead).toBe(1)

    const summary = await service.syncSummary(working)
    expect(summary.ahead).toBe(1)
  })

  it('removes a remote', async () => {
    const directory = await temporaryDirectory()
    const service = new GitService()
    await service.initialize(directory)
    await service.addRemote(directory, 'origin', 'https://example.com/repo.git')
    await service.addRemote(directory, 'upstream', 'https://example.com/upstream.git')
    const afterRemove = await service.removeRemote(directory, 'upstream')
    expect(afterRemove.map((remote) => remote.name)).toEqual(['origin'])
  })

  it('surfaces merge conflicts and aborts the merge back to a clean tree', async () => {
    const directory = await temporaryDirectory()
    const service = new GitService()
    await service.initialize(directory)
    await writeFile(join(directory, 'conflict.txt'), 'base\n', 'utf-8')
    await service.stage(directory, ['conflict.txt'])
    await service.commit(directory, 'base')

    await simpleGit(directory).checkoutLocalBranch('feature')
    await writeFile(join(directory, 'conflict.txt'), 'feature\n', 'utf-8')
    await service.stage(directory, ['conflict.txt'])
    await service.commit(directory, 'feature change')

    await simpleGit(directory).checkout('main')
    await writeFile(join(directory, 'conflict.txt'), 'main\n', 'utf-8')
    await service.stage(directory, ['conflict.txt'])
    await service.commit(directory, 'main change')

    const summary = await service.merge(directory, 'feature')
    expect(summary.conflicted.some((entry) => entry.path === 'conflict.txt')).toBe(true)

    const statusAfterConflict = await service.getStatus(directory)
    expect(statusAfterConflict.conflicted).toContain('conflict.txt')
    expect(statusAfterConflict.conflictState).toBe('merge')

    await service.abortMerge(directory)
    const statusAfterAbort = await service.getStatus(directory)
    expect(statusAfterAbort.conflicted).toHaveLength(0)
    expect(statusAfterAbort.conflictState).toBe('none')
  })

  it('surfaces rebase conflicts and aborts the rebase', async () => {
    const directory = await temporaryDirectory()
    const service = new GitService()
    await service.initialize(directory)
    await writeFile(join(directory, 'rebase.txt'), 'base\n', 'utf-8')
    await service.stage(directory, ['rebase.txt'])
    await service.commit(directory, 'base')

    await simpleGit(directory).checkoutLocalBranch('topic')
    await writeFile(join(directory, 'rebase.txt'), 'topic\n', 'utf-8')
    await service.stage(directory, ['rebase.txt'])
    await service.commit(directory, 'topic change')

    await simpleGit(directory).checkout('main')
    await writeFile(join(directory, 'rebase.txt'), 'main\n', 'utf-8')
    await service.stage(directory, ['rebase.txt'])
    await service.commit(directory, 'main change')

    const summary = await service.rebase(directory, 'topic')
    expect(summary.conflicted.some((entry) => entry.path === 'rebase.txt')).toBe(true)

    const statusAfterConflict = await service.getStatus(directory)
    expect(statusAfterConflict.conflictState).toBe('rebase')

    await service.abortRebase(directory)
    const statusAfterAbort = await service.getStatus(directory)
    expect(statusAfterAbort.conflictState).toBe('none')
    expect(statusAfterAbort.conflicted).toHaveLength(0)
  })

  it('stashes dirty changes and restores a clean tree', async () => {
    const directory = await temporaryDirectory()
    const service = new GitService()
    await service.initialize(directory)
    await writeFile(join(directory, 'keep.txt'), 'keep\n', 'utf-8')
    await service.stage(directory, ['keep.txt'])
    await service.commit(directory, 'keep')

    await writeFile(join(directory, 'dirty.txt'), 'dirty\n', 'utf-8')
    await service.stage(directory, ['dirty.txt'])

    const afterStash = await service.stash(directory, 'wip dirty')
    expect(afterStash.clean).toBe(true)

    const status = await service.getStatus(directory)
    expect(status.clean).toBe(true)
  })

  it('pushes with a transient auth token without persisting it', async () => {
    const working = await temporaryDirectory('codeinoven-git-token-working')
    const bare = await temporaryDirectory('codeinoven-git-token-bare')
    const service = new GitService()

    await service.initialize(working)
    await writeFile(join(working, 'a.txt'), 'a\n', 'utf-8')
    await service.stage(working, ['a.txt'])
    await service.commit(working, 'initial')

    await simpleGit(bare).init(true)
    await service.addRemote(working, 'origin', bare)

    const branchName = (await simpleGit(working).revparse(['--abbrev-ref', 'HEAD'])).trim()
    await expect(
      service.push(working, {
        setUpstream: true,
        remote: 'origin',
        branch: branchName,
        token: 'dummy-pat-token'
      })
    ).resolves.toMatchObject({ ahead: 0 })

    // The token must never leak into the repository's persisted config.
    const config = await simpleGit(working).raw(['config', '--local', '--list'])
    expect(config).not.toContain('dummy-pat-token')
    expect(config).not.toContain('extraheader')
  })

  it('no-ops on empty stage/unstage without invoking git', async () => {
    const directory = await temporaryDirectory()
    const service = new GitService()
    await service.initialize(directory)
    const status = await service.getStatus(directory)

    const staged = await service.stage(directory, [])
    expect(staged.clean).toBe(status.clean)
    const unstaged = await service.unstage(directory, [])
    expect(unstaged.clean).toBe(status.clean)
  })

  it('pulls back commits pushed from another clone and clears behind', async () => {
    const working = await temporaryDirectory('codeinoven-git-pull-working')
    const bare = await temporaryDirectory('codeinoven-git-pull-bare')
    const service = new GitService()

    await service.initialize(working)
    await writeFile(join(working, 'a.txt'), 'a\n', 'utf-8')
    await service.stage(working, ['a.txt'])
    await service.commit(working, 'first')
    await simpleGit(bare).init(true)
    await service.addRemote(working, 'origin', bare)
    const branchName = (await simpleGit(working).revparse(['--abbrev-ref', 'HEAD'])).trim()
    await service.push(working, { setUpstream: true, remote: 'origin', branch: branchName })

    // A peer clone advances the shared remote.
    const clone = await temporaryDirectory('codeinoven-git-pull-clone')
    await simpleGit().clone(bare, clone)
    const cloneRepo = simpleGit(clone)
    await writeFile(join(clone, 'b.txt'), 'b\n', 'utf-8')
    await cloneRepo.add('.')
    await cloneRepo.commit('peer change')
    await cloneRepo.push(['origin', branchName])

    // The original repo is now behind and pull brings it forward.
    const fetched = await service.fetch(working)
    expect(fetched.behind).toBe(1)

    const pulled = await service.pull(working)
    expect(pulled.behind).toBe(0)
    const pulledStatus = await service.getStatus(working)
    expect(pulledStatus.behind).toBe(0)
  })
})
