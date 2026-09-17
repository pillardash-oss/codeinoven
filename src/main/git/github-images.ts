import { isLocalDevelopmentUrl } from '../../lib/local-development-url'
import { fetchImageAsDataUrl } from '../editor/favicon-service'
import { Logger } from '../system/logger'

/**
 * Remote images that appear inside provider-authored markdown (a GitHub pull
 * request body or comment).
 *
 * The renderer CSP is `img-src 'self' data: blob: file: appfile:`, so a screenshot
 * a review comment points at renders as a broken image and every picture has to
 * arrive as a `data:` URL. This is the avatars/favicons route for the images a
 * markdown body embeds: fetch here, inline once, cache by URL so scrolling the
 * same conversation back and forth does not re-download anything.
 *
 * Unlike an avatar URL, a markdown image URL is written by whoever authored the
 * comment, so it is untrusted input: only `https:` survives validation, literal
 * private/loopback/link-local hosts are refused, and one call cannot fan out into
 * hundreds of downloads.
 */

/**
 * GitHub's attachment CDN is content addressed: the `<uuid>` in
 * `github.com/user-attachments/assets/<uuid>` *is* the identity of the bytes, so
 * the picture at that URL can never change and a long-lived hit is free.
 */
const IMMUTABLE_CACHE_TTL_MS = 24 * 60 * 60 * 1000
/**
 * Every other host may replace the bytes behind the same path (a README banner is
 * re-uploaded, a screenshot is overwritten), so an ordinary hit is kept for an
 * hour: long enough that a conversation re-render or a reopen is free, short
 * enough that a replaced image appears in the same session.
 */
const CACHE_TTL_MS = 60 * 60 * 1000
/**
 * A miss is retried sooner, exactly like the avatar store: it can mean a removed
 * attachment, a hotlink-protected host, or a request that merely blipped.
 */
const NEGATIVE_CACHE_TTL_MS = 10 * 60 * 1000
/**
 * Bounded so a long-lived main process cannot accumulate inlined images forever.
 * The inliner caps each entry at 512 KB, so this is at worst a low-hundreds-of-MB
 * ceiling and normally far less, since real screenshots are small. Eviction is
 * least-recently-used; a hit refreshes recency without extending its TTL.
 */
const MAX_CACHE_ENTRIES = 256
/**
 * One payload may name as many images as it likes; this keeps one hostile (or
 * merely careless) markdown body from turning into hundreds of outbound requests.
 * It is deliberately above the renderer's batch size of 32.
 */
const MAX_URLS_PER_CALL = 64

const cache = new Map<string, { dataUrl: string | null; expiresAt: number }>()

/** Inline the remote images a markdown body named. Keys are the URLs as asked for. */
export async function resolveImages(urls: string[]): Promise<Record<string, string | null>> {
  const requested = [...new Set(urls)]
  const accepted = requested.slice(0, MAX_URLS_PER_CALL)
  if (accepted.length < requested.length) {
    Logger.dev(
      `Image inlining capped at ${MAX_URLS_PER_CALL} URLs per call; ` +
        `${requested.length - accepted.length} skipped.`
    )
  }

  const result: Record<string, string | null> = {}
  // URLs past the cap are reported as null rather than omitted, so every URL that
  // was asked about has an answer and the renderer's negative cache can settle.
  for (const url of requested) result[url] = null
  await Promise.all(
    accepted.map(async (url) => {
      result[url] = await imageFor(url)
    })
  )
  return result
}

async function imageFor(rawUrl: string): Promise<string | null> {
  const url = validatedImageUrl(rawUrl)
  // A rejected URL is never cached: validation is pure and free, and putting junk
  // in the LRU would push out a real picture.
  if (!url) return null

  const cached = cache.get(rawUrl)
  if (cached) {
    if (cached.expiresAt > Date.now()) {
      // Refresh recency so the entry just used is the last one evicted.
      cache.delete(rawUrl)
      cache.set(rawUrl, cached)
      return cached.dataUrl
    }
    cache.delete(rawUrl)
  }

  const dataUrl = await fetchImageAsDataUrl(url.href)
  remember(rawUrl, dataUrl, ttlFor(url))
  return dataUrl
}

/**
 * The URL to fetch, or null when this markdown image must not be fetched. Provider
 * markdown can name any scheme a browser understands, and the fetches below run in
 * the main process with Node's privileges, so the allow-list is a hard `https:`
 * filter:
 *
 * - `http:` is plaintext (and mixed-content blocked in the renderer anyway),
 * - `data:`/`blob:` would let the comment author smuggle arbitrary bytes straight
 *   into the page as an image the app never vetted,
 * - `file:` would read the user's disk into the renderer,
 * - `javascript:` and anything else unparseable is not an image at all.
 */
function validatedImageUrl(rawUrl: string): URL | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  if (url.hostname.length === 0) return null
  if (isBlockedHost(url)) return null
  return url
}

/**
 * Whether the host is this machine, the local network or a link-local address.
 *
 * The WHATWG URL parser already normalizes exotic IPv4 spellings (`0x7f.1`,
 * `2130706433`) to dotted decimal, so a literal check on the serialized hostname
 * cannot be spelled around. `isLocalDevelopmentUrl` owns the repository's notion of
 * loopback/RFC1918/`.localhost`; this adds the ranges that matter for an outbound
 * fetch but not for a browser address bar: link-local IPv4 (where cloud metadata
 * services live), IPv6 link-local/unique-local, and IPv4-mapped IPv6.
 *
 * This is a literal-IP guard only, applied to the URL the markdown names. It does
 * not resolve DNS and it does not re-check redirects, so a public hostname that
 * resolves (or redirects) to an internal address is not covered. That is the
 * honest limit of a dependency-free check at this boundary; the allow-list still
 * turns a trivial `https://127.0.0.1/...` payload into a null without a request.
 */
function isBlockedHost(url: URL): boolean {
  if (isLocalDevelopmentUrl(url.href)) return true

  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/gu, '')
    .replace(/\.$/u, '')

  const octets = host.split('.')
  if (octets.length === 4 && octets.every((part) => /^\d{1,3}$/u.test(part))) {
    const first = Number(octets[0])
    const second = Number(octets[1])
    // Link-local 169.254.0.0/16, the range cloud metadata endpoints answer on.
    if (first === 169 && second === 254) return true
  }

  if (host.includes(':')) {
    // IPv6 link-local `fe80::/10`, unique-local `fc00::/7`, IPv4-mapped `::ffff:0:0/96`.
    if (/^(?:fe[89ab]|f[cd])/u.test(host)) return true
    if (host.startsWith('::ffff:')) return true
  }

  return false
}

/** How long a successful fetch stays warm, by how immutable the bytes behind it are. */
function ttlFor(url: URL): number {
  const isGithubAttachment =
    url.hostname === 'github.com' && url.pathname.startsWith('/user-attachments/')
  return isGithubAttachment ? IMMUTABLE_CACHE_TTL_MS : CACHE_TTL_MS
}

function remember(rawUrl: string, dataUrl: string | null, ttlMs: number): void {
  if (cache.size >= MAX_CACHE_ENTRIES && !cache.has(rawUrl)) {
    // Map iteration is insertion order, so the first key is the least recently used.
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(rawUrl, {
    dataUrl,
    expiresAt: Date.now() + (dataUrl === null ? NEGATIVE_CACHE_TTL_MS : ttlMs)
  })
}
