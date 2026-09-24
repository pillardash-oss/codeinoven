/**
 * How an image travels from a tool result to the model, and what it costs.
 *
 * A screenshot arrives as base64 inside a tool result. A harness bills a base64
 * payload sitting in a TEXT part at roughly one token per character, while the
 * same bytes delivered as an IMAGE content part are billed on the pixels it
 * covers. Measured on a real 3840x2160 capture from a design thread:
 *
 *   3840x2160 as a text part    ~40,788 tokens
 *   3840x2160 as an image part  ~11,059 tokens
 *   1568x882  as an image part   ~1,844 tokens
 *   1280x720  as an image part   ~1,229 tokens
 *
 * That one thread held seven byte-identical copies of a single capture in one
 * turn, which is why it compacted repeatedly, so the delivery type is the
 * dominant lever and this module owns it.
 *
 * Downscaling is the weaker lever on bytes: the same capture measured 40,788
 * base64 characters at 4K and 40,224 at 1568px, because a flat design page
 * already compresses well and PNG beat JPEG at equal size (30,166 against 29,593
 * bytes). It still matters, because it cuts the picture the provider has to tile
 * and it bounds a photo-heavy page that would otherwise bloat the transcript.
 *
 * Pure string and shape logic with no Electron or `node:*` import, so the main
 * process, the generated gateway scripts, and build scripts can all consume it.
 */

/** A content part a harness renders as a picture rather than as text. */
export interface GatewayImagePart {
  type: 'image'
  data: string
  mimeType: string
}

/** A content part a harness renders as prose. */
export interface GatewayTextPart {
  type: 'text'
  text: string
}

export type GatewayContentPart = GatewayImagePart | GatewayTextPart

/**
 * A gateway result carrying images: the `content` array is the tool content a
 * harness renders, and both bridges already forward a `content` array verbatim
 * (the MCP bridge through its own `resultContent`, the Pi bridge through
 * `textResult`). Returning this shape is therefore all it takes to stop paying
 * text rates for a picture.
 */
export interface GatewayImageResult {
  content: GatewayContentPart[]
}

/**
 * The longest edge a captured screenshot is kept at. 1568px is where the vision
 * providers stop downscaling anyway, so a larger capture buys no legibility with
 * the model and only costs tokens; the user still sees the full-resolution page
 * in the browser panel.
 */
export const MAX_SCREENSHOT_DIMENSION = 1568

/** A result is not scanned deeper than this, so a pathological payload cannot
 *  turn the walk into a full-tree traversal. */
const MAX_WALK_DEPTH = 6

/** Images converted out of one result. A screenshot call returns one; a
 *  multi-image utility returns a handful, and the rest stay inline. */
const MAX_IMAGES_PER_RESULT = 8

const IMAGE_DATA_URL = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/iu

/**
 * Fit a box inside a square budget, preserving its aspect ratio and never
 * upscaling it. Returns whole pixels, because a fractional capture size is
 * rounded by the encoder anyway and the resize call expects integers.
 */
export function fitWithin(
  width: number,
  height: number,
  max: number
): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (!Number.isFinite(longest) || longest <= max || longest <= 0) {
    return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) }
  }
  const scale = max / longest
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  }
}

/** Split a base64 image data URL into the parts a harness needs, or null when
 *  the string is not an image data URL. */
export function parseImageDataUrl(value: string): { mimeType: string; data: string } | null {
  const match = IMAGE_DATA_URL.exec(value)
  if (!match) return null
  return { mimeType: match[1].toLowerCase(), data: match[2] }
}

/** The text left behind where an image was lifted out of the payload. It states
 *  the media type and size so the model knows what it is looking at without
 *  needing the bytes repeated as characters. */
function imageMarker(mimeType: string, base64Length: number): string {
  const kilobytes = Math.max(1, Math.round((base64Length * 3) / 4 / 1024))
  return `[image delivered as an image content part, not inline base64: ${mimeType}, ${kilobytes} KB]`
}

function collect(value: unknown, images: GatewayImagePart[], depth: number): unknown {
  if (typeof value === 'string') {
    if (images.length >= MAX_IMAGES_PER_RESULT) return value
    const parsed = parseImageDataUrl(value)
    if (!parsed) return value
    images.push({ type: 'image', data: parsed.data, mimeType: parsed.mimeType })
    return imageMarker(parsed.mimeType, parsed.data.length)
  }
  if (depth >= MAX_WALK_DEPTH) return value
  if (Array.isArray(value)) return value.map((item) => collect(item, images, depth + 1))
  if (typeof value === 'object' && value !== null) {
    const mapped: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) mapped[key] = collect(item, images, depth + 1)
    return mapped
  }
  return value
}

/**
 * Rewrite a gateway result so every image data URL it carries becomes a real
 * image content part, with a short marker left in its place.
 *
 * Returns null when the result holds no image, so a caller keeps today's exact
 * behaviour for every text-only result instead of wrapping them all.
 */
export function resultWithImageParts(result: unknown): GatewayImageResult | null {
  const images: GatewayImagePart[] = []
  const stripped = collect(result, images, 0)
  if (images.length === 0) return null
  const text = JSON.stringify(stripped) ?? String(stripped)
  return { content: [{ type: 'text', text }, ...images] }
}
