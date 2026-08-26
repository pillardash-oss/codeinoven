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
