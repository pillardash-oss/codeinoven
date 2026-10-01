/**
 * The tinting half of the custom-SVG pipeline, kept apart from the parsing half.
 *
 * `lib/custom-svg` parses a pasted SVG with `@xmldom/xmldom`, which is ~236 KB of
 * renderer JavaScript. Project and routine icons only ever need to tint an
 * already-sanitized SVG, and both resolve on the first paint (the sidebar and the
 * assistant search read them), so importing that parser for a tint pinned the
 * whole XML DOM into the entry chunk. This module carries the one function they
 * need, with no parser dependency; `lib/custom-svg` is left to the surfaces that
 * actually sanitize a pasted value, and re-exports this one so a caller that
 * needs both keeps importing it from one place.
 */

const svgUrlCache = new Map<string, string>()

/** Render a normalized SVG as an image URL with its chromatic paint tinted. */
export function getCustomSvgDataUrl(svg: string, color: string): string {
  const cacheKey = `${color}\u0000${svg}`
  const cached = svgUrlCache.get(cacheKey)
  if (cached) return cached
  const escapedColor = color.replace(/[&"<>]/g, (character) => {
    const escapes: Record<string, string> = {
      '&': '&amp;',
      '"': '&quot;',
      '<': '&lt;',
      '>': '&gt;'
    }
    return escapes[character] ?? character
  })
  const rendered = svg.replace(/currentColor/g, escapedColor)
  const binary = Array.from(new TextEncoder().encode(rendered), (byte) =>
    String.fromCharCode(byte)
  ).join('')
  const url = `data:image/svg+xml;base64,${btoa(binary)}`
  svgUrlCache.set(cacheKey, url)
  if (svgUrlCache.size > 256) {
    const oldest = svgUrlCache.keys().next().value
    if (oldest !== undefined) svgUrlCache.delete(oldest)
  }
  return url
}
