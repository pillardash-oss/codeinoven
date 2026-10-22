import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'

const MAX_EDGE = 256

/** Decode and resize PNGs in the worker using the app's existing bundled codec. */
export async function prepareIcon(
  sourcePath: string
): Promise<{ bytes: Uint8Array; extension: string }> {
  const metadata = await stat(sourcePath)
  if (!metadata.isFile() || metadata.size > 8 * 1024 * 1024)
    throw new Error('Project icon is too large')
  const bytes = await readFile(sourcePath)
  const extension = extname(sourcePath).toLowerCase()
  if (extension === '.svg' && bytes.length <= 64 * 1024) return { bytes, extension }
  // ICO dimensions are at most 256 per frame; keep the original multi-size icon.
  if (extension === '.ico' && bytes.length <= 512 * 1024) return { bytes, extension }
  if (extension === '.webp' && bytes.length <= 512 * 1024) {
    const dimensions = webpDimensions(bytes)
    if (dimensions && dimensions.width <= MAX_EDGE && dimensions.height <= MAX_EDGE)
      return { bytes, extension }
  }
  if (
    extension !== '.png' ||
    bytes.length < 24 ||
    bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
  )
    throw new Error('Project icon cannot be safely decoded')
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20)
  if (!width || !height || width * height > 16 * 1024 * 1024)
    throw new Error('Project icon has too many pixels')
  const { PNG } = await import('pngjs')
  const image = PNG.sync.read(bytes)
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height))
  const targetWidth = Math.max(1, Math.round(width * scale)),
    targetHeight = Math.max(1, Math.round(height * scale))
  const data = Buffer.alloc(targetWidth * targetHeight * 4)
  for (let y = 0; y < targetHeight; y++) {
    const sourceY = Math.max(0, Math.min(height - 1, (y + 0.5) / scale - 0.5))
    const y0 = Math.floor(sourceY),
      y1 = Math.min(height - 1, y0 + 1),
      fy = sourceY - y0
    for (let x = 0; x < targetWidth; x++) {
      const sourceX = Math.max(0, Math.min(width - 1, (x + 0.5) / scale - 0.5))
      const x0 = Math.floor(sourceX),
        x1 = Math.min(width - 1, x0 + 1),
        fx = sourceX - x0
      for (let channel = 0; channel < 4; channel++) {
        const top =
          image.data[(y0 * width + x0) * 4 + channel] * (1 - fx) +
          image.data[(y0 * width + x1) * 4 + channel] * fx
        const bottom =
          image.data[(y1 * width + x0) * 4 + channel] * (1 - fx) +
          image.data[(y1 * width + x1) * 4 + channel] * fx
        data[(y * targetWidth + x) * 4 + channel] = Math.round(top * (1 - fy) + bottom * fy)
      }
    }
  }
  return {
    bytes: PNG.sync.write({ width: targetWidth, height: targetHeight, data }),
    extension: '.png'
  }
}

function webpDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (
    bytes.length < 30 ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WEBP'
  )
    return null
  switch (bytes.toString('ascii', 12, 16)) {
    case 'VP8X':
      return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 }
    case 'VP8L': {
      if (bytes[20] !== 0x2f) return null
      const bits = bytes.readUInt32LE(21)
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
    }
    case 'VP8 ':
      return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff }
    default:
      return null
  }
}
