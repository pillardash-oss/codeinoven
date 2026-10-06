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
 * Marks a result that is already shaped for a bridge.
 *
 * An MCP `CallToolResult` and a shaped gateway result are structurally the same
 * thing (`content` parts beside `structuredContent`), so a second shaping pass
 * cannot tell them apart by shape and would rewrite a snapshot that is already
 * clean. The mark is a symbol, so it lives only in the process that built the
 * value: a bridge receiving the JSON never sees it.
 */
export const SHAPED_GATEWAY_RESULT = Symbol('codeinoven.shapedGatewayResult')

/**
 * A gateway result as a bridge forwards it: the content parts a harness
 * renders, plus the same payload as data.
 *
 * The text part is what a model reads, because a model never sees
 * `structuredContent`. The structured payload is what a script resolves the
 * call to, because a harness that runs scripts hands a tool declaring an output
 * schema its `structuredContent` instead of its flattened text. One result,
 * two readers, and neither is asked to parse the other's copy.
 */
export interface GatewayStructuredResult {
  content: GatewayContentPart[]
  structuredContent: Record<string, unknown>
  [SHAPED_GATEWAY_RESULT]?: true
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

/**
 * The size a base64 payload decodes to, in whole kilobytes.
 *
 * Every marker that stands in for an image payload states its size, and they
 * must agree: a reader comparing "32 KB" here with "31 KB" in the durable log
 * would be looking at a bug that does not exist. Exported for that reason.
 */
export function base64Kilobytes(base64Length: number): number {
  return Math.max(1, Math.round((base64Length * 3) / 4 / 1024))
}

/** The text left behind where an image was lifted out of the payload. It states
 *  the media type and size so the model knows what it is looking at without
 *  needing the bytes repeated as characters. */
function imageMarker(mimeType: string, base64Length: number): string {
  return `[image delivered as an image content part, not inline base64: ${mimeType}, ${base64Kilobytes(base64Length)} KB]`
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

/**
 * Lift image content parts a server already sent out of the payload and into
 * the envelope's content array.
 *
 * An MCP server may answer with a picture as a content part rather than as a
 * data URL inside a string (the computer-use driver does), and those bytes are
 * billed as text wherever they sit in a payload. The part moves to the content
 * array, where a harness renders it as a picture, and a text marker takes its
 * place so the payload still says what was there.
 */
function hoistImageParts(value: unknown, images: GatewayImagePart[], depth = 0): unknown {
  if (depth >= MAX_WALK_DEPTH) return value
  if (Array.isArray(value)) return value.map((item) => hoistImageParts(item, images, depth + 1))
  if (typeof value !== 'object' || value === null) return value
  const record = value as Record<string, unknown>
  if (
    record['type'] === 'image' &&
    typeof record['data'] === 'string' &&
    typeof record['mimeType'] === 'string'
  ) {
    const mimeType = record['mimeType']
    const data = record['data']
    if (images.length < MAX_IMAGES_PER_RESULT && !images.some((image) => image.data === data)) {
      images.push({ type: 'image', data, mimeType })
    }
    return { type: 'text', text: imageMarker(mimeType, data.length) }
  }
  const mapped: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(record)) {
    mapped[key] = hoistImageParts(item, images, depth + 1)
  }
  return mapped
}

/** Whether a value is already shaped for a bridge to forward as it stands. */
function isGatewayStructuredResult(value: unknown): value is GatewayStructuredResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return (value as GatewayStructuredResult)[SHAPED_GATEWAY_RESULT] === true
}

/** Whether a value can be a structured payload: a JSON object, never an array. */
function isStructuredPayload(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The content parts a result already carries, with every picture in them lifted
 * into `images`, or null when the result carries none.
 *
 * A server's own parts are the model's view today and stay the model's view
 * here: its text is kept verbatim (a data URL inside that text becomes an image
 * part with a marker left behind), and its pictures travel as pictures.
 */
function existingContentParts(
  result: Record<string, unknown>,
  images: GatewayImagePart[]
): GatewayContentPart[] | null {
  if (!Array.isArray(result['content'])) return null
  const parts: GatewayContentPart[] = []
  for (const part of result['content']) {
    if (typeof part !== 'object' || part === null || Array.isArray(part)) continue
    const entry = part as Record<string, unknown>
    if (entry['type'] === 'text' && typeof entry['text'] === 'string') {
      const lifted: GatewayImagePart[] = []
      const text = collect(entry['text'], lifted, 0)
      for (const image of lifted) {
        if (!images.some((existing) => existing.data === image.data)) images.push(image)
      }
      parts.push({ type: 'text', text: typeof text === 'string' ? text : String(text) })
      continue
    }
    if (
      entry['type'] === 'image' &&
      typeof entry['data'] === 'string' &&
      typeof entry['mimeType'] === 'string'
    ) {
      if (!images.some((existing) => existing.data === entry['data'])) {
        images.push({ type: 'image', data: entry['data'], mimeType: entry['mimeType'] })
      }
      continue
    }
    // Anything else a server sent is kept as text, so no field is ever dropped.
    parts.push({ type: 'text', text: JSON.stringify(entry) ?? String(entry) })
  }
  return parts.length > 0 ? parts : null
}

/**
 * Shape one gateway result for the bridges: content parts for a model, and the
 * payload itself for a script.
 *
 * Every picture the result carries becomes a real image part, with a marker
 * left where its bytes were, so nothing is billed at text rates and the payload
 * still says what was there. The model's view does not change: a result that
 * already carries content parts keeps them (the server's own words and
 * pictures), and one that does not is read as the JSON a bridge rendered before.
 *
 * A result that is already shaped (the computer-use snapshot) is returned
 * untouched, so a clean payload is never walked a second time.
 *
 * A result that is not a JSON object (an array, a string, a number) is wrapped
 * as `{ result: value }`, because a declared output schema promises a script an
 * object it can read fields from.
 *
 * An MCP result that carries its own `structuredContent` hands that payload to a
 * script directly rather than nesting the whole result around it: the picture's
 * bytes would otherwise sit in the structured copy as well, and a script that
 * asked for a snapshot's elements would have to unwrap a layer nobody needs.
 */
export function gatewayStructuredResult(result: unknown): GatewayStructuredResult {
  if (isGatewayStructuredResult(result)) return result
  const record =
    typeof result === 'object' && result !== null && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : null
  const images: GatewayImagePart[] = []
  // The payload a script reads: an MCP result's own `structuredContent` when it
  // has one, and the whole result otherwise.
  const payloadSource =
    record && 'structuredContent' in record ? record['structuredContent'] : result
  const stripped = hoistImageParts(collect(payloadSource, images, 0), images)
  const payload = isStructuredPayload(stripped) ? stripped : { result: stripped }
  const parts = record ? existingContentParts(record, images) : null
  if (parts) return { content: [...parts, ...images], structuredContent: payload }
  const text = JSON.stringify(stripped) ?? String(stripped)
  return { content: [{ type: 'text', text }, ...images], structuredContent: payload }
}
