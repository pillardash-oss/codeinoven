import { createReadStream } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { opendir, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { PROTOTYPE_ASSET_BYTE_LIMIT } from '../../lib/prototypes/prototype-artifacts'

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2'
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

export class PrototypePreviewService {
  private server: Server | null = null
  private readonly roots = new Map<string, string>()

  async register(previewSlug: string, canonicalRoot: string): Promise<void> {
    if (!/^[a-z0-9][a-z0-9-]{0,160}$/u.test(previewSlug)) {
      throw new TypeError('Invalid prototype preview slug')
    }
    this.roots.set(previewSlug, await realpath(canonicalRoot))
  }

  /** Restore feature-scoped preview registrations without traversing project source trees. */
  async registerProject(projectRoot: string): Promise<number> {
    const specsRoot = join(projectRoot, '.cio', 'specs')
    let registered = 0
    let inspected = 0
    try {
      const features = await opendir(specsRoot)
      for await (const feature of features) {
        if (!feature.isDirectory() || !/^[a-z0-9][a-z0-9-]{0,127}$/u.test(feature.name)) continue
        const prototypesRoot = join(specsRoot, feature.name, 'prototypes')
        try {
          const prototypes = await opendir(prototypesRoot)
          for await (const prototype of prototypes) {
            inspected += 1
            if (inspected > 1_000) return registered
            if (!prototype.isDirectory() || !/^[LH][1-9][0-9]*$/u.test(prototype.name)) continue
            await this.register(
              `${feature.name}-${prototype.name.toLowerCase()}`,
              join(prototypesRoot, prototype.name)
            )
            registered += 1
            if (registered % 20 === 0)
              await new Promise<void>((resolveYield) => setImmediate(resolveYield))
          }
        } catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT')
            throw error
        }
      }
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
    }
    return registered
  }

  async start(): Promise<number> {
    if (this.server) {
      const address = this.server.address()
      if (address && typeof address !== 'string') return address.port
    }
    this.server = createServer((request, response) => {
      void this.respond(request.url ?? '/', response)
    })
    await new Promise<void>((resolvePromise, reject) => {
      this.server?.once('error', reject)
      this.server?.listen(0, '127.0.0.1', resolvePromise)
    })
    const address = this.server.address()
    if (!address || typeof address === 'string')
      throw new Error('Prototype preview port unavailable')
    return address.port
  }

  async dispose(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
  }

  private async respond(url: string, response: import('node:http').ServerResponse): Promise<void> {
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
    )
    try {
      const parsed = new URL(url, 'http://127.0.0.1')
      const segments = parsed.pathname.split('/').filter(Boolean)
      if (segments[0] !== 'cio' || !segments[1]) throw new Error('not_found')
      const root = this.roots.get(segments[1])
      if (!root) throw new Error('not_found')
      const requested = resolve(root, ...segments.slice(2))
      if (!inside(root, requested)) throw new Error('not_found')
      const info = await stat(requested)
      const target = info.isDirectory() ? resolve(requested, 'index.html') : requested
      const actual = await realpath(target)
      if (!inside(root, actual)) throw new Error('not_found')
      const targetInfo = await stat(actual)
      if (!targetInfo.isFile() || targetInfo.size > PROTOTYPE_ASSET_BYTE_LIMIT) {
        throw new Error('not_found')
      }
      response.statusCode = 200
      response.setHeader('Content-Length', String(targetInfo.size))
      response.setHeader(
        'Content-Type',
        MIME_TYPES[extname(actual).toLowerCase()] ?? 'application/octet-stream'
      )
      createReadStream(actual, { highWaterMark: 256 * 1024 }).pipe(response)
    } catch {
      response.statusCode = 404
      response.end('Not found')
    }
  }
}
