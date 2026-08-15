import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isPairingExpired,
  loadOrCreatePeerSecret,
  readPairingExpiry,
  rotatePeerSecret,
  writePairingExpiry
} from '../../../src/main/remote/peer-secret'

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

describe('pairing bootstrap ceremony (A-04)', () => {
  it('stamps a five-minute expiry when the secret is created', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeinoven-peer-pairing-'))
    const before = Date.now()
    await loadOrCreatePeerSecret(dir)
    const expiresAt = await readPairingExpiry(dir)
    expect(expiresAt).not.toBeNull()
    if (expiresAt !== null) {
      expect(expiresAt).toBeGreaterThanOrEqual(before)
      // The expiry is stamped at write time, so it is the full TTL plus the
      // milliseconds that elapsed between the `before` capture and the write.
      expect(expiresAt - before).toBeLessThanOrEqual(5 * 60 * 1_000 + 5_000)
    }
  })

  it('a pairing value is not expired while fresh but is expired after five minutes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeinoven-peer-pairing-'))
    await loadOrCreatePeerSecret(dir)
    expect(await isPairingExpired(dir, Date.now())).toBe(false)
    expect(await isPairingExpired(dir, Date.now() + 5 * 60 * 1_000 + 1_000)).toBe(true)
  })

  it('rotatePeerSecret replaces the value and stamps a fresh expiry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeinoven-peer-pairing-'))
    const first = await loadOrCreatePeerSecret(dir)
    const rotated = await rotatePeerSecret(dir)
    expect(rotated).not.toBe(first)
    const expiresAt = await readPairingExpiry(dir)
    expect(expiresAt).not.toBeNull()
    if (expiresAt !== null) expect(expiresAt - Date.now()).toBeLessThanOrEqual(5 * 60 * 1_000)
    // The rotated value is the one now persisted.
    expect((await readFile(join(dir, 'peer-secret'), 'utf8')).trim()).toBe(rotated)
  })

  it('explicit expiry write is honored by isPairingExpired', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeinoven-peer-pairing-'))
    await loadOrCreatePeerSecret(dir)
    await writePairingExpiry(dir, Date.now() - 1_000)
    expect(await isPairingExpired(dir)).toBe(true)
  })
})
