import { describe, expect, it, vi } from 'vitest'
import {
  authenticateHandshake,
  createHandshakeToken,
  decryptPayload,
  encryptPayload,
  generateNonce,
  verifyHandshakeToken
} from './session-security'
import { createLanTransport, type TransportSocket } from './transport'
import { createRelayClient } from './relay'

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
}

describe('handshake tokens', () => {
  it('verifies a correct token and rejects a wrong secret', async () => {
    const nonce = generateNonce()
    const token = await createHandshakeToken('shared-secret', nonce)

    await expect(verifyHandshakeToken('shared-secret', nonce, token)).resolves.toBe(true)
    await expect(verifyHandshakeToken('wrong-secret', nonce, token)).resolves.toBe(false)
  })

  it('rejects every handshake when no secret is configured', async () => {
    const nonce = generateNonce()
    const token = await createHandshakeToken('anything', nonce)
    await expect(authenticateHandshake(null, nonce, token)).resolves.toBe(false)
  })

  it('accepts a handshake when the shared secret matches', async () => {
    const nonce = generateNonce()
    const token = await createHandshakeToken('shared-secret', nonce)
    await expect(authenticateHandshake('shared-secret', nonce, token)).resolves.toBe(true)
  })

  it('does not leak the secret inside the token', async () => {
    const token = await createHandshakeToken('very-secret-value', 'nonce')
    expect(token).not.toContain('very-secret-value')
  })
})

describe('payload encryption', () => {
  it('round-trips a payload through AES-GCM', async () => {
    const ciphertext = await encryptPayload('shared-secret', 'hello phone')
    expect(ciphertext).not.toContain('hello phone')
    await expect(decryptPayload('shared-secret', ciphertext)).resolves.toBe('hello phone')
  })

  it('produces a distinct ciphertext each time for the same plaintext', async () => {
    const first = await encryptPayload('shared-secret', 'same')
    const second = await encryptPayload('shared-secret', 'same')
    expect(first).not.toBe(second)
  })

  it('fails to decrypt with the wrong secret', async () => {
    const ciphertext = await encryptPayload('server-secret', 'payload')
    await expect(decryptPayload('client-secret', ciphertext)).rejects.toThrow()
  })

  it('rejects malformed ciphertext', async () => {
    await expect(decryptPayload('shared-secret', 'not-a-payload')).rejects.toThrow(
      'malformed-encrypted-payload'
    )
  })
})

describe('handshake enforcement across routes', () => {
  const peer = { host: '192.168.1.5', port: 4455 }
  const relayUrl = 'wss://relay.example.test'

  it('rejects the LAN handshake when the peer secret is wrong', async () => {
    const socket = new FakeSocket()
    const transport = createLanTransport({
      peer,
      authSecret: 'client-secret',
      socketFactory: () => socket,
      onEvent: () => undefined
    })

    const connectPromise = transport.connect()
    socket.open()
    await vi.waitFor(() => {
      expect(socket.sent.length).toBe(1)
    })
    const hello = JSON.parse(socket.sent[0]) as { nonce: string; token: string }
    const accepted = await authenticateHandshake('server-secret', hello.nonce, hello.token)
    socket.receive(
      JSON.stringify(
        accepted ? { type: 'remote:hello:ok' } : { type: 'remote:error', reason: 'auth-failed' }
      )
    )

    await expect(connectPromise).resolves.toBe('rejected')
  })

  it('rejects the relay handshake when the peer secret is wrong', async () => {
    const socket = new FakeSocket()
    const client = createRelayClient({
      url: relayUrl,
      token: 'relay-token',
      authSecret: 'client-secret',
      mqtt: { url: null, username: null, password: null },
      socketFactory: () => socket,
      onEvent: () => undefined
    })

    const connectPromise = client.connect()
    socket.open()
    await vi.waitFor(() => {
      expect(socket.sent.length).toBe(1)
    })
    const hello = JSON.parse(socket.sent[0]) as { nonce: string; auth: string }
    const accepted = await authenticateHandshake('server-secret', hello.nonce, hello.auth)
    socket.receive(
      JSON.stringify(
        accepted ? { type: 'relay:hello:ok' } : { type: 'relay:error', reason: 'auth-failed' }
      )
    )

    await expect(connectPromise).resolves.toBe('rejected')
  })
})
