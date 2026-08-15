import { afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import {
  ChangeTrackingService,
  CheckpointLimitError,
  type CheckpointBlobStore
} from '../../src/main/git/change-tracking-service'

const temporaryPaths: string[] = []
const execFileAsync = promisify(execFile)

class MemoryBlobStore implements CheckpointBlobStore {
  private readonly blobs = new Map<string, Uint8Array>()

  async put(hash: string, content: Uint8Array): Promise<void> {
    this.blobs.set(hash, content.slice())
  }

  async get(hash: string): Promise<Uint8Array | null> {
    return this.blobs.get(hash)?.slice() ?? null
  }
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'codeinoven-checkpoint-'))
  temporaryPaths.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('ChangeTrackingService', () => {
  it('calculates and selectively restores created, modified, and deleted files', async () => {
    const project = await temporaryDirectory()
    await writeFile(join(project, 'modified.txt'), 'before', 'utf-8')
    await writeFile(join(project, 'deleted.txt'), 'restore me', 'utf-8')
    await writeFile(join(project, 'unrelated.txt'), 'leave me', 'utf-8')
    const service = new ChangeTrackingService(new MemoryBlobStore())
    const before = await service.snapshot(project)

    await writeFile(join(project, 'modified.txt'), 'after', 'utf-8')
    await rm(join(project, 'deleted.txt'))
    await writeFile(join(project, 'created.txt'), 'remove me', 'utf-8')
    const after = await service.snapshot(project)

    expect(
      service.calculateChanges(before, after).map((change) => `${change.kind}:${change.path}`)
    ).toEqual(['created:created.txt', 'deleted:deleted.txt', 'modified:modified.txt'])

    await service.restoreBefore(before, after)

    await expect(readFile(join(project, 'created.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(project, 'deleted.txt'), 'utf-8')).resolves.toBe('restore me')
    await expect(readFile(join(project, 'modified.txt'), 'utf-8')).resolves.toBe('before')
    await expect(readFile(join(project, 'unrelated.txt'), 'utf-8')).resolves.toBe('leave me')
  })

  it('skips excluded paths and never follows a symlink outside the project', async () => {
    const project = await temporaryDirectory()
    const outside = await temporaryDirectory()
    await mkdir(join(project, 'node_modules'))
    await writeFile(join(project, 'node_modules', 'ignored.txt'), 'ignored', 'utf-8')
    await mkdir(join(project, '.cio'))
    await writeFile(join(project, '.cio', 'spec.md'), 'agent context', 'utf-8')
    await writeFile(join(outside, 'secret.txt'), 'secret', 'utf-8')
    await symlink(join(outside, 'secret.txt'), join(project, 'secret-link'))
    await writeFile(join(project, 'kept.txt'), 'kept', 'utf-8')

    const checkpoint = await new ChangeTrackingService(new MemoryBlobStore()).snapshot(project)

    expect(Object.keys(checkpoint.files)).toEqual(['kept.txt'])
  })

  it('throws an explicit error when a checkpoint limit is exceeded', async () => {
    const project = await temporaryDirectory()
    await writeFile(join(project, 'large.txt'), '12345', 'utf-8')
    const service = new ChangeTrackingService(new MemoryBlobStore(), {
      limits: { maxFileBytes: 4 }
    })

    await expect(service.snapshot(project)).rejects.toBeInstanceOf(CheckpointLimitError)
  })

  it('captures the repository head and pre-turn working tree state', async () => {
    const project = await temporaryDirectory()
    await execFileAsync('git', ['init', project])
    await execFileAsync('git', ['-C', project, 'config', 'user.name', 'CodeInOven Test'])
    await execFileAsync('git', [
      '-C',
      project,
      'config',
      'user.email',
      'codeinoven@example.invalid'
    ])
    await writeFile(join(project, 'tracked.txt'), 'tracked', 'utf-8')
    await execFileAsync('git', ['-C', project, 'add', 'tracked.txt'])
    await execFileAsync('git', ['-C', project, 'commit', '-m', 'baseline'])
    await writeFile(join(project, 'untracked.txt'), 'pending', 'utf-8')

    const checkpoint = await new ChangeTrackingService(new MemoryBlobStore()).snapshot(project, {
      includeGitMetadata: true
    })

    expect(checkpoint.git?.repositoryRoot).toBe(await realpath(project))
    expect(checkpoint.git?.head).toMatch(/^[a-f0-9]{40}$/u)
    expect(checkpoint.git?.porcelainStatus).toContain('?? untracked.txt')
  })
})
