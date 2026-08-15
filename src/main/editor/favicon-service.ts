import { Logger } from '../system/logger'

/**
 * Favicon resolution for external links.
 *
 * The renderer CSP blocks remote images, so link favicons are fetched here in the
 * main process and returned as `data:` URLs. Lookup strategy per host:
 *
 * 1. `{origin}/favicon.ico` (the classic location, one cheap request).
 * 2. The page's declared icon (`<link rel="icon">` / `apple-touch-icon`) parsed
 *    from a size-limited HTML fetch.
 *
 * Results are cached by host with a TTL so repeated links never re-fetch.
 */

const FAVICON_TIMEOUT_MS = 8_000
const MAX_HTML_BYTES = 128 * 1024
const MAX_ICON_BYTES = 512 * 1024
const CACHE_TTL_MS = 6 * 60 * 60 * 1000
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

const cache = new Map<string, { dataUrl: string | null; expiresAt: number }>()

/** Resolve favicons for many hosts in one call. Keys are the requested hosts. */
export async function resolveFavicons(hosts: string[]): Promise<Record<string, string | null>> {
  const result: Record<string, string | null> = {}
  const now = Date.now()
  for (const host of hosts) {
    const cached = cache.get(host)
    if (cached && cached.expiresAt > now) {
      result[host] = cached.dataUrl
      continue
    }
    const dataUrl = await resolveFavicon(host)
    cache.set(host, { dataUrl, expiresAt: Date.now() + CACHE_TTL_MS })
    result[host] = dataUrl
  }
  return result
}

async function resolveFavicon(host: string): Promise<string | null> {
  const origins = [`https://${host}`, `http://${host}`]
  for (const origin of origins) {
    const ico = await fetchImageAsDataUrl(`${origin}/favicon.ico`)
    if (ico) return ico
  }
  for (const origin of origins) {
    const iconUrl = await declaredIconHref(origin)
    if (!iconUrl) continue
    const icon = await fetchImageAsDataUrl(iconUrl)
    if (icon) return icon
  }
  return null
}

/** Find the declared icon href from a size-limited fetch of the page HTML. */
async function declaredIconHref(origin: string): Promise<string | null> {
  const html = await fetchTextLimited(`${origin}/`, MAX_HTML_BYTES)
  if (!html) return null
  const href = extractIconHref(html)
  if (!href) return null
  try {
    return new URL(href, origin).href
  } catch {
    return null
  }
}

function extractIconHref(html: string): string | null {
  const tagRe = /<link\b[^>]*>/gi
  const hrefRe = /\bhref\s*=\s*["']([^"']+)["']/i
  const relRe = /\brel\s*=\s*["']([^"']*)["']/i
  let appleTouch: string | null = null
  for (const tag of html.matchAll(tagRe)) {
    const rel = (tag[0].match(relRe)?.[1] ?? '').toLowerCase()
    const href = tag[0].match(hrefRe)?.[1]
    if (!href) continue
    if (/apple-touch/.test(rel)) {
      if (!appleTouch) appleTouch = href
    } else if (/icon/.test(rel) && !/(preload|manifest)/.test(rel)) {
      return href
    }
  }
  return appleTouch
}

async function fetchTextLimited(url: string, maxBytes: number): Promise<string | null> {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FAVICON_TIMEOUT_MS),
      headers: { 'user-agent': BROWSER_UA, accept: 'text/html' }
    })
    if (!response.ok || !response.body) return null
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let received = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      chunks.push(value)
      received += value.length
      if (received >= maxBytes) break
    }
    await reader.cancel().catch(() => undefined)
    return Buffer.concat(chunks).toString('utf8')
  } catch (error) {
    Logger.dev(`Favicon page fetch failed for ${url}:`, error)
    return null
  }
}

async function fetchImageAsDataUrl(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FAVICON_TIMEOUT_MS),
      headers: { 'user-agent': BROWSER_UA, accept: 'image/*,*/*' }
    })
    if (!response.ok) return null
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length === 0 || buffer.length > MAX_ICON_BYTES) return null
    const mime = sniffImage(buffer, response.headers.get('content-type') ?? '')
    if (!mime) return null
    return `data:${mime};base64,${buffer.toString('base64')}`
  } catch (error) {
    Logger.dev(`Favicon image fetch failed for ${url}:`, error)
    return null
  }
}

/** Return a usable image mime for the buffer, or null when it is not an image. */
function sniffImage(buffer: Buffer, contentType: string): string | null {
  const declared = contentType.split(';')[0].trim().toLowerCase()
  if (declared.startsWith('image/')) return declared
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return 'image/png'
  }
  if (buffer.length >= 6 && buffer.subarray(0, 6).toString('ascii') === 'GIF89a') {
    return 'image/gif'
  }
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x00 &&
    buffer[1] === 0x00 &&
    buffer[2] === 0x01 &&
    buffer[3] === 0x00
  ) {
    return 'image/x-icon'
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp'
  }
  const head = buffer.subarray(0, 256).toString('utf8').trimStart().toLowerCase()
  if (head.startsWith('<svg') || head.startsWith('<?xml')) return 'image/svg+xml'
  return null
}
