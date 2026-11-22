import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'child_process'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'

/**
 * What a fingerprint is allowed to cost.
 *
 * A change window brackets every tool a turn runs, so the scan behind it runs
 * dozens of times per turn on the main process. It needs one thing from Git:
 * the list of tracked-and-untracked paths. Reaching that through the full
 * checkpoint metadata read also spawned `rev-parse HEAD` and a whole
 * `git status --porcelain` walk and then discarded both, which on a large
 * checkout is hundreds of milliseconds per tool call for answers nobody read.
 *
 * These tests pin the Git invocations a fingerprint makes, so that waste cannot
 * quietly return.
 */
const gitArgs = vi.hoisted(() => [] as string[][])

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  const execFileMock = (
    file: string,
    args: readonly string[],
    options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ) => {
    gitArgs.push([...args])
    return actual.execFile(
      file,
      args,
      options as Parameters<typeof actual.execFile>[2],
      callback as Parameters<typeof actual.execFile>[3]
    )
  }
  return { ...actual, execFile: execFileMock, default: { ...actual, execFile: execFileMock } }
})

const { ChangeTrackingService } = await import('../../../src/main/git/change-tracking-service')

const execFileAsync = promisify(execFile)
const temporaryPaths: string[] = []

class MemoryBlobStore {
  private readonly blobs = new Map<string, Uint8Array>()
  async put(hash: string, content: Uint8Array): Promise<void> {
    this.blobs.set(hash, content.slice())
  }
  async get(hash: string): Promise<Uint8Array | null> {
    return this.blobs.get(hash)?.slice() ?? null
  }
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'codeinoven-fingerprint-'))
  temporaryPaths.push(path)
  return path
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd })
}

function gitCommands(): string[] {
  return gitArgs.map((args) => args.join(' '))
}

afterEach(async () => {
  gitArgs.length = 0
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe.skipIf(process.platform === 'win32')('fingerprint cost', () => {
  it('lists tracked paths without paying for HEAD or a working-tree status walk', async () => {
    const project = await temporaryDirectory()
    await git(project, ['init'])
    await writeFile(join(project, 'a.txt'), 'one', 'utf-8')
    await git(project, ['add', 'a.txt'])
    await git(project, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'base'])

    const service = new ChangeTrackingService(new MemoryBlobStore())
    gitArgs.length = 0
    const fingerprint = await service.fingerprint(project)

    expect(Object.keys(fingerprint.files)).toContain('a.txt')
    const commands = gitCommands()
    expect(commands.some((command) => command.includes('ls-files'))).toBe(true)
    // The two spawns a fingerprint never read back.
    expect(commands.some((command) => command.includes('status --porcelain'))).toBe(false)
    expect(commands.some((command) => command.includes('rev-parse HEAD'))).toBe(false)
  })

  it('resolves the repository root once for repeated scans of one checkout', async () => {
    const project = await temporaryDirectory()
    await git(project, ['init'])
    await writeFile(join(project, 'a.txt'), 'one', 'utf-8')

    const service = new ChangeTrackingService(new MemoryBlobStore())
    gitArgs.length = 0
    await service.fingerprint(project)
    await writeFile(join(project, 'b.txt'), 'two', 'utf-8')
    await service.fingerprint(project)

    const rootResolutions = gitCommands().filter((command) => command.includes('rev-parse'))
    expect(rootResolutions).toHaveLength(1)
  })

  it('still records the commit and working-tree status a checkpoint needs', async () => {
    const project = await temporaryDirectory()
    await git(project, ['init'])
    await writeFile(join(project, 'a.txt'), 'one', 'utf-8')
    await git(project, ['add', 'a.txt'])
    await git(project, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'base'])

    const service = new ChangeTrackingService(new MemoryBlobStore())
    gitArgs.length = 0
    await service.snapshot(project, { includeGitMetadata: true })

    const commands = gitCommands()
    expect(commands.some((command) => command.includes('rev-parse HEAD'))).toBe(true)
    expect(commands.some((command) => command.includes('status --porcelain'))).toBe(true)
  })

  it('reports a changed file between two fingerprints of the same tree', async () => {
    const project = await temporaryDirectory()
    await git(project, ['init'])
    await writeFile(join(project, 'a.txt'), 'one', 'utf-8')

    const service = new ChangeTrackingService(new MemoryBlobStore())
    const before = await service.fingerprint(project)
    await writeFile(join(project, 'a.txt'), 'one changed', 'utf-8')
    await writeFile(join(project, 'b.txt'), 'new', 'utf-8')
    const after = await service.fingerprint(project)

    expect(service.diffFingerprints(before, after)).toEqual(['a.txt', 'b.txt'])
  })
})
