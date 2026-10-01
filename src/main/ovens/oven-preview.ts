import { createServer, request as httpRequest, Agent, type Server } from 'node:http'
import { connect, type Socket } from 'node:net'
import { randomBytes } from 'node:crypto'
import { extname } from 'node:path'
import type { OvenService } from './oven-service'

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2'
}

/** An unguessable loopback link streams files from the Oven without copying a repo. */
export class OvenPreview {
  private readonly servers = new Map<string, Server>()
  private readonly tunnels = new Map<string, () => void>()
  private openingTail: Promise<unknown> = Promise.resolve()
  private openingCount = 0
  private disposed = false

  private openQueued(action: () => Promise<string>): Promise<string> {
    if (this.disposed) return Promise.reject(new Error('The Oven previews are closed.'))
    if (this.openingCount >= 4)
      return Promise.reject(new Error('Preview setup is busy. Try again shortly.'))
    this.openingCount++
    const task = this.openingTail
      .catch(() => undefined)
      .then(action)
      .finally(() => this.openingCount--)
    this.openingTail = task
    return task
  }
  constructor(private readonly service: OvenService) {}

  open(ovenId: string, root: string): Promise<string> {
    return this.openQueued(() => this.openStatic(ovenId, root))
  }

  private async openStatic(ovenId: string, root: string): Promise<string> {
    const key = `${ovenId}\0${root}`
    const previous = this.servers.get(key)
    if (previous) {
      previous.close()
      this.servers.delete(key)
    }
    if (this.servers.size >= 4)
      throw new Error('Close a preview before opening another. At most four previews may be open.')
    await this.service.workspace(ovenId, { operation: 'stat', root, path: '' })
    const token = randomBytes(24).toString('hex')
    const cookieName = `oven_preview_${token.slice(0, 12)}`
    let active = 0
    const server = createServer((request, response) => {
      if (request.method !== 'GET' || active >= 4) {
        response.writeHead(429)
        response.end()
        return
      }
      const url = new URL(request.url ?? '/', 'http://localhost')
      const tokenPath = url.pathname.startsWith(`/${token}/`)
      const cookie = request.headers.cookie
        ?.split(';')
        .some((part) => part.trim() === `${cookieName}=${token}`)
      if (!tokenPath && !cookie) {
        response.writeHead(404)
        response.end()
        return
      }
      let path: string
      try {
        path =
          decodeURIComponent(
            tokenPath ? url.pathname.slice(token.length + 2) : url.pathname.slice(1)
          ) || 'index.html'
      } catch {
        response.writeHead(400)
        response.end()
        return
      }
      active++
      void (async () => {
        try {
          let offset = 0
          let first = true
          while (!response.destroyed) {
            const file = await this.service.workspace(ovenId, {
              operation: 'read',
              root,
              path,
              offset
            })
            if ((file.size ?? 0) > 16 * 1024 * 1024) throw new Error('Preview file exceeds 16 MiB.')
            if (first) {
              response.writeHead(200, {
                'Content-Type': `${MIME[extname(path)] ?? 'text/plain'}; charset=utf-8`,
                'Cache-Control': 'no-store',
                ...(tokenPath
                  ? { 'Set-Cookie': `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/` }
                  : {}),
                'X-Content-Type-Options': 'nosniff',
                'Content-Security-Policy':
                  'sandbox allow-scripts allow-same-origin allow-forms allow-popups'
              })
              first = false
            }
            const chunk = Buffer.from(file.data ?? '', 'base64')
            if (!response.write(chunk))
              await new Promise<void>((resolve) => {
                response.once('drain', resolve)
                response.once('close', resolve)
              })
            offset += chunk.length
            if (!chunk.length || offset >= (file.size ?? 0)) break
          }
          response.end()
        } catch {
          if (!response.headersSent) response.writeHead(404, { 'Content-Type': 'text/plain' })
          response.end('The file is unavailable on this Oven.')
        } finally {
          active--
        }
      })()
    })
    server.requestTimeout = 30_000
    server.maxConnections = 8
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (this.disposed) {
      server.close()
      throw new Error('The Oven previews are closed.')
    }
    if (!address || typeof address === 'string') throw new Error('The Oven preview could not open.')
    this.servers.set(key, server)
    return `http://127.0.0.1:${address.port}/${token}/`
  }

  /** Proxy a running remote app, including its WebSocket upgrades, over SSH. */
  openPort(ovenId: string, remotePort: number): Promise<string> {
    return this.openQueued(() => this.openRunning(ovenId, remotePort))
  }

  private async openRunning(ovenId: string, remotePort: number): Promise<string> {
    const key = `${ovenId}\0port:${remotePort}`
    this.servers.get(key)?.close()
    this.servers.delete(key)
    this.tunnels.get(key)?.()
    this.tunnels.delete(key)
    if (this.servers.size >= 4) throw new Error('At most four previews may be open.')
    await this.service.probe(ovenId)
    if (this.disposed) throw new Error('The Oven previews are closed.')
    const tunnel = await this.service.ssh.tunnel(ovenId, remotePort)
    if (this.disposed) {
      tunnel.close()
      throw new Error('The Oven previews are closed.')
    }
    const token = randomBytes(24).toString('hex')
    const cookieName = `oven_preview_${token.slice(0, 12)}`
    const agent = new Agent({
      keepAlive: true,
      maxSockets: 4,
      maxTotalSockets: 4,
      timeout: 120_000
    })
    const sockets = new Set<Socket>()
    let active = 0
    const authorized = (cookie: string | undefined): boolean =>
      !!cookie?.split(';').some((part) => part.trim() === `${cookieName}=${token}`)
    const server = createServer((incoming, outgoing) => {
      const url = new URL(incoming.url ?? '/', 'http://localhost')
      if (url.pathname === `/${token}/`) {
        outgoing.writeHead(302, {
          Location: '/',
          'Cache-Control': 'no-store',
          'Set-Cookie': `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/`
        })
        outgoing.end()
        return
      }
      if (!authorized(incoming.headers.cookie)) {
        outgoing.writeHead(404)
        outgoing.end()
        return
      }
      if (active >= 4) {
        outgoing.writeHead(503)
        outgoing.end()
        return
      }
      active++
      let settled = false
      const settle = (): void => {
        if (!settled) {
          settled = true
          active--
        }
      }
      const headers = { ...incoming.headers, host: `127.0.0.1:${remotePort}` }
      headers.cookie = incoming.headers.cookie
        ?.split(';')
        .filter((part) => !part.trim().startsWith('oven_preview_'))
        .join(';')
      const upstream = httpRequest(
        {
          hostname: '127.0.0.1',
          port: tunnel.port,
          method: incoming.method,
          path: `${url.pathname}${url.search}`,
          headers,
          agent
        },
        (response) => {
          outgoing.writeHead(response.statusCode ?? 502, response.headers)
          response.pipe(outgoing)
          response.once('error', () => outgoing.destroy())
        }
      )
      upstream.setTimeout(120_000, () => upstream.destroy(new Error('Preview timed out.')))
      upstream.once('error', () => {
        if (!outgoing.headersSent) outgoing.writeHead(502, { 'Content-Type': 'text/plain' })
        outgoing.end('The development server is unavailable on this Oven.')
      })
      outgoing.once('close', () => {
        upstream.destroy()
        settle()
      })
      outgoing.once('finish', settle)
      incoming.once('aborted', () => upstream.destroy())
      incoming.pipe(upstream)
    })
    server.on('upgrade', (incoming, socket, head) => {
      if (!authorized(incoming.headers.cookie) || sockets.size >= 4) {
        socket.destroy()
        return
      }
      const upstream = connect(tunnel.port, '127.0.0.1')
      sockets.add(upstream)
      upstream.once('close', () => {
        sockets.delete(upstream)
        socket.destroy()
      })
      socket.once('close', () => upstream.destroy())
      upstream.once('error', () => socket.destroy())
      socket.once('error', () => upstream.destroy())
      upstream.once('connect', () => {
        const headers = { ...incoming.headers, host: `127.0.0.1:${remotePort}` }
        headers.cookie = incoming.headers.cookie
          ?.split(';')
          .filter((part) => !part.trim().startsWith('oven_preview_'))
          .join(';')
        if (headers.origin) headers.origin = `http://127.0.0.1:${remotePort}`
        const request = [
          `${incoming.method} ${incoming.url} HTTP/1.1`,
          ...Object.entries(headers)

            .flatMap(([name, value]) =>
              value === undefined
                ? []
                : `${name}: ${Array.isArray(value) ? value.join(', ') : value}`
            ),
          '',
          ''
        ].join('\r\n')
        upstream.write(request)
        if (head.length) upstream.write(head)
        socket.pipe(upstream)
        upstream.pipe(socket)
      })
    })
    server.maxConnections = 8
    server.requestTimeout = 120_000
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      const address = server.address()
      if (this.disposed) throw new Error('The Oven previews are closed.')
      if (!address || typeof address === 'string')
        throw new Error('The development preview could not open.')
      this.servers.set(key, server)
      this.tunnels.set(key, () => {
        for (const socket of sockets) socket.destroy()
        agent.destroy()
        server.closeAllConnections()
        tunnel.close()
      })
      return `http://127.0.0.1:${address.port}/${token}/`
    } catch (error) {
      agent.destroy()
      tunnel.close()
      server.close()
      throw error
    }
  }

  dispose(): void {
    this.disposed = true
    for (const server of this.servers.values()) server.close()
    this.servers.clear()
    for (const close of this.tunnels.values()) close()
    this.tunnels.clear()
  }
}
