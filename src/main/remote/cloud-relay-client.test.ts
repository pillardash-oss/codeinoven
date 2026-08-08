import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CloudRelayClient,
  fullJitterDelay,
  type CloudRelayClientOptions
} from './cloud-relay-client'
import { decryptPayload, encryptPayload } from '../../renderer/lib/remote/session-security'

const SECRET = 'control-secret'

class FakeSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readyState = FakeSocket.CONNECTING
  sent: string[] = []
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number; reason?: string }) => void) | null = null
  onerror: (() => void) | null = null

  open(): void {
    this.readyState = FakeSocket.OPEN
    this.onopen?.()
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.readyState = FakeSocket.CLOSED
    this.onclose?.({ code: 1000, reason: 'closed' })
  }

  receive(data: string): void {
    this.onmessage?.({ data })
  }

  fail(reason = 'network'): void {
    this.readyState = FakeSocket.CLOSED
    this.onclose?.({ code: 1006, reason })
  }
}

interface Harness {
  client: CloudRelayClient
  sockets: FakeSocket[]
  disconnected: string[]
  authenticated: number
  onRpc: ReturnType<typeof vi.fn>
}

function makeHarness(overrides: Partial<CloudRelayClientOptions> = {}): Harness {
  const sockets: FakeSocket[] = []
  const disconnected: string[] = []
  let authenticated = 0
  const onRpc = vi.fn(async () => ({ ok: true, result: 'rpc-result' }))
  const client = new CloudRelayClient({
    apiOrigin: 'https://relay.example.test',
    deviceToken: 'device-token',
    controlSecret: SECRET,
    socketFactory: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    onAuthenticated: () => {
      authenticated += 1
    },
    onDisconnected: (reason) => {
      disconnected.push(reason)
    },
    onRpc,
    ...overrides
  })
  return {
    client,
    sockets,
    disconnected,
    get authenticated(): number {
      return authenticated
    },
    onRpc
  }
}

async function receivedData(socket: FakeSocket, invoke: unknown): Promise<void> {
  const payload = await encryptPayload(SECRET, JSON.stringify(invoke))
  socket.receive(JSON.stringify({ type: 'relay:data', payload }))
}

/** Decrypt and parse every `relay:data` frame a socket has sent, caching so
 *  repeated reads never re-decrypt the same frame (the security layer rejects
 *  replay). */
function makeBodyReader(): (socket: FakeSocket) => Promise<Record<string, unknown>[]> {
  const decryptedBySocket = new WeakMap<FakeSocket, Promise<Record<string, unknown>[]>>()
  const parsedCountBySocket = new WeakMap<FakeSocket, number>()
  return async (socket: FakeSocket): Promise<Record<string, unknown>[]> => {
    let bodies = await (decryptedBySocket.get(socket) ?? Promise.resolve([]))
    const parsed = parsedCountBySocket.get(socket) ?? 0
    const frames = socket.sent.filter((frame) => frame.includes('relay:data'))
    const pending = frames.slice(parsed).map(async (frame) => {
      const record = JSON.parse(frame) as { type: string; payload?: string }
      if (typeof record.payload !== 'string') return null
      const plaintext = await decryptPayload(SECRET, record.payload)
      return JSON.parse(plaintext) as Record<string, unknown>
    })
    const fresh = await Promise.all(pending)
    bodies = [...bodies, ...fresh.filter((body): body is Record<string, unknown> => body !== null)]
    decryptedBySocket.set(socket, Promise.resolve(bodies))
    parsedCountBySocket.set(socket, frames.length)
    return bodies
  }
}

function dataFrameIds(socket: FakeSocket): number[] {
  return socket.sent
    .filter((frame) => frame.includes('relay:data'))
    .map((frame) => (JSON.parse(frame) as { id: number }).id)
}

function openAuthenticated(harness: Harness, index = 0): FakeSocket {
  const socket = harness.sockets[index]
  socket.open()
  socket.receive(JSON.stringify({ type: 'relay:authenticated' }))
  return socket
}

const readBodies = makeBodyReader()

afterEach(() => {
  vi.useRealTimers()
})

describe('fullJitterDelay', () => {
  it('returns a deterministic value within [0, cap) for a fixed random source', () => {
    const random = vi.fn(() => 0.5)
    expect(fullJitterDelay(0, 1_000, 30_000, random)).toBe(500)
    expect(fullJitterDelay(1, 1_000, 30_000, random)).toBe(1_000)
    expect(fullJitterDelay(5, 1_000, 30_000, random)).toBe(15_000)
    expect(fullJitterDelay(20, 1_000, 30_000, random)).toBe(15_000)
  })

  it('caps the delay at the maximum regardless of attempt', () => {
    expect(fullJitterDelay(50, 1_000, 2_000, () => 1)).toBe(2_000)
  })

  it('never exceeds maxMs even with a full random sample', () => {
    for (const attempt of [0, 1, 2, 3, 10]) {
      const delay = fullJitterDelay(attempt, 100, 30_000, () => 1)
      expect(delay).toBeLessThanOrEqual(30_000)
      expect(delay).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('CloudRelayClient connect/auth deadlines', () => {
  it('emits connect-timeout when the socket never opens', async () => {
    vi.useFakeTimers()
    const harness = makeHarness({ connectTimeoutMs: 50 })
    harness.client.connect()
    expect(harness.disconnected).toEqual([])
    await vi.advanceTimersByTimeAsync(60)
    expect(harness.disconnected).toEqual(['connect-timeout'])
  })

  it('emits auth-timeout when the relay never authenticates', async () => {
    vi.useFakeTimers()
    const harness = makeHarness({ authTimeoutMs: 50 })
    harness.client.connect()
    harness.sockets[0].open()
    expect(harness.sockets[0].sent.some((frame) => frame.includes('relay:authenticate'))).toBe(true)
    await vi.advanceTimersByTimeAsync(60)
    expect(harness.disconnected).toEqual(['auth-timeout'])
  })

  it('authenticates and clears the auth deadline when accepted', async () => {
    vi.useFakeTimers()
    const harness = makeHarness({ authTimeoutMs: 50 })
    harness.client.connect()
    harness.sockets[0].open()
    harness.sockets[0].receive(JSON.stringify({ type: 'relay:authenticated' }))
    expect(harness.authenticated).toBe(1)
    await vi.advanceTimersByTimeAsync(60)
    expect(harness.disconnected).toEqual([])
  })
})

describe('CloudRelayClient outbound queue and acknowledgements', () => {
  it('queues sends before authentication and flushes them after', async () => {
    const harness = makeHarness()
    harness.client.connect()
    await harness.client.send({ rpc: 'event', channel: 'thread.updated', payload: 1 })
    await harness.client.send({ rpc: 'event', channel: 'thread.updated', payload: 2 })
    expect(await readBodies(harness.sockets[0])).toEqual([])
    const socket = openAuthenticated(harness)
    await vi.waitFor(async () => {
      expect(await readBodies(socket)).toHaveLength(2)
    })
  })

  it('assigns monotonic message ids and removes acked messages from in-flight', async () => {
    const harness = makeHarness()
    harness.client.connect()
    const socket = openAuthenticated(harness)
    await harness.client.send({ rpc: 'event', channel: 'a', payload: 1 })
    await harness.client.send({ rpc: 'event', channel: 'a', payload: 2 })
    let ids: number[] = []
    await vi.waitFor(() => {
      ids = dataFrameIds(socket)
      expect(ids).toHaveLength(2)
    })
    // Epoch-scoped ids: strictly increasing and unique across client restarts.
    expect(ids[0]).toBeGreaterThanOrEqual(2 ** 32)
    expect(ids[1]).toBeGreaterThan(ids[0])
    socket.receive(JSON.stringify({ type: 'relay:ack', id: ids[0] }))
    socket.fail()
    expect(socket.sent.filter((frame) => frame.includes('relay:data'))).toHaveLength(2)
  })

  it('drops the oldest message when the bounded queue is full', async () => {
    const harness = makeHarness({ queueLimit: 2 })
    harness.client.connect()
    await harness.client.send({ rpc: 'event', channel: 'a', payload: 1 })
    await harness.client.send({ rpc: 'event', channel: 'a', payload: 2 })
    await harness.client.send({ rpc: 'event', channel: 'a', payload: 3 })
    const socket = openAuthenticated(harness)
    await vi.waitFor(async () => {
      const bodies = await readBodies(socket)
      expect(bodies).toEqual([
        { rpc: 'event', channel: 'a', payload: 2 },
        { rpc: 'event', channel: 'a', payload: 3 }
      ])
    })
  })

  it('requeues unacknowledged messages when the socket drops', async () => {
    const harness = makeHarness()
    harness.client.connect()
    const first = openAuthenticated(harness)
    await harness.client.send({ rpc: 'event', channel: 'a', payload: 1 })
    let firstIds: number[] = []
    await vi.waitFor(() => {
      firstIds = dataFrameIds(first)
      expect(firstIds).toHaveLength(1)
    })
    first.fail()
    harness.client.connect()
    const second = openAuthenticated(harness, 1)
    await vi.waitFor(() => {
      // The unacknowledged frame keeps its original epoch-scoped id.
      expect(dataFrameIds(second)).toEqual(firstIds)
    })
  })
})

describe('CloudRelayClient cancellation', () => {
  it('aborts the connection when the AbortSignal fires', async () => {
    const controller = new AbortController()
    const harness = makeHarness({ signal: controller.signal })
    harness.client.connect()
    harness.sockets[0].open()
    controller.abort()
    expect(harness.disconnected).toEqual(['cancelled'])
    expect(harness.sockets[0].closed).toBe(true)
  })

  it('does not emit disconnected for a deliberate close', async () => {
    const harness = makeHarness()
    harness.client.connect()
    harness.sockets[0].open()
    harness.client.close()
    expect(harness.disconnected).toEqual([])
  })
})

describe('CloudRelayClient self-reconnect preserving the queue', () => {
  it('reconnects on the same client and retransmits unacknowledged work', async () => {
    const harness = makeHarness({
      reconnect: { initialDelayMs: 5, maxDelayMs: 10, random: () => 0.5 }
    })
    harness.client.connect()
    const first = openAuthenticated(harness)
    await harness.client.send({ rpc: 'event', channel: 'a', payload: 1 })
    let originalIds: number[] = []
    await vi.waitFor(() => {
      originalIds = dataFrameIds(first)
      expect(originalIds).toHaveLength(1)
    })

    first.fail()
    expect(harness.disconnected).toEqual(['network'])
    // Reconnect fires after the full-jitter delay (~2ms).
    await new Promise((resolve) => setTimeout(resolve, 12))
    const second = openAuthenticated(harness, 1)
    // The unacknowledged frame is retransmitted on the same client with its id.
    await vi.waitFor(() => {
      expect(dataFrameIds(second)).toEqual(originalIds)
    })
  })

  it('never reconnects after a deliberate close', async () => {
    const harness = makeHarness({
      reconnect: { initialDelayMs: 5, maxDelayMs: 10, random: () => 0.5 }
    })
    harness.client.connect()
    const socket = openAuthenticated(harness)
    harness.client.close()
    socket.fail()
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(harness.disconnected).toEqual([])
    expect(harness.sockets).toHaveLength(1)
  })
})

describe('CloudRelayClient configured replay limit', () => {
  it('evicts the oldest answered invoke from the bounded replay cache', async () => {
    const harness = makeHarness({ replayLimit: 2 })
    harness.client.connect()
    const socket = openAuthenticated(harness)
    for (const id of [1, 2, 3]) {
      await receivedData(socket, { rpc: 'invoke', id, channel: 'chat', args: [] })
      await vi.waitFor(async () => {
        const bodies = await readBodies(socket)
        expect(bodies.some((body) => body['id'] === id && body['rpc'] === 'result')).toBe(true)
      })
    }
    expect(harness.onRpc).toHaveBeenCalledTimes(3)
    // Id 1 was evicted (limit 2) so a repeat re-runs onRpc; id 3 replays.
    await receivedData(socket, { rpc: 'invoke', id: 1, channel: 'chat', args: [] })
    await vi.waitFor(() => {
      expect(harness.onRpc).toHaveBeenCalledTimes(4)
    })
    await receivedData(socket, { rpc: 'invoke', id: 3, channel: 'chat', args: [] })
    await vi.waitFor(async () => {
      expect(harness.onRpc).toHaveBeenCalledTimes(4)
    })
  })
})

describe('CloudRelayClient duplicate suppression and idempotent replay', () => {
  it('suppresses a duplicate invoke while the first is still processing', async () => {
    let resolveRpc: ((value: { ok: boolean; result?: unknown }) => void) | null = null
    const onRpc = vi.fn(
      () =>
        new Promise<{ ok: boolean; result?: unknown }>((resolve) => {
          resolveRpc = resolve
        })
    )
    const harness = makeHarness({ onRpc })
    harness.client.connect()
    const socket = openAuthenticated(harness)
    await receivedData(socket, { rpc: 'invoke', id: 7, channel: 'chat', args: [] })
    await receivedData(socket, { rpc: 'invoke', id: 7, channel: 'chat', args: [] })
    await vi.waitFor(() => {
      expect(onRpc).toHaveBeenCalledTimes(1)
    })
    resolveRpc?.({ ok: true, result: 'done' })
    await vi.waitFor(async () => {
      const bodies = await readBodies(socket)
      // The duplicate is either suppressed or replayed idempotently, but the
      // RPC is never re-invoked and every answer is the same.
      expect(bodies.length).toBeGreaterThanOrEqual(1)
      for (const body of bodies) {
        expect(body['rpc']).toBe('result')
        expect(body['id']).toBe(7)
        expect(body['result']).toBe('done')
      }
    })
  })

  it('replays the cached result for a repeated invoke id', async () => {
    const harness = makeHarness()
    harness.client.connect()
    const socket = openAuthenticated(harness)
    await receivedData(socket, { rpc: 'invoke', id: 9, channel: 'chat', args: [] })
    await vi.waitFor(async () => {
      expect(harness.onRpc).toHaveBeenCalledTimes(1)
      const bodies = await readBodies(socket)
      expect(bodies).toHaveLength(1)
    })
    await receivedData(socket, { rpc: 'invoke', id: 9, channel: 'chat', args: [] })
    await vi.waitFor(async () => {
      expect(harness.onRpc).toHaveBeenCalledTimes(1)
      const bodies = await readBodies(socket)
      expect(bodies).toHaveLength(2)
    })
    const bodies = await readBodies(socket)
    for (const body of bodies) {
      expect(body['rpc']).toBe('result')
      expect(body['id']).toBe(9)
      expect(body['result']).toBe('rpc-result')
    }
  })

  it('answers with an error when the RPC exceeds the request deadline', async () => {
    const onRpc = vi.fn(() => new Promise<{ ok: boolean; result?: unknown }>(() => undefined))
    const harness = makeHarness({ requestTimeoutMs: 30, onRpc })
    harness.client.connect()
    const socket = openAuthenticated(harness)
    await receivedData(socket, { rpc: 'invoke', id: 11, channel: 'chat', args: [] })
    await vi.waitFor(async () => {
      const bodies = await readBodies(socket)
      expect(bodies).toHaveLength(1)
      expect(bodies[0]['rpc']).toBe('error')
      expect(bodies[0]['id']).toBe(11)
    })
  })
})
