import { createReadStream } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { open, opendir, realpath, stat } from 'node:fs/promises'
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
const PREVIEW_CHUNK_BYTES = 192 * 1024

/** 16x16 amber placeholder served when a browser asks the origin root for a favicon. */
const DEFAULT_FAVICON_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAG0lEQVR4nGN41WXznxLMMGrAaBiMpoP/wyQMANVNrx/VZr2aAAAAAElFTkSuQmCC',
  'base64'
)

/**
 * Dev-preview posture for agent-generated prototypes: prototypes are self-contained
 * static HTML that rely on inline scripts, inline event handlers, and demo forms that
 * post back to their own URL, so same-origin interactivity is allowed. Everything that
 * would let prototype content reach outside this loopback origin stays locked down:
 * no external script/CDN origins, no framing from other documents, no base-url
 * hijacking, no plugin content.
 */
const PREVIEW_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'"
].join('; ')

export interface PrototypePreviewChunk {
  base64: string
  nextOffset: number
  size: number
  mime: string
}

export async function readPrototypePreviewChunk(
  canonicalRoot: string,
  relativeFile: string,
  offset: number
): Promise<PrototypePreviewChunk> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError('Invalid preview offset')
  const root = await realpath(canonicalRoot)
  const requested = resolve(root, relativeFile)
  if (!inside(root, requested)) throw new TypeError('Preview asset escapes its approved root')
  const actual = await realpath(requested)
  if (!inside(root, actual)) throw new TypeError('Preview asset resolves outside its approved root')
  const info = await stat(actual)
  if (
    !info.isFile() ||
    info.size < 1 ||
    info.size > PROTOTYPE_ASSET_BYTE_LIMIT ||
    offset >= info.size
  ) {
    throw new TypeError('Invalid preview asset')
  }
  const length = Math.min(PREVIEW_CHUNK_BYTES, info.size - offset)
  const buffer = Buffer.allocUnsafe(length)
  const handle = await open(actual, 'r')
  try {
    const result = await handle.read(buffer, 0, length, offset)
    if (result.bytesRead !== length) throw new Error('Preview asset changed while reading')
  } finally {
    await handle.close()
  }
  return {
    base64: buffer.toString('base64'),
    nextOffset: offset + length,
    size: info.size,
    mime: MIME_TYPES[extname(actual).toLowerCase()] ?? 'application/octet-stream'
  }
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

export class PrototypePreviewService {
  private server: Server | null = null
  private starting: Promise<number> | null = null
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
    if (this.starting) return this.starting

    const starting = (async (): Promise<number> => {
      const server = createServer((request, response) => {
        void this.respond(request.url ?? '/', response)
      })
      this.server = server
      try {
        await new Promise<void>((resolvePromise, reject) => {
          server.once('error', reject)
          server.listen(0, '127.0.0.1', resolvePromise)
        })
        const address = server.address()
        if (!address || typeof address === 'string') {
          throw new Error('Prototype preview port unavailable')
        }
        return address.port
      } catch (error) {
        if (this.server === server) this.server = null
        server.close()
        throw error
      }
    })()
    this.starting = starting
    try {
      return await starting
    } finally {
      if (this.starting === starting) this.starting = null
    }
  }

  async dispose(): Promise<void> {
    await this.starting?.catch(() => undefined)
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
  }

  private async respond(url: string, response: import('node:http').ServerResponse): Promise<void> {
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    response.setHeader('Content-Security-Policy', PREVIEW_CSP)
    try {
      const parsed = new URL(url, 'http://127.0.0.1')
      if (parsed.pathname === '/favicon.ico') {
        response.statusCode = 200
        response.setHeader('Content-Type', 'image/png')
        response.setHeader('Content-Length', String(DEFAULT_FAVICON_PNG.length))
        response.setHeader('Cache-Control', 'public, max-age=86400')
        response.end(DEFAULT_FAVICON_PNG)
        return
      }
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
