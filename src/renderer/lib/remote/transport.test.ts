import { describe, expect, it, vi } from 'vitest'
import {
  createAuthToken,
  createLanTransport,
  createNonce,
  type TransportEvent,
  type TransportSocket
} from './transport'

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

function helloOf(socket: FakeSocket): { nonce: string; token: string; type: string } {
  const message = JSON.parse(socket.sent[0]) as {
    type: string
    nonce: string
    token: string
  }
  return message
}

const peer = { host: '192.168.1.5', port: 4455 }

describe('createLanTransport', () => {
  it('opens a data channel after a successful PEER_SECRET_AUTH handshake', async () => {
    const socket = new FakeSocket()
    const events: TransportEvent[] = []
    const transport = createLanTransport({
      peer,
      authSecret: 'secret',
      socketFactory: () => socket,
      onEvent: (event) => events.push(event)
    })

    const connectPromise = transport.connect()
    socket.open()
    await vi.waitFor(() => {
      expect(socket.sent.length).toBe(1)
    })
    const hello = helloOf(socket)

    expect(hello.type).toBe('remote:hello')
    expect(hello.nonce.length).toBeGreaterThan(0)
    expect(hello.token).not.toBe('secret')

    socket.receive(JSON.stringify({ type: 'remote:hello:ok' }))
    await expect(connectPromise).resolves.toBe('open')

    expect(events.some((event) => event.kind === 'connecting')).toBe(true)
    expect(events.some((event) => event.kind === 'handshaking')).toBe(true)
    expect(events.some((event) => event.kind === 'handshake:ok')).toBe(true)

    transport.send('ping')
    expect(socket.sent).toContain('ping')
  })

  it('rejects the handshake when the peer rejects the auth token', async () => {
    const socket = new FakeSocket()
    const events: TransportEvent[] = []
    const transport = createLanTransport({
      peer,
      authSecret: 'wrong-secret',
      socketFactory: () => socket,
      onEvent: (event) => events.push(event)
    })

    const connectPromise = transport.connect()
    socket.open()
    socket.receive(JSON.stringify({ type: 'remote:error', reason: 'auth-failed' }))

    await expect(connectPromise).resolves.toBe('rejected')
    expect(events.some((event) => event.kind === 'handshake:rejected')).toBe(true)
    expect(socket.closed).toBe(true)
  })

  it('reports a disconnection that happens before the handshake completes', async () => {
    const socket = new FakeSocket()
    const events: TransportEvent[] = []
    const transport = createLanTransport({
      peer,
      authSecret: 'secret',
      socketFactory: () => socket,
      onEvent: (event) => events.push(event)
    })

    const connectPromise = transport.connect()
    socket.open()
    socket.closeFromServer()

    await expect(connectPromise).resolves.toBe('failed')
    expect(events.some((event) => event.kind === 'disconnected')).toBe(true)
  })

  it('times out when the peer never answers the handshake', async () => {
    const socket = new FakeSocket()
    const events: TransportEvent[] = []
    const transport = createLanTransport({
      peer,
      authSecret: 'secret',
      handshakeTimeoutMs: 5,
      socketFactory: () => socket,
      onEvent: (event) => events.push(event)
    })

    const connectPromise = transport.connect()
    socket.open()

    await expect(connectPromise).resolves.toBe('failed')
    const disconnected = events.find((event) => event.kind === 'disconnected')
    expect(disconnected?.kind === 'disconnected' && disconnected.reason).toBe('handshake-timeout')
  })

  it('derives a different token per nonce', async () => {
    const first = await createAuthToken('secret', 'nonce-a')
    const second = await createAuthToken('secret', 'nonce-b')
    expect(first).not.toBe(second)
  })

  it('produces unique nonces', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 32; i += 1) {
      const nonce = createNonce()
      expect(seen.has(nonce)).toBe(false)
      seen.add(nonce)
    }
  })
})

describe('createAuthToken', () => {
  it('signs the nonce without leaking the secret', async () => {
    const token = await createAuthToken('secret-value', 'nonce')
    expect(token).not.toContain('secret-value')
    expect(token.length).toBeGreaterThan(10)
  })
})

describe('browser WebSocket default', () => {
  it('creates the socket via the factory when one is supplied', () => {
    const factory = vi.fn(() => new FakeSocket())
    const transport = createLanTransport({
      peer,
      authSecret: 'secret',
      socketFactory: factory,
      onEvent: () => undefined
    })
    void transport.connect()
    expect(factory).toHaveBeenCalledWith('ws://192.168.1.5:4455')
  })
})
