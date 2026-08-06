import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadOrCreatePeerSecret } from './peer-secret'

describe('loadOrCreatePeerSecret', () => {
  it('generates a strong random secret when none exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeinoven-peer-secret-'))
    const secret = await loadOrCreatePeerSecret(dir)
    expect(secret.length).toBeGreaterThanOrEqual(32)
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('persists the generated secret so it is stable across restarts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeinoven-peer-secret-'))
    const first = await loadOrCreatePeerSecret(dir)
    const persisted = (await readFile(join(dir, 'peer-secret'), 'utf8')).trim()
    expect(persisted).toBe(first)
    expect(await loadOrCreatePeerSecret(dir)).toBe(first)
  })

  it('reuses an existing valid persisted secret', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeinoven-peer-secret-'))
    await writeFile(join(dir, 'peer-secret'), 'existing-secret-value-1234567890', 'utf8')
    expect(await loadOrCreatePeerSecret(dir)).toBe('existing-secret-value-1234567890')
  })

  it('regenerates a too-short persisted secret', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeinoven-peer-secret-'))
    await writeFile(join(dir, 'peer-secret'), 'short', 'utf8')
    const secret = await loadOrCreatePeerSecret(dir)
    expect(secret).not.toBe('short')
    expect(secret.length).toBeGreaterThanOrEqual(32)
  })
})
