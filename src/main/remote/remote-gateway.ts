/**
 * LAN gateway for remote connection.
 *
 * Two listeners:
 *
 * - **HTTPS on 0.0.0.0:`port`** (LAN_PORT) — serves ONLY the installable phone
 *   PWA assets (allow-listed) over TLS with a self-signed certificate so the
 *   client is a secure context (service worker + install actually work), and
 *   accepts `wss` peer sessions. This is what phones open and connect to.
 * - **HTTP on 127.0.0.1:`localPort`** (LAN_LOCAL_PORT, loopback only) — accepts
 *   plain `ws` peer sessions for the Electron renderer's in-app Remote view; it
 *   serves no static files, so nothing is exposed to the LAN.
 *
 * Peer sessions use the same `PEER_SECRET_AUTH` HMAC handshake and AES-GCM
 * payload encryption as the renderer transport. Upgrades require
 * `Sec-WebSocket-Version: 13`, are origin-checked, and unauthenticated peers
 * are evicted after a timeout. Only one phone peer is live at a time — a
 * second peer is rejected (`session-live`), matching the takeover-rejection
 * semantics required by the spec.
 *
 * Asset serving: the PWA is a Vite code-split bundle, so its shared chunks
 * have hashed, unrelated names. At startup the gateway computes the exact set
 * of `/assets/...` files `remote.html` references (see `pwa-asset-graph.ts`)
 * and serves only that closure — never the desktop app's shell or entry.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { readFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import type { Duplex } from 'node:stream'
import { Logger } from '../logger'
import {
  buildUpgradeResponse,
  decodeWsFrames,
  encodeCloseFrame,
  encodeTextFrame
} from './ws-frames'
import {
  authenticateHandshake,
  decryptPayload,
  encryptPayload
} from '../../renderer/lib/remote/session-security'
import { loadOrCreateSelfSignedCertificate } from './self-signed-cert'
import { computePwaAssetClosure } from './pwa-asset-graph'

export interface GatewayHandlers {
  /** Called when a phone peer authenticates (live=true) or disconnects (live=false). */
  onSessionChange: (live: boolean) => void
  /** Called with the decrypted plaintext of a `remote:data` frame. */
  onData?: (plaintext: string) => void
}

export interface RemoteGatewayOptions {
  /** HTTPS LAN port on 0.0.0.0 (serves the PWA + wss). */
  port: number
  /** HTTP loopback port on 127.0.0.1 (ws only, no static). */
  localPort: number
  peerSecret: string | null
  /** Directory for the persisted self-signed certificate. */
  certificateDir: string
  /** Directory of built renderer assets (only PWA assets are served). */
  staticRoot: string
  handlers: GatewayHandlers
  /** How long an unauthenticated peer may hold a connection open. */
  unauthenticatedTimeoutMs?: number
}

interface PeerConnection {
  socket: Duplex
  buffer: Buffer
  authenticated: boolean
  closing: boolean
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2'
}

/** Static files the HTTPS gateway is allowed to serve (PWA assets only). */
const ALLOWED_STATIC: ReadonlySet<string> = new Set([
  '/remote.html',
  '/manifest.webmanifest',
  '/service-worker.js',
  '/apple-touch-icon.png',
  '/icon.png',
  '/logo.png',
  '/favicon.ico'
])

const UNAUTHENTICATED_TIMEOUT_MS = 10_000
export class RemoteGateway {
  private httpsServer: HttpsServer | null = null
  private httpServer: Server | null = null
  private readonly peers = new Set<PeerConnection>()
  private livePeer: PeerConnection | null = null
  private port: number
  private localPort: number
  private stopped = false
  /** Asset paths the PWA actually references (computed from the build output). */
  private allowedAssets = new Set<string>()

  constructor(private readonly options: RemoteGatewayOptions) {
    this.port = options.port
    this.localPort = options.localPort
  }

  info() {
    const listening = this.httpsServer !== null && this.httpsServer.listening
    const secret = this.options.peerSecret
    return {
      listening,
      port: this.port,
      url: listening ? `https://${this.advertisedHost()}:${this.port}/remote.html` : null,
      pairingUrl:
        listening && secret
          ? `https://${this.advertisedHost()}:${this.port}/remote.html?pair=${encodeURIComponent(secret)}`
          : null
    }
  }

  async start(): Promise<{ port: number; localPort: number }> {
    const { key, cert } = await loadOrCreateSelfSignedCertificate(this.options.certificateDir)

    this.allowedAssets = await computePwaAssetClosure(this.options.staticRoot)
    if (this.allowedAssets.size > 0) {
      Logger.info('PWA asset closure (allow-list):', [...this.allowedAssets])
    }

    const httpsServer = createHttpsServer({ key, cert }, (request, response) =>
      this.handleHttp(request, response)
    )
    httpsServer.on('upgrade', (request, socket) => this.handleUpgrade(request, socket, 'strict'))
    this.httpsServer = httpsServer

    const httpServer = createServer((request, response) => this.handleLoopbackHttp(response))
    httpServer.on('upgrade', (request, socket) => this.handleUpgrade(request, socket, 'local'))
    this.httpServer = httpServer

    await Promise.all([
      this.listen(httpsServer, this.options.port, '0.0.0.0'),
      this.listen(httpServer, this.options.localPort, '127.0.0.1')
    ])

    const address = httpsServer.address()
    if (address && typeof address === 'object') this.port = address.port
    const localAddress = httpServer.address()
    if (localAddress && typeof localAddress === 'object') this.localPort = localAddress.port
    Logger.info(
      `Remote gateway https://0.0.0.0:${this.port} (PWA + wss) and ws://127.0.0.1:${this.localPort}`
    )
    return { port: this.port, localPort: this.localPort }
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const peer of this.peers) {
      peer.closing = true
      try {
        if (!peer.socket.destroyed) peer.socket.destroy()
      } catch {
        // best-effort close
      }
    }
    this.peers.clear()
    this.livePeer = null

    const servers: Array<Server | HttpsServer | null> = [this.httpsServer, this.httpServer]
    this.httpsServer = null
    this.httpServer = null
    await Promise.all(
      servers
        .filter((server): server is Server | HttpsServer => server !== null)
        .map(
          (server) =>
            new Promise<void>((resolveStop) => {
              server.close(() => resolveStop())
              server.closeAllConnections?.()
            })
        )
    )
    Logger.info('Remote gateway stopped')
  }

  private listen(server: Server | HttpsServer, port: number, host: string): Promise<void> {
    return new Promise<void>((resolveStart, reject) => {
      const onError = (error: Error): void => {
        server.removeListener('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        server.removeListener('error', onError)
        resolveStart()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, host)
    })
  }

  private handleLoopbackHttp(response: ServerResponse): void {
    // The loopback listener exists only for the renderer's ws peer sessions.
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('Not found')
  }

  private handleHttp(request: IncomingMessage, response: ServerResponse): void {
    const urlPath = request.url ?? '/'
    const pathOnly = urlPath.split('?')[0]
    const filePath = this.resolvePwaPath(pathOnly)
    if (!filePath) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('Not found')
      return
    }
    void readFile(filePath)
      .then((data) => {
        response.writeHead(200, {
          'Content-Type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream',
          'Cache-Control': 'no-store'
        })
        response.end(data)
      })
      .catch(() => {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end('Not found')
      })
  }

  /** Resolve a request path to a PWA asset — allow-list enforced. */
  private resolvePwaPath(pathOnly: string): string | null {
    // The self-signed certificate is served so phones (iOS in particular) can
    // download and install it as a trust profile.
    if (pathOnly === '/cert.pem') {
      const certPath = join(this.options.certificateDir, 'cert.pem')
      return existsSync(certPath) ? certPath : null
    }
    const root = resolve(this.options.staticRoot)
    const path = pathOnly === '/' ? '/remote.html' : pathOnly
    if (!ALLOWED_STATIC.has(path) && !this.allowedAssets.has(path)) return null
    const requested = normalize(path).replace(/^([/\\])+/, '')
    const target = resolve(root, requested)
    if (target !== root && !target.startsWith(root + sep)) return null
    return existsSync(target) ? target : null
  }

  private advertisedHost(): string {
    try {
      const meta = JSON.parse(
        readFileSync(join(this.options.certificateDir, 'meta.json'), 'utf8')
      ) as {
        hosts?: string[]
      }
      if (Array.isArray(meta.hosts) && meta.hosts.length > 0) return meta.hosts[0]
    } catch {
      // fall through to localhost
    }
    return 'localhost'
  }

  private handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    originPolicy: 'strict' | 'local'
  ): void {
    if (request.headers['sec-websocket-version'] !== '13') {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return
    }
    if (!this.originAllowed(request, originPolicy)) {
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
      closing: false
    }
    this.peers.add(peer)

    const closePeer = (): void => {
      if (!this.peers.has(peer)) return
      this.peers.delete(peer)
      if (this.livePeer === peer) {
        this.livePeer = null
        this.options.handlers.onSessionChange(false)
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
      peer.buffer = Buffer.concat([peer.buffer, chunk])
      const { frames, remaining } = decodeWsFrames(peer.buffer)
      peer.buffer = remaining
      for (const frame of frames) {
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

  /**
   * Origin check for WebSocket upgrades.
   *
   * - `strict` (LAN-exposed HTTPS listener): only same-host origins, plus the
   *   missing/`null` origins produced by non-browser clients.
   * - `local` (loopback-only listener for the desktop's own renderer): also
   *   accepts same-machine origins — `file://` (production renderer loaded via
   *   `loadFile`) and `localhost`/`127.0.0.1`/`::1` (the Vite dev server).
   */
  private originAllowed(request: IncomingMessage, originPolicy: 'strict' | 'local'): boolean {
    const origin = request.headers['origin']
    if (!origin || origin === 'null') return true
    try {
      const stripPort = (host: string): string => host.split(':')[0]
      const originHost = stripPort(new URL(origin).host)
      if (originPolicy === 'local') {
        const localHosts = new Set(['', 'localhost', '127.0.0.1', '::1', '[::1]'])
        if (localHosts.has(originHost)) return true
      }
      const requestHost = stripPort(request.headers['host'] ?? '')
      return originHost === requestHost
    } catch {
      return false
    }
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
      const token = typeof record.token === 'string' ? record.token : ''
      void authenticateHandshake(this.options.peerSecret, nonce, token).then((accepted) => {
        if (this.stopped || !this.peers.has(peer)) return
        if (!accepted) {
          socketSend(peer, { type: 'remote:error', reason: 'auth-failed' })
          peer.closing = true
          peer.socket.end(encodeCloseFrame())
          return
        }
        // Single-session enforcement: a second live peer is refused.
        if (this.livePeer && this.livePeer !== peer) {
          socketSend(peer, { type: 'remote:error', reason: 'session-live' })
          peer.closing = true
          peer.socket.end(encodeCloseFrame())
          return
        }
        peer.authenticated = true
        this.livePeer = peer
        socketSend(peer, { type: 'remote:hello:ok' })
        this.options.handlers.onSessionChange(true)
      })
      return
    }

    if (record.type === 'remote:data' && typeof record.payload === 'string') {
      const secret = this.options.peerSecret ?? ''
      void decryptPayload(secret, record.payload)
        .then((plaintext) => {
          if (this.stopped || !this.peers.has(peer)) return
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
      void encryptPayload(this.options.peerSecret ?? '', JSON.stringify({ type: 'pong' })).then(
        (payload) => socketSend(peer, { type: 'remote:data', payload })
      )
    }
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
