/// <reference types="node" />

/**
 * LAN gateway for remote connection.
 *
 * Two listeners:
 *
 * - **HTTPS on 0.0.0.0:`port`** (LAN_PORT)   serves ONLY the installable phone
 *   PWA assets (allow-listed) over TLS with a self-signed certificate so the
 *   client is a secure context (service worker + install actually work), and
 *   accepts `wss` peer sessions. This is what phones open and connect to.
 * - **HTTP on 127.0.0.1:`localPort`** (LAN_LOCAL_PORT, loopback only)   accepts
 *   plain `ws` peer sessions for the Electron renderer's in-app Remote view; it
 *   serves no static files, so nothing is exposed to the LAN.
 *
 * Peer sessions use the same `PEER_SECRET_AUTH` HMAC handshake and AES-GCM
 * payload encryption as the renderer transport. Upgrades require
 * `Sec-WebSocket-Version: 13`, are origin-checked, and unauthenticated peers
 * are evicted after a timeout. Only one phone peer is live at a time   a
 * second peer is rejected (`session-live`), matching the takeover-rejection
 * semantics required by the spec.
 *
 * Asset serving: the PWA is a Vite code-split bundle, so its shared chunks
 * have hashed, unrelated names. At startup the gateway computes the exact set
 * of `/assets/...` files `remote.html` references (see `pwa-asset-graph.ts`)
 * and serves only that closure   never the desktop app's shell or entry.
 *
 * This file is the composition root: listeners live here, PWA asset serving in
 * `remote-gateway/pwa-asset-server.ts`, peer sessions in
 * `remote-gateway/gateway-peers.ts`, and host/origin checks in
 * `remote-gateway/gateway-hosts.ts`.
 */

import { createServer, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { Logger } from '../system/logger'
import { loadOrCreateSelfSignedCertificate } from './self-signed-cert'
import type { RemoteDeviceInfo } from './remote-types'
import { PwaAssetServer } from './remote-gateway/pwa-asset-server'
import { GatewayPeerRegistry } from './remote-gateway/gateway-peers'
import { advertisedHosts } from './remote-gateway/gateway-hosts'
import type { RemoteGatewayOptions } from './remote-gateway/gateway-types'

export type { GatewayHandlers, RemoteGatewayOptions } from './remote-gateway/gateway-types'
export { MAX_ASSET_CACHE_BYTES, MAX_ASSET_CACHE_ENTRIES } from './remote-gateway/pwa-asset-server'

export class RemoteGateway {
  private httpsServer: HttpsServer | null = null
  private httpServer: Server | null = null
  private port: number
  private localPort: number
  private stopped = false
  private readonly assets: PwaAssetServer
  private readonly peers: GatewayPeerRegistry

  constructor(private readonly options: RemoteGatewayOptions) {
    this.port = options.port
    this.localPort = options.localPort
    this.assets = new PwaAssetServer(options.staticRoot, options.certificateDir)
    this.peers = new GatewayPeerRegistry({
      handlers: options.handlers,
      getPeerSecret: () => this.options.peerSecret,
      unauthenticatedTimeoutMs: options.unauthenticatedTimeoutMs,
      allowedOrigins: options.allowedOrigins,
      isStopped: () => this.stopped
    })
  }

  info() {
    const listening = this.httpsServer !== null && this.httpsServer.listening
    const hosts = advertisedHosts(this.options.certificateDir)
    const urls = listening
      ? hosts.map((host) => {
          const renderedHost = host.includes(':') ? `[${host}]` : host
          return `https://${renderedHost}:${this.port}/remote.html`
        })
      : []
    return {
      listening,
      port: this.port,
      url: urls[0] ?? null,
      urls
    }
  }

  /** Replace the control secret used for encrypted LAN sessions. */
  setPeerSecret(secret: string): void {
    this.options.peerSecret = secret
  }

  async start(): Promise<{ port: number; localPort: number }> {
    const { key, cert } = await loadOrCreateSelfSignedCertificate(this.options.certificateDir)

    await this.assets.refreshClosure()

    const httpsServer = createHttpsServer({ key, cert }, (request, response) =>
      this.assets.handleHttp(request, response)
    )
    httpsServer.on('upgrade', (request, socket) =>
      this.peers.handleUpgrade(request, socket, 'strict')
    )
    this.httpsServer = httpsServer

    const httpServer = createServer((request, response) => this.handleLoopbackHttp(response))
    httpServer.on('upgrade', (request, socket) =>
      this.peers.handleUpgrade(request, socket, 'local')
    )
    this.httpServer = httpServer

    try {
      // Bind sequentially so a LAN-port failure never leaves the loopback
      // listener alive, and clean up HTTPS if the loopback bind fails.
      await this.listenWithPortFallback(httpsServer, this.options.port, '0.0.0.0', 'LAN')
      await this.listenWithPortFallback(httpServer, this.options.localPort, '127.0.0.1', 'loopback')
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
    this.peers.closeAll()
    this.assets.clearCache()

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

  private async listenWithPortFallback(
    server: Server | HttpsServer,
    port: number,
    host: string,
    label: string
  ): Promise<void> {
    try {
      await this.listen(server, port, host)
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EADDRINUSE') {
        throw error
      }
      Logger.info(`Remote ${label} port ${port} is already owned; using an available port`)
      await this.listen(server, 0, host)
    }
  }

  private handleLoopbackHttp(response: ServerResponse): void {
    // The loopback listener exists only for the renderer's ws peer sessions.
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('Not found')
  }

  /** Whether at least one authenticated phone device is currently attached. */
  get hasLivePeer(): boolean {
    return this.peers.hasLivePeer
  }

  /** List the connected phone devices, newest first. */
  listDevices(): RemoteDeviceInfo[] {
    return this.peers.listDevices()
  }

  /** Force-disconnect a connected device by id. */
  disconnectDevice(deviceId: string): boolean {
    return this.peers.disconnectDevice(deviceId)
  }

  /**
   * Send a JSON payload to every connected device inside an encrypted
   * `remote:data` frame. Used by the RPC bridge to deliver forwarded live
   * events to the phones.
   */
  sendToPeer(payload: unknown): void {
    this.peers.sendToPeer(payload)
  }
}
