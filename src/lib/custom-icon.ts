/**
 * The one shape a user-picked icon image takes once the pipeline has run.
 *
 * A picked image is decoded, centre-cropped to a square, scaled down and
 * re-encoded as WebP in the renderer, because Chromium is the only image codec
 * the app can reach that writes WebP (the main process can only emit PNG/JPEG).
 * What crosses the IPC boundary is therefore already final: the main process
 * only bounds it and writes it down.
 *
 * This module imports nothing, so the renderer can share it without pulling a
 * Node built-in in through it.
 */

/** The longest edge a stored icon image keeps. Icons are drawn at 12-32 px. */
export const CUSTOM_ICON_EDGE = 64

/**
 * The largest a pipelined icon may be, in bytes.
 *
 * A 64 px WebP is a few kilobytes at most, so half a megabyte is generous while
 * still refusing an oversized or forged payload before it reaches disk.
 */
export const MAX_CUSTOM_ICON_BYTES = 512 * 1024

/** A ready-to-store icon image: square WebP bytes, at most {@link CUSTOM_ICON_EDGE}. */
export interface CustomIconImage {
  data: Uint8Array
}

const RIFF_TAG = [0x52, 0x49, 0x46, 0x46]
const WEBP_TAG = [0x57, 0x45, 0x42, 0x50]

/** Whether `bytes` begins with the RIFF/WEBP container signature. */
export function isWebpImage(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 12) return false
  for (let index = 0; index < 4; index += 1) {
    if (bytes[index] !== RIFF_TAG[index] || bytes[index + 8] !== WEBP_TAG[index]) return false
  }
  return true
}

/** Validate an icon payload that arrived over IPC. Throws on anything else. */
export function validateCustomIconImage(value: unknown, label = 'Icon image'): CustomIconImage {
  if (typeof value !== 'object' || value === null || !('data' in value)) {
    throw new TypeError(`${label} is required`)
  }
  const data = (value as { data: unknown }).data
  if (!(data instanceof Uint8Array)) throw new TypeError(`${label} must be image bytes`)
  if (data.byteLength === 0) throw new TypeError(`${label} is empty`)
  if (data.byteLength > MAX_CUSTOM_ICON_BYTES) throw new TypeError(`${label} is too large`)
  if (!isWebpImage(data)) throw new TypeError(`${label} must be a WebP image`)
  return { data }
}
