/**
 * Minimal RFC 6455 WebSocket frame codec for the LAN gateway.
 *
 * The project has no `ws` dependency, so the gateway implements just enough
 * of the WebSocket protocol itself: the server handshake accept key, text
 * frame encoding (server → client, unmasked) and decoding (client → server,
 * masked), with buffering for frames split across TCP reads.
 */

import { createHash } from 'node:crypto'

export const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/**
 * Maximum decoded frame payload accepted before allocation (1 MiB). Matches the
 * gateway's peer-buffer bound so a hostile header can never force a large
 * payload copy before the length is validated.
 */
export const MAX_FRAME_PAYLOAD_BYTES = 1024 * 1024

/** Error thrown when a frame declares a payload larger than the accepted cap. */
export class WsFrameTooLargeError extends Error {
  constructor(public readonly declaredBytes: number) {
    super('ws-frame-payload-too-large')
    this.name = 'WsFrameTooLargeError'
  }
}

/** Compute the `Sec-WebSocket-Accept` value for a client handshake key. */
export function acceptWebSocketKey(clientKey: string): string {
  return createHash('sha1')
    .update(clientKey + WEBSOCKET_GUID, 'utf8')
    .digest('base64')
}

/** Build the HTTP 101 response for a successful upgrade. */
export function buildUpgradeResponse(clientKey: string): string {
  return [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptWebSocketKey(clientKey)}`,
    '\r\n'
  ].join('\r\n')
}

/** Encode a text frame (opcode 0x1) — server to client, unmasked. */
export function encodeTextFrame(payload: string): Buffer {
  const data = Buffer.from(payload, 'utf8')
  const header: number[] = [0x81]
  const length = data.length
  if (length <= 125) {
    header.push(length)
  } else if (length <= 0xffff) {
    header.push(126, (length >> 8) & 0xff, length & 0xff)
  } else {
    const high = Math.floor(length / 0x100000000)
    header.push(
      127,
      0,
      0,
      0,
      0,
      high & 0xff,
      (length >> 16) & 0xff,
      (length >> 8) & 0xff,
      length & 0xff
    )
  }
  return Buffer.concat([Buffer.from(header), data])
}

/** Encode a close frame (opcode 0x8). */
export function encodeCloseFrame(): Buffer {
  return Buffer.from([0x88, 0x00])
}

export interface DecodedWsFrame {
  opcode: number
  fin: boolean
  masked: boolean
  payload: Buffer
}

/**
 * Decode every complete frame in a buffer. Returns the decoded frames and the
 * unconsumed trailing bytes (a partially-received frame).
 *
 * A frame whose header declares a payload larger than `maxPayloadBytes` throws
 * `WsFrameTooLargeError` before any payload is sliced or copied, so oversized
 * encrypted/decoded messages fail before large allocation.
 */
export function decodeWsFrames(
  buffer: Buffer,
  options: { maxPayloadBytes?: number } = {}
): { frames: DecodedWsFrame[]; remaining: Buffer } {
  const maxPayloadBytes = options.maxPayloadBytes ?? MAX_FRAME_PAYLOAD_BYTES
  let offset = 0
  const frames: DecodedWsFrame[] = []
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset]
    const second = buffer[offset + 1]
    const opcode = first & 0x0f
    const fin = (first & 0x80) !== 0
    const masked = (second & 0x80) !== 0
    let length = second & 0x7f
    let headerLength = 2
    if (length === 126) {
      if (offset + 4 > buffer.length) break
      length = buffer.readUInt16BE(offset + 2)
      headerLength = 4
    } else if (length === 127) {
      if (offset + 10 > buffer.length) break
      const high = buffer.readUInt32BE(offset + 2)
      const low = buffer.readUInt32BE(offset + 6)
      length = high * 0x100000000 + low
      headerLength = 10
    }
    if (length > maxPayloadBytes) {
      throw new WsFrameTooLargeError(length)
    }
    const maskLength = masked ? 4 : 0
    const totalLength = headerLength + maskLength + length
    if (offset + totalLength > buffer.length) break

    let payload = buffer.subarray(
      offset + headerLength + maskLength,
      offset + headerLength + maskLength + length
    )
    if (masked) {
      const mask = buffer.subarray(offset + headerLength, offset + headerLength + 4)
      payload = Buffer.from(payload)
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4]
      }
    }
    frames.push({ opcode, fin, masked, payload })
    offset += totalLength
  }
  return { frames, remaining: buffer.subarray(offset) }
}

/** Test helper: encode a masked text frame the way a browser client sends it. */
export function encodeMaskedTextFrame(
  payload: string,
  mask = Buffer.from([0x11, 0x22, 0x33, 0x44])
): Buffer {
  const data = Buffer.from(payload, 'utf8')
  const header: number[] = [0x81, 0x80 | data.length]
  const masked = Buffer.from(data)
  for (let index = 0; index < masked.length; index += 1) {
    masked[index] ^= mask[index % 4]
  }
  return Buffer.concat([Buffer.from(header), mask, masked])
}
