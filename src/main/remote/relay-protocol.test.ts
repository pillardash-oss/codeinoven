import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { CloudRelayClient } from './cloud-relay-client'
import {
  createAccountRelayClient,
  type AccountRelayClient
} from '../../renderer/lib/remote/account-relay'
import {
  RelayHub,
  type RelayRole,
  type RelaySocket
} from '../../../services/remote-control/relay-hub'

/**
 * End-to-end protocol coverage that exercises the REAL production relay hub
 * (`services/remote-control/relay-hub.ts` — the routing logic the remote-control
 * server's `relayMessage` handler delegates to) between a real desktop
 * (CloudRelayClient) and a real mobile (account-relay client). This verifies
 * the wire protocol, ACK-on-accept delivery semantics, offline buffering,
 * reconnect replay, TTL expiry, deterministic overflow, and epoch-scoped ids
 * against the shared server logic rather than a synthetic harness.
 */

const SECRET = 'control-secret'
const DESKTOP_ID = 'desktop-1'

class DuplexSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3

  readyState = DuplexSocket.CONNECTING
  sent: string[] = []
  received: string[] = []
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
    this.received.push(data)
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

/**
 * Bridges one client socket to the real RelayHub exactly as the server's
 * `relayMessage` handler does: register the peer, route `relay:data` through
 * `hub.forward`, and acknowledge only frames the hub accepted for delivery.
 */
class HubBridge {
  readonly client: DuplexSocket
  private readonly pendingReplay: string[]
  private readonly peerSocket: RelaySocket

  constructor(
    private readonly hub: RelayHub,
    private readonly desktopId: string,
    private readonly role: RelayRole,
    client: DuplexSocket
  ) {
    this.client = client
    this.peerSocket = {
      send: (data) => client.deliver(data),
      close: (code, reason) => client.drop(`${code}:${reason}`)
    }
    this.pendingReplay =
      role === 'desktop'
        ? hub.connectDesktop(desktopId, this.peerSocket)
        : hub.connectMobile(desktopId, this.peerSocket)
    client.send = (data) => {
      client.sent.push(data)
      let frame: { type?: string; id?: unknown }
      try {
        frame = JSON.parse(data) as { type?: string; id?: unknown }
      } catch {
        return
      }
      if (frame.type === 'relay:data' && typeof frame.id === 'number') {
        const outcome = hub.forward(desktopId, role, data)
        if (outcome.accepted) {
          client.deliver(JSON.stringify({ type: 'relay:ack', id: frame.id }))
        }
      }
    }
  }

  /** Deliver buffered frames the hub returned for a reconnect, post-auth. */
  deliverReplay(): string[] {
    const frames = [...this.pendingReplay]
    for (const frame of frames) this.client.deliver(frame)
    return frames
  }

  /** Remove this peer from the hub (simulates the socket closing server-side). */
  disconnect(): void {
    this.hub.disconnect(this.desktopId, this.role, this.peerSocket)
  }
}

function wireDesktop(hub: RelayHub): {
  client: DuplexSocket
  onRpc: ReturnType<typeof vi.fn>
  bridge: HubBridge
} {
  const client = new DuplexSocket()
  const onRpc = vi.fn(async () => ({ ok: true, result: 'rpc-result' }))
  const bridge = new HubBridge(hub, DESKTOP_ID, 'desktop', client)
  return { client, onRpc, bridge }
}

function wireMobile(
  hub: RelayHub,
  onMessage: (data: string) => void
): { client: DuplexSocket; mobile: AccountRelayClient } {
  const client = new DuplexSocket()
  const mobile = createAccountRelayClient({
    desktopId: DESKTOP_ID,
    mobileDeviceId: 'mobile-1',
    controlSecret: SECRET,
    socketFactory: () => client,
    onEvent: (event) => {
      if (event.kind === 'message') onMessage(event.data)
    }
  })
  // Mobile is authenticated by the server without a client handshake frame.
  void mobile.connect()
  new HubBridge(hub, DESKTOP_ID, 'mobile', client)
  return { client, mobile }
}

/** Server accepts the mobile: mark the channel open and deliver authenticated. */
function authenticateMobile(client: DuplexSocket, online = true): void {
  client.readyState = DuplexSocket.OPEN
  client.deliver(JSON.stringify({ type: 'relay:authenticated', online }))
}

function createDesktopClient(
  hub: RelayHub,
  bridge: HubBridge,
  onRpc: ReturnType<typeof vi.fn>
): CloudRelayClient {
  return new CloudRelayClient({
    apiOrigin: 'https://relay.example.test',
    deviceToken: 'desktop-token',
    controlSecret: SECRET,
    socketFactory: () => bridge.client,
    onAuthenticated: () => undefined,
    onDisconnected: () => undefined,
    onRpc,
    reconnect: { initialDelayMs: 5, maxDelayMs: 10, random: () => 0.5 }
  })
}

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

describe('account relay end-to-end protocol (real RelayHub)', () => {
  it('routes frames through the hub with ACK-on-accepted-delivery', async () => {
    const hub = new RelayHub()
    const desktopMessages: string[] = []
    const mobileMessages: string[] = []

    // Desktop connects + authenticates.
    const desktopBridge = wireDesktop(hub)
    const desktop = createDesktopClient(hub, desktopBridge, desktopBridge.onRpc)
    desktop.connect()
    desktopBridge.client.open()
    await vi.waitFor(() => expect(desktopBridge.client.sent.length).toBe(1))
    desktopBridge.client.deliver(
      JSON.stringify({ type: 'relay:authenticated', desktopId: DESKTOP_ID })
    )

    // Mobile connects + authenticates.
    const mobileWire = wireMobile(hub, (data) => mobileMessages.push(data))
    authenticateMobile(mobileWire.client)

    // Mobile invokes an RPC -> hub routes to desktop -> desktop answers -> hub
    // routes the result back to the mobile.
    await sendMobileData(mobileWire.mobile, { rpc: 'invoke', id: 1, channel: 'chat', args: [] })
    await vi.waitFor(() => {
      expect(desktopBridge.onRpc).toHaveBeenCalledWith('chat', [])
    })
    await vi.waitFor(() => {
      expect(mobileMessages).toHaveLength(1)
      const body = JSON.parse(mobileMessages[0] ?? '{}') as { rpc: string; id: number }
      expect(body.rpc).toBe('result')
      expect(body.id).toBe(1)
    })

    // Every accepted relay:data frame is acknowledged to its sender.
    const desktopAcks = desktopBridge.client.received.filter((frame) => frame.includes('relay:ack'))
    expect(desktopAcks.length).toBeGreaterThan(0)
    const mobileAcks = mobileWire.client.received.filter((frame) => frame.includes('relay:ack'))
    expect(mobileAcks.length).toBeGreaterThan(0)
    expect(desktopMessages).toEqual([])

    desktop.close()
    mobileWire.mobile.close()
  })

  it('buffers for an offline peer and replays on reconnect', async () => {
    const hub = new RelayHub()

    // Desktop connects + authenticates, then goes offline (hub-visible).
    const desktopBridge = wireDesktop(hub)
    const desktop = createDesktopClient(hub, desktopBridge, desktopBridge.onRpc)
    desktop.connect()
    desktopBridge.client.open()
    await vi.waitFor(() => expect(desktopBridge.client.sent.length).toBe(1))
    desktopBridge.client.deliver(
      JSON.stringify({ type: 'relay:authenticated', desktopId: DESKTOP_ID })
    )
    desktopBridge.bridge.disconnect()
    desktopBridge.client.drop('offline')

    // Mobile stays online and sends while the desktop is offline.
    const mobileWire = wireMobile(hub, () => undefined)
    authenticateMobile(mobileWire.client)
    await sendMobileData(mobileWire.mobile, { rpc: 'invoke', id: 5, channel: 'chat', args: [] })
    await vi.waitFor(() => {
      expect(hub.bufferedCount()).toBe(1)
    })
    // The offline frame is still accepted (buffered) and acknowledged.
    const mobileAck = mobileWire.client.received.find((frame) => frame.includes('relay:ack'))
    expect(mobileAck).toBeDefined()

    // Desktop reconnects (new socket) and the hub replays the buffered frame.
    const reconnected = wireDesktop(hub)
    const desktop2 = createDesktopClient(hub, reconnected.bridge, reconnected.onRpc)
    desktop2.connect()
    reconnected.client.open()
    reconnected.client.deliver(
      JSON.stringify({ type: 'relay:authenticated', desktopId: DESKTOP_ID })
    )
    reconnected.bridge.deliverReplay()
    await vi.waitFor(async () => {
      expect(reconnected.onRpc).toHaveBeenCalled()
    })
    expect(hub.bufferedCount()).toBe(0)

    desktop2.close()
    mobileWire.mobile.close()
  })

  it('drops the oldest buffered frame deterministically at the buffer limit', async () => {
    const hub = new RelayHub({ bufferLimit: 2 })
    const mobileWire = wireMobile(hub, () => undefined)
    authenticateMobile(mobileWire.client)
    for (const id of [1, 2, 3]) {
      await sendMobileData(mobileWire.mobile, { rpc: 'event', channel: 'a', payload: id })
    }
    await vi.waitFor(() => {
      expect(hub.bufferedCount()).toBe(2)
    })
    // Reconnect the desktop and inspect which frames survived the overflow.
    const desktopBridge = wireDesktop(hub)
    const replayed = desktopBridge.bridge.deliverReplay()
    const { decryptPayload } = await import('../../renderer/lib/remote/session-security')
    const bodies = await Promise.all(
      replayed.map(async (frame) => {
        const parsed = JSON.parse(frame) as { payload: string }
        return JSON.parse(await decryptPayload(SECRET, parsed.payload)) as Record<string, unknown>
      })
    )
    expect(bodies.map((body) => body['payload'])).toEqual([2, 3])
    mobileWire.mobile.close()
  })

  it('expires buffered frames after the TTL', async () => {
    const now = 1_000
    const hub = new RelayHub({ bufferTtlMs: 5_000, now: () => now })
    const mobileWire = wireMobile(hub, () => undefined)
    authenticateMobile(mobileWire.client)
    await sendMobileData(mobileWire.mobile, { rpc: 'event', channel: 'a', payload: 1 })
    await vi.waitFor(() => {
      expect(hub.bufferedCount()).toBe(1)
    })
    ;(hub as unknown as { now: () => number }).now = () => now + 6_000
    expect(hub.sweep()).toBe(1)
    expect(hub.bufferedCount()).toBe(0)
    mobileWire.mobile.close()
  })

  it('uses epoch-scoped wire ids so a reloaded peer is not deduplicated away', async () => {
    const hub = new RelayHub()
    // First mobile client sends an event.
    const firstMobile = wireMobile(hub, () => undefined)
    authenticateMobile(firstMobile.client)
    await sendMobileData(firstMobile.mobile, { rpc: 'event', channel: 'a', payload: 1 })
    const firstId = firstMobile.client.sent
      .filter((frame) => frame.includes('relay:data'))
      .map((frame) => (JSON.parse(frame) as { id: number }).id)[0]
    expect(firstId).toBeGreaterThanOrEqual(2 ** 32)

    // A reloaded client gets a fresh epoch -> a non-overlapping id space.
    const secondMobile = wireMobile(hub, () => undefined)
    authenticateMobile(secondMobile.client)
    await sendMobileData(secondMobile.mobile, { rpc: 'event', channel: 'a', payload: 2 })
    const secondId = secondMobile.client.sent
      .filter((frame) => frame.includes('relay:data'))
      .map((frame) => (JSON.parse(frame) as { id: number }).id)[0]
    const epochOf = (id: number): number => Math.floor(id / 2 ** 32)
    expect(epochOf(secondId)).not.toBe(epochOf(firstId))

    firstMobile.mobile.close()
    secondMobile.mobile.close()
  })
})
