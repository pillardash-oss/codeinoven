import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AdmissionDecision,
  ResourceWaitTarget,
  ThreadResourceGateAnswer
} from '../../src/lib/resource-admission'

const invoke = vi.fn()
const queuedMessageFor = vi.fn()

vi.mock('$lib/ipc.svelte', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))
vi.mock('$lib/stores/renderer-recovery.svelte', () => ({
  rendererRecovery: { queuedMessageFor: (...args: unknown[]) => queuedMessageFor(...args) }
}))

type Store = typeof import('../../src/renderer/lib/stores/queued-resource-wait.svelte')

const device: ResourceWaitTarget = { kind: 'device' }

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

/** One thread-gate answer: whose machine, and the reading that holds it. */
function gate(
  wait: AdmissionDecision | null,
  target: ResourceWaitTarget = device
): ThreadResourceGateAnswer {
  return { wait, target }
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

  it('holds a message on a machine and remembers the reading and whose machine', async () => {
    const { queuedResourceWait } = await loadStore()
    queuedResourceWait.hold('p', 't', decision('queue'), device)
    expect(queuedResourceWait.holds('p', 't')).toBe(true)
    expect(queuedResourceWait.for('p', 't')?.decision.action).toBe('queue')
    expect(queuedResourceWait.for('p', 't')?.target.kind).toBe('device')
    expect(queuedResourceWait.for('p', 'other')).toBeNull()
  })

  it('keeps holding while the machine is still short, and refreshes the numbers', async () => {
    const { queuedResourceWait } = await loadStore()
    queuedResourceWait.hold('p', 't', decision('queue'), device)
    invoke.mockResolvedValue(gate(decision('queue', 2, 300)))
    await tick()
    expect(queuedResourceWait.holds('p', 't')).toBe(true)
    expect(queuedResourceWait.for('p', 't')?.decision.cpuAvailablePercent).toBe(2)
    expect(invoke).toHaveBeenCalledWith('system:threadResourceGate', 'p', 't')
  })

  it('releases and runs the path that queued the message once the machine clears', async () => {
    const { queuedResourceWait } = await loadStore()
    const retry = vi.fn()
    queuedResourceWait.hold('p', 't', decision('queue'), device, retry)
    invoke.mockResolvedValue(gate(null))
    await tick()
    expect(queuedResourceWait.holds('p', 't')).toBe(false)
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('releases one thread while another stays held', async () => {
    const { queuedResourceWait } = await loadStore()
    const retryA = vi.fn()
    queuedResourceWait.hold('p', 'a', decision('queue'), device, retryA)
    queuedResourceWait.hold('p', 'b', decision('queue'), device)
    invoke.mockImplementation(async (_channel: string, projectId: string, threadId: string) =>
      threadId === 'a' ? gate(null) : gate(decision('queue'))
    )
    await tick()
    expect(queuedResourceWait.holds('p', 'a')).toBe(false)
    expect(queuedResourceWait.holds('p', 'b')).toBe(true)
    expect(retryA).toHaveBeenCalledTimes(1)
  })

  it('drops a wait whose message is gone instead of retrying it', async () => {
    const { queuedResourceWait } = await loadStore()
    const retry = vi.fn()
    queuedResourceWait.hold('p', 't', decision('queue'), device, retry)
    queuedMessageFor.mockReturnValue(null)
    invoke.mockResolvedValue(gate(null))
    await tick()
    expect(queuedResourceWait.holds('p', 't')).toBe(false)
    expect(retry).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('stops asking once nothing is held', async () => {
    const { queuedResourceWait } = await loadStore()
    queuedResourceWait.hold('p', 't', decision('queue'), device)
    invoke.mockResolvedValue(gate(null))
    await tick()
    invoke.mockClear()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('fails open and delivers when the gate cannot be read', async () => {
    // An unreadable sampler must never stop the user's work: the delivery
    // paths fail open on a gate error, so the ticker releases the wait and
    // hands the message back rather than holding it on a number it cannot see.
    const { queuedResourceWait } = await loadStore()
    const retry = vi.fn()
    queuedResourceWait.hold('p', 't', decision('queue'), device, retry)
    invoke.mockRejectedValue(new Error('ipc down'))
    await tick()
    expect(queuedResourceWait.holds('p', 't')).toBe(false)
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('clears one thread without touching another', async () => {
    const { queuedResourceWait } = await loadStore()
    queuedResourceWait.hold('p', 'a', decision('queue'), device)
    queuedResourceWait.hold('p', 'b', decision('queue'), device)
    queuedResourceWait.clear('p', 'a')
    expect(queuedResourceWait.holds('p', 'a')).toBe(false)
    expect(queuedResourceWait.holds('p', 'b')).toBe(true)
  })

  it('fails open when the gate cannot be read at all', async () => {
    const { readThreadHold } = await loadStore()
    invoke.mockRejectedValue(new Error('ipc down'))
    await expect(readThreadHold('p', 't')).resolves.toBeNull()
  })

  it('answers null for an idle machine, so a send is never parked by a healthy gate', async () => {
    // The gate answers for every thread. Returning that answer as-is made every
    // send read as held: the message parked, the wait released it, the retry
    // parked it again. Null is the only "may send now" answer.
    const { readThreadHold } = await loadStore()
    invoke.mockResolvedValue(gate(null))
    await expect(readThreadHold('p', 't')).resolves.toBeNull()
  })

  it('answers the reading and whose machine from the thread gate', async () => {
    const { readThreadHold } = await loadStore()
    invoke.mockResolvedValue(gate(decision('queue'), { kind: 'oven', ovenId: 'o1', name: 'Az' }))
    const answer = await readThreadHold('p', 't')
    expect(answer?.wait?.action).toBe('queue')
    expect(answer?.target).toEqual({ kind: 'oven', ovenId: 'o1', name: 'Az' })
  })
})
