import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { CloudRelayClient } from './cloud-relay-client'
import {
  createAccountRelayClient,
  type AccountRelayClient
} from '../../renderer/lib/remote/account-relay'

/**
 * End-to-end protocol coverage for the account relay path. An in-memory
 * protocol-conforming relay server routes `relay:data` frames between the
 * desktop (main-process CloudRelayClient) and the mobile (renderer
 * account-relay client), acknowledges delivery with `relay:ack`, and buffers
 * frames for a disconnected peer. This exercises the real wire protocol on both
 * production client paths rather than mock-only ACKs.
 */

const SECRET = 'control-secret'

class DuplexSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3

  readyState = DuplexSocket.CONNECTING
  sent: string[] = []
  peer: DuplexSocket | null = null
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number; reason?: string }) => void) | null = null
  onerror: (() => void) | null = null

  open(): void {
    this.readyState = DuplexSocket.OPEN
    this.onopen?.()
  }

  send(data: string): void {
    this.sent.push(data)
    this.peer?.deliver(data)
  }

  deliver(data: string): void {
    this.onmessage?.({ data })
  }

  close(): void {
    if (this.readyState === DuplexSocket.CLOSED) return
    this.readyState = DuplexSocket.CLOSED
    this.onclose?.({ code: 1000, reason: 'closed' })
    this.peer?.drop('closed')
  }

  drop(reason = 'closed'): void {
    if (this.readyState === DuplexSocket.CLOSED) return
    this.readyState = DuplexSocket.CLOSED
    this.onclose?.({ code: 1006, reason })
  }
}

interface BufferedFrame {
  data: string
}

class RelayServerHarness {
  desktopClient: DuplexSocket | null = null
  mobileClient: DuplexSocket | null = null
  ackCount = 0
  private readonly bufferedForDesktop: BufferedFrame[] = []

  constructor(private readonly ack = true) {}

  socketFactoryFor(role: 'desktop' | 'mobile'): () => DuplexSocket {
    return () => {
      const client = new DuplexSocket()
      const server = new DuplexSocket()
      client.peer = server
      server.peer = client
      server.onmessage = (event) => this.handleServerMessage(role, server, event.data)
      if (role === 'desktop') this.desktopClient = client
      else this.mobileClient = client
      return client
    }
  }

  openDesktop(): void {
    this.desktopClient?.open()
  }

  openMobile(online = true): void {
    if (!this.mobileClient) return
    // account-relay does not use onopen; mark the peer channel open directly.
    this.mobileClient.readyState = DuplexSocket.OPEN
    this.mobileClient.deliver(JSON.stringify({ type: 'relay:authenticated', online }))
  }

  dropDesktop(): void {
    this.desktopClient?.drop('network')
  }

  dropMobile(): void {
    this.mobileClient?.drop('network')
  }

  private handleServerMessage(
    role: 'desktop' | 'mobile',
    server: DuplexSocket,
    data: string
  ): void {
    const frame = JSON.parse(data) as { type: string; id?: number }
    if (frame.type === 'relay:authenticate') {
      server.peer?.deliver(JSON.stringify({ type: 'relay:authenticated', online: true }))
      // Deliver frames buffered while the desktop was offline.
      for (const buffered of this.bufferedForDesktop.splice(0)) {
        server.peer?.deliver(buffered.data)
      }
      return
    }
    if (frame.type === 'relay:data') {
      const other = role === 'desktop' ? this.mobileClient : this.desktopClient
      if (other && other.readyState === DuplexSocket.OPEN) {
        other.deliver(data)
      } else if (role === 'mobile') {
        this.bufferedForDesktop.push({ data })
      }
      if (this.ack && frame.id !== undefined) {
        this.ackCount += 1
        server.peer?.deliver(JSON.stringify({ type: 'relay:ack', id: frame.id }))
      }
    }
  }
}

interface DesktopHarness {
  server: RelayServerHarness
  desktop: CloudRelayClient
  onRpc: ReturnType<typeof vi.fn>
  disconnected: string[]
}

function createDesktop(
  server: RelayServerHarness,
  overrides: Partial<ConstructorParameters<typeof CloudRelayClient>[0]> = {}
): DesktopHarness {
  const disconnected: string[] = []
  const onRpc = vi.fn(async () => ({ ok: true, result: 'rpc-result' }))
  const desktop = new CloudRelayClient({
    apiOrigin: 'https://relay.example.test',
    deviceToken: 'desktop-token',
    controlSecret: SECRET,
    socketFactory: server.socketFactoryFor('desktop'),
    onAuthenticated: () => undefined,
    onDisconnected: (reason) => disconnected.push(reason),
    onRpc,
    reconnect: { initialDelayMs: 5, maxDelayMs: 10, random: () => 0.5 },
    ...overrides
  })
  return { server, desktop, onRpc, disconnected }
}

/** account-relay send() takes plaintext and encrypts internally. */
async function sendMobileData(mobile: AccountRelayClient, invoke: unknown): Promise<void> {
  await mobile.send(JSON.stringify(invoke))
}

beforeAll(() => {
  ;(globalThis as Record<string, unknown>)['window'] = {
    location: { origin: 'https://mobile.example.test' },
    setTimeout,
    clearTimeout
  }
})

afterAll(() => {
  delete (globalThis as Record<string, unknown>)['window']
})

describe('account relay end-to-end protocol', () => {
  it('routes frames between desktop and mobile with acknowledgement', async () => {
    const server = new RelayServerHarness()
    const { desktop, onRpc } = createDesktop(server)
    const mobileMessages: string[] = []
    const mobile = createAccountRelayClient({
      desktopId: 'desktop-1',
      mobileDeviceId: 'mobile-1',
      controlSecret: SECRET,
      socketFactory: server.socketFactoryFor('mobile'),
      onEvent: (event) => {
        if (event.kind === 'message') mobileMessages.push(event.data)
      }
    })

    const desktopConnect = desktop.connect()
    server.openDesktop()
    await vi.waitFor(() => expect(server.desktopClient?.sent.length).toBe(1))
    const mobileConnect = mobile.connect()
    server.openMobile()

    expect(await desktopConnect).toBeUndefined()
    expect(await mobileConnect).toBe('open')

    // Mobile invokes an RPC -> relay routes to desktop -> desktop answers.
    await sendMobileData(mobile, { rpc: 'invoke', id: 1, channel: 'chat', args: [] })
    await vi.waitFor(() => {
      expect(onRpc).toHaveBeenCalledWith('chat', [])
    })
    // Desktop's result is routed back to the mobile and decrypted there.
    await vi.waitFor(() => {
      expect(mobileMessages).toHaveLength(1)
      const body = JSON.parse(mobileMessages[0] ?? '{}') as { rpc: string; id: number }
      expect(body.rpc).toBe('result')
      expect(body.id).toBe(1)
    })
    // Desktop outbound frames carry monotonic ids and are acknowledged.
    const desktopDataFrames =
      server.desktopClient?.sent.filter((frame) => frame.includes('relay:data')) ?? []
    expect(desktopDataFrames.map((frame) => (JSON.parse(frame) as { id: number }).id)).toEqual([1])
    expect(server.ackCount).toBeGreaterThan(0)

    mobile.close()
    desktop.close()
  })

  it('suppresses a duplicate inbound frame delivered twice by the relay', async () => {
    const server = new RelayServerHarness()
    const messages: string[] = []
    const { desktop } = createDesktop(server)
    const mobile = createAccountRelayClient({
      desktopId: 'desktop-1',
      mobileDeviceId: 'mobile-1',
      controlSecret: SECRET,
      socketFactory: server.socketFactoryFor('mobile'),
      onEvent: (event) => {
        if (event.kind === 'message') messages.push(event.data)
      }
    })

    desktop.connect()
    server.openDesktop()
    await vi.waitFor(() => expect(server.desktopClient?.sent.length).toBe(1))
    void mobile.connect()
    server.openMobile()

    const { encryptPayload } = await import('../../renderer/lib/remote/session-security')
    const payload = await encryptPayload(SECRET, JSON.stringify({ greeting: 'hello' }))
    const frame = JSON.stringify({ type: 'relay:data', id: 42, payload })
    server.mobileClient?.deliver(frame)
    server.mobileClient?.deliver(frame)
    await vi.waitFor(() => {
      expect(messages).toEqual([JSON.stringify({ greeting: 'hello' })])
    })

    mobile.close()
    desktop.close()
  })

  it('replays the cached desktop answer for a repeated invoke id', async () => {
    const server = new RelayServerHarness()
    const { desktop, onRpc } = createDesktop(server)
    const mobile = createAccountRelayClient({
      desktopId: 'desktop-1',
      mobileDeviceId: 'mobile-1',
      controlSecret: SECRET,
      socketFactory: server.socketFactoryFor('mobile'),
      onEvent: () => undefined
    })

    desktop.connect()
    server.openDesktop()
    await vi.waitFor(() => expect(server.desktopClient?.sent.length).toBe(1))
    void mobile.connect()
    server.openMobile()

    await sendMobileData(mobile, { rpc: 'invoke', id: 9, channel: 'chat', args: [] })
    await vi.waitFor(() => expect(onRpc).toHaveBeenCalledTimes(1))
    await sendMobileData(mobile, { rpc: 'invoke', id: 9, channel: 'chat', args: [] })
    // Idempotent replay: the RPC is never re-invoked; the cached answer is re-sent.
    await vi.waitFor(() => {
      const frames =
        server.desktopClient?.sent.filter((frame) => frame.includes('relay:data')) ?? []
      expect(frames.length).toBe(2)
    })
    expect(onRpc).toHaveBeenCalledTimes(1)

    mobile.close()
    desktop.close()
  })

  it('preserves the desktop outbound queue across a same-client reconnect', async () => {
    // No server acks: the frame stays in-flight so the drop exercises the
    // client-side requeue and retransmission on reconnect.
    const server = new RelayServerHarness(false)
    const { desktop } = createDesktop(server)
    const mobileMessages: string[] = []
    const mobile = createAccountRelayClient({
      desktopId: 'desktop-1',
      mobileDeviceId: 'mobile-1',
      controlSecret: SECRET,
      socketFactory: server.socketFactoryFor('mobile'),
      onEvent: (event) => {
        if (event.kind === 'message') mobileMessages.push(event.data)
      }
    })

    desktop.connect()
    server.openDesktop()
    await vi.waitFor(() => expect(server.desktopClient?.sent.length).toBe(1))
    void mobile.connect()
    server.openMobile()

    // Desktop pushes an event while the channel is open (unacknowledged).
    await desktop.send({ rpc: 'event', channel: 'thread.updated', payload: 1 })
    await vi.waitFor(() => {
      expect(mobileMessages.some((message) => message.includes('thread.updated'))).toBe(true)
    })

    // The desktop socket drops; the client reconnects on the same instance and
    // retransmits the unacknowledged frame through the relay. The mobile's
    // duplicate suppression accepts the frame exactly once.
    server.dropDesktop()
    await new Promise((resolve) => setTimeout(resolve, 20))
    server.openDesktop()
    await vi.waitFor(() => {
      const retransmitted =
        server.desktopClient?.sent.filter((frame) => frame.includes('relay:data')) ?? []
      expect(retransmitted).toHaveLength(1)
      expect((JSON.parse(retransmitted[0] ?? '{}') as { id: number }).id).toBe(1)
    })
    expect(mobileMessages.filter((message) => message.includes('thread.updated'))).toHaveLength(1)

    mobile.close()
    desktop.close()
  })
})
