import { describe, expect, it } from 'vitest'
import {
  createMemoryDeviceKeyStore,
  loadOrCreateDeviceKeyMaterial,
  saveAssignedDeviceId,
  saveDeviceAuthVersion
} from '../../../../src/renderer/lib/remote/device-identity'

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
