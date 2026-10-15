import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileHandle } from 'fs/promises'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { atomicWrite, atomicWriteDurable, readJson, resolveWithinRoot } from '../../src/lib/utils'

/**
 * Shared probe so a test can assert the order of filesystem effects (a flush
 * before the rename) and force a flush to fail, without a real crash.
 */
const fsProbe = vi.hoisted(() => ({
  events: [] as string[],
  failTempSync: false,
  reset() {
    this.events.length = 0
    this.failTempSync = false
  }
}))

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises')
  const actualOpen = actual.open as unknown as (...args: unknown[]) => Promise<FileHandle>
  return {
    ...actual,
    rename: vi.fn(async (from: string, to: string) => {
      fsProbe.events.push('rename')
      return actual.rename(from, to)
    }),
    open: vi.fn(async (...args: unknown[]) => {
      const handle = await actualOpen(...args)
      const target = args[0]
      const isTemp = typeof target === 'string' && target.endsWith('.tmp')
      fsProbe.events.push(isTemp ? 'open:temp' : 'open:dir')
      if (!isTemp) return handle
      return {
        writeFile: async (data: string | Uint8Array, options?: unknown) => {
          fsProbe.events.push('writeFile')
          return handle.writeFile(data, options as never)
        },
        sync: async () => {
          fsProbe.events.push('sync')
          if (fsProbe.failTempSync) throw new Error('simulated fsync failure')
          return handle.sync()
        },
        close: () => handle.close()
      } as unknown as FileHandle
    })
  }
})

function lockedError(code: 'EPERM' | 'EBUSY' | 'EACCES'): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: operation not permitted, rename`), { code })
}

describe('storage utilities', () => {
  let sandboxPath: string
  let rootPath: string

  beforeEach(async () => {
    vi.mocked(rename).mockClear()
    fsProbe.reset()
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

  it('retries a locked rename on EACCES, then lands the write', async () => {
    const filePath = join(rootPath, 'locked-eacces.txt')
    vi.mocked(rename).mockRejectedValueOnce(lockedError('EACCES'))

    await atomicWrite(filePath, 'eacces-content')

    expect(await readFile(filePath, 'utf-8')).toBe('eacces-content')
    expect(vi.mocked(rename)).toHaveBeenCalledTimes(2)
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

  it('flushes the temporary file before renaming it into place', async () => {
    const filePath = join(rootPath, 'durable-order.json')

    await atomicWriteDurable(filePath, '{"ordered":true}')

    const tempSyncIndex = fsProbe.events.indexOf('sync')
    const renameIndex = fsProbe.events.indexOf('rename')
    expect(tempSyncIndex).toBeGreaterThan(-1)
    expect(renameIndex).toBeGreaterThan(-1)
    expect(tempSyncIndex).toBeLessThan(renameIndex)
    expect(fsProbe.events.indexOf('open:temp')).toBeLessThan(tempSyncIndex)
  })

  it('performs no fsync on the default atomic write path', async () => {
    const filePath = join(rootPath, 'cheap.txt')

    await atomicWrite(filePath, 'cheap-content')

    expect(await readFile(filePath, 'utf-8')).toBe('cheap-content')
    expect(fsProbe.events).not.toContain('sync')
    expect(fsProbe.events).not.toContain('open:temp')
  })

  it('removes the temporary file when the durable flush fails', async () => {
    const filePath = join(rootPath, 'durable-failure.json')
    fsProbe.failTempSync = true

    await expect(atomicWriteDurable(filePath, '{"never":true}')).rejects.toThrow(
      'simulated fsync failure'
    )

    expect(fsProbe.events).toContain('sync')
    expect(fsProbe.events).not.toContain('rename')
    expect((await readdir(rootPath)).filter((entry) => entry.endsWith('.tmp'))).toEqual([])
    await expect(readFile(filePath, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('distinguishes missing JSON from corrupt JSON', async () => {
    await expect(readJson(join(rootPath, 'missing.json'))).resolves.toBeNull()

    const corruptPath = join(rootPath, 'corrupt.json')
    await atomicWrite(corruptPath, '{')

    await expect(readJson(corruptPath)).rejects.toThrow(`Corrupt JSON file "${corruptPath}"`)
  })

  describe.skipIf(process.platform === 'win32')('platform-specific path resolution', () => {
    it('rejects symlinks outside the storage root', async () => {
      const outsidePath = join(sandboxPath, 'outside')
      await mkdir(outsidePath)
      await symlink(outsidePath, join(rootPath, 'outside-link'))

      expect(() => resolveWithinRoot(rootPath, 'outside-link/value.json')).toThrow(
        /symlink outside/
      )
    })

    it('allows symlinks that remain within the storage root', async () => {
      await symlink(join(rootPath, 'nested'), join(rootPath, 'inside-link'))

      expect(resolveWithinRoot(rootPath, 'inside-link/value.json')).toBe(
        join(rootPath, 'inside-link', 'value.json')
      )
    })
  })
})
