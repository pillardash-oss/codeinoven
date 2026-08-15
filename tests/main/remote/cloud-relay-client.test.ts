import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CloudRelayClient,
  fullJitterDelay,
  type CloudRelayClientOptions
} from '../../../src/main/remote/cloud-relay-client'
import { decryptPayload, encryptPayload } from '../../../src/renderer/lib/remote/session-security'
import {
  createMemoryDeviceKeyStore,
  loadOrCreateDeviceKeyMaterial,
  signTranscript,
  handshakeTranscript,
  type DeviceKeyMaterial
} from '../../../src/renderer/lib/remote/device-identity'
import { DeviceCredentialService } from '../../../src/main/remote/device-credential-service'
import { RemoteRpcDispatcher, type RemoteRpcServices } from '../../../src/main/remote/remote-rpc'
import DatabaseConstructor from 'better-sqlite3'
import type { Database } from '../../../src/main/database/database'
import { REMOTE_DEVICE_SQL } from '../../../src/main/database/schema'
import { createTestDb, destroyTestDb } from '../database/test-helper'
import type { ProjectManager } from '../../../src/lib/engines/project-manager'

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
      return socket as unknown as WebSocket
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

async function receivedDataWithId(socket: FakeSocket, id: string, invoke: unknown): Promise<void> {
  const payload = await encryptPayload(SECRET, JSON.stringify(invoke))
  socket.receive(JSON.stringify({ type: 'relay:data', id, payload }))
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

function dataFrameIds(socket: FakeSocket): string[] {
  return socket.sent
    .filter((frame) => frame.includes('relay:data'))
    .map((frame) => (JSON.parse(frame) as { id: string }).id)
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
    let ids: string[] = []
    await vi.waitFor(() => {
      ids = dataFrameIds(socket)
      expect(ids).toHaveLength(2)
    })
    // Instance-scoped ids: full `<uuid>:<seq>` strings, strictly increasing.
    expect(ids[0]).toMatch(/^[0-9a-f-]+:\d+$/)
    expect(ids[1] > ids[0]).toBe(true)
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
    let firstIds: string[] = []
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
    let originalIds: string[] = []
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
  it('acknowledges every accepted inbound frame as the receiver', async () => {
    const harness = makeHarness()
    harness.client.connect()
    const socket = openAuthenticated(harness)
    await receivedDataWithId(socket, '12345678-1234-1234-1234-123456789abc:1', {
      rpc: 'invoke',
      id: 1,
      channel: 'chat',
      args: []
    })
    await vi.waitFor(() => {
      expect(harness.onRpc).toHaveBeenCalledTimes(1)
    })
    const acks = socket.sent.filter((frame) => frame.includes('relay:ack'))
    expect(acks).toHaveLength(1)
    expect(JSON.parse(acks[0] ?? '{}')).toEqual({
      type: 'relay:ack',
      id: '12345678-1234-1234-1234-123456789abc:1'
    })
    // A duplicate delivery is acknowledged again without re-processing.
    await receivedDataWithId(socket, '12345678-1234-1234-1234-123456789abc:1', {
      rpc: 'invoke',
      id: 1,
      channel: 'chat',
      args: []
    })
    await vi.waitFor(() => {
      const acksAfter = socket.sent.filter((frame) => frame.includes('relay:ack'))
      expect(acksAfter).toHaveLength(2)
    })
    expect(harness.onRpc).toHaveBeenCalledTimes(1)
  })

  it('requeues an outbound frame on a retryable NACK', async () => {
    const harness = makeHarness()
    harness.client.connect()
    const socket = openAuthenticated(harness)
    await harness.client.send({ rpc: 'event', channel: 'a', payload: 1 })
    const ids = dataFrameIds(socket)
    expect(ids).toHaveLength(1)
    // Relay rejects the frame with a retryable NACK.
    socket.receive(JSON.stringify({ type: 'relay:nack', id: ids[0], reason: 'expired' }))
    // Reconnect + re-auth flushes the requeued frame with the same id.
    socket.fail()
    harness.client.connect()
    const second = openAuthenticated(harness, 1)
    await vi.waitFor(() => {
      expect(dataFrameIds(second)).toEqual(ids)
    })
  })

  it('fails closed on inbound payload authentication failure without reconnecting', async () => {
    const harness = makeHarness({
      reconnect: { initialDelayMs: 5, maxDelayMs: 10, random: () => 0.5 }
    })
    harness.client.connect()
    const first = openAuthenticated(harness)
    // A frame that fails to decrypt indicates a stale key or tampering. It is
    // terminal for this client rather than a retryable network interruption.
    first.receive(
      JSON.stringify({
        type: 'relay:data',
        id: '12345678-1234-1234-1234-123456789abc:1',
        payload: 'not-encrypted'
      })
    )
    await vi.waitFor(() => expect(harness.disconnected).toContain('payload-authentication-failed'))
    await new Promise((resolve) => setTimeout(resolve, 12))
    expect(harness.sockets).toHaveLength(1)
    expect(harness.onRpc).not.toHaveBeenCalled()
  })

  it('dispatches exactly once for concurrent duplicates of the same inbound id', async () => {
    const harness = makeHarness()
    harness.client.connect()
    const socket = openAuthenticated(harness)
    const payload1 = await encryptPayload(
      SECRET,
      JSON.stringify({ rpc: 'invoke', id: 3, channel: 'chat', args: [] })
    )
    const payload2 = await encryptPayload(
      SECRET,
      JSON.stringify({ rpc: 'invoke', id: 3, channel: 'chat', args: [] })
    )
    // Deliver both frames back-to-back before the first decrypt resolves: the
    // bounded inbound-processing set suppresses the concurrent duplicate.
    socket.receive(
      JSON.stringify({
        type: 'relay:data',
        id: '12345678-1234-1234-1234-123456789abc:1',
        payload: payload1
      })
    )
    socket.receive(
      JSON.stringify({
        type: 'relay:data',
        id: '12345678-1234-1234-1234-123456789abc:1',
        payload: payload2
      })
    )
    await vi.waitFor(() => expect(harness.onRpc).toHaveBeenCalledTimes(1))
    // The concurrent duplicate is coalesced: exactly ONE decrypt/dispatch/ACK.
    await vi.waitFor(() => {
      expect(socket.sent.filter((frame) => frame.includes('relay:ack'))).toHaveLength(1)
    })
  })

  it('coalesces concurrent decrypt failures into one terminal disconnect', async () => {
    const harness = makeHarness({
      reconnect: { initialDelayMs: 5, maxDelayMs: 10, random: () => 0.5 }
    })
    harness.client.connect()
    const first = openAuthenticated(harness)
    const wireId = '12345678-1234-1234-1234-123456789abc:1'
    // Two concurrent frames with the SAME valid UUID wire id both fail to
    // Decrypt failures are coalesced: zero ACKs and one terminal disconnect.
    first.receive(JSON.stringify({ type: 'relay:data', id: wireId, payload: 'bad-1' }))
    first.receive(JSON.stringify({ type: 'relay:data', id: wireId, payload: 'bad-2' }))
    await vi.waitFor(() => expect(harness.disconnected).toContain('payload-authentication-failed'))
    expect(first.sent.filter((frame) => frame.includes('relay:ack'))).toHaveLength(0)
    await new Promise((resolve) => setTimeout(resolve, 12))
    expect(harness.sockets).toHaveLength(1)
    expect(
      harness.disconnected.filter((reason) => reason === 'payload-authentication-failed')
    ).toHaveLength(1)
    expect(harness.onRpc).not.toHaveBeenCalled()
  })

  it('suppresses a duplicate invoke while the first is still processing', async () => {
    let resolveRpc: (value: { ok: boolean; result?: unknown }) => void = () => undefined
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
    resolveRpc({ ok: true, result: 'done' })
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

describe('CloudRelayClient — relay device proof of possession (A-04)', () => {
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

  function makeDispatcher(
    credentials: DeviceCredentialService,
    database: Database
  ): RemoteRpcDispatcher {
    const chatEngine = {
      loadMessages: async () => [],
      deleteThreadSession: async () => undefined,
      listProviderSnapshot: async () => [],
      getSessionStatus: async () => null,
      ensureSession: async () => 'session-1',
      sendPrompt: async () => ({ id: 'm1', role: 'assistant', parts: [], createdAt: 0 }),
      steerPrompt: async () => ({ id: 'm2', role: 'assistant', parts: [], createdAt: 0 }),
      abort: async () => undefined,
      listPermissions: async () => [],
      replyPermission: async () => undefined,
      listQuestions: async () => [],
      answerQuestion: async () => undefined
    } as unknown as RemoteRpcServices['chatEngine']
    const projectManager = {
      listProjects: async () => [{ id: 'p1', name: 'P1' }],
      getProject: async () => null,
      getIconDataUrl: async () => null
    } as unknown as ProjectManager
    return new RemoteRpcDispatcher({
      database,
      chatEngine,
      projectManager,
      credentials
    })
  }

  /** Build an auth frame signing a DESKTOP-issued challenge nonce. */
  async function authFrame(
    nonce: string,
    context: { deviceId?: string | null; authVersion?: number },
    bootstrapValue = 'bootstrap',
    keyMaterial: DeviceKeyMaterial | null = null
  ): Promise<Record<string, unknown>> {
    const km =
      keyMaterial ?? (await loadOrCreateDeviceKeyMaterial({ store: createMemoryDeviceKeyStore() }))
    const transcript = handshakeTranscript({
      nonce,
      deviceId: context.deviceId ?? km.deviceId,
      authVersion: context.authVersion ?? km.authVersion,
      bootstrap: bootstrapValue,
      context: 'relay'
    })
    const signature = await signTranscript(km.signingKey, transcript)
    const frame: Record<string, unknown> = {
      type: 'remote:device:auth',
      nonce,
      signature,
      deviceName: km.deviceName
    }
    if (context.deviceId) {
      frame['deviceId'] = context.deviceId
      frame['authVersion'] = context.authVersion ?? km.authVersion
    } else {
      frame['bootstrap'] = bootstrapValue
      frame['signingPublicJwk'] = km.signingPublicJwk
      frame['agreementPublicJwk'] = km.agreementPublicJwk
    }
    return frame
  }

  async function challengeNonceOf(socket: FakeSocket): Promise<string> {
    await vi.waitFor(async () => {
      const bodies = await readBodies(socket)
      expect(bodies.some((body) => body.type === 'remote:device:challenge')).toBe(true)
    })
    const challenge = (await readBodies(socket)).find(
      (body) => body.type === 'remote:device:challenge'
    )
    expect(typeof challenge?.['nonce']).toBe('string')
    return challenge?.['nonce'] as string
  }

  async function invokeReply(
    socket: FakeSocket,
    id: number,
    invoke: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> {
    await receivedData(socket, invoke)
    await vi.waitFor(async () => {
      const bodies = await readBodies(socket)
      expect(
        bodies.some((body) => (body.rpc === 'result' || body.rpc === 'error') && body.id === id)
      ).toBe(true)
    })
    return (await readBodies(socket)).find(
      (body) => (body.rpc === 'result' || body.rpc === 'error') && body.id === id
    )
  }

  async function makeRelayHarness(credentials: DeviceCredentialService): Promise<{
    harness: Harness
    socket: FakeSocket
    dispose: () => void
  }> {
    const database = await createTestDb()
    const dispatcher = makeDispatcher(credentials, database)
    const harness = makeHarness({
      credentials,
      onRpc: async (channel, args, device) => dispatcher.dispatch({ id: 0, channel, args, device })
    })
    harness.client.connect()
    const socket = openAuthenticated(harness)
    return { harness, socket, dispose: () => destroyTestDb(database) }
  }

  it('issues a fresh challenge and rejects an invoke with no authenticated device', async () => {
    const credentials = new DeviceCredentialService(makeRawDatabase())
    const { harness, socket, dispose } = await makeRelayHarness(credentials)
    expect((await challengeNonceOf(socket)).length).toBeGreaterThan(0)

    // No device handshake → the invoke fails closed (device-less bypass).
    const reply = await invokeReply(socket, 1, {
      rpc: 'invoke',
      id: 1,
      channel: 'project:list',
      args: []
    })
    expect(reply?.rpc).toBe('error')
    if (typeof reply?.message === 'string')
      expect(reply.message).toContain('Device authentication required')
    harness.client.close()
    dispose()
  })

  it('rejects an invoke carrying a caller-forged device context', async () => {
    const credentials = new DeviceCredentialService(makeRawDatabase())
    const { harness, socket, dispose } = await makeRelayHarness(credentials)
    await challengeNonceOf(socket)

    const reply = await invokeReply(socket, 2, {
      rpc: 'invoke',
      id: 2,
      channel: 'project:list',
      args: [],
      device: {
        deviceId: 'forged',
        name: 'x',
        fingerprint: 'x',
        authVersion: 1,
        sessionId: 's',
        requestId: 'r',
        scopes: ['workspace.read'],
        transport: 'relay',
        allProjects: true,
        projectIds: []
      }
    })
    expect(reply?.rpc).toBe('error')
    if (typeof reply?.message === 'string')
      expect(reply.message).toContain('Device authentication required')
    harness.client.close()
    dispose()
  })

  it('binds an enrolled device after signing the desktop challenge and dispatches with capability context', async () => {
    const credentials = new DeviceCredentialService(makeRawDatabase())
    const { harness, socket, dispose } = await makeRelayHarness(credentials)
    const nonce = await challengeNonceOf(socket)
    const bootstrap = await credentials.createPairingBootstrap()

    await receivedData(
      socket,
      await authFrame(nonce, { deviceId: null, authVersion: undefined }, bootstrap.value)
    )
    await vi.waitFor(async () => {
      const bodies = await readBodies(socket)
      expect(bodies.some((body) => body.type === 'remote:device:ok')).toBe(true)
    })
    const ok = (await readBodies(socket)).find((body) => body.type === 'remote:device:ok')
    const assignedId = ((ok?.['device'] as { id?: unknown }) ?? {}).id
    expect(typeof assignedId).toBe('string')

    // project:list and thread:harnessUsage are default workspace.read → succeed.
    const list = await invokeReply(socket, 3, {
      rpc: 'invoke',
      id: 3,
      channel: 'project:list',
      args: []
    })
    expect(list?.rpc).toBe('result')
    const usage = await invokeReply(socket, 4, {
      rpc: 'invoke',
      id: 4,
      channel: 'thread:harnessUsage',
      args: ['p1', 't1']
    })
    expect(usage?.rpc).toBe('result')

    // git:push is outside the default scopes → capability-bound denial.
    const denied = await invokeReply(socket, 5, {
      rpc: 'invoke',
      id: 5,
      channel: 'git:push',
      args: ['p1']
    })
    expect(denied?.rpc).toBe('error')
    if (typeof denied?.message === 'string') expect(denied.message).toContain('Access denied')

    const events = credentials.listAudit(20)
    const allowedAudit = events.find(
      (event) => event.decision === 'rpc_allowed' && event.channel === 'project:list'
    )
    expect(allowedAudit?.deviceId).toBe(assignedId)
    expect(allowedAudit?.channel).toBe('project:list')
    harness.client.close()
    dispose()
  })

  it('rejects a replayed proof against the same challenge and keeps the session unbound', async () => {
    const credentials = new DeviceCredentialService(makeRawDatabase())
    const { harness, socket, dispose } = await makeRelayHarness(credentials)
    const nonce = await challengeNonceOf(socket)
    const bootstrap = await credentials.createPairingBootstrap()
    const frame = await authFrame(
      nonce,
      { deviceId: null, authVersion: undefined },
      bootstrap.value
    )
    await receivedData(socket, frame)
    await vi.waitFor(async () => {
      const bodies = await readBodies(socket)
      expect(bodies.some((body) => body.type === 'remote:device:ok')).toBe(true)
    })

    // Replaying the SAME proof cannot rebind or escalate: the single-use
    // challenge was consumed, so the desktop issues a fresh challenge and
    // never emits a second bind.
    await receivedData(socket, frame)
    await vi.waitFor(async () => {
      const bodies = await readBodies(socket)
      expect(bodies.some((body) => body.type === 'remote:device:challenge')).toBe(true)
    })
    const bindCount = (await readBodies(socket)).filter(
      (body) => body.type === 'remote:device:ok'
    ).length
    expect(bindCount).toBe(1)
    harness.client.close()
    dispose()
  })

  it('rejects a mismatched nonce (stale proof from another connection)', async () => {
    const credentials = new DeviceCredentialService(makeRawDatabase())
    const { harness, socket, dispose } = await makeRelayHarness(credentials)
    const issued = await challengeNonceOf(socket)

    // Sign a transcript over a DIFFERENT nonce — the desktop recomputes the
    // canonical transcript from ITS challenge, so the signature must not verify.
    const frame = await authFrame('stale-nonce-123', { deviceId: null, authVersion: undefined })
    void issued
    await receivedData(socket, frame)
    await vi.waitFor(async () => {
      const bodies = await readBodies(socket)
      // A mismatched proof yields a fresh challenge, never a bind.
      expect(bodies.some((body) => body.type === 'remote:device:challenge')).toBe(true)
      expect(bodies.some((body) => body.type === 'remote:device:ok')).toBe(false)
    })
    harness.client.close()
    dispose()
  })

  it('rejects a forged enrollment bootstrap and keeps the session unbound', async () => {
    const credentials = new DeviceCredentialService(makeRawDatabase())
    const { harness, socket, dispose } = await makeRelayHarness(credentials)
    const nonce = await challengeNonceOf(socket)
    const frame = await authFrame(nonce, { deviceId: null, authVersion: undefined })
    // The frame signs a transcript bound to bootstrap 'bootstrap', but the
    // frame itself carries no bootstrap value → malformed and rejected.
    delete frame['bootstrap']
    await receivedData(socket, frame)
    await vi.waitFor(async () => {
      const bodies = await readBodies(socket)
      expect(bodies.some((body) => body.type === 'remote:device:error')).toBe(true)
    })
    const reply = await invokeReply(socket, 7, {
      rpc: 'invoke',
      id: 7,
      channel: 'project:list',
      args: []
    })
    expect(reply?.rpc).toBe('error')
    if (typeof reply?.message === 'string')
      expect(reply.message).toContain('Device authentication required')
    harness.client.close()
    dispose()
  })

  it('revokes a bound cloud device and rejects its subsequent invokes (per-invoke revalidation)', async () => {
    const credentials = new DeviceCredentialService(makeRawDatabase())
    const { harness, socket, dispose } = await makeRelayHarness(credentials)
    const nonce = await challengeNonceOf(socket)
    const bootstrap = await credentials.createPairingBootstrap()
    await receivedData(
      socket,
      await authFrame(nonce, { deviceId: null, authVersion: undefined }, bootstrap.value)
    )
    await vi.waitFor(async () => {
      const bodies = await readBodies(socket)
      expect(bodies.some((body) => body.type === 'remote:device:ok')).toBe(true)
    })
    const ok = (await readBodies(socket)).find((body) => body.type === 'remote:device:ok')
    const assignedId = ((ok?.['device'] as { id?: unknown }) ?? {}).id
    expect(typeof assignedId).toBe('string')

    // The bound device is revoked server-side → the next invoke must be rejected
    // even though the relay session is still open (no stateless trust).
    expect(credentials.revokeDevice(assignedId as string, 'stolen')).toBe(true)
    const reply = await invokeReply(socket, 8, {
      rpc: 'invoke',
      id: 8,
      channel: 'project:list',
      args: []
    })
    expect(reply?.rpc).toBe('error')
    if (typeof reply?.message === 'string') expect(reply.message).toContain('Access denied')
    const deniedAudit = credentials
      .listAudit(20)
      .find((event) => event.decision === 'rpc_denied' && event.deviceId === assignedId)
    expect(deniedAudit).toBeDefined()
    harness.client.close()
    dispose()
  })

  it('reports a trusted enrollment-success callback for rotation after relay enrollment', async () => {
    const credentials = new DeviceCredentialService(makeRawDatabase())
    const enrolledIds: string[] = []
    const database = await createTestDb()
    const dispatcher = makeDispatcher(credentials, database)
    const harness = makeHarness({
      credentials,
      onDeviceEnrolled: async (deviceId) => {
        enrolledIds.push(deviceId)
      },
      onRpc: async (channel, args, device) => dispatcher.dispatch({ id: 0, channel, args, device })
    })
    harness.client.connect()
    const socket = openAuthenticated(harness)
    const nonce = await challengeNonceOf(socket)
    const bootstrap = await credentials.createPairingBootstrap()
    const keyMaterial = await loadOrCreateDeviceKeyMaterial({ store: createMemoryDeviceKeyStore() })

    // Enrollment fires the callback exactly once with the assigned device id.
    await receivedData(
      socket,
      await authFrame(
        nonce,
        { deviceId: null, authVersion: undefined },
        bootstrap.value,
        keyMaterial
      )
    )
    await vi.waitFor(async () => {
      const bodies = await readBodies(socket)
      expect(bodies.some((body) => body.type === 'remote:device:ok')).toBe(true)
    })
    expect(enrolledIds).toHaveLength(1)
    expect(enrolledIds[0]?.length).toBeGreaterThan(0)

    // The single-use bootstrap is consumed (rotated): it cannot enroll again.
    const stale = await credentials.consumePairingBootstrap(bootstrap.value)
    expect(stale.ok).toBe(false)

    // A reconnect auth (same key, same device, fresh challenge) must NOT fire
    // the enrollment callback again — only the initial enrollment rotates.
    // The consumed challenge mismatches, so the desktop re-challenges first.
    await receivedData(
      socket,
      await authFrame(
        nonce,
        { deviceId: enrolledIds[0], authVersion: 1 },
        bootstrap.value,
        keyMaterial
      )
    )
    const fresh = await challengeNonceOf(socket)
    await receivedData(
      socket,
      await authFrame(
        fresh,
        { deviceId: enrolledIds[0], authVersion: 1 },
        bootstrap.value,
        keyMaterial
      )
    )
    await vi.waitFor(async () => {
      const bodies = await readBodies(socket)
      expect(bodies.some((body) => body.type === 'remote:device:ok')).toBe(true)
    })
    expect(enrolledIds).toHaveLength(1)
    harness.client.close()
    destroyTestDb(database)
  })
})
