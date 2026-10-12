import { CUSTOM_ICON_EDGE, type CustomIconImage } from '$shared/custom-icon'
import { invoke } from '$lib/ipc.svelte'

/**
 * The one image pipeline every custom icon goes through.
 *
 * A user picks a file through the OS dialog, and what comes back is whatever
 * they had: a screenshot, a 4K logo, a favicon, an SVG. None of that belongs in
 * an icon slot. This decodes the pick, crops it to a centred square, caps it at
 * {@link CUSTOM_ICON_EDGE} pixels and encodes it as WebP, so every entity stores
 * one small, square, compressed image regardless of where it came from.
 *
 * Chromium is the only WebP encoder the app can reach, which is why this lives
 * in the renderer and hands finished bytes to the main process rather than the
 * other way round.
 */
export interface OptimizedCustomIcon {
  /** The finished bytes, to persist and to hand to the main process. */
  image: CustomIconImage
  /** The same bytes as a data URL, for an editor's preview. */
  dataUrl: string
}

const WEBP_QUALITY = 0.92
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'

/** Base64 without spreading a whole buffer onto the call stack at once. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}

/** Whether the picked bytes are SVG markup rather than a raster image. */
function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.subarray(0, 256)).trimStart()
  return head.startsWith('<svg') || head.startsWith('<?xml')
}

/**
 * Give an SVG file the namespace a browser needs to decode it as an image.
 *
 * A `.svg` a designer exports always carries `xmlns`, but a hand-written one
 * often does not, and Chromium refuses to decode that as an image: "the source
 * image cannot be decoded". Adding the default namespace is the whole fix.
 */
function withSvgNamespace(bytes: Uint8Array): Uint8Array {
  const text = new TextDecoder().decode(bytes)
  if (/xmlns\s*=/u.test(text)) return bytes
  return new TextEncoder().encode(text.replace(/<svg/i, `<svg xmlns="${SVG_NAMESPACE}"`))
}

/**
 * Decode, centre-crop, downscale and re-encode one picked image.
 *
 * An SVG or a raster both arrive here the same way: the browser decodes the file
 * into an image element, so a pasted `.svg` file is rasterized to the same WebP
 * an icon needs. A source smaller than the edge is kept at its own size rather
 * than upscaled, which would only add bytes without adding detail.
 */
export async function optimizeCustomIconImage(bytes: Uint8Array): Promise<OptimizedCustomIcon> {
  // Copy into a fresh backing buffer: a BlobPart must be ArrayBuffer-backed,
  // and the bytes that cross IPC are typed only as an arbitrary view.
  const isSvg = looksLikeSvg(bytes)
  const owned = new Uint8Array(isSvg ? withSvgNamespace(bytes) : bytes)
  const blob = new Blob([owned], { type: isSvg ? 'image/svg+xml' : 'image/*' })
  const url = URL.createObjectURL(blob)
  const image = new Image()
  image.src = url
  try {
    await image.decode()
    // An SVG with only a viewBox has no intrinsic size; the edge is the honest
    // fallback, and it is the size the icon is drawn at anyway.
    const width = image.naturalWidth || CUSTOM_ICON_EDGE
    const height = image.naturalHeight || CUSTOM_ICON_EDGE
    const square = Math.min(width, height)
    if (square <= 0) throw new Error('This image has no pixels to read')

    const edge = Math.min(CUSTOM_ICON_EDGE, Math.round(square))
    const sourceX = Math.round((width - square) / 2)
    const sourceY = Math.round((height - square) / 2)

    const canvas = new OffscreenCanvas(edge, edge)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('The canvas context is unavailable')
    context.drawImage(image, sourceX, sourceY, square, square, 0, 0, edge, edge)

    const encoded = await canvas.convertToBlob({ type: 'image/webp', quality: WEBP_QUALITY })
    if (encoded.type !== 'image/webp') throw new Error('WebP encoding is unavailable')
    const data = new Uint8Array(await encoded.arrayBuffer())
    return { image: { data }, dataUrl: `data:image/webp;base64,${bytesToBase64(data)}` }
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * Ask for an image and return the finished icon.
 *
 * Returns null when the dialog was cancelled. A file that cannot be decoded
 * throws, so the editor that asked can say so instead of silently keeping the
 * old icon.
 */
export async function pickCustomIconImage(): Promise<OptimizedCustomIcon | null> {
  const path = await invoke('dialog:pickImage')
  if (!path) return null
  const bytes = await invoke('file:read', path)
  if (!bytes) throw new Error('The picked image could not be read')
  return optimizeCustomIconImage(bytes)
}
