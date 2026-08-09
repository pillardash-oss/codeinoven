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
import { readFile, stat } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { brotliCompress, gzip } from 'node:zlib'
import { promisify } from 'node:util'
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
import type { RemoteRpcDeviceContext, RemoteScope } from '../../lib/remote-rpc'
import { loadOrCreateSelfSignedCertificate } from './self-signed-cert'
import { computePwaAssetGraph } from './pwa-asset-graph'
import type { RemoteDeviceInfo } from './remote-types'

export interface GatewayHandlers {
  /** Called whenever the set of connected phone devices changes. */
  onDevicesChange: (devices: RemoteDeviceInfo[]) => void
  /** Called with the decrypted plaintext of a `remote:data` frame. */
  onData?: (plaintext: string) => void
  /** Called with a decrypted remote RPC invoke; returns the result to reply. */
  onRpc?: (
    channel: string,
    args: unknown[],
    device?: RemoteRpcDeviceContext
  ) => Promise<{ ok: true; result: unknown } | { ok: false; message: string }>
  /**
   * Authenticates a device handshake against the device credential service.
   * Proof-of-possession: the hello carries an ECDSA signature over the
   * challenge transcript (plus a single-use pairing bootstrap + public keys
   * for first-time enrollment). When absent the gateway falls back to the
   * shared-secret handshake so the desktop renderer loopback keeps working.
   */
  authenticateDevice?: (input: {
    nonce: string
    token?: string
    signature?: string
    transcript?: string
    bootstrap?: string
    signingPublicJwk?: JsonWebKey
    agreementPublicJwk?: JsonWebKey
    authVersion?: number
    deviceId: string
    deviceName: string
    originPolicy: 'strict' | 'local'
    transport: 'lan' | 'relay'
  }) => Promise<{ accepted: boolean; device?: RemoteDeviceInfo }>
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
  /** Exact hosted PWA origins allowed to attempt an authenticated LAN upgrade. */
  allowedOrigins?: string[]
}

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
}

/** An on-disk file with its raw bytes, ETag, and lazily-compressed variants. */
interface CachedAsset {
  /** `mtimeMs:size` stamp used to invalidate the cache on rebuild. */
  stamp: string
  raw: Buffer
  etag: string
  compressed: Partial<Record<'br' | 'gzip', Buffer>>
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
  '/precache-manifest.json',
  '/apple-touch-icon.png',
  '/icon.png',
  '/logo.png',
  '/favicon.ico'
])

/** Text-like types worth compressing; binary assets are served as-is. */
const COMPRESSIBLE_TYPES: ReadonlySet<string> = new Set([
  '.html',
  '.js',
  '.mjs',
  '.css',
  '.json',
  '.webmanifest',
  '.svg',
  '.txt'
])

const brotliCompressAsync = promisify(brotliCompress)
const gzipAsync = promisify(gzip)

/**
 * Pick the strongest acceptable content encoding, or `null` for identity.
 * Brotli wins over gzip when both are advertised; q-values are honoured so a
 * client can explicitly refuse either.
 */
function negotiateEncoding(acceptEncoding: string | undefined): 'br' | 'gzip' | null {
  if (!acceptEncoding) return null
  let br = 0
  let gzip = 0
  for (const part of acceptEncoding.split(',')) {
    const [token, ...params] = part.trim().split(';')
    const name = token.trim().toLowerCase()
    let quality = 1
    for (const param of params) {
      const [key, value] = param.trim().split('=')
      if (key === 'q') {
        const parsed = Number.parseFloat(value)
        if (Number.isFinite(parsed)) quality = parsed
      }
    }
    if (name === 'br') br = quality
    else if (name === 'gzip') gzip = quality
  }
  if (br > 0 && br >= gzip) return 'br'
  if (gzip > 0) return 'gzip'
  return null
}

/**
 * Whether `If-None-Match` matches our validator. `*` matches any current
 * representation; otherwise the opaque tag portion of each listed tag is
 * compared (weak/strong prefixes are ignored for revalidation purposes).
 */
function ifNoneMatchMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false
  const ours = etag.replace(/^W\//, '')
  for (const candidate of header.split(',')) {
    const trimmed = candidate.trim()
    if (trimmed === '*') return true
    if (trimmed.replace(/^W\//, '') === ours) return true
  }
  return false
}

const UNAUTHENTICATED_TIMEOUT_MS = 10_000
const MAX_PEER_BUFFER_BYTES = 1024 * 1024
export class RemoteGateway {
  private httpsServer: HttpsServer | null = null
  private httpServer: Server | null = null
  private readonly peers = new Set<PeerConnection>()
  /** Authenticated live peers, keyed by device id. */
  private readonly livePeers = new Map<string, PeerConnection>()
  private port: number
  private localPort: number
  private stopped = false
  /** Asset paths the PWA actually references (computed from the build output). */
  private allowedAssets = new Set<string>()
  /** Hashed build outputs that may be served with immutable caching. */
  private immutableAssets = new Set<string>()
  /** Public runtime assets (agent icons) that must never be immutable. */
  private mutableAssets = new Set<string>()
  /** Disconnected-shell precache manifest (absolute paths). */
  private precache: string[] = []
  /** In-memory asset cache keyed by file path (invalidated by mtime/size). */
  private readonly assetCache = new Map<string, CachedAsset>()
  /** Fingerprint of the `remote.html` the graph was computed from. */
  private closureStamp: string | null = null

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
          ? `https://${this.advertisedHost()}:${this.port}/remote.html#pair=${encodeURIComponent(secret)}`
          : null
    }
  }

  /**
   * Replace the peer secret (used for the pairing QR and the loopback legacy
   * handshake). Called after a device enrolls so the live QR rotates and a
   * stale QR value can no longer start another enrollment.
   */
  setPeerSecret(secret: string): void {
    this.options.peerSecret = secret
  }

  async start(): Promise<{ port: number; localPort: number }> {
    const { key, cert } = await loadOrCreateSelfSignedCertificate(this.options.certificateDir)

    await this.refreshAssetClosure()

    const httpsServer = createHttpsServer({ key, cert }, (request, response) =>
      this.handleHttp(request, response)
    )
    httpsServer.on('upgrade', (request, socket) => this.handleUpgrade(request, socket, 'strict'))
    this.httpsServer = httpsServer

    const httpServer = createServer((request, response) => this.handleLoopbackHttp(response))
    httpServer.on('upgrade', (request, socket) => this.handleUpgrade(request, socket, 'local'))
    this.httpServer = httpServer

    try {
      // Bind sequentially so a LAN-port failure never leaves the loopback
      // listener alive, and clean up HTTPS if the loopback bind fails.
      await this.listen(httpsServer, this.options.port, '0.0.0.0')
      await this.listen(httpServer, this.options.localPort, '127.0.0.1')
    } catch (error) {
      await this.closeServers()
      throw error
    }

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
    this.livePeers.clear()

    await this.closeServers()
    Logger.info('Remote gateway stopped')
  }

  private async closeServers(): Promise<void> {
    const servers: Array<Server | HttpsServer | null> = [this.httpsServer, this.httpServer]
    this.httpsServer = null
    this.httpServer = null
    await Promise.all(
      servers
        .filter((server): server is Server | HttpsServer => server !== null && server.listening)
        .map(
          (server) =>
            new Promise<void>((resolveStop) => {
              server.close(() => resolveStop())
              server.closeAllConnections?.()
            })
        )
    )
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

  /**
   * Recompute the allow-list when the build output changed.
   *
   * Every rebuild rewrites `remote.html` with freshly hashed chunk names, so a
   * closure captured at startup would 404 exactly the assets the newly served
   * HTML asks for — the phone would load a blank page until the app restarted.
   * Fingerprinting `remote.html` keeps the allow-list in step with whatever is
   * actually on disk.
   */
  private async refreshAssetClosure(): Promise<void> {
    let stamp: string
    try {
      const info = await stat(join(this.options.staticRoot, 'remote.html'))
      stamp = `${info.mtimeMs}:${info.size}`
    } catch {
      return
    }
    if (stamp === this.closureStamp) return
    const graph = await computePwaAssetGraph(this.options.staticRoot)
    this.allowedAssets = new Set(graph.closure)
    this.immutableAssets = new Set(graph.immutable)
    this.mutableAssets = new Set(graph.mutable)
    this.precache = graph.precache
    this.closureStamp = stamp
    Logger.dev('PWA asset graph refreshed', {
      assetCount: graph.closure.size,
      immutableCount: graph.immutable.size,
      mutableCount: graph.mutable.size,
      precacheCount: graph.precache.length
    })
  }

  private handleHttp(request: IncomingMessage, response: ServerResponse): void {
    void this.refreshAssetClosure().then(() => this.serveHttp(request, response))
  }

  private serveHttp(request: IncomingMessage, response: ServerResponse): void {
    const urlPath = request.url ?? '/'
    const pathOnly = urlPath.split('?')[0]

    if (pathOnly === '/service-worker.js') {
      this.serveServiceWorker(response)
      return
    }
    if (pathOnly === '/precache-manifest.json') {
      this.servePrecacheManifest(response)
      return
    }

    const filePath = this.resolvePwaPath(pathOnly)
    if (!filePath) {
      this.writeResponse(
        response,
        404,
        'text/plain; charset=utf-8',
        'no-store',
        null,
        null,
        null,
        'Not found'
      )
      return
    }

    void this.readAsset(filePath).then((asset) => {
      if (!asset) {
        this.writeResponse(
          response,
          404,
          'text/plain; charset=utf-8',
          'no-store',
          null,
          null,
          null,
          'Not found'
        )
        return
      }
      void this.serveAsset(request, response, filePath, pathOnly, asset)
    })
  }

  /** Serve a single asset with compression, caching, ETag, and 304 handling. */
  private async serveAsset(
    request: IncomingMessage,
    response: ServerResponse,
    filePath: string,
    pathOnly: string,
    asset: CachedAsset
  ): Promise<void> {
    const contentType = CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream'
    const compressible = COMPRESSIBLE_TYPES.has(extname(filePath))
    const cacheControl = this.cacheControlFor(pathOnly)
    const encoding = compressible ? negotiateEncoding(request.headers['accept-encoding']) : null
    let body: Buffer
    if (encoding === 'br') {
      asset.compressed['br'] ??= await brotliCompressAsync(asset.raw)
      body = asset.compressed['br']
    } else if (encoding === 'gzip') {
      asset.compressed['gzip'] ??= await gzipAsync(asset.raw)
      body = asset.compressed['gzip']
    } else {
      body = asset.raw
    }
    const etag = asset.etag

    const common: Record<string, string> = {
      'Content-Type': contentType,
      'Cache-Control': cacheControl,
      ETag: etag
    }
    if (compressible) common['Vary'] = 'Accept-Encoding'

    if (ifNoneMatchMatches(request.headers['if-none-match'], etag)) {
      // 304 carries the validator + cache headers but never a body,
      // Content-Length, or Content-Encoding.
      response.writeHead(304, common)
      response.end()
      return
    }

    const headers: Record<string, string> = { ...common }
    if (encoding) headers['Content-Encoding'] = encoding
    headers['Content-Length'] = String(body.length)
    response.writeHead(200, headers)
    response.end(body)
  }

  /** Serve the generated service worker with the precache manifest injected. */
  private serveServiceWorker(response: ServerResponse): void {
    const source = this.generateServiceWorkerSource()
    const body = Buffer.from(source, 'utf8')
    this.writeResponse(
      response,
      200,
      'text/javascript; charset=utf-8',
      'no-store',
      null,
      null,
      this.etagFor(body),
      body
    )
  }

  /** Serve the precache manifest the service worker fetches on install. */
  private servePrecacheManifest(response: ServerResponse): void {
    const body = Buffer.from(JSON.stringify({ urls: this.precache }), 'utf8')
    this.writeResponse(
      response,
      200,
      'application/json; charset=utf-8',
      'no-store',
      null,
      null,
      this.etagFor(body),
      body
    )
  }

  private writeResponse(
    response: ServerResponse,
    status: number,
    contentType: string,
    cacheControl: string,
    contentEncoding: string | null,
    vary: string | null,
    etag: string | null,
    body: Buffer | string | null
  ): void {
    const headers: Record<string, string> = { 'Content-Type': contentType }
    headers['Cache-Control'] = cacheControl
    if (contentEncoding) headers['Content-Encoding'] = contentEncoding
    if (vary) headers['Vary'] = vary
    if (etag) headers['ETag'] = etag
    const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body
    if (bytes) headers['Content-Length'] = String(bytes.length)
    response.writeHead(status, headers)
    response.end(bytes)
  }

  /** Read and cache an asset (with compressed variants) from disk. */
  private async readAsset(filePath: string): Promise<CachedAsset | null> {
    const cached = this.assetCache.get(filePath)
    if (cached) {
      const current = await this.fileStamp(filePath)
      if (current === cached.stamp) return cached
    }
    try {
      const data = await readFile(filePath)
      const stamp = await this.fileStamp(filePath)
      if (stamp === null) return null
      const asset: CachedAsset = {
        stamp,
        raw: data,
        etag: this.etagFor(data),
        compressed: {}
      }
      this.assetCache.set(filePath, asset)
      return asset
    } catch {
      return null
    }
  }

  private async fileStamp(filePath: string): Promise<string | null> {
    try {
      const info = await stat(filePath)
      return `${info.mtimeMs}:${info.size}`
    } catch {
      return null
    }
  }

  /**
   * Weak ETag over the raw file bytes. The same resource is served in multiple
   * content-encodings (identity/gzip/brotli), so a strong validator would have
   * to differ per representation; a weak one is spec-correct and still
   * revalidates `If-None-Match` for GET.
   */
  private etagFor(data: Buffer): string {
    return `W/"${createHash('sha1').update(data).digest('hex').slice(0, 16)}"`
  }
  /** Cache-Control for a served path: immutable for hashed build outputs. */
  private cacheControlFor(pathOnly: string): string {
    if (pathOnly === '/cert.pem') return 'no-store'
    if (this.immutableAssets.has(pathOnly)) return 'public, max-age=31536000, immutable'
    // Mutable shell/API endpoints and unhashed public assets (agent icons) are
    // never cached as immutable — the service worker owns their lifecycle.
    if (this.mutableAssets.has(pathOnly)) return 'no-store'
    return 'no-store'
  }

  /** Generate the service-worker source with the current precache injected. */
  private generateServiceWorkerSource(): string {
    try {
      const template = readFileSync(join(this.options.staticRoot, 'service-worker.js'), 'utf8')
      const version = JSON.stringify(this.closureStamp ?? 'dev')
      return template
        .replace('/*__PRECACHE_MANIFEST__*/[]', JSON.stringify(this.precache))
        .replace('/*__PRECACHE_VERSION__*/"dev"', version)
    } catch {
      return 'self.onfetch=()=>{}'
    }
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
      closing: false,
      deviceId: '',
      deviceName: '',
      connectedAt: 0,
      authChallenge: randomBytes(32).toString('base64url'),
      sessionId: randomBytes(16).toString('base64url'),
      originPolicy
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
      if (this.options.allowedOrigins?.includes(new URL(origin).origin)) return true
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
            token: token || undefined,
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
        : authenticateHandshake(this.options.peerSecret, nonce, token).then((verified) => ({
            accepted: challengeAccepted && verified,
            device: undefined
          }))
      void verify.then((result) => {
        const accepted = challengeAccepted && result.accepted
        if (this.stopped || !this.peers.has(peer)) return
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

  private notifyDevicesChange(): void {
    this.options.handlers.onDevicesChange(this.listDevices())
  }

  /**
   * Send a JSON payload to every connected device inside an encrypted
   * `remote:data` frame. Used by the RPC bridge to deliver forwarded live
   * events to the phones.
   */
  sendToPeer(payload: unknown): void {
    const secret = this.options.peerSecret ?? ''
    void encryptPayload(secret, JSON.stringify(payload)).then((encrypted) => {
      for (const peer of this.livePeers.values()) {
        if (peer.closing || peer.socket.destroyed) continue
        socketSend(peer, { type: 'remote:data', payload: encrypted })
      }
    })
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
    if (this.stopped || !this.peers.has(peer)) return
    this.sendToPeerOnly(
      peer,
      outcome.ok
        ? { rpc: 'result', id, result: outcome.result }
        : { rpc: 'error', id, message: outcome.message }
    )
  }

  /** Send a JSON payload to a single peer (RPC results must not broadcast). */
  private sendToPeerOnly(peer: PeerConnection, payload: unknown): void {
    if (peer.closing || peer.socket.destroyed) return
    void encryptPayload(this.options.peerSecret ?? '', JSON.stringify(payload)).then((encrypted) =>
      socketSend(peer, { type: 'remote:data', payload: encrypted })
    )
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
