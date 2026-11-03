import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LocalAiRuntimeRegistry,
  localAiServerKey,
  type LocalAiProcessLauncher,
  type LocalAiServerProcess,
  type LocalAiServerRequest
} from '../../../src/main/local-ai/local-ai-runtime-registry'

/** One fake server process: counts its termination and settles when killed. */
class FakeProcess implements LocalAiServerProcess {
  terminated = 0
  private settleExit: () => void = () => undefined
  readonly exited: Promise<void>

  constructor(
    readonly pid: number,
    readonly port: number
  ) {
    this.exited = new Promise<void>((resolve) => {
      this.settleExit = resolve
    })
  }

  terminate(): void {
    this.terminated += 1
    this.settleExit()
  }
}

/** A launcher that hands out predictable ports and records every launch. */
class FakeLauncher implements LocalAiProcessLauncher {
  readonly requests: LocalAiServerRequest[] = []
  readonly processes: FakeProcess[] = []
  private nextPort = 41_000

  async launch(request: LocalAiServerRequest): Promise<LocalAiServerProcess> {
    this.requests.push(request)
    // Resolving on a later tick is what a real launch does, and it is what lets
    // two concurrent callers observe the same in-flight launch.
    await Promise.resolve()
    const process = new FakeProcess(1_000 + this.processes.length, this.nextPort++)
    this.processes.push(process)
    return process
  }
}

function request(overrides: Partial<LocalAiServerRequest> = {}): LocalAiServerRequest {
  return {
    runtime: 'llama.cpp',
    modelFile: '/models/embeddinggemma.gguf',
    port: 0,
    executable: '/usr/local/bin/llama-server',
    args: ['--model', '/models/embeddinggemma.gguf'],
    cwd: '/tmp',
    label: 'test',
    interactive: false,
    ...overrides
  }
}

interface Recorded {
  registered: number[]
  unregistered: number[]
  prepared: number
}

function harness(): {
  launcher: FakeLauncher
  registry: LocalAiRuntimeRegistry
  recorded: Recorded
} {
  const launcher = new FakeLauncher()
  const recorded: Recorded = { registered: [], unregistered: [], prepared: 0 }
  const registry = new LocalAiRuntimeRegistry(launcher, {
    registerProcess: (pid) => recorded.registered.push(pid),
    unregisterProcess: (pid) => recorded.unregistered.push(pid),
    prepare: async () => {
      recorded.prepared += 1
    }
  })
  return { launcher, registry, recorded }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('LocalAiRuntimeRegistry', () => {
  it('keys a server by runtime, model file, and port', () => {
    const base = { runtime: 'llama.cpp' as const, modelFile: '/models/a.gguf', port: 0 }
    expect(localAiServerKey(base)).toBe(localAiServerKey({ ...base }))
    expect(localAiServerKey(base)).not.toBe(localAiServerKey({ ...base, port: 8080 }))
    expect(localAiServerKey(base)).not.toBe(localAiServerKey({ ...base, modelFile: '/b.gguf' }))
    expect(localAiServerKey(base)).not.toBe(localAiServerKey({ ...base, runtime: 'mlx' }))
  })

  it('returns the resident server for a key instead of launching a second one', async () => {
    const { launcher, registry } = harness()
    const first = await registry.ensureServer(request({ interactive: true }))
    const second = await registry.ensureServer(request({ interactive: true }))

    expect(launcher.requests).toHaveLength(1)
    expect(second).toEqual(first)
    expect(second.port).toBe(first.port)
  })

  it('spawns once when two callers ask for the same key at the same time', async () => {
    const { launcher, registry } = harness()
    const [first, second] = await Promise.all([
      registry.ensureServer(request({ interactive: true })),
      registry.ensureServer(request({ interactive: true }))
    ])

    expect(launcher.requests).toHaveLength(1)
    expect(second.key).toBe(first.key)
    expect(second.generation).toBe(first.generation)
  })

  it('does not let a background reuse extend the idle window', async () => {
    const { launcher, registry } = harness()
    await registry.ensureServer(request({ interactive: true }))

    // A sweep embeds 20 minutes in, which is inside the 30 minute window. If that
    // pass re-armed the timer the server would live until the 50 minute mark.
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    await registry.ensureServer(request({ interactive: false }))
    await vi.advanceTimersByTimeAsync(10 * 60_000)

    expect(launcher.requests).toHaveLength(1)
    expect(launcher.processes[0]?.terminated).toBe(1)
  })

  it('restarts the idle window for an interactive reuse', async () => {
    const { launcher, registry } = harness()
    const handle = await registry.ensureServer(request({ interactive: true }))

    // The second use lands 20 minutes in, so the window now ends at 50 minutes.
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    await registry.ensureServer(request({ interactive: true }))
    await vi.advanceTimersByTimeAsync(20 * 60_000)

    expect(launcher.processes[0]?.terminated).toBe(0)
    expect(registry.isAlive(handle)).toBe(true)
  })

  it('holds the model for the session when the window is "keep"', async () => {
    const { launcher, registry } = harness()
    registry.setUnloadOption('keep')
    await registry.ensureServer(request({ interactive: false }))

    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)

    expect(launcher.processes[0]?.terminated).toBe(0)
  })

  it('applies a shorter window chosen while a server is resident', async () => {
    const { launcher, registry } = harness()
    await registry.ensureServer(request({ interactive: true }))
    registry.setUnloadOption('5m')

    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(launcher.processes[0]?.terminated).toBe(1)
  })

  it('launches a fresh server after the idle window released the previous one', async () => {
    const { launcher, registry } = harness()
    const first = await registry.ensureServer(request({ interactive: true }))
    await vi.advanceTimersByTimeAsync(30 * 60_000)

    const second = await registry.ensureServer(request({ interactive: true }))

    expect(launcher.requests).toHaveLength(2)
    expect(second.generation).toBeGreaterThan(first.generation)
    expect(second.port).not.toBe(first.port)
    expect(registry.isAlive(first)).toBe(false)
    expect(registry.isAlive(second)).toBe(true)
  })

  it('journals every process it spawns and drops it once it exits', async () => {
    const { launcher, registry, recorded } = harness()
    const handle = await registry.ensureServer(request({ interactive: true }))

    expect(recorded.registered).toEqual([launcher.processes[0]?.pid])
    expect(recorded.prepared).toBe(1)

    await registry.release(handle)
    expect(launcher.processes[0]?.terminated).toBe(1)
    expect(recorded.unregistered).toEqual([launcher.processes[0]?.pid])
    expect(registry.isAlive(handle)).toBe(false)
  })

  it('reports a server it stopped as gone, so the next request boots a new one', async () => {
    const { launcher, registry } = harness()
    const handle = await registry.ensureServer(request({ interactive: true }))
    await registry.release(handle)

    expect(registry.isAlive(handle)).toBe(false)
    const next = await registry.ensureServer(request({ interactive: true }))
    expect(launcher.requests).toHaveLength(2)
    expect(next.generation).not.toBe(handle.generation)
  })

  it('stops every server on dispose and refuses to spawn afterwards', async () => {
    const { launcher, registry } = harness()
    await registry.ensureServer(request({ interactive: true }))
    await registry.ensureServer(
      request({ interactive: true, modelFile: '/models/cleanup.gguf', label: 'cleanup' })
    )

    await registry.dispose()

    expect(launcher.processes.map((process) => process.terminated)).toEqual([1, 1])
    await expect(registry.ensureServer(request({ interactive: true }))).rejects.toThrow(/disposed/u)
  })
})
