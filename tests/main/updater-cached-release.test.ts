import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cachedArtifactReady,
  toCachedUpdateInfo,
  toUpdateInfo
} from '../../src/main/notifications/updater-cached-release'
import type { SelectedUpdateArtifact } from '../../src/main/notifications/updater-download'

const tempDirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cio-cached-update-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function selection(overrides: Partial<SelectedUpdateArtifact> = {}): SelectedUpdateArtifact {
  return {
    fileName: 'codeinoven-0.5.69-nightly.15-arm64.zip',
    sha512: 'sha512-value',
    size: 4,
    isAdminRightsRequired: false,
    ...overrides
  }
}

describe('cached update record', () => {
  it('keeps the usable feed entry of a persisted release', () => {
    const cached = toCachedUpdateInfo({
      version: '0.5.69-nightly.15',
      files: [
        { url: 'codeinoven-0.5.69-nightly.15-arm64.zip', sha512: 'zip-hash', size: 225168832 },
        { url: 'codeinoven-0.5.69-nightly.15-arm64.dmg', sha512: 'dmg-hash', size: 232834267 }
      ],
      releaseName: 'CodeInOven 0.5.69 nightly',
      releaseDate: '2026-11-07T08:41:04.980Z'
    })

    expect(cached).not.toBeNull()
    expect(cached?.version).toBe('0.5.69-nightly.15')
    expect(cached?.files).toHaveLength(2)
    expect(cached?.path).toBe('codeinoven-0.5.69-nightly.15-arm64.zip')
    expect(cached?.sha512).toBe('zip-hash')
    expect(cached?.releaseDate).toBe('2026-11-07T08:41:04.980Z')
  })

  it('drops entries the installer could not verify', () => {
    const cached = toCachedUpdateInfo({
      version: '0.5.69-nightly.15',
      files: [
        { url: 'codeinoven-arm64.zip' },
        { sha512: 'hash-without-url' },
        { url: 'codeinoven-0.5.69-nightly.15-arm64.zip', sha512: 'zip-hash' }
      ]
    })

    expect(cached?.files).toEqual([
      { url: 'codeinoven-0.5.69-nightly.15-arm64.zip', sha512: 'zip-hash' }
    ])
  })

  it('rejects a record with no version or no verifiable file', () => {
    expect(toCachedUpdateInfo(null)).toBeNull()
    expect(toCachedUpdateInfo({ files: [{ url: 'a.zip', sha512: 'x' }] })).toBeNull()
    expect(toCachedUpdateInfo({ version: '1.0.0', files: [] })).toBeNull()
  })

  it('reconstructs the feed shape electron-updater expects', () => {
    const cached = toCachedUpdateInfo({
      version: '1.2.3',
      files: [{ url: 'a.zip', sha512: 'hash', size: 10 }]
    })
    expect(cached).not.toBeNull()
    if (cached === null) return
    const info = toUpdateInfo(cached)
    expect(info.version).toBe('1.2.3')
    expect(info.files[0]?.sha512).toBe('hash')
    expect(info.path).toBe('a.zip')
    expect(info.sha512).toBe('hash')
  })
})

describe('cached artifact completeness', () => {
  it('accepts a payload whose bytes match the feed size', async () => {
    const dir = await tempDir()
    await writeFile(path.join(dir, selection().fileName), 'zip!')
    await expect(cachedArtifactReady(selection(), dir)).resolves.toBe(true)
  })

  it('rejects a partial payload so it is never offered as an install', async () => {
    const dir = await tempDir()
    await writeFile(path.join(dir, selection().fileName), 'zi')
    await expect(cachedArtifactReady(selection(), dir)).resolves.toBe(false)
  })

  it('rejects a missing payload', async () => {
    const dir = await tempDir()
    await expect(cachedArtifactReady(selection(), dir)).resolves.toBe(false)
  })

  it('accepts an existing file when the feed published no size', async () => {
    const dir = await tempDir()
    await writeFile(path.join(dir, selection().fileName), 'any')
    await expect(cachedArtifactReady(selection({ size: 0 }), dir)).resolves.toBe(true)
  })
})
