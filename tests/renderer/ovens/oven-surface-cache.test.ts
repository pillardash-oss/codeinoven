import { describe, expect, it } from 'vitest'
import { APP_SLUG } from '../../../src/lib/brand'
import {
  ovenSurfaceCacheKey,
  readOvenSurface,
  removeOvenSurface,
  writeOvenSurface,
  type OvenSurfaceCacheStorage
} from '../../../src/renderer/lib/oven-surface-cache'

const ENTRY_PREFIX = `${APP_SLUG}.ovenSurfaceCache.v1.entry.`

/** An in-memory storage that also records how many keys it still holds. */
function memoryStorage(): OvenSurfaceCacheStorage & { size(): number } {
  const entries = new Map<string, string>()
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, value),
    removeItem: (key) => void entries.delete(key),
    size: () => entries.size
  }
}

describe('Oven surface cache', () => {
  it('reads back the payload written for one surface', () => {
    const storage = memoryStorage()
    const key = ovenSurfaceCacheKey('files', 'oven-1', 'thread-1')
    writeOvenSurface(key, ['README.md', 'src'], storage)
    expect(readOvenSurface<string[]>(key, storage)).toEqual(['README.md', 'src'])
  })

  it('keeps each Oven and thread separate', () => {
    const storage = memoryStorage()
    const files = ovenSurfaceCacheKey('files', 'oven-1', 'thread-1')
    const git = ovenSurfaceCacheKey('git', 'oven-1', 'thread-1')
    const otherThread = ovenSurfaceCacheKey('files', 'oven-1', 'thread-2')
    writeOvenSurface(files, 'files-payload', storage)
    writeOvenSurface(git, 'git-payload', storage)
    writeOvenSurface(otherThread, 'other-payload', storage)
    expect(readOvenSurface(files, storage)).toBe('files-payload')
    expect(readOvenSurface(git, storage)).toBe('git-payload')
    expect(readOvenSurface(otherThread, storage)).toBe('other-payload')
  })

  it('reports no cache for a surface that was never read', () => {
    expect(readOvenSurface(ovenSurfaceCacheKey('git', 'oven-1', 'thread-1'), memoryStorage())).toBe(
      null
    )
  })

  it('treats a corrupt entry as no cache instead of throwing', () => {
    const storage = memoryStorage()
    const key = ovenSurfaceCacheKey('files', 'oven-1', 'thread-1')
    storage.setItem(`${ENTRY_PREFIX}${key}`, '{not json')
    expect(readOvenSurface(key, storage)).toBeNull()
  })

  it('refuses a payload too large to be worth keeping', () => {
    const storage = memoryStorage()
    const key = ovenSurfaceCacheKey('files', 'oven-1', 'thread-1')
    writeOvenSurface(key, 'x'.repeat(300_000), storage)
    expect(readOvenSurface(key, storage)).toBeNull()
  })

  it('stays bounded, dropping the oldest surfaces first', () => {
    const storage = memoryStorage()
    const keys = Array.from({ length: 30 }, (_, index) =>
      ovenSurfaceCacheKey('files', 'oven-1', `thread-${String(index)}`)
    )
    for (const key of keys) writeOvenSurface(key, 'payload', storage)
    expect(readOvenSurface(keys[0], storage)).toBeNull()
    expect(readOvenSurface(keys.at(-1) ?? '', storage)).toBe('payload')
    // One entry per surface plus the index.
    expect(storage.size()).toBeLessThanOrEqual(25)
  })

  it('forgets a single surface without touching its siblings', () => {
    const storage = memoryStorage()
    const kept = ovenSurfaceCacheKey('git', 'oven-1', 'thread-1')
    const dropped = ovenSurfaceCacheKey('files', 'oven-1', 'thread-1')
    writeOvenSurface(kept, 'kept', storage)
    writeOvenSurface(dropped, 'dropped', storage)
    removeOvenSurface(dropped, storage)
    expect(readOvenSurface(dropped, storage)).toBeNull()
    expect(readOvenSurface(kept, storage)).toBe('kept')
  })

  it('never throws when storage itself is unavailable', () => {
    const broken: OvenSurfaceCacheStorage = {
      getItem: () => {
        throw new Error('storage disabled')
      },
      setItem: () => {
        throw new Error('storage disabled')
      },
      removeItem: () => {
        throw new Error('storage disabled')
      }
    }
    const key = ovenSurfaceCacheKey('git', 'oven-1', 'thread-1')
    expect(() => writeOvenSurface(key, { branch: 'dev' }, broken)).not.toThrow()
    expect(readOvenSurface(key, broken)).toBeNull()
    expect(() => removeOvenSurface(key, broken)).not.toThrow()
  })
})
