import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdmissionDecision } from '../../src/lib/resource-admission'

const invoke = vi.fn()
const queuedMessageFor = vi.fn()

vi.mock('$lib/ipc.svelte', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))
vi.mock('$lib/stores/renderer-recovery.svelte', () => ({
  rendererRecovery: { queuedMessageFor: (...args: unknown[]) => queuedMessageFor(...args) }
}))

type Store = typeof import('../../src/renderer/lib/stores/queued-resource-wait.svelte')

function decision(action: AdmissionDecision['action'], cpu = 1, memory = 200): AdmissionDecision {
  return {
    action,
    reason:
      action === 'queue' ? 'cpu-and-memory-short' : action === 'offload' ? 'cpu-short' : 'enough',
    cpuAvailablePercent: cpu,
    memoryAvailableBytes: memory,
    memoryFloorBytes: 500,
    totalMemoryBytes: 32 * 1024 ** 3,
    sampledAt: 1
  }
}

async function loadStore(): Promise<Store> {
  vi.resetModules()
  return import('../../src/renderer/lib/stores/queued-resource-wait.svelte')
}

/** Let the store's own ticker run without waiting five real seconds. */
async function tick(): Promise<void> {
  await vi.advanceTimersByTimeAsync(5_000)
}

describe('queuedResourceWait', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    invoke.mockReset()
    queuedMessageFor.mockReset()
    queuedMessageFor.mockReturnValue({ id: 'queued' })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('holds a message on the device and remembers the reading', async () => {
    const { queuedResourceWait } = await loadStore()
    queuedResourceWait.hold('p', 't', decision('queue'))
    expect(queuedResourceWait.holds('p', 't')).toBe(true)
    expect(queuedResourceWait.for('p', 't')?.action).toBe('queue')
    expect(queuedResourceWait.for('p', 'other')).toBeNull()
  })

  it('keeps holding while the device is still short, and refreshes the numbers', async () => {
    const { queuedResourceWait } = await loadStore()
    queuedResourceWait.hold('p', 't', decision('queue'))
    invoke.mockResolvedValue(decision('queue', 2, 300))
    await tick()
    expect(queuedResourceWait.holds('p', 't')).toBe(true)
    expect(queuedResourceWait.for('p', 't')?.cpuAvailablePercent).toBe(2)
    expect(invoke).toHaveBeenCalledWith('system:resourceAdmission')
  })

  it('releases and runs the path that queued the message once the device clears', async () => {
    const { queuedResourceWait } = await loadStore()
    const retry = vi.fn()
    queuedResourceWait.hold('p', 't', decision('queue'), retry)
    invoke.mockResolvedValue(decision('proceed', 40, 8_000))
    await tick()
    expect(queuedResourceWait.holds('p', 't')).toBe(false)
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('drops a wait whose message is gone instead of retrying it', async () => {
    const { queuedResourceWait } = await loadStore()
    const retry = vi.fn()
    queuedResourceWait.hold('p', 't', decision('queue'), retry)
    queuedMessageFor.mockReturnValue(null)
    invoke.mockResolvedValue(decision('proceed', 40, 8_000))
    await tick()
    expect(queuedResourceWait.holds('p', 't')).toBe(false)
    expect(retry).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('stops asking once nothing is held', async () => {
    const { queuedResourceWait } = await loadStore()
    queuedResourceWait.hold('p', 't', decision('queue'))
    invoke.mockResolvedValue(decision('proceed', 40, 8_000))
    await tick()
    invoke.mockClear()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('keeps holding when the reading cannot be taken', async () => {
    const { queuedResourceWait } = await loadStore()
    queuedResourceWait.hold('p', 't', decision('queue'))
    invoke.mockRejectedValue(new Error('no main process'))
    await tick()
    expect(queuedResourceWait.holds('p', 't')).toBe(true)
  })

  it('clears one thread without touching another', async () => {
    const { queuedResourceWait } = await loadStore()
    queuedResourceWait.hold('p', 'a', decision('queue'))
    queuedResourceWait.hold('p', 'b', decision('queue'))
    queuedResourceWait.clear('p', 'a')
    expect(queuedResourceWait.holds('p', 'a')).toBe(false)
    expect(queuedResourceWait.holds('p', 'b')).toBe(true)
  })

  it('fails open when the device cannot be read at all', async () => {
    const { readDeviceHold } = await loadStore()
    invoke.mockRejectedValue(new Error('ipc down'))
    await expect(readDeviceHold()).resolves.toBeNull()
  })

  it('reports the hold only for a queue decision', async () => {
    const { readDeviceHold } = await loadStore()
    invoke.mockResolvedValue(decision('offload'))
    await expect(readDeviceHold()).resolves.toBeNull()
    invoke.mockResolvedValue(decision('queue'))
    await expect(readDeviceHold()).resolves.toMatchObject({ action: 'queue' })
  })
})
