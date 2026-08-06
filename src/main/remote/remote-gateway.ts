/**
 * LAN gateway for remote connection.
 *
 * Runs an HTTP server on `LAN_PORT` that (a) serves the renderer's built
 * static assets — including the installable phone PWA at `/remote.html` — so a
 * phone on the same network can open the client, and (b) accepts WebSocket
 * peer sessions on `/ws` using the same `PEER_SECRET_AUTH` handshake and
 * AES-GCM payload encryption as the renderer transport modules. The raw secret
 * never crosses the wire; session-live transitions are reported to the
 * remote-mode controller so the tray keep-alive reflects a live phone session.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
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

export interface GatewayHandlers {
  /** Called when a phone peer authenticates (live=true) or disconnects (live=false). */
  onSessionChange: (live: boolean) => void
  /** Called with the decrypted plaintext of a `remote:data` frame. */
  onData?: (plaintext: string) => void
}

export interface RemoteGatewayOptions {
  port: number
  peerSecret: string | null
  /** Directory of built renderer assets served to phones. */
  staticRoot: string
  handlers: GatewayHandlers
}

interface PeerConnection {
  socket: Duplex
  buffer: Buffer
  authenticated: boolean
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

export class RemoteGateway {
  private server: Server | null = null
  private port: number
  private readonly peers = new Set<PeerConnection>()
  private stopped = false

  constructor(private readonly options: RemoteGatewayOptions) {
    this.port = options.port
  }

  info() {
    return {
      listening: this.server !== null && this.server.listening,
      port: this.port,
      url:
        this.server !== null && this.server.listening
          ? `http://0.0.0.0:${this.port}/remote.html`
          : null
    }
  }

  async start(): Promise<number> {
    const server = createServer((request, response) => this.handleHttp(request, response))
    server.on('upgrade', (request, socket) => this.handleUpgrade(request, socket))
    this.server = server

    await new Promise<void>((resolveStart, reject) => {
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
      server.listen(this.options.port, '0.0.0.0')
    })

    const address = server.address()
    if (address && typeof address === 'object') this.port = address.port
    Logger.info(`Remote gateway listening on http://0.0.0.0:${this.port}`)
    return this.port
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const peer of this.peers) {
      try {
        peer.socket.end(encodeCloseFrame())
      } catch {
        // best-effort close
      }
    }
    this.peers.clear()
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolveStop) => {
      server.close(() => resolveStop())
      server.closeAllConnections?.()
    })
    Logger.info('Remote gateway stopped')
  }

  private handleHttp(request: IncomingMessage, response: ServerResponse): void {
    const urlPath = request.url ?? '/'
    const pathOnly = urlPath.split('?')[0]
    const filePath = this.resolveStaticPath(pathOnly)
    if (!filePath) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('Not found')
      return
    }
    void readFile(filePath)
      .then((data) => {
        response.writeHead(200, {
          'Content-Type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream'
        })
        response.end(data)
      })
      .catch(() => {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end('Not found')
      })
  }

  private resolveStaticPath(pathOnly: string): string | null {
    const root = resolve(this.options.staticRoot)
    const requested = normalize(pathOnly).replace(/^([/\\])+/, '')
    if (requested.length === 0) {
      const fallback = join(root, 'remote.html')
      return existsSync(fallback) ? fallback : null
    }
    const target = resolve(root, requested)
    if (target !== root && !target.startsWith(root + sep)) return null
    if (!existsSync(target)) return null
    return target
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex): void {
    // The gateway accepts WebSocket upgrades on any path (the renderer
    // transport dials `ws://host:port` without a path); HTTP GETs are served
    // as static files above.
    const clientKey = request.headers['sec-websocket-key']
    if (typeof clientKey !== 'string') {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return
    }
    socket.write(buildUpgradeResponse(clientKey))

    const peer: PeerConnection = { socket, buffer: Buffer.alloc(0), authenticated: false }
    this.peers.add(peer)

    socket.on('data', (chunk: Buffer) => {
      peer.buffer = Buffer.concat([peer.buffer, chunk])
      const { frames, remaining } = decodeWsFrames(peer.buffer)
      peer.buffer = remaining
      for (const frame of frames) {
        if (frame.opcode === 0x8) {
          socket.end(encodeCloseFrame())
          return
        }
        if (frame.opcode === 0x1) {
          this.handlePeerFrame(peer, frame.payload.toString('utf8'))
        }
      }
    })

    const closePeer = (): void => {
      if (!this.peers.has(peer)) return
      this.peers.delete(peer)
      if (peer.authenticated) this.options.handlers.onSessionChange(false)
    }
    socket.on('close', closePeer)
    socket.on('error', (error) => {
      Logger.error('Remote gateway socket error:', error)
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
        peer.socket.end(encodeCloseFrame())
        return
      }
      const nonce = typeof record.nonce === 'string' ? record.nonce : ''
      const token = typeof record.token === 'string' ? record.token : ''
      void authenticateHandshake(this.options.peerSecret, nonce, token).then((accepted) => {
        if (this.stopped || !this.peers.has(peer)) return
        if (!accepted) {
          socketSend(peer, { type: 'remote:error', reason: 'auth-failed' })
          peer.socket.end(encodeCloseFrame())
          return
        }
        peer.authenticated = true
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
    peer.socket.write(encodeTextFrame(JSON.stringify(message)))
  } catch {
    // socket is gone; the close handler cleans up
  }
}
