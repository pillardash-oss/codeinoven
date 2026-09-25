/** Whether a web URL targets this machine or the local network (loopback + RFC1918 private). */
export function isLocalDevelopmentUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false

  const hostname = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/gu, '')
    .replace(/\.$/u, '')
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true
  if (hostname === '::1' || hostname === '::' || hostname === '0.0.0.0') return true

  const ipv4 = hostname.split('.')
  if (ipv4.length === 4 && ipv4.every((part) => /^\d{1,3}$/u.test(part))) {
    const a = Number(ipv4[0])
    const b = Number(ipv4[1])
    // Loopback: 127.0.0.0/8
    if (a === 127) return true
    // Private LAN: 10.0.0.0/8
    if (a === 10) return true
    // Private LAN: 172.16.0.0/12 (172.16 - 172.31)
    if (a === 172 && b >= 16 && b <= 31) return true
    // Private LAN: 192.168.0.0/16
    if (a === 192 && b === 168) return true
  }
  return false
}

/**
 * Whether an outbound fetch must refuse this host.
 *
 * `isLocalDevelopmentUrl` owns this repository's notion of loopback, RFC1918 and
 * `.localhost`, which is what a browser address bar needs. An outbound fetch
 * needs that answer plus the ranges that only matter when this process opens the
 * connection: link-local IPv4 (where cloud metadata services answer), IPv6
 * link-local and unique-local, and IPv4-mapped IPv6.
 *
 * The WHATWG URL parser normalizes exotic IPv4 spellings (`0x7f.1`,
 * `2130706433`) to dotted decimal, so a literal check on the serialized hostname
 * cannot be spelled around. It is a literal check only: it resolves no DNS, so a
 * public hostname that resolves to an internal address is not covered, and a
 * caller that follows redirects has to re-check every hop.
 */
export function isBlockedFetchHost(value: string | URL): boolean {
  let url: URL
  try {
    url = typeof value === 'string' ? new URL(value) : value
  } catch {
    return false
  }
  if (isLocalDevelopmentUrl(url.href)) return true

  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/gu, '')
    .replace(/\.$/u, '')

  const octets = host.split('.')
  if (octets.length === 4 && octets.every((part) => /^\d{1,3}$/u.test(part))) {
    // Link-local 169.254.0.0/16, the range cloud metadata endpoints answer on.
    if (Number(octets[0]) === 169 && Number(octets[1]) === 254) return true
  }

  if (host.includes(':')) {
    // IPv6 link-local `fe80::/10`, unique-local `fc00::/7`, IPv4-mapped `::ffff:0:0/96`.
    if (/^(?:fe[89ab]|f[cd])/u.test(host)) return true
    if (host.startsWith('::ffff:')) return true
  }

  return false
}

/**
 * Whether a page URL belongs to one preview origin.
 *
 * This is how the tab a preview server is feeding gets found: the server knows
 * its own origin and nothing about browsers, so the browser side matches tabs by
 * the URL they are showing. The comparison is on the origin rather than the whole
 * URL, because a preview can be on any path under it, and the separator keeps
 * `:8080` from matching `:80801`.
 */
export function isPreviewOriginUrl(value: string, origin: string): boolean {
  const base = origin.endsWith('/') ? origin.slice(0, -1) : origin
  if (!base) return false
  return value === base || value.startsWith(`${base}/`)
}

/** Add a development-friendly scheme when the address bar receives a host only. */
export function normalizeBrowserUrl(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const candidate = /^[a-z][a-z\d+.-]*:/iu.test(trimmed) ? trimmed : `http://${trimmed}`
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.username !== '' || url.password !== '') return null
    return url.href
  } catch {
    return null
  }
}
