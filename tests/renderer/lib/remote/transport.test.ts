import { describe, expect, it, vi } from 'vitest'
import {
  createLanTransport,
  type TransportEvent,
  type TransportSocket
} from '../../../../src/renderer/lib/remote/transport'
import { generateNonce } from '../../../../src/renderer/lib/remote/session-security'
import {
  createMemoryDeviceKeyStore,
  loadOrCreateDeviceKeyMaterial
} from '../../../../src/renderer/lib/remote/device-identity'

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

const peer = { host: '192.168.1.5', port: 4455 }

describe('createLanTransport', () => {
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

  it('produces unique nonces', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 32; i += 1) {
      const nonce = generateNonce()
      expect(seen.has(nonce)).toBe(false)
      seen.add(nonce)
    }
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

describe('createLanTransport — proof of possession (A-04)', () => {
  it('signs the challenge instead of deriving a shared-secret token on first enrollment', async () => {
    const socket = new FakeSocket()
    const events: TransportEvent[] = []
    const keyMaterial = await loadOrCreateDeviceKeyMaterial({ store: createMemoryDeviceKeyStore() })
    const transport = createLanTransport({
      peer,
      authSecret: 'bootstrap',
      pairingBootstrap: 'bootstrap',
      socketFactory: () => socket,
      device: {
        deviceId: keyMaterial.deviceId,
        deviceName: keyMaterial.deviceName,
        authVersion: keyMaterial.authVersion,
        signingKey: keyMaterial.signingKey,
        signingPublicJwk: keyMaterial.signingPublicJwk,
        agreementPublicJwk: keyMaterial.agreementPublicJwk
      },
      onEvent: (event) => events.push(event)
    })

    const connectPromise = transport.connect()
    socket.open()
    socket.receive(JSON.stringify({ type: 'remote:challenge', nonce: 'challenge-1' }))
    await vi.waitFor(() => {
      expect(socket.sent.length).toBe(1)
    })
    const hello = JSON.parse(socket.sent[0] ?? '') as {
      type: string
      version: number
      nonce: string
      token?: string
      signature: string
      transcript: string
      bootstrap: string
      signingPublicJwk: JsonWebKey
      agreementPublicJwk: JsonWebKey
    }
    expect(hello.type).toBe('remote:hello')
    expect(hello.version).toBe(3)
    expect(hello.nonce).toBe('challenge-1')
    expect(hello.token).toBeUndefined()
    expect(hello.bootstrap).toBe('bootstrap')
    expect(hello.signature.length).toBeGreaterThan(40)
    expect(hello.transcript).toContain('codeinoven:enroll:bootstrap:challenge-1')
    expect(hello.signingPublicJwk.kty).toBe('EC')
    expect(hello.agreementPublicJwk.kty).toBe('EC')

    socket.receive(JSON.stringify({ type: 'remote:hello:ok' }))
    await expect(connectPromise).resolves.toBe('open')
  })

  it('reports the desktop-assigned device id from a successful enrollment reply', async () => {
    const socket = new FakeSocket()
    const keyMaterial = await loadOrCreateDeviceKeyMaterial({ store: createMemoryDeviceKeyStore() })
    let assigned = ''
    const transport = createLanTransport({
      peer,
      authSecret: 'bootstrap',
      pairingBootstrap: 'bootstrap',
      socketFactory: () => socket,
      device: {
        deviceId: keyMaterial.deviceId,
        deviceName: keyMaterial.deviceName,
        authVersion: keyMaterial.authVersion,
        signingKey: keyMaterial.signingKey,
        signingPublicJwk: keyMaterial.signingPublicJwk,
        agreementPublicJwk: keyMaterial.agreementPublicJwk
      },
      onAssignedDevice: (deviceId) => {
        assigned = deviceId
      },
      onEvent: () => undefined
    })

    const connectPromise = transport.connect()
    socket.open()
    socket.receive(JSON.stringify({ type: 'remote:challenge', nonce: 'challenge-2' }))
    await vi.waitFor(() => expect(socket.sent.length).toBe(1))
    socket.receive(
      JSON.stringify({
        type: 'remote:hello:ok',
        device: { id: 'desktop-assigned-42', authVersion: 1 }
      })
    )
    await expect(connectPromise).resolves.toBe('open')
    expect(assigned).toBe('desktop-assigned-42')
  })

  it('binds the reconnect signature to the device id and auth version', async () => {
    const socket = new FakeSocket()
    const transport = createLanTransport({
      peer,
      authSecret: 'bootstrap',
      socketFactory: () => socket,
      device: {
        deviceId: 'device-abc',
        deviceName: 'iPhone',
        authVersion: 2,
        signingKey: (await loadOrCreateDeviceKeyMaterial({ store: createMemoryDeviceKeyStore() }))
          .signingKey,
        signingPublicJwk: (
          await loadOrCreateDeviceKeyMaterial({ store: createMemoryDeviceKeyStore() })
        ).signingPublicJwk,
        agreementPublicJwk: (
          await loadOrCreateDeviceKeyMaterial({ store: createMemoryDeviceKeyStore() })
        ).agreementPublicJwk
      },
      onEvent: () => undefined
    })

    const connectPromise = transport.connect()
    socket.open()
    socket.receive(JSON.stringify({ type: 'remote:challenge', nonce: 'challenge-3' }))
    await vi.waitFor(() => expect(socket.sent.length).toBe(1))
    const hello = JSON.parse(socket.sent[0] ?? '') as {
      version: number
      deviceId: string
      authVersion: number
      transcript: string
      token?: string
    }
    expect(hello.version).toBe(3)
    expect(hello.deviceId).toBe('device-abc')
    expect(hello.authVersion).toBe(2)
    expect(hello.token).toBeUndefined()
    expect(hello.transcript).toBe('codeinoven:auth:challenge-3:device-abc:2')

    socket.receive(JSON.stringify({ type: 'remote:hello:ok' }))
    await expect(connectPromise).resolves.toBe('open')
  })
})
