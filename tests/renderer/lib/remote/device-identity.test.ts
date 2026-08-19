import { describe, expect, it } from 'vitest'
import {
  createMemoryDeviceKeyStore,
  loadOrCreateDeviceKeyMaterial,
  loadDeviceIdentity,
  rotateDeviceIdentity,
  saveAssignedDeviceId,
  saveDeviceAuthVersion
} from '../../../../src/renderer/lib/remote/device-identity'

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()

  get length(): number {
    return this.values.size
  }

  clear(): void {
    this.values.clear()
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

describe('desktop-scoped remote device assignments', () => {
  it('keeps each desktop-assigned id and auth version independent', async () => {
    const store = createMemoryDeviceKeyStore()
    await loadOrCreateDeviceKeyMaterial({ store })
    await saveAssignedDeviceId('legacy-device', store)
    await saveDeviceAuthVersion(3, store)

    const migrationCandidate = await loadOrCreateDeviceKeyMaterial({
      store,
      desktopId: 'desktop-a'
    })
    expect(migrationCandidate.deviceId).toBe('legacy-device')
    expect(migrationCandidate.authVersion).toBe(3)

    await saveAssignedDeviceId('device-a', store, 'desktop-a')
    await saveDeviceAuthVersion(4, store, 'desktop-a')
    await saveAssignedDeviceId('device-b', store, 'desktop-b')
    await saveDeviceAuthVersion(2, store, 'desktop-b')

    const desktopA = await loadOrCreateDeviceKeyMaterial({ store, desktopId: 'desktop-a' })
    const desktopB = await loadOrCreateDeviceKeyMaterial({ store, desktopId: 'desktop-b' })
    expect({ id: desktopA.deviceId, version: desktopA.authVersion }).toEqual({
      id: 'device-a',
      version: 4
    })
    expect({ id: desktopB.deviceId, version: desktopB.authVersion }).toEqual({
      id: 'device-b',
      version: 2
    })
  })
})

describe('browser device identity rotation', () => {
  it('changes the id while preserving the device name', async () => {
    const storage = new MemoryStorage()
    storage.setItem('deviceName', 'My phone')
    const original = await loadDeviceIdentity(storage)
    const rotated = await rotateDeviceIdentity(storage)

    expect(rotated.id).not.toBe(original.id)
    expect(rotated.name).toBe('My phone')
    expect((await loadDeviceIdentity(storage)).id).toBe(rotated.id)
  })
})
