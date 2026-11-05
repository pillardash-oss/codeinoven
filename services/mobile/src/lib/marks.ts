/**
 * The two small pieces every mark on the phone needs: the initials a project or
 * an assistant falls back to, and the tinted data URL a pasted SVG is drawn from.
 *
 * The desktop's own `custom-svg-tint` lives apart from its XML parser for exactly
 * this reason: a mark resolves on first paint, and the parser that sanitizes a
 * pasted value is not something a list row should carry into the bundle.
 */

const urlCache = new Map<string, string>()

/** Render a stored SVG as an image URL with its chromatic paint tinted. */
export function customSvgDataUrl(svg: string, color: string): string {
  const cacheKey = `${color}\u0000${svg}`
  const cached = urlCache.get(cacheKey)
  if (cached) return cached

  const escaped = color.replace(/[&"<>]/g, (character) => {
    const escapes: Record<string, string> = {
      '&': '&amp;',
      '"': '&quot;',
      '<': '&lt;',
      '>': '&gt;'
    }
    return escapes[character] ?? character
  })
  const rendered = svg.replace(/currentColor/g, escaped)
  const binary = Array.from(new TextEncoder().encode(rendered), (byte) =>
    String.fromCharCode(byte)
  ).join('')
  const url = `data:image/svg+xml;base64,${btoa(binary)}`
  urlCache.set(cacheKey, url)
  if (urlCache.size > 256) {
    const oldest = urlCache.keys().next().value
    if (oldest !== undefined) urlCache.delete(oldest)
  }
  return url
}

/** The two letters a mark shows when the project or assistant has no icon. */
export function markInitials(name: string): string {
  return name
    .split(/[\s-_]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
}
