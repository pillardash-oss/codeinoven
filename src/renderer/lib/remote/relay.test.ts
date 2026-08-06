import { describe, expect, it, vi } from 'vitest'
import {
  createRelayClient,
  type RelayClientOptions,
  type RelayEvent,
  type RelayConnectResult,
  type RelayClient
} from './relay'
import type { TransportSocket } from './transport'

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

    client.send('payload')
    expect(relaySocket.sent).toContain('payload')
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
})
