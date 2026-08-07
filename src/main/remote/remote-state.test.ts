import { describe, expect, it } from 'vitest'
import {
  readRemoteDeviceNames,
  readRemoteModeState,
  writeRemoteDeviceName,
  writeRemoteModeState,
  REMOTE_DEVICES_FILE,
  REMOTE_STATE_FILE
} from './remote-state'

class FakeStorage {
  private data = new Map<string, unknown>()
  async write(relativePath: string, value: unknown): Promise<void> {
    this.data.set(relativePath, value)
  }
  async read<T>(relativePath: string): Promise<T | null> {
    return (this.data.get(relativePath) as T) ?? null
  }
}

describe('remote-mode state persistence', () => {
  it('returns false when no state has been written', async () => {
    const storage = new FakeStorage()
    expect(await readRemoteModeState(storage)).toBe(false)
  })

  it('round-trips enabled=true', async () => {
    const storage = new FakeStorage()
    await writeRemoteModeState(storage, true)
    expect(await readRemoteModeState(storage)).toBe(true)
  })

  it('round-trips enabled=false', async () => {
    const storage = new FakeStorage()
    await writeRemoteModeState(storage, true)
    await writeRemoteModeState(storage, false)
    expect(await readRemoteModeState(storage)).toBe(false)
  })

  it('writes under remote/state.json', async () => {
    const storage = new FakeStorage()
    await writeRemoteModeState(storage, true)
    const raw = await storage.read<{ enabled: boolean }>(REMOTE_STATE_FILE)
    expect(raw?.enabled).toBe(true)
  })

  it('treats malformed persisted state as disabled', async () => {
    const storage = new FakeStorage()
    await storage.write(REMOTE_STATE_FILE, { enabled: 'yes' })
    expect(await readRemoteModeState(storage)).toBe(false)
  })
})

describe('remote device-name persistence', () => {
  it('returns an empty map when no names have been written', async () => {
    const storage = new FakeStorage()
    expect(await readRemoteDeviceNames(storage)).toEqual({})
  })

  it('round-trips a single device name', async () => {
    const storage = new FakeStorage()
    await writeRemoteDeviceName(storage, 'phone-1', 'iPhone')
    expect(await readRemoteDeviceNames(storage)).toEqual({ 'phone-1': 'iPhone' })
  })

  it('preserves other devices when one is renamed', async () => {
    const storage = new FakeStorage()
    await writeRemoteDeviceName(storage, 'phone-1', 'iPhone')
    await writeRemoteDeviceName(storage, 'phone-2', 'Android phone')
    expect(await readRemoteDeviceNames(storage)).toEqual({
      'phone-1': 'iPhone',
      'phone-2': 'Android phone'
    })
  })

  it('deletes the override when an empty name is written', async () => {
    const storage = new FakeStorage()
    await writeRemoteDeviceName(storage, 'phone-1', 'iPhone')
    await writeRemoteDeviceName(storage, 'phone-1', '')
    expect(await readRemoteDeviceNames(storage)).toEqual({})
  })

  it('trims and caps device names', async () => {
    const storage = new FakeStorage()
    await writeRemoteDeviceName(storage, 'phone-1', '  My long device name  ')
    const names = await readRemoteDeviceNames(storage)
    expect(names['phone-1']).toBe('My long device name')
  })

  it('writes under remote/devices.json', async () => {
    const storage = new FakeStorage()
    await writeRemoteDeviceName(storage, 'phone-1', 'iPhone')
    const raw = await storage.read<Record<string, string>>(REMOTE_DEVICES_FILE)
    expect(raw?.['phone-1']).toBe('iPhone')
  })

  it('ignores malformed persisted names', async () => {
    const storage = new FakeStorage()
    await storage.write(REMOTE_DEVICES_FILE, ['not-an-object'])
    expect(await readRemoteDeviceNames(storage)).toEqual({})
  })
})
