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
 * (CloudRelayClient) and a real mobile (account-relay client). Delivery is
 * confirmed END TO END: the hub retains each frame until the RECEIVER
 * acknowledges it, then forwards that receiver-generated ACK to the sender.
 * This covers offline/reconnect, disconnect-after-send, overflow, expiry, and
 * receiver-ACK clearing against the shared server logic.
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
 * `hub.forward`, forward receiver-generated `relay:ack` through
 * `hub.acknowledge`, and surface retryable `relay:nack` on rejection.
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
      if (frame.type === 'relay:ack' && typeof frame.id === 'string') {
        this.hub.acknowledge(this.desktopId, frame.id, this.role, this.peerSocket)
        return
      }
      if (frame.type === 'relay:data' && typeof frame.id === 'string') {
        const outcome = this.hub.forward(this.desktopId, this.role, this.peerSocket, data)
        if (!outcome.accepted) {
          client.deliver(
            JSON.stringify({
              type: 'relay:nack',
              id: frame.id,
              reason: outcome.reason ?? 'rejected'
            })
          )
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

  /** The peer socket identity registered with the hub. */
  socket(): RelaySocket {
    return this.peerSocket
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

/** Structural cast so the test socket satisfies the client's WebSocket type. */
function asWebSocket(client: DuplexSocket): WebSocket {
  return client as unknown as WebSocket
}

function wireMobile(
  hub: RelayHub,
  onMessage: (data: string) => void
): { client: DuplexSocket; mobile: AccountRelayClient; bridge: HubBridge } {
  const client = new DuplexSocket()
  const mobile = createAccountRelayClient({
    desktopId: DESKTOP_ID,
    mobileDeviceId: 'mobile-1',
    controlSecret: SECRET,
    socketFactory: () => asWebSocket(client),
    onEvent: (event) => {
      if (event.kind === 'message') onMessage(event.data)
    }
  })
  // Mobile is authenticated by the server without a client handshake frame.
  void mobile.connect()
  const bridge = new HubBridge(hub, DESKTOP_ID, 'mobile', client)
  return { client, mobile, bridge }
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
    socketFactory: () => asWebSocket(bridge.client),
    onAuthenticated: () => undefined,
    onDisconnected: () => undefined,
    onRpc: onRpc as unknown as (
      channel: string,
      args: unknown[]
    ) => Promise<{ ok: boolean; result?: unknown; message?: string }>,
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
  it('confirms delivery only after the receiver acknowledges end to end', async () => {
    const hub = new RelayHub()
    const mobileMessages: string[] = []
    const desktopWire = wireDesktop(hub)
    const desktop = createDesktopClient(hub, desktopWire.bridge, desktopWire.onRpc)
    desktop.connect()
    desktopWire.client.open()
    await vi.waitFor(() => expect(desktopWire.client.sent.length).toBe(1))
    desktopWire.client.deliver(
      JSON.stringify({ type: 'relay:authenticated', desktopId: DESKTOP_ID })
    )

    const mobileWire = wireMobile(hub, (data) => mobileMessages.push(data))
    authenticateMobile(mobileWire.client)

    // Mobile invokes an RPC; the desktop (receiver) processes it and the hub
    // routes the result back. No ACK is issued by the hub on acceptance.
    await sendMobileData(mobileWire.mobile, { rpc: 'invoke', id: 1, channel: 'chat', args: [] })
    await vi.waitFor(() => {
      expect(desktopWire.onRpc).toHaveBeenCalledWith('chat', [])
    })
    await vi.waitFor(() => {
      expect(mobileMessages).toHaveLength(1)
      const body = JSON.parse(mobileMessages[0] ?? '{}') as { rpc: string; id: number }
      expect(body.rpc).toBe('result')
      expect(body.id).toBe(1)
    })
    // Both directions resolve once the receivers confirm: retained work clears.
    await vi.waitFor(() => {
      expect(hub.outstandingCount()).toBe(0)
    })
    // The mobile received receiver-generated end-to-end ACKs for its frames.
    const mobileAcks = mobileWire.client.received.filter((frame) => frame.includes('relay:ack'))
    expect(mobileAcks.length).toBeGreaterThan(0)
    const desktopAcks = desktopWire.client.received.filter((frame) => frame.includes('relay:ack'))
    expect(desktopAcks.length).toBeGreaterThan(0)

    desktop.close()
    mobileWire.mobile.close()
  })

  it('buffers for an offline peer, no premature ACK, and replays on reconnect', async () => {
    const hub = new RelayHub()

    // Desktop connects + authenticates, then goes offline (hub-visible).
    const desktopBridge = wireDesktop(hub)
    const desktop = createDesktopClient(hub, desktopBridge.bridge, desktopBridge.onRpc)
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
      expect(hub.outstandingCount()).toBe(1)
    })
    // No receiver confirmation yet: the sender must NOT be acked prematurely.
    const mobileAckBefore = mobileWire.client.received.filter((frame) =>
      frame.includes('relay:ack')
    )
    expect(mobileAckBefore).toHaveLength(0)

    // Desktop reconnects (new socket) and the hub replays the buffered frame.
    const reconnected = wireDesktop(hub)
    const desktop2 = createDesktopClient(hub, reconnected.bridge, reconnected.onRpc)
    desktop2.connect()
    reconnected.client.open()
    reconnected.client.deliver(
      JSON.stringify({ type: 'relay:authenticated', desktopId: DESKTOP_ID })
    )
    reconnected.bridge.deliverReplay()
    await vi.waitFor(() => {
      expect(reconnected.onRpc).toHaveBeenCalled()
    })
    // The desktop (receiver) confirmed the replayed frame -> sender acked + cleared.
    await vi.waitFor(() => {
      expect(hub.outstandingCount()).toBe(0)
    })
    const mobileAckAfter = mobileWire.client.received.filter((frame) => frame.includes('relay:ack'))
    expect(mobileAckAfter.length).toBeGreaterThan(0)

    desktop2.close()
    mobileWire.mobile.close()
  })

  it('rejects on overflow with a retryable NACK instead of silently dropping', async () => {
    const hub = new RelayHub({ bufferLimit: 2 })
    const mobileWire = wireMobile(hub, () => undefined)
    authenticateMobile(mobileWire.client)
    for (const id of [1, 2, 3]) {
      await sendMobileData(mobileWire.mobile, { rpc: 'event', channel: 'a', payload: id })
    }
    await vi.waitFor(() => {
      expect(hub.outstandingCount()).toBe(2)
    })
    // The overflowing frame was rejected with an explicit retryable NACK.
    const nacks = mobileWire.client.received.filter((frame) => frame.includes('relay:nack'))
    expect(nacks).toHaveLength(1)
    const nack = JSON.parse(nacks[0] ?? '{}') as { id: number; reason?: string }
    expect(nack.reason).toBe('overflow')

    // The two accepted frames survive and are replayed on reconnect.
    const desktopBridge = wireDesktop(hub)
    const replayed = desktopBridge.bridge.deliverReplay()
    const { decryptPayload } = await import('../../renderer/lib/remote/session-security')
    const bodies = await Promise.all(
      replayed.map(async (frame) => {
        const parsed = JSON.parse(frame) as { payload: string }
        return JSON.parse(await decryptPayload(SECRET, parsed.payload)) as Record<string, unknown>
      })
    )
    expect(bodies.map((body) => body['payload'])).toEqual([1, 2])
    mobileWire.mobile.close()
  })

  it('expires accepted frames after the TTL and NACKs the sender', async () => {
    const now = 1_000
    const hub = new RelayHub({ bufferTtlMs: 5_000, now: () => now })
    const mobileWire = wireMobile(hub, () => undefined)
    authenticateMobile(mobileWire.client)
    await sendMobileData(mobileWire.mobile, { rpc: 'event', channel: 'a', payload: 1 })
    await vi.waitFor(() => {
      expect(hub.outstandingCount()).toBe(1)
    })
    ;(hub as unknown as { now: () => number }).now = () => now + 6_000
    expect(hub.sweep()).toBe(1)
    expect(hub.outstandingCount()).toBe(0)
    const nacks = mobileWire.client.received.filter((frame) => frame.includes('relay:nack'))
    expect(nacks).toHaveLength(1)
    const nack = JSON.parse(nacks[0] ?? '{}') as { id: number; reason?: string }
    expect(nack.reason).toBe('expired')
    mobileWire.mobile.close()
  })

  it('survives a sender disconnect-after-send: retained work still resolves end to end', async () => {
    const hub = new RelayHub()

    // Receiver (desktop) offline from the start.
    // Sender (mobile) sends while the receiver is offline -> retained, no ack.
    const mobileWire = wireMobile(hub, () => undefined)
    authenticateMobile(mobileWire.client)
    await sendMobileData(mobileWire.mobile, { rpc: 'invoke', id: 7, channel: 'chat', args: [] })
    await vi.waitFor(() => {
      expect(hub.outstandingCount()).toBe(1)
    })
    expect(mobileWire.client.received.filter((frame) => frame.includes('relay:ack'))).toHaveLength(
      0
    )

    // The sender disconnects before the receiver can confirm.
    mobileWire.bridge.disconnect()
    mobileWire.client.drop('offline')

    // The receiver reconnects, gets the replayed frame, and confirms it. The
    // hub forwards the ACK to the (now stale) sender socket harmlessly and
    // releases the retained work.
    const desktopWire = wireDesktop(hub)
    const desktop = createDesktopClient(hub, desktopWire.bridge, desktopWire.onRpc)
    desktop.connect()
    desktopWire.client.open()
    await vi.waitFor(() => expect(desktopWire.client.sent.length).toBe(1))
    desktopWire.client.deliver(
      JSON.stringify({ type: 'relay:authenticated', desktopId: DESKTOP_ID })
    )
    desktopWire.bridge.deliverReplay()
    await vi.waitFor(() => {
      expect(desktopWire.onRpc).toHaveBeenCalledTimes(1)
    })
    // The replayed frame was confirmed end to end: the sender (now stale)
    // received the receiver-generated ACK and the retained entry is released.
    const mobileAck = mobileWire.client.received.find((frame) => frame.includes('relay:ack'))
    expect(mobileAck).toBeDefined()
    // Only the desktop's result (buffered for the offline mobile) remains.
    await vi.waitFor(() => {
      expect(hub.outstandingCount()).toBe(1)
    })

    desktop.close()
  })

  it('uses epoch-scoped wire ids so a reloaded peer is not deduplicated away', async () => {
    const hub = new RelayHub()
    // First mobile client sends an event.
    const firstMobile = wireMobile(hub, () => undefined)
    authenticateMobile(firstMobile.client)
    await sendMobileData(firstMobile.mobile, { rpc: 'event', channel: 'a', payload: 1 })
    const firstId = firstMobile.client.sent
      .filter((frame) => frame.includes('relay:data'))
      .map((frame) => (JSON.parse(frame) as { id: string }).id)[0]
    expect(firstId).toMatch(/^[0-9a-f-]+:\d+$/)

    // A reloaded client gets a fresh epoch -> a non-overlapping id space.
    const secondMobile = wireMobile(hub, () => undefined)
    authenticateMobile(secondMobile.client)
    await sendMobileData(secondMobile.mobile, { rpc: 'event', channel: 'a', payload: 2 })
    const secondId = secondMobile.client.sent
      .filter((frame) => frame.includes('relay:data'))
      .map((frame) => (JSON.parse(frame) as { id: string }).id)[0]
    // Distinct sender instances (UUID prefix) across reloads.
    const instanceOf = (id: string): string => id.split(':')[0] ?? ''
    expect(instanceOf(secondId)).not.toBe(instanceOf(firstId))

    firstMobile.mobile.close()
    secondMobile.mobile.close()
  })

  it('rebinds the retained sender on identical retransmission after a sender reconnect', async () => {
    const hub = new RelayHub()

    // Mobile with a socket factory that hands out a NEW socket + hub bridge per
    // connection so the self-reconnect observes a different sender socket.
    const mobileWires: Array<{ client: DuplexSocket; bridge: HubBridge }> = []
    const mobile = createAccountRelayClient({
      desktopId: DESKTOP_ID,
      mobileDeviceId: 'mobile-1',
      controlSecret: SECRET,
      reconnect: { initialDelayMs: 5, maxDelayMs: 10, random: () => 0.5 },
      socketFactory: () => {
        const client = new DuplexSocket()
        const bridge = new HubBridge(hub, DESKTOP_ID, 'mobile', client)
        mobileWires.push({ client, bridge })
        return asWebSocket(client)
      },
      onEvent: () => undefined
    })
    void mobile.connect()
    authenticateMobile(mobileWires[0].client)

    // Desktop (receiver) is OFFLINE. Mobile sends an invoke; the hub retains it
    // with the FIRST sender socket (no receiver ACK yet).
    await sendMobileData(mobile, { rpc: 'invoke', id: 7, channel: 'chat', args: [] })
    await vi.waitFor(() => expect(hub.outstandingCount()).toBe(1))
    expect(mobileWires[0].client.received.filter((f) => f.includes('relay:ack'))).toHaveLength(0)

    // The sender disconnects (socket + hub-visible), then reconnects with a new
    // socket; the client's queue flush retransmits the identical retained frame,
    // which the hub accepts and REBINDS to the new authenticated sender.
    mobileWires[0].bridge.disconnect()
    mobileWires[0].client.drop('offline')
    await new Promise((resolve) => setTimeout(resolve, 15))
    authenticateMobile(mobileWires[1].client)
    await vi.waitFor(() => {
      expect(mobileWires[1].client.sent.some((f) => f.includes('relay:data'))).toBe(true)
      expect(hub.outstandingCount()).toBe(1)
    })

    // The receiver now connects; the hub replays the buffered frame, the
    // desktop processes it and ACKs, and the ACK reaches the NEW sender socket.
    const desktopWire = wireDesktop(hub)
    const desktop = createDesktopClient(hub, desktopWire.bridge, desktopWire.onRpc)
    desktop.connect()
    desktopWire.client.open()
    await vi.waitFor(() => expect(desktopWire.client.sent.length).toBe(1))
    desktopWire.client.deliver(
      JSON.stringify({ type: 'relay:authenticated', desktopId: DESKTOP_ID })
    )
    desktopWire.bridge.deliverReplay()
    await vi.waitFor(() => {
      expect(desktopWire.onRpc).toHaveBeenCalledTimes(1)
      expect(hub.outstandingCount()).toBe(0)
    })
    // The new sender received exactly one receiver-generated ACK; the stale
    // socket received none.
    const newAcks = mobileWires[1].client.received.filter((f) => f.includes('relay:ack'))
    expect(newAcks).toHaveLength(1)
    const staleAcks = mobileWires[0].client.received.filter((f) => f.includes('relay:ack'))
    expect(staleAcks).toHaveLength(0)

    mobile.close()
    desktop.close()
  })
})

describe('RelayHub loss-safety unit semantics', () => {
  function recordingSocket(): { socket: RelaySocket; sent: string[] } {
    const sent: string[] = []
    return {
      sent,
      socket: {
        send: (data) => sent.push(data),
        close: () => undefined
      }
    }
  }

  it('does not ack on server acceptance — only on receiver confirmation', () => {
    const hub = new RelayHub()
    const sender = recordingSocket()
    const receiver = recordingSocket()
    hub.connectMobile(DESKTOP_ID, sender.socket)
    hub.connectDesktop(DESKTOP_ID, receiver.socket)

    const outcome = hub.forward(
      DESKTOP_ID,
      'mobile',
      sender.socket,
      JSON.stringify({
        type: 'relay:data',
        id: '12345678-1234-1234-1234-123456789abc:1',
        payload: 'x'
      })
    )
    expect(outcome).toEqual({ accepted: true, delivered: true })
    // No premature ACK from the hub.
    expect(sender.sent).toEqual([])
    expect(hub.outstandingCount()).toBe(1)

    // The receiver confirms -> the receiver-generated ACK is forwarded to the
    // sender and the retained frame is released.
    expect(
      hub.acknowledge(
        DESKTOP_ID,
        '12345678-1234-1234-1234-123456789abc:1',
        'desktop',
        receiver.socket
      )
    ).toBe(true)
    expect(sender.sent).toEqual([
      JSON.stringify({ type: 'relay:ack', id: '12345678-1234-1234-1234-123456789abc:1' })
    ])
    expect(hub.outstandingCount()).toBe(0)
    expect(
      hub.acknowledge(
        DESKTOP_ID,
        '12345678-1234-1234-1234-123456789abc:1',
        'desktop',
        receiver.socket
      )
    ).toBe(false)
  })

  it('rejects a malformed or non-positive wire id without accepting it', () => {
    const hub = new RelayHub()
    const sender = recordingSocket()
    const receiver = recordingSocket()
    hub.connectMobile(DESKTOP_ID, sender.socket)
    hub.connectDesktop(DESKTOP_ID, receiver.socket)

    expect(
      hub.forward(
        DESKTOP_ID,
        'mobile',
        sender.socket,
        JSON.stringify({ type: 'relay:data', payload: 'x' })
      )
    ).toEqual({ accepted: false, delivered: false, reason: 'invalid-id' })
    expect(
      hub.forward(
        DESKTOP_ID,
        'mobile',
        sender.socket,
        JSON.stringify({ type: 'relay:data', id: 'not-a-valid-id', payload: 'x' })
      )
    ).toEqual({ accepted: false, delivered: false, reason: 'invalid-id' })
    expect(
      hub.forward(
        DESKTOP_ID,
        'mobile',
        sender.socket,
        JSON.stringify({ type: 'relay:data', id: 'not-a-uuid:0', payload: 'x' })
      )
    ).toEqual({ accepted: false, delivered: false, reason: 'invalid-id' })
    expect(hub.outstandingCount()).toBe(0)
    expect(receiver.sent).toEqual([])
  })

  it('never lets a sender self-ACK — the ACK must come from the intended receiver', () => {
    const hub = new RelayHub()
    const sender = recordingSocket()
    const receiver = recordingSocket()
    hub.connectMobile(DESKTOP_ID, sender.socket)
    hub.connectDesktop(DESKTOP_ID, receiver.socket)
    const outcome = hub.forward(
      DESKTOP_ID,
      'mobile',
      sender.socket,
      JSON.stringify({
        type: 'relay:data',
        id: '12345678-1234-1234-1234-123456789abc:2',
        payload: 'x'
      })
    )
    expect(outcome.accepted).toBe(true)
    // The sender (mobile) tries to ack its own frame -> rejected, no ACK.
    expect(
      hub.acknowledge(DESKTOP_ID, '12345678-1234-1234-1234-123456789abc:2', 'mobile', sender.socket)
    ).toBe(false)
    expect(hub.outstandingCount()).toBe(1)
    expect(sender.sent).toEqual([])
    // The intended receiver (desktop) acking with a non-live socket is also
    // rejected; the current live receiver socket succeeds.
    expect(
      hub.acknowledge(
        DESKTOP_ID,
        '12345678-1234-1234-1234-123456789abc:2',
        'desktop',
        sender.socket
      )
    ).toBe(false)
    expect(
      hub.acknowledge(
        DESKTOP_ID,
        '12345678-1234-1234-1234-123456789abc:2',
        'desktop',
        receiver.socket
      )
    ).toBe(true)
    expect(hub.outstandingCount()).toBe(0)
    expect(sender.sent).toEqual([
      JSON.stringify({ type: 'relay:ack', id: '12345678-1234-1234-1234-123456789abc:2' })
    ])
  })

  it('rejects a cross-direction wire-id collision instead of aliasing it', () => {
    const hub = new RelayHub()
    const mobile = recordingSocket()
    const desktop = recordingSocket()
    hub.connectMobile(DESKTOP_ID, mobile.socket)
    hub.connectDesktop(DESKTOP_ID, desktop.socket)
    // Mobile sends id 500; retained awaiting receiver confirmation.
    const mobileFrame = JSON.stringify({
      type: 'relay:data',
      id: '12345678-1234-1234-1234-123456789abc:3',
      payload: 'mobile'
    })
    expect(hub.forward(DESKTOP_ID, 'mobile', mobile.socket, mobileFrame).accepted).toBe(true)
    // Desktop tries the same wire id in the opposite direction -> rejected.
    const desktopFrame = JSON.stringify({
      type: 'relay:data',
      id: '12345678-1234-1234-1234-123456789abc:3',
      payload: 'desktop'
    })
    expect(hub.forward(DESKTOP_ID, 'desktop', desktop.socket, desktopFrame)).toEqual({
      accepted: false,
      delivered: false,
      reason: 'id-collision'
    })
    // A same-direction retransmission is accepted and re-delivered.
    expect(hub.forward(DESKTOP_ID, 'mobile', mobile.socket, mobileFrame).accepted).toBe(true)
    expect(hub.outstandingCount()).toBe(1)
  })

  it('never aliases a same-direction different message as a retransmission', () => {
    const hub = new RelayHub()
    const mobile = recordingSocket()
    const desktop = recordingSocket()
    hub.connectMobile(DESKTOP_ID, mobile.socket)
    hub.connectDesktop(DESKTOP_ID, desktop.socket)
    // Two distinct messages from the same sender (different sequence ids) are
    // two separate outstanding entries, never treated as the same frame.
    const first = JSON.stringify({
      type: 'relay:data',
      id: '12345678-1234-1234-1234-123456789abc:4',
      payload: 'one'
    })
    const second = JSON.stringify({
      type: 'relay:data',
      id: '12345678-1234-1234-1234-123456789abc:5',
      payload: 'two'
    })
    expect(hub.forward(DESKTOP_ID, 'mobile', mobile.socket, first).accepted).toBe(true)
    expect(hub.forward(DESKTOP_ID, 'mobile', mobile.socket, second).accepted).toBe(true)
    expect(hub.outstandingCount()).toBe(2)
    expect(desktop.sent.filter((f) => f.includes('relay:data'))).toHaveLength(2)
    // A genuine retransmission of the FIRST message re-delivers it (3 data
    // frames) while still resolving to a single retained entry.
    expect(hub.forward(DESKTOP_ID, 'mobile', mobile.socket, first).accepted).toBe(true)
    expect(hub.outstandingCount()).toBe(2)
    expect(desktop.sent.filter((f) => f.includes('relay:data'))).toHaveLength(3)
    expect(
      hub.acknowledge(
        DESKTOP_ID,
        '12345678-1234-1234-1234-123456789abc:4',
        'desktop',
        desktop.socket
      )
    ).toBe(true)
    expect(
      hub.acknowledge(
        DESKTOP_ID,
        '12345678-1234-1234-1234-123456789abc:5',
        'desktop',
        desktop.socket
      )
    ).toBe(true)
    expect(hub.outstandingCount()).toBe(0)
  })

  it('rejects on overflow (NACK) instead of dropping already-accepted work', () => {
    const hub = new RelayHub({ bufferLimit: 2 })
    const sender = recordingSocket()
    hub.connectMobile(DESKTOP_ID, sender.socket)
    // Receiver offline: frames are retained, then the third overflows.
    for (const seq of [1, 2]) {
      const outcome = hub.forward(
        DESKTOP_ID,
        'mobile',
        sender.socket,
        JSON.stringify({
          type: 'relay:data',
          id: `12345678-1234-1234-1234-123456789abc:${seq}`,
          payload: String(seq)
        })
      )
      expect(outcome.accepted).toBe(true)
    }
    const overflow = hub.forward(
      DESKTOP_ID,
      'mobile',
      sender.socket,
      JSON.stringify({
        type: 'relay:data',
        id: '12345678-1234-1234-1234-123456789abc:3',
        payload: '3'
      })
    )
    expect(overflow).toEqual({ accepted: false, delivered: false, reason: 'overflow' })
    expect(hub.outstandingCount()).toBe(2)
  })

  it('expires retained frames with a retryable NACK, never silently', () => {
    const now = 1_000
    const hub = new RelayHub({ bufferTtlMs: 5_000, now: () => now })
    const sender = recordingSocket()
    hub.connectMobile(DESKTOP_ID, sender.socket)
    hub.forward(
      DESKTOP_ID,
      'mobile',
      sender.socket,
      JSON.stringify({
        type: 'relay:data',
        id: '12345678-1234-1234-1234-123456789abc:9',
        payload: 'x'
      })
    )
    ;(hub as unknown as { now: () => number }).now = () => now + 6_000
    expect(hub.sweep()).toBe(1)
    expect(hub.outstandingCount()).toBe(0)
    expect(sender.sent).toEqual([
      JSON.stringify({
        type: 'relay:nack',
        id: '12345678-1234-1234-1234-123456789abc:9',
        reason: 'expired'
      })
    ])
  })

  it('forwards a late receiver ACK to a stale (disconnected) sender harmlessly', () => {
    const hub = new RelayHub()
    const sender = recordingSocket()
    const receiver = recordingSocket()
    hub.connectMobile(DESKTOP_ID, sender.socket)
    hub.connectDesktop(DESKTOP_ID, receiver.socket)
    hub.forward(
      DESKTOP_ID,
      'mobile',
      sender.socket,
      JSON.stringify({
        type: 'relay:data',
        id: '12345678-1234-1234-1234-123456789abc:11',
        payload: 'x'
      })
    )
    // The sender disconnects after sending; its socket is no longer live.
    hub.disconnect(DESKTOP_ID, 'mobile', sender.socket)
    // The receiver confirms; the ACK is authenticated (receiver role + its
    // current socket), forwarded to the stale sender socket (harmless), and the
    // retained frame is released.
    expect(
      hub.acknowledge(
        DESKTOP_ID,
        '12345678-1234-1234-1234-123456789abc:11',
        'desktop',
        receiver.socket
      )
    ).toBe(true)
    expect(hub.outstandingCount()).toBe(0)
  })

  it('re-delivers a retransmission of an accepted frame and re-acks on confirm', () => {
    const hub = new RelayHub()
    const sender = recordingSocket()
    const receiver = recordingSocket()
    hub.connectMobile(DESKTOP_ID, sender.socket)
    hub.connectDesktop(DESKTOP_ID, receiver.socket)
    const frame = JSON.stringify({
      type: 'relay:data',
      id: '12345678-1234-1234-1234-123456789abc:5',
      payload: 'x'
    })
    hub.forward(DESKTOP_ID, 'mobile', sender.socket, frame)
    // Retransmission (same id) is accepted and delivered again.
    const retry = hub.forward(DESKTOP_ID, 'mobile', sender.socket, frame)
    expect(retry).toEqual({ accepted: true, delivered: true })
    expect(receiver.sent.filter((f) => f.includes('relay:data'))).toHaveLength(2)
    expect(hub.outstandingCount()).toBe(1)
    // One receiver confirmation resolves the single retained entry.
    expect(
      hub.acknowledge(
        DESKTOP_ID,
        '12345678-1234-1234-1234-123456789abc:5',
        'desktop',
        receiver.socket
      )
    ).toBe(true)
    expect(hub.outstandingCount()).toBe(0)
  })
})
