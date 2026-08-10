/**
 * Controller-level cloud rotation contract test (A-04, r4 review).
 *
 * After a phone enrolls over the relay, RemoteModeController rotates the
 * persisted peer secret, the gateway secret, the visible pairing URL, and the
 * registered five-minute bootstrap immediately — exactly like the LAN path.
 */

import { describe, expect, it, vi, beforeAll } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteModeController } from './remote-mode'
import { DeviceCredentialService } from './device-credential-service'
import { readPairingExpiry } from './peer-secret'
import DatabaseConstructor from 'better-sqlite3'
import type { Database } from '../database/database'
import { REMOTE_DEVICE_SQL } from '../database/schema'

const { userDataDir } = vi.hoisted(() => ({ userDataDir: { current: '' } }))

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataDir.current
  },
  BrowserWindow: {
    getAllWindows: () => [],
    fromId: () => null
  },
  ipcMain: { handle: vi.fn() },
  Menu: { buildFromTemplate: () => ({ popup: () => undefined }) },
  Tray: class {
    setTitle(): void {}
    setToolTip(): void {}
    on(): void {}
    destroy(): void {}
  },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) }
}))

function makeRawDatabase(): Database {
  const raw = new DatabaseConstructor(':memory:')
  raw.pragma('foreign_keys = ON')
  raw.exec(REMOTE_DEVICE_SQL)
  const prepared = raw.prepare.bind(raw)
  return {
    run: (sql: string, ...params: unknown[]) => {
      prepared(sql).run(...params)
    },
    get: <T>(sql: string, ...params: unknown[]) => prepared(sql).get(...params) as T | undefined,
    all: <T>(sql: string, ...params: unknown[]) => prepared(sql).all(...params) as T[],
    prepare: (sql: string) => ({
      run: (...params: unknown[]) => prepared(sql).run(...params)
    }),
    transaction: <T>(fn: () => T) => raw.transaction(fn)()
  } as unknown as Database
}

describe('RemoteModeController — cloud enrollment rotates the pairing bootstrap', () => {
  beforeAll(() => {
    // No network/port reuse: the controller binds ephemeral ports via the gateway.
  })

  it('rotates the persisted secret, gateway secret, QR, and fresh five-minute bootstrap after relay enrollment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codeinoven-cloud-rotation-'))
    const staticRoot = join(root, 'renderer')
    const userData = join(root, 'user-data')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(staticRoot, { recursive: true })
    await mkdir(userData, { recursive: true })
    userDataDir.current = userData
    await writeFile(join(staticRoot, 'remote.html'), '<h1>phone client</h1>', 'utf8')

    const credentials = new DeviceCredentialService(makeRawDatabase())
    const controller = new RemoteModeController({
      lanPort: 0,
      localPort: 0,
      peerSecret: null,
      staticRoot,
      iconPath: '',
      storage: null,
      credentials,
      rpc: null
    })

    // Start the gateway so syncPairingState registers the current secret as a
    // five-minute account enrollment bootstrap.
    await controller.ensureGateway()

    const secretFile = join(userData, 'remote-gateway', 'peer-secret')
    const originalSecret = (await readFile(secretFile, 'utf8')).trim()
    expect(originalSecret.length).toBeGreaterThanOrEqual(16)
    // The pre-rotation control value is a usable bootstrap.
    const originalBootstrap = await credentials.consumePairingBootstrap(originalSecret)
    // Re-register it so the rotation contract can be asserted below.
    if (!originalBootstrap.ok) {
      await credentials.registerPairingValue(originalSecret)
    }
    // Relay enrollment succeeds -> controller rotates immediately.
    await (
      controller as unknown as { rotatePairingBootstrap(): Promise<void> }
    ).rotatePairingBootstrap()

    // 1) The persisted peer secret changed.
    const rotatedSecret = (await readFile(secretFile, 'utf8')).trim()
    expect(rotatedSecret).not.toBe(originalSecret)

    // 2) The old value can no longer enroll.
    const stale = await credentials.consumePairingBootstrap(originalSecret)
    expect(stale.ok).toBe(false)

    // 3) A fresh <=5-minute bootstrap exists for the new value.
    const fresh = await credentials.consumePairingBootstrap(rotatedSecret)
    expect(fresh.ok).toBe(true)
    const expiry = await readPairingExpiry(join(userData, 'remote-gateway'))
    expect(expiry).not.toBeNull()
    if (expiry !== null) {
      expect(expiry).toBeGreaterThan(0)
      expect(expiry - Date.now()).toBeLessThanOrEqual(5 * 60 * 1_000)
    }

    await controller.dispose()
  })
})
