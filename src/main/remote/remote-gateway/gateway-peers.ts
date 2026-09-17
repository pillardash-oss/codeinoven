/**
 * Peer session handling for the remote gateway.
 *
 * Peer sessions use the `PEER_SECRET_AUTH` HMAC handshake and AES-GCM payload
 * encryption. Upgrades require `Sec-WebSocket-Version: 13`, are origin-checked,
 * and unauthenticated peers are evicted after a timeout. Only one phone peer is
 * live per device id   a second peer for the same device takes over, matching
 * the takeover-rejection semantics required by the spec.
 *
 * This module owns connection state only; the gateway owns the listeners and
 * hands socket upgrades here.
 */

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { randomBytes } from 'node:crypto'
import { Logger } from '../../system/logger'
import {
  buildUpgradeResponse,
  decodeWsFrames,
  encodeCloseFrame,
  encodeTextFrame
} from '../ws-frames'
import { decryptPayload, encryptPayload } from '../../../renderer/lib/remote/session-security'
import type { RemoteRpcDeviceContext, RemoteScope } from '../../../lib/remote-rpc'
import type { RemoteDeviceInfo } from '../remote-types'
import type { GatewayHandlers } from './gateway-types'
import { originAllowed } from './gateway-hosts'

interface PeerConnection {
  socket: Duplex
  buffer: Buffer
  authenticated: boolean
  closing: boolean
  deviceId: string
  deviceName: string
  connectedAt: number
  authChallenge: string
  /** Enrolled-device record resolved by the `authenticateDevice` handler. */
  device?: RemoteDeviceInfo
  sessionId: string
  originPolicy: 'strict' | 'local'
  /** Per-device send chain: encrypted event deltas must reach the browser in source order. */
  sendQueue: Promise<void>
}

const UNAUTHENTICATED_TIMEOUT_MS = 10_000
const MAX_PEER_BUFFER_BYTES = 1024 * 1024

export interface GatewayPeerRegistryOptions {
  handlers: GatewayHandlers
  /** Reads the current control secret (it can be rotated while running). */
  getPeerSecret: () => string | null
  unauthenticatedTimeoutMs?: number
  allowedOrigins?: string[]
  /** Whether the owning gateway has stopped (peer async work must then no-op). */
  isStopped: () => boolean
}

export class GatewayPeerRegistry {
  private readonly peers = new Set<PeerConnection>()
  /** Authenticated live peers, keyed by device id. */
  private readonly livePeers = new Map<string, PeerConnection>()

  constructor(private readonly options: GatewayPeerRegistryOptions) {}

  handleUpgrade(request: IncomingMessage, socket: Duplex, originPolicy: 'strict' | 'local'): void {
    if (request.headers['sec-websocket-version'] !== '13') {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return
    }
    if (!originAllowed(this.options.allowedOrigins, request, originPolicy)) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    const clientKey = request.headers['sec-websocket-key']
    if (typeof clientKey !== 'string') {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return
    }
    socket.write(buildUpgradeResponse(clientKey))

    const peer: PeerConnection = {
      socket,
      buffer: Buffer.alloc(0),
      authenticated: false,
      closing: false,
      deviceId: '',
      deviceName: '',
      connectedAt: 0,
      authChallenge: randomBytes(32).toString('base64url'),
      sessionId: randomBytes(16).toString('base64url'),
      originPolicy,
      sendQueue: Promise.resolve()
    }
    this.peers.add(peer)
    socketSend(peer, { type: 'remote:challenge', nonce: peer.authChallenge })

    const closePeer = (): void => {
      if (!this.peers.has(peer)) return
      this.peers.delete(peer)
      if (this.livePeers.get(peer.deviceId) === peer) {
        this.livePeers.delete(peer.deviceId)
        this.notifyDevicesChange()
      }
    }

    // Unauthenticated peers are evicted after a timeout so a LAN client cannot
    // hold the peer set open forever.
    const authTimer = setTimeout(() => {
      if (!peer.authenticated) {
        peer.closing = true
        closePeer()
        socket.destroy()
      }
    }, this.options.unauthenticatedTimeoutMs ?? UNAUTHENTICATED_TIMEOUT_MS) as unknown as number

    socket.on('data', (chunk: Buffer) => {
      if (peer.buffer.length + chunk.length > MAX_PEER_BUFFER_BYTES) {
        peer.closing = true
        closePeer()
        socket.destroy()
        return
      }
      peer.buffer = Buffer.concat([peer.buffer, chunk])
      let frames: ReturnType<typeof decodeWsFrames>
      try {
        frames = decodeWsFrames(peer.buffer)
      } catch {
        // A frame declaring a payload above the decoded-size cap must not
        // allocate or copy it; drop the peer instead of crashing the process.
        peer.closing = true
        closePeer()
        socket.destroy()
        return
      }
      peer.buffer = frames.remaining
      for (const frame of frames.frames) {
        // RFC 6455 requires browser/client frames to be masked. This gateway
        // intentionally does not implement fragmented messages; rejecting
        // them keeps buffering bounded and the parser deterministic.
        if (!frame.masked || !frame.fin || frame.payload.length > MAX_PEER_BUFFER_BYTES) {
          peer.closing = true
          closePeer()
          socket.destroy()
          return
        }
        if (frame.opcode === 0x8) {
          peer.closing = true
          if (!socket.destroyed) socket.end(encodeCloseFrame())
          return
        }
        if (frame.opcode === 0x1) {
          this.handlePeerFrame(peer, frame.payload.toString('utf8'))
        }
      }
    })

    socket.on('close', () => {
      clearTimeout(authTimer)
      closePeer()
    })
    socket.on('error', (error) => {
      if (!peer.closing) {
        Logger.error('Remote gateway socket error:', error)
      }
      closePeer()
    })
  }

  private handlePeerFrame(peer: PeerConnection, text: string): void {
    let message: unknown
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    if (typeof message !== 'object' || message === null) return
    const record = message as Record<string, unknown>

    if (!peer.authenticated) {
      if (record.type !== 'remote:hello') {
        socketSend(peer, { type: 'remote:error', reason: 'not-authenticated' })
        peer.closing = true
        peer.socket.end(encodeCloseFrame())
        return
      }
      const nonce = typeof record.nonce === 'string' ? record.nonce : ''
      const signature = typeof record.signature === 'string' ? record.signature : ''
      const transcript = typeof record.transcript === 'string' ? record.transcript : ''
      const bootstrap = typeof record.bootstrap === 'string' ? record.bootstrap : ''
      const deviceId = typeof record.deviceId === 'string' ? record.deviceId.trim() : ''
      const deviceName = typeof record.deviceName === 'string' ? record.deviceName.trim() : ''
      const authVersion = typeof record.authVersion === 'number' ? record.authVersion : undefined
      const signingJwk =
        typeof record.signingPublicJwk === 'object' && record.signingPublicJwk !== null
          ? (record.signingPublicJwk as JsonWebKey)
          : undefined
      const agreementJwk =
        typeof record.agreementPublicJwk === 'object' && record.agreementPublicJwk !== null
          ? (record.agreementPublicJwk as JsonWebKey)
          : undefined
      const challengeAccepted = nonce === peer.authChallenge && peer.authChallenge.length > 0
      peer.authChallenge = ''
      const verify = this.options.handlers.authenticateDevice
        ? this.options.handlers.authenticateDevice({
            nonce,
            signature: signature || undefined,
            transcript: transcript || undefined,
            bootstrap: bootstrap || undefined,
            signingPublicJwk: signingJwk,
            agreementPublicJwk: agreementJwk,
            authVersion,
            deviceId,
            deviceName,
            originPolicy: peer.originPolicy,
            transport: 'lan'
          })
        : Promise.resolve({ accepted: false as const, device: undefined })
      void verify.then((result) => {
        const accepted = challengeAccepted && result.accepted
        if (this.options.isStopped() || !this.peers.has(peer)) return
        if (!accepted) {
          socketSend(peer, { type: 'remote:error', reason: 'auth-failed' })
          peer.closing = true
          peer.socket.end(encodeCloseFrame())
          return
        }
        // Takeover semantics: reconnecting the same device replaces its
        // previous socket so a re-pairing phone never leaves a ghost device.
        const identity =
          deviceId.length > 0
            ? deviceId
            : `device-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const previous = this.livePeers.get(identity)
        if (previous && previous !== peer) {
          previous.closing = true
          try {
            if (!previous.socket.destroyed) previous.socket.destroy()
          } catch {
            // best-effort close
          }
          this.peers.delete(previous)
        }
        peer.deviceId = identity
        peer.deviceName = deviceName.length > 0 ? deviceName : 'Phone'
        peer.connectedAt = Date.now()
        peer.device = result.device
        peer.authenticated = true
        this.livePeers.set(identity, peer)
        socketSend(peer, {
          type: 'remote:hello:ok',
          ...(result.device ? { device: result.device } : {})
        })
        this.notifyDevicesChange()
      })
      return
    }

    if (record.type === 'remote:data' && typeof record.payload === 'string') {
      const secret = this.options.getPeerSecret() ?? ''
      void decryptPayload(secret, record.payload)
        .then((plaintext) => {
          if (this.options.isStopped() || !this.peers.has(peer)) return
          this.options.handlers.onData?.(plaintext)
          this.handleData(peer, plaintext)
        })
        .catch(() => {
          socketSend(peer, { type: 'remote:error', reason: 'decrypt-failed' })
          peer.closing = true
          peer.socket.end(encodeCloseFrame())
        })
      return
    }
  }

  /** Whether at least one authenticated phone device is currently attached. */
  get hasLivePeer(): boolean {
    return this.livePeers.size > 0
  }

  /** List the connected phone devices, newest first. */
  listDevices(): RemoteDeviceInfo[] {
    return [...this.livePeers.values()]
      .filter((peer) => !peer.closing && !peer.socket.destroyed)
      .sort((a, b) => b.connectedAt - a.connectedAt)
      .map((peer) => ({
        id: peer.deviceId,
        name: peer.deviceName,
        connectedAt: peer.connectedAt,
        transport: 'lan' as const,
        connected: true,
        scopes: peer.device?.scopes ?? [],
        fingerprint: peer.device?.fingerprint ?? null,
        lastUsedAt: peer.device?.lastUsedAt ?? null,
        expiresAt: peer.device?.expiresAt ?? null,
        credentialExpiresAt: peer.device?.credentialExpiresAt ?? null,
        revokedAt: peer.device?.revokedAt ?? null,
        authVersion: peer.device?.authVersion ?? 0,
        allProjects: peer.device?.allProjects ?? true,
        projectIds: peer.device?.projectIds ?? []
      }))
  }

  /** Force-disconnect a connected device by id. */
  disconnectDevice(deviceId: string): boolean {
    const peer = this.livePeers.get(deviceId)
    if (!peer) return false
    peer.closing = true
    try {
      if (!peer.socket.destroyed) peer.socket.destroy()
    } catch {
      // best-effort close; the close handler cleans up
    }
    return true
  }

  /** Destroy every live peer and clear the registry (gateway stop). */
  closeAll(): void {
    for (const peer of this.peers) {
      peer.closing = true
      try {
        if (!peer.socket.destroyed) peer.socket.destroy()
      } catch {
        // best-effort close
      }
    }
    this.peers.clear()
    this.livePeers.clear()
  }

  private notifyDevicesChange(): void {
    this.options.handlers.onDevicesChange(this.listDevices())
  }

  /**
   * Send a JSON payload to every connected device inside an encrypted
   * `remote:data` frame. Used by the RPC bridge to deliver forwarded live
   * events to the phones.
   */
  sendToPeer(payload: unknown): void {
    for (const peer of this.livePeers.values()) this.queuePeerSend(peer, payload)
  }

  private handleData(peer: PeerConnection, plaintext: string): void {
    let message: unknown
    try {
      message = JSON.parse(plaintext)
    } catch {
      return
    }
    if (typeof message !== 'object' || message === null) return
    const record = message as Record<string, unknown>
    if (record.type === 'ping') {
      this.queuePeerSend(peer, { type: 'pong' })
      return
    }
    if (record.type === 'remote:workspace:active' && typeof record.active === 'boolean') {
      this.options.handlers.onWorkspaceActiveChange?.(peer.deviceId, record.active)
      return
    }
    if (record.rpc === 'invoke') {
      void this.handleRpc(peer, record)
    }
  }

  private async handleRpc(peer: PeerConnection, record: Record<string, unknown>): Promise<void> {
    if (!this.options.handlers.onRpc) return
    const id = typeof record.id === 'number' ? record.id : -1
    const channel = typeof record.channel === 'string' ? record.channel : ''
    const args = Array.isArray(record.args) ? record.args : []
    const device: RemoteRpcDeviceContext | undefined = peer.device
      ? {
          deviceId: peer.device.id,
          name: peer.device.name,
          fingerprint: peer.device.fingerprint ?? '',
          authVersion: peer.device.authVersion,
          sessionId: peer.sessionId,
          requestId: String(id),
          scopes: peer.device.scopes as RemoteScope[],
          transport: 'lan',
          allProjects: peer.device.allProjects ?? true,
          projectIds: peer.device.projectIds ?? []
        }
      : undefined
    const outcome = await this.options.handlers.onRpc(channel, args, device)
    if (this.options.isStopped() || !this.peers.has(peer)) return
    this.sendToPeerOnly(
      peer,
      outcome.ok
        ? { rpc: 'result', id, result: outcome.result }
        : { rpc: 'error', id, message: outcome.message }
    )
  }

  /** Send a JSON payload to a single peer (RPC results must not broadcast). */
  private sendToPeerOnly(peer: PeerConnection, payload: unknown): void {
    this.queuePeerSend(peer, payload)
  }

  private queuePeerSend(peer: PeerConnection, payload: unknown): void {
    if (peer.closing || peer.socket.destroyed) return
    const plaintext = JSON.stringify(payload)
    peer.sendQueue = peer.sendQueue
      .then(async () => {
        if (peer.closing || peer.socket.destroyed) return
        const encrypted = await encryptPayload(this.options.getPeerSecret() ?? '', plaintext)
        socketSend(peer, { type: 'remote:data', payload: encrypted })
      })
      .catch(() => undefined)
  }
}

function socketSend(peer: PeerConnection, message: unknown): void {
  try {
    if (!peer.socket.destroyed && peer.socket.writable) {
      peer.socket.write(encodeTextFrame(JSON.stringify(message)))
    }
  } catch {
    // socket is gone; the close handler cleans up
  }
}
