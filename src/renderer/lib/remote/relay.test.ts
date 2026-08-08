import { describe, expect, it, vi } from 'vitest'
import {
  createRelayClient,
  fullJitterDelay,
  type RelayClientOptions,
  type RelayEvent,
  type RelayConnectResult,
  type RelayClient
} from './relay'
import type { TransportSocket } from './transport'
import { decryptPayload, encryptPayload } from './session-security'

async function encryptTestPayload(plaintext: string): Promise<string> {
  return encryptPayload('peer-secret', plaintext)
}

const RELAY_URL = 'wss://relay.example.test'

class FakeSocket implements TransportSocket {
  sent: string[] = []
  closed = false
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
  }

  open(): void {
    this.onopen?.({})
  }

  receive(data: string): void {
    this.onmessage?.({ data })
  }

  closeFromServer(): void {
    this.onclose?.({ code: 1000, reason: 'normal' })
  }
}

function baseOptions(overrides: Partial<RelayClientOptions> = {}): RelayClientOptions {
  return {
    url: RELAY_URL,
    token: 'relay-token',
    authSecret: 'peer-secret',
    mqtt: { url: null, username: null, password: null },
    onEvent: () => undefined,
    ...overrides
  }
}

async function connectWith(
  options: RelayClientOptions,
  sockets: FakeSocket[],
  drive: (client: RelayClient, sockets: FakeSocket[]) => Promise<void> = async () => undefined
): Promise<{ result: RelayConnectResult; events: RelayEvent[]; client: RelayClient }> {
  const events: RelayEvent[] = []
  let index = 0
  const client = createRelayClient({
    ...options,
    onEvent: (event) => events.push(event),
    socketFactory: () => {
      const socket = sockets[index]
      index += 1
      return socket
    }
  })
  const connectPromise = client.connect()
  await drive(client, sockets)
  const result = await connectPromise
  return { result, events, client }
}

describe('createRelayClient', () => {
  it('opens a data channel after a successful relay handshake', async () => {
    const relaySocket = new FakeSocket()
    const { result, events, client } = await connectWith(baseOptions(), [relaySocket], async () => {
      relaySocket.open()
      await vi.waitFor(() => {
        expect(relaySocket.sent.length).toBe(1)
      })
      relaySocket.receive(JSON.stringify({ type: 'relay:hello:ok' }))
    })

    expect(result).toBe('open')
    expect(events.some((event) => event.kind === 'handshake:ok')).toBe(true)

    const hello = JSON.parse(relaySocket.sent[0]) as {
      token: string | null
      auth: string
      nonce: string
    }
    expect(hello.token).toBe('relay-token')
    expect(hello.auth).not.toBe('peer-secret')
    expect(hello.nonce.length).toBeGreaterThan(0)

    await client.send('payload')
    const envelope = JSON.parse(relaySocket.sent[relaySocket.sent.length - 1]) as {
      type: string
      payload: string
    }
    expect(envelope.type).toBe('remote:data')
    await expect(decryptPayload('peer-secret', envelope.payload)).resolves.toBe('payload')
  })

  it('rejects the handshake when the relay rejects the token', async () => {
    const relaySocket = new FakeSocket()
    const { result, events } = await connectWith(baseOptions(), [relaySocket], async () => {
      relaySocket.open()
      relaySocket.receive(JSON.stringify({ type: 'relay:error', reason: 'bad-token' }))
    })

    expect(result).toBe('rejected')
    expect(events.some((event) => event.kind === 'handshake:rejected')).toBe(true)
    expect(relaySocket.closed).toBe(true)
  })

  it('reports MQTT signaling failure but still connects through the relay', async () => {
    const mqttSocket = new FakeSocket()
    const relaySocket = new FakeSocket()
    const options = baseOptions({
      mqtt: { url: 'ws://mqtt.example.test', username: 'user', password: 'pass' },
      mqttSignalingTimeoutMs: 5
    })
    const events: RelayEvent[] = []
    const client = createRelayClient({
      ...options,
      onEvent: (event) => events.push(event),
      socketFactory: (url: string) => (url === options.mqtt.url ? mqttSocket : relaySocket)
    })

    const connectPromise = client.connect()
    relaySocket.open()
    await vi.waitFor(() => {
      expect(relaySocket.sent.length).toBe(1)
    })
    relaySocket.receive(JSON.stringify({ type: 'relay:hello:ok' }))
    const result = await connectPromise

    expect(result).toBe('open')
    expect(events.some((event) => event.kind === 'signaling:mqtt-failed')).toBe(true)
    expect(events.some((event) => event.kind === 'handshake:ok')).toBe(true)
  })

  it('reports a disconnection that happens before the handshake completes', async () => {
    const relaySocket = new FakeSocket()
    const { result, events } = await connectWith(baseOptions(), [relaySocket], async () => {
      relaySocket.open()
      relaySocket.closeFromServer()
    })

    expect(result).toBe('failed')
    expect(events.some((event) => event.kind === 'disconnected')).toBe(true)
  })

  it('creates the socket through the injected factory', () => {
    const factory = vi.fn(() => new FakeSocket())
    const client = createRelayClient(baseOptions({ socketFactory: factory }))
    void client.connect()
    expect(factory).toHaveBeenCalledWith(RELAY_URL)
  })

  it('fails the attempt when the socket never opens before the connect deadline', async () => {
    const relaySocket = new FakeSocket()
    const { result, events } = await connectWith(
      baseOptions({ connectTimeoutMs: 20 }),
      [relaySocket],
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 30))
      }
    )

    expect(result).toBe('failed')
    expect(
      events.some((event) => event.kind === 'disconnected' && event.reason === 'connect-timeout')
    ).toBe(true)
  })

  it('queues sends before the channel opens, assigns ids, and flushes on open', async () => {
    const relaySocket = new FakeSocket()
    const events: RelayEvent[] = []
    const client = createRelayClient({
      ...baseOptions(),
      onEvent: (event) => events.push(event),
      socketFactory: () => relaySocket
    })
    const connectPromise = client.connect()
    await client.send('one')
    await client.send('two')
    // Nothing is transmitted before the handshake completes.
    expect(relaySocket.sent).toEqual([])

    relaySocket.open()
    await vi.waitFor(() => {
      expect(relaySocket.sent.length).toBe(1)
    })
    relaySocket.receive(JSON.stringify({ type: 'relay:hello:ok' }))
    expect(await connectPromise).toBe('open')

    await vi.waitFor(() => {
      expect(relaySocket.sent.filter((frame) => frame.includes('remote:data'))).toHaveLength(2)
    })
    const envelopes = relaySocket.sent
      .filter((frame) => frame.includes('remote:data'))
      .map((frame) => JSON.parse(frame) as { id: number; payload: string })
    expect(envelopes.map((envelope) => envelope.id)).toEqual([1, 2])
    await expect(decryptPayload('peer-secret', envelopes[0].payload)).resolves.toBe('one')
    await expect(decryptPayload('peer-secret', envelopes[1].payload)).resolves.toBe('two')
  })

  it('honours acks by removing the acknowledged frame from retransmission', async () => {
    const relaySocket = new FakeSocket()
    const client = createRelayClient({
      ...baseOptions({
        reconnect: { maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 10, random: () => 0.5 }
      }),
      socketFactory: () => relaySocket
    })
    const connectPromise = client.connect()
    relaySocket.open()
    await vi.waitFor(() => {
      expect(relaySocket.sent.length).toBe(1)
    })
    relaySocket.receive(JSON.stringify({ type: 'relay:hello:ok' }))
    expect(await connectPromise).toBe('open')
    await client.send('one')
    await client.send('two')
    await vi.waitFor(() => {
      expect(relaySocket.sent.filter((frame) => frame.includes('remote:data'))).toHaveLength(2)
    })
    // Acknowledge the first frame; the second stays unacknowledged.
    relaySocket.receive(JSON.stringify({ type: 'remote:ack', id: 1 }))
    relaySocket.closeFromServer()
    // Without reconnect attempts the queued work is retained for the next open.
    client.close()
  })

  it('suppresses duplicate inbound frames sharing a message id', async () => {
    const relaySocket = new FakeSocket()
    const messages: string[] = []
    const client = createRelayClient({
      ...baseOptions(),
      onEvent: (event) => {
        if (event.kind === 'message') messages.push(event.data)
      },
      socketFactory: () => relaySocket
    })
    const connectPromise = client.connect()
    relaySocket.open()
    await vi.waitFor(() => {
      expect(relaySocket.sent.length).toBe(1)
    })
    relaySocket.receive(JSON.stringify({ type: 'relay:hello:ok' }))
    expect(await connectPromise).toBe('open')

    const payload1 = JSON.stringify({
      type: 'remote:data',
      id: 42,
      payload: await encryptTestPayload('first')
    })
    const payload2 = JSON.stringify({
      type: 'remote:data',
      id: 42,
      payload: await encryptTestPayload('second')
    })
    relaySocket.receive(payload1)
    relaySocket.receive(payload2)
    await vi.waitFor(() => {
      expect(messages.length).toBe(1)
    })
    expect(messages[0]).toBe('first')
  })

  it('reconnects with full-jitter backoff up to the bounded attempt limit', async () => {
    const sockets = [new FakeSocket(), new FakeSocket(), new FakeSocket()]
    let index = 0
    const disconnected: string[] = []
    const client = createRelayClient({
      ...baseOptions({
        reconnect: { maxAttempts: 2, initialDelayMs: 20, maxDelayMs: 40, random: () => 0.5 }
      }),
      onEvent: (event) => {
        if (event.kind === 'disconnected') disconnected.push(event.reason)
      },
      socketFactory: () => {
        const socket = sockets[index]
        index += 1
        return socket
      }
    })
    const connectPromise = client.connect()
    sockets[0].open()
    await vi.waitFor(() => {
      expect(sockets[0].sent.length).toBe(1)
    })
    sockets[0].receive(JSON.stringify({ type: 'relay:hello:ok' }))
    expect(await connectPromise).toBe('open')

    // Drop the live socket; the client schedules a full-jitter reconnect.
    sockets[0].closeFromServer()
    await vi.waitFor(() => {
      expect(disconnected).toContain('socket-closed (reconnect 1)')
    })
    // First reconnect attempt is rejected, advancing to attempt 2.
    await new Promise((resolve) => setTimeout(resolve, 12))
    sockets[1].open()
    await vi.waitFor(() => {
      expect(sockets[1].sent.length).toBe(1)
    })
    sockets[1].receive(JSON.stringify({ type: 'relay:error', reason: 'bad-token' }))
    await vi.waitFor(() => {
      expect(disconnected).toContain('auth-failed (reconnect 2)')
    })
    // Second reconnect attempt is rejected, exhausting the retry budget.
    await new Promise((resolve) => setTimeout(resolve, 22))
    sockets[2].open()
    await vi.waitFor(() => {
      expect(sockets[2].sent.length).toBe(1)
    })
    sockets[2].receive(JSON.stringify({ type: 'relay:error', reason: 'bad-token' }))
    await vi.waitFor(() => {
      expect(disconnected.some((reason) => reason === 'auth-failed')).toBe(true)
    })
    expect(disconnected).toEqual([
      'socket-closed (reconnect 1)',
      'auth-failed (reconnect 2)',
      'auth-failed'
    ])
    client.close()
  })

  it('computes deterministic full-jitter backoff delays', () => {
    expect(fullJitterDelay(0, 1_000, 30_000, () => 0.5)).toBe(500)
    expect(fullJitterDelay(1, 1_000, 30_000, () => 0.5)).toBe(1_000)
    expect(fullJitterDelay(5, 1_000, 30_000, () => 0.5)).toBe(15_000)
    expect(fullJitterDelay(10, 1_000, 30_000, () => 1)).toBe(30_000)
  })
})
