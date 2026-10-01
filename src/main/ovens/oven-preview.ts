import { createServer, type Server } from 'node:http'
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
  constructor(private readonly service: OvenService) {}

  async open(ovenId: string, root: string): Promise<string> {
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
        .some((part) => part.trim() === `oven_preview=${token}`)
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
                  ? { 'Set-Cookie': `oven_preview=${token}; HttpOnly; SameSite=Strict; Path=/` }
                  : {}),
                'X-Content-Type-Options': 'nosniff',
                'Content-Security-Policy': 'sandbox allow-scripts allow-forms allow-popups'
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
    if (!address || typeof address === 'string') throw new Error('The Oven preview could not open.')
    this.servers.set(key, server)
    return `http://127.0.0.1:${address.port}/${token}/`
  }

  dispose(): void {
    for (const server of this.servers.values()) server.close()
    this.servers.clear()
  }
}
