import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { atomicWrite, atomicWriteDurable, readJson, resolveWithinRoot } from '../../src/lib/utils'

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises')
  return { ...actual, rename: vi.fn(actual.rename) }
})

function lockedError(code: 'EPERM' | 'EBUSY' | 'EACCES'): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: operation not permitted, rename`), { code })
}

describe.skipIf(process.platform === 'win32')('storage utilities', () => {
  let sandboxPath: string
  let rootPath: string

  beforeEach(async () => {
    vi.mocked(rename).mockClear()
    sandboxPath = await mkdtemp(join(tmpdir(), 'codeinoven-storage-'))
    rootPath = join(sandboxPath, 'root')
    await mkdir(join(rootPath, 'nested'), { recursive: true })
  })

  afterEach(async () => {
    await rm(sandboxPath, { recursive: true, force: true })
  })

  it('preserves valid nested paths within the storage root', () => {
    expect(resolveWithinRoot(rootPath, 'nested/value.json')).toBe(
      join(rootPath, 'nested', 'value.json')
    )
  })

  it.each(['/tmp/escape', '../escape', 'nested/../escape', 'C:\\escape'])(
    'rejects unsafe path %s',
    (unsafePath) => {
      expect(() => resolveWithinRoot(rootPath, unsafePath)).toThrow(/Storage path/)
    }
  )

  it('rejects symlinks outside the storage root', async () => {
    const outsidePath = join(sandboxPath, 'outside')
    await mkdir(outsidePath)
    await symlink(outsidePath, join(rootPath, 'outside-link'))

    expect(() => resolveWithinRoot(rootPath, 'outside-link/value.json')).toThrow(/symlink outside/)
  })

  it('allows symlinks that remain within the storage root', async () => {
    await symlink(join(rootPath, 'nested'), join(rootPath, 'inside-link'))

    expect(resolveWithinRoot(rootPath, 'inside-link/value.json')).toBe(
      join(rootPath, 'inside-link', 'value.json')
    )
  })

  it('supports concurrent atomic writes without leaking temporary files', async () => {
    const filePath = join(rootPath, 'race.txt')
    const values = Array.from({ length: 20 }, (_, index) => String(index))

    await Promise.all(values.map((value) => atomicWrite(filePath, value)))

    expect(values).toContain(await readFile(filePath, 'utf-8'))
    expect((await readdir(rootPath)).filter((entry) => entry.endsWith('.tmp'))).toEqual([])
  })

  it('cleans its temporary file when the atomic rename fails', async () => {
    const destinationPath = join(rootPath, 'destination')
    await mkdir(destinationPath)

    await expect(atomicWrite(destinationPath, 'content')).rejects.toThrow()
    expect((await readdir(rootPath)).filter((entry) => entry.endsWith('.tmp'))).toEqual([])
  })

  it('retries a locked rename on EPERM and EBUSY, then lands the write', async () => {
    const filePath = join(rootPath, 'locked.txt')
    vi.mocked(rename)
      .mockRejectedValueOnce(lockedError('EPERM'))
      .mockRejectedValueOnce(lockedError('EBUSY'))

    await atomicWrite(filePath, 'retried-content')

    expect(await readFile(filePath, 'utf-8')).toBe('retried-content')
    expect(vi.mocked(rename)).toHaveBeenCalledTimes(3)
    expect((await readdir(rootPath)).filter((entry) => entry.endsWith('.tmp'))).toEqual([])
  })

  it('gives up after a bounded number of attempts and removes the temp file', async () => {
    const filePath = join(rootPath, 'permanently-locked.txt')
    for (let attempt = 0; attempt < 5; attempt += 1) {
      vi.mocked(rename).mockRejectedValueOnce(lockedError('EACCES'))
    }

    await expect(atomicWrite(filePath, 'never-lands')).rejects.toMatchObject({ code: 'EACCES' })

    expect(vi.mocked(rename)).toHaveBeenCalledTimes(5)
    expect((await readdir(rootPath)).filter((entry) => entry.endsWith('.tmp'))).toEqual([])
  })

  it('writes durably through a synced temporary file and leaves no temp behind', async () => {
    const filePath = join(rootPath, 'durable.json')

    await atomicWriteDurable(filePath, '{"durable":true}')

    expect(await readFile(filePath, 'utf-8')).toBe('{"durable":true}')
    expect((await readdir(rootPath)).filter((entry) => entry.endsWith('.tmp'))).toEqual([])
  })

  it('distinguishes missing JSON from corrupt JSON', async () => {
    await expect(readJson(join(rootPath, 'missing.json'))).resolves.toBeNull()

    const corruptPath = join(rootPath, 'corrupt.json')
    await atomicWrite(corruptPath, '{')

    await expect(readJson(corruptPath)).rejects.toThrow(`Corrupt JSON file "${corruptPath}"`)
  })
})
