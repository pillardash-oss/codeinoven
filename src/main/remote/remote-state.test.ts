import { describe, expect, it } from 'vitest'
import { readRemoteModeState, writeRemoteModeState, REMOTE_STATE_FILE } from './remote-state'

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
