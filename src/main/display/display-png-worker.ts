/**
 * PNG encoding for the one source whose pixels exist nowhere but in this process.
 *
 * A desktop capture arrives as raw BGRA pixels because `desktopCapturer` hands them
 * over decoded. Turning them into a picture the renderer can paint is a deflate of
 * a few megabytes, which is exactly the work that must never happen on the Electron
 * main thread, so it happens here instead and only the finished PNG crosses back.
 */

import { parentPort } from 'node:worker_threads'
import { deflateSync } from 'node:zlib'

export interface PngEncodeMessage {
  id: number
  /** Raw BGRA pixels, as Electron's `NativeImage.toBitmap()` produces them. */
  bitmap: ArrayBuffer
  width: number
  height: number
}

export interface PngEncodeReply {
  id: number
  png?: Uint8Array
  error?: string
}

const PNG_SIGNATURE = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
]) as Uint8Array
/** RGBA at 8 bits per channel. */
const COLOR_TYPE_RGBA = 6
/** None, Sub, Up. The three that pay for a screenshot; Paeth and Average do not. */
const FILTERS = [0, 1, 2] as const
/** Deflate effort. Level 3 is where a screen's flat areas are already cheap. */
const DEFLATE_LEVEL = 3

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** One PNG chunk: length, type, payload, CRC over type and payload. */
function chunk(type: string, payload: Uint8Array): Uint8Array {
  const typeBytes = Uint8Array.from(type, (character) => character.charCodeAt(0))
  const body = new Uint8Array(typeBytes.byteLength + payload.byteLength)
  body.set(typeBytes, 0)
  body.set(payload, typeBytes.byteLength)
  const out = new Uint8Array(8 + body.byteLength)
  const view = new DataView(out.buffer)
  view.setUint32(0, payload.byteLength)
  out.set(body, 4)
  // Length (4) plus body (4 + payload) leaves the CRC in the last four bytes.
  view.setUint32(4 + body.byteLength, crc32(body))
  return out
}

/**
 * Adaptively filtered scanlines.
 *
 * Every row is tried unfiltered, `Sub` and `Up`, and the winner is the one whose
 * filtered bytes are smallest in absolute terms: that is the standard heuristic,
 * and on a screenshot it is the difference between a picture and a deflate of noise.
 */
function filterScanlines(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const stride = width * 4
  const scanlines = new Uint8Array((stride + 1) * height)
  const previous = new Uint8Array(stride)
  const row = new Uint8Array(stride)
  const candidate = new Uint8Array(stride)
  const best = new Uint8Array(stride)

  for (let y = 0; y < height; y += 1) {
    const start = y * stride
    for (let x = 0; x < stride; x += 4) {
      const source = start + x
      row[x] = rgba[source + 2]!
      row[x + 1] = rgba[source + 1]!
      row[x + 2] = rgba[source]!
      row[x + 3] = rgba[source + 3]!
    }

    let chosenFilter = 0
    let chosenScore = -1
    for (const filter of FILTERS) {
      let score = 0
      for (let x = 0; x < stride; x += 1) {
        const left = x >= 4 ? row[x - 4]! : 0
        const up = previous[x]!
        const raw = row[x]!
        const value = filter === 0 ? raw : filter === 1 ? (raw - left) & 0xff : (raw - up) & 0xff
        candidate[x] = value
        score += value < 128 ? value : 256 - value
      }
      if (chosenScore < 0 || score < chosenScore) {
        chosenScore = score
        chosenFilter = filter
        best.set(candidate)
      }
    }

    const target = y * (stride + 1)
    scanlines[target] = chosenFilter
    scanlines.set(best, target + 1)
    previous.set(row)
  }

  return scanlines
}

export function encodePng(bitmap: Uint8Array, width: number, height: number): Uint8Array {
  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  header[8] = 8
  header[9] = COLOR_TYPE_RGBA

  const compressed = new Uint8Array(
    deflateSync(filterScanlines(bitmap, width, height), { level: DEFLATE_LEVEL })
  )
  const chunks = [
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', compressed),
    chunk('IEND', new Uint8Array(0))
  ]
  const total = chunks.reduce((sum, part) => sum + part.byteLength, 0)
  const png = new Uint8Array(total)
  let offset = 0
  for (const part of chunks) {
    png.set(part, offset)
    offset += part.byteLength
  }
  return png
}

parentPort?.on('message', (message: PngEncodeMessage) => {
  const reply: PngEncodeReply = { id: message.id }
  try {
    reply.png = encodePng(new Uint8Array(message.bitmap), message.width, message.height)
  } catch (error) {
    reply.error = error instanceof Error ? error.message : String(error)
  }
  const transfer = reply.png ? [reply.png.buffer as ArrayBuffer] : []
  parentPort?.postMessage(reply, transfer)
})
