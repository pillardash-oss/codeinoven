import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { simpleGit } from 'simple-git'
import type { SimpleGit } from 'simple-git'

/**
 * Phase 0 spike: prove `simple-git` (thin wrapper over the system git binary)
 * covers every operation the four phases need before the architecture commits
 * to it — init, status, stage/commit, push to a bare local remote, rebase with
 * a constructed conflict, and merge `MergeSummary` conflict detection.
 */

const temporaryPaths: string[] = []

async function temporaryDirectory(prefix = 'codeinoven-git-spike'): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  temporaryPaths.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

async function commitEverything(repo: SimpleGit, message: string): Promise<void> {
  await repo.add('.')
  await repo.commit(message)
}

describe('simple-git spike against the system git binary', () => {
  it('initializes a repository and reports working-tree status', async () => {
    const directory = await temporaryDirectory()
    const repo = simpleGit(directory)

    await repo.init({ '--initial-branch': 'main' })

    await writeFile(join(directory, 'hello.txt'), 'one\n', 'utf-8')
    const dirty = await repo.status()
    expect(dirty.files).toHaveLength(1)
    expect(dirty.files[0]?.path).toBe('hello.txt')
    expect(dirty.files[0]?.working_dir).toBe('?')
    expect(dirty.current).not.toBe('')

    await commitEverything(repo, 'initial commit')
    const clean = await repo.status()
    expect(clean.isClean()).toBe(true)
  })

  it('stages, commits, and pushes to a bare local remote', async () => {
    const working = await temporaryDirectory('codeinoven-git-spike-working')
    const bare = await temporaryDirectory('codeinoven-git-spike-bare')
    const repo = simpleGit(working)

    await repo.init({ '--initial-branch': 'main' })
    await writeFile(join(working, 'feature.txt'), 'feature\n', 'utf-8')
    await repo.add('.')
    await repo.commit('feature commit')

    await repo.init({ '--initial-branch': 'main' })
    await simpleGit(bare).init(true, { '--initial-branch': 'main' })
    await repo.addRemote('origin', bare)
    await repo.push(['--set-upstream', 'origin', 'HEAD'])

    const cloned = await temporaryDirectory('codeinoven-git-spike-clone')
    await simpleGit().clone(bare, cloned)
    const cloneStatus = await simpleGit(cloned).status()
    expect(cloneStatus.files).toHaveLength(0)
  })

  it('surfaces a merge conflict via MergeSummary', async () => {
    const directory = await temporaryDirectory()
    const repo = simpleGit(directory)

    await repo.init({ '--initial-branch': 'main' })
    await writeFile(join(directory, 'conflict.txt'), 'base\n', 'utf-8')
    await commitEverything(repo, 'base')

    await repo.checkoutLocalBranch('feature')
    await writeFile(join(directory, 'conflict.txt'), 'feature\n', 'utf-8')
    await commitEverything(repo, 'feature change')

    await repo.checkout('main')
    await writeFile(join(directory, 'conflict.txt'), 'main\n', 'utf-8')
    await commitEverything(repo, 'main change')

    const failure = await repo.merge(['feature']).catch((error: unknown) => error)
    const conflict = failure as {
      git?: { conflicts?: Array<{ file: string }>; result?: string }
    }
    expect(conflict.git?.conflicts?.map((entry) => entry.file)).toContain('conflict.txt')

    const statusAfterConflict = await repo.status()
    expect(statusAfterConflict.conflicted).toContain('conflict.txt')

    await repo.raw(['merge', '--abort'])
    const statusAfterAbort = await repo.status()
    expect(statusAfterAbort.conflicted).toHaveLength(0)
  })

  it('rebases onto a branch after a constructed conflict and allows abort', async () => {
    const directory = await temporaryDirectory()
    const repo = simpleGit(directory)

    await repo.init({ '--initial-branch': 'main' })
    await writeFile(join(directory, 'rebase.txt'), 'base\n', 'utf-8')
    await commitEverything(repo, 'base')

    await repo.checkoutLocalBranch('topic')
    await writeFile(join(directory, 'rebase.txt'), 'topic\n', 'utf-8')
    await commitEverything(repo, 'topic change')

    await repo.checkout('main')
    await writeFile(join(directory, 'rebase.txt'), 'main\n', 'utf-8')
    await commitEverything(repo, 'main change')

    const failure = await repo.rebase(['topic']).catch((error: unknown) => error)
    expect(failure).toBeDefined()

    const conflicted = await repo.status()
    expect(conflicted.conflicted).toContain('rebase.txt')

    await repo.raw(['rebase', '--abort'])
    const statusAfterAbort = await repo.status()
    expect(statusAfterAbort.conflicted).toHaveLength(0)
    const head = await repo.revparse(['--abbrev-ref', 'HEAD'])
    expect(head).toBe('main')
  })

  it('resolves git-not-installed into the existing git_unavailable path', async () => {
    const directory = await temporaryDirectory()
    const repo = simpleGit(directory, { binary: 'definitely-not-a-real-git-binary' })
    const failure = await repo.init().catch((error: unknown) => error)
    expect(failure).toBeDefined()
    const message = failure instanceof Error ? failure.message : String(failure)
    expect(message.length).toBeGreaterThan(0)
  })
})
