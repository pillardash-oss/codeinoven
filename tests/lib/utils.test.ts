import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { atomicWrite, readJson, resolveWithinRoot } from '../../src/lib/utils'

describe.skipIf(process.platform === 'win32')('storage utilities', () => {
  let sandboxPath: string
  let rootPath: string

  beforeEach(async () => {
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

  it('distinguishes missing JSON from corrupt JSON', async () => {
    await expect(readJson(join(rootPath, 'missing.json'))).resolves.toBeNull()

    const corruptPath = join(rootPath, 'corrupt.json')
    await atomicWrite(corruptPath, '{')

    await expect(readJson(corruptPath)).rejects.toThrow(`Corrupt JSON file "${corruptPath}"`)
  })
})
