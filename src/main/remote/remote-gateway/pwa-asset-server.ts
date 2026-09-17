/// <reference types="node" />

/**
 * PWA static asset serving for the remote gateway.
 *
 * The PWA is a Vite code-split bundle, so its shared chunks have hashed,
 * unrelated names. This server computes the exact set of `/assets/...` files
 * `remote.html` references (see `pwa-asset-graph.ts`) and serves only that
 * closure   never the desktop app's shell or entry. Assets are cached with
 * ETag revalidation and lazily compressed with Brotli or gzip.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { brotliCompress, gzip } from 'node:zlib'
import { promisify } from 'node:util'
import { Logger } from '../../system/logger'
import { computePwaAssetGraph } from '../pwa-asset-graph'

/** An on-disk file with its raw bytes, ETag, and lazily-compressed variants. */
interface CachedAsset {
  /** `mtimeMs:size` stamp used to invalidate the cache on rebuild. */
  stamp: string
  raw: Buffer
  etag: string
  compressed: Partial<Record<'br' | 'gzip', Buffer>>
}

/** Raw plus compressed PWA assets retained by the gateway process. */
export const MAX_ASSET_CACHE_ENTRIES = 256
export const MAX_ASSET_CACHE_BYTES = 128 * 1024 * 1024

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
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/notification-badge.png',
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

export class PwaAssetServer {
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

  constructor(
    private readonly staticRoot: string,
    private readonly certificateDir: string
  ) {}

  /**
   * Recompute the allow-list when the build output changed.
   *
   * Every rebuild rewrites `remote.html` with freshly hashed chunk names, so a
   * closure captured at startup would 404 exactly the assets the newly served
   * HTML asks for   the phone would load a blank page until the app restarted.
   * Fingerprinting `remote.html` keeps the allow-list in step with whatever is
   * actually on disk.
   */
  async refreshClosure(): Promise<void> {
    let stamp: string
    try {
      const info = await stat(join(this.staticRoot, 'remote.html'))
      stamp = `${info.mtimeMs}:${info.size}`
    } catch {
      return
    }
    if (stamp === this.closureStamp) return
    const graph = await computePwaAssetGraph(this.staticRoot)
    // Hashed assets change as one generation. Discard the previous generation
    // atomically instead of retaining obsolete raw/gzip/Brotli variants.
    this.assetCache.clear()
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

  /** Drop every cached asset (used when the gateway stops). */
  clearCache(): void {
    this.assetCache.clear()
  }

  handleHttp(request: IncomingMessage, response: ServerResponse): void {
    void this.refreshClosure().then(() => this.serveHttp(request, response))
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
    this.enforceAssetCacheBounds()
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
      if (current === cached.stamp) {
        this.assetCache.delete(filePath)
        this.assetCache.set(filePath, cached)
        return cached
      }
      this.assetCache.delete(filePath)
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
      this.enforceAssetCacheBounds()
      return asset
    } catch {
      return null
    }
  }

  private cachedAssetBytes(asset: CachedAsset): number {
    return (
      asset.raw.byteLength +
      (asset.compressed.br?.byteLength ?? 0) +
      (asset.compressed.gzip?.byteLength ?? 0)
    )
  }

  /** LRU eviction bounded by both cardinality and retained byte size. */
  private enforceAssetCacheBounds(): void {
    let bytes = 0
    for (const asset of this.assetCache.values()) bytes += this.cachedAssetBytes(asset)
    while (this.assetCache.size > MAX_ASSET_CACHE_ENTRIES || bytes > MAX_ASSET_CACHE_BYTES) {
      const oldest = this.assetCache.entries().next().value as [string, CachedAsset] | undefined
      if (!oldest) break
      this.assetCache.delete(oldest[0])
      bytes -= this.cachedAssetBytes(oldest[1])
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
    // never cached as immutable   the service worker owns their lifecycle.
    if (this.mutableAssets.has(pathOnly)) return 'no-store'
    return 'no-store'
  }

  /** Generate the service-worker source with the current precache injected. */
  private generateServiceWorkerSource(): string {
    try {
      const template = readFileSync(join(this.staticRoot, 'service-worker.js'), 'utf8')
      const version = JSON.stringify(this.closureStamp ?? 'dev')
      return template
        .replace('/*__PRECACHE_MANIFEST__*/[]', JSON.stringify(this.precache))
        .replace('/*__PRECACHE_VERSION__*/"dev"', version)
    } catch {
      return 'self.onfetch=()=>{}'
    }
  }

  /** Resolve a request path to a PWA asset   allow-list enforced. */
  private resolvePwaPath(pathOnly: string): string | null {
    // The self-signed certificate is served so phones (iOS in particular) can
    // download and install it as a trust profile.
    if (pathOnly === '/cert.pem') {
      const certPath = join(this.certificateDir, 'cert.pem')
      return existsSync(certPath) ? certPath : null
    }
    const root = resolve(this.staticRoot)
    const path = pathOnly === '/' ? '/remote.html' : pathOnly
    if (!ALLOWED_STATIC.has(path) && !this.allowedAssets.has(path)) return null
    const requested = normalize(path).replace(/^([/\\])+/, '')
    const target = resolve(root, requested)
    if (target !== root && !target.startsWith(root + sep)) return null
    return existsSync(target) ? target : null
  }
}
