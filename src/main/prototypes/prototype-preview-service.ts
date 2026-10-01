import { createReadStream } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { opendir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { mimeTypeForPath } from '../../lib/mime-types'
import { PROTOTYPE_ASSET_BYTE_LIMIT } from '../../lib/prototypes/prototype-artifacts'
import { appServiceRegistry } from '../system/app-service-registry'
import {
  STRICT_PROTOTYPE_CDN_POLICY,
  prototypePreviewCsp,
  type PrototypeCdnPolicy
} from '../../lib/prototypes/prototype-cdn'

/** 16x16 amber placeholder served when a browser asks the origin root for a favicon. */
const DEFAULT_FAVICON_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAG0lEQVR4nGN41WXznxLMMGrAaBiMpoP/wyQMANVNrx/VZr2aAAAAAElFTkSuQmCC',
  'base64'
)

function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

export class PrototypePreviewService {
  private server: Server | null = null
  private starting: Promise<number> | null = null
  private readonly roots = new Map<string, string>()
  /**
   * The header the next response carries. Strict until the app applies the
   * configured policy, so a service nobody configured stays closed rather than
   * silently opening the network.
   */
  private csp = prototypePreviewCsp(STRICT_PROTOTYPE_CDN_POLICY)

  /**
   * Apply the external CDN policy from settings. Resolved on apply rather than
   * per response, so one settings change costs one recomputation and every
   * following request already carries the new header.
   */
  setCdnPolicy(policy: PrototypeCdnPolicy): void {
    this.csp = prototypePreviewCsp(policy)
  }

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
        // Announce the loopback origin so the task manager shows it. It lives
        // for the whole app session, so it registers with no stop action.
        appServiceRegistry.register({
          id: 'prototype-preview',
          kind: 'server',
          name: 'Prototype preview server',
          detail: `http://127.0.0.1:${address.port}`,
          scope: 'app',
          port: address.port,
          url: `http://127.0.0.1:${address.port}`
        })
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
    appServiceRegistry.unregister('prototype-preview')
    if (!server) return
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
  }

  private async respond(url: string, response: import('node:http').ServerResponse): Promise<void> {
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    response.setHeader('Content-Security-Policy', this.csp)
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
      response.setHeader('Content-Type', mimeTypeForPath(actual))
      createReadStream(actual, { highWaterMark: 256 * 1024 }).pipe(response)
    } catch {
      response.statusCode = 404
      response.end('Not found')
    }
  }
}
