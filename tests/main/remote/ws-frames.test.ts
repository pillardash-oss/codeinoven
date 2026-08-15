import { describe, expect, it } from 'vitest'
import {
  MAX_FRAME_PAYLOAD_BYTES,
  WsFrameTooLargeError,
  acceptWebSocketKey,
  buildUpgradeResponse,
  decodeWsFrames,
  encodeCloseFrame,
  encodeMaskedTextFrame,
  encodeTextFrame
} from '../../../src/main/remote/ws-frames'

describe('acceptWebSocketKey', () => {
  it('matches the RFC 6455 handshake test vector', () => {
    expect(acceptWebSocketKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
  })
})

describe('buildUpgradeResponse', () => {
  it('returns a 101 response with the accept key', () => {
    const response = buildUpgradeResponse('dGhlIHNhbXBsZSBub25jZQ==')
    expect(response).toContain('HTTP/1.1 101 Switching Protocols')
    expect(response).toContain('Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
  })
})

describe('encodeTextFrame / decodeWsFrames', () => {
  it('round-trips an unmasked server text frame', () => {
    const frame = encodeTextFrame('hello')
    const { frames, remaining } = decodeWsFrames(frame)
    expect(remaining.length).toBe(0)
    expect(frames).toHaveLength(1)
    expect(frames[0].opcode).toBe(0x1)
    expect(frames[0].payload.toString('utf8')).toBe('hello')
  })

  it('decodes a masked client text frame', () => {
    const frame = encodeMaskedTextFrame('hello phone')
    const { frames, remaining } = decodeWsFrames(frame)
    expect(remaining.length).toBe(0)
    expect(frames[0].payload.toString('utf8')).toBe('hello phone')
  })

  it('buffers frames split across reads', () => {
    const frame = encodeMaskedTextFrame('a-frame-split-in-two')
    const half = frame.subarray(0, Math.floor(frame.length / 2))
    const rest = frame.subarray(Math.floor(frame.length / 2))

    const first = decodeWsFrames(half)
    expect(first.frames).toHaveLength(0)
    expect(first.remaining.length).toBeGreaterThan(0)

    const second = decodeWsFrames(Buffer.concat([first.remaining, rest]))
    expect(second.frames).toHaveLength(1)
    expect(second.frames[0].payload.toString('utf8')).toBe('a-frame-split-in-two')
  })

  it('decodes multiple frames in a single chunk', () => {
    const combined = Buffer.concat([encodeTextFrame('one'), encodeMaskedTextFrame('two')])
    const { frames } = decodeWsFrames(combined)
    expect(frames.map((frame) => frame.payload.toString('utf8'))).toEqual(['one', 'two'])
  })

  it('handles the extended 16-bit length form', () => {
    const payload = 'x'.repeat(300)
    const frame = encodeTextFrame(payload)
    const { frames } = decodeWsFrames(frame)
    expect(frames[0].payload.toString('utf8')).toBe(payload)
  })

  it('decodes a close frame', () => {
    const { frames } = decodeWsFrames(encodeCloseFrame())
    expect(frames).toHaveLength(1)
    expect(frames[0].opcode).toBe(0x8)
  })

  it('throws before allocating when a 16-bit frame declares an oversized payload', () => {
    // Declares 4096 payload bytes but carries none of them.
    const frame = Buffer.from([0x81, 126, 0x10, 0x00])
    expect(() => decodeWsFrames(frame, { maxPayloadBytes: 100 })).toThrow(WsFrameTooLargeError)
  })

  it('throws before allocating when a 64-bit frame declares an oversized payload', () => {
    // Declares 2^32 payload bytes but carries only the 10-byte header.
    const frame = Buffer.from([0x81, 127, 0, 0, 0, 0x01, 0, 0, 0, 0])
    expect(() => decodeWsFrames(frame, { maxPayloadBytes: 100 })).toThrow(
      'ws-frame-payload-too-large'
    )
  })

  it('rejects frames above the default 1 MiB cap even without explicit options', () => {
    // Declares MAX_FRAME_PAYLOAD_BYTES + 1 payload bytes (64-bit length form):
    // 0x00000000_00100001 = 1,048,577.
    const header = Buffer.from([0x81, 127, 0, 0, 0, 0, 0, 0x10, 0x00, 0x01])
    try {
      decodeWsFrames(header)
      expect.unreachable('oversized frame must throw')
    } catch (error) {
      expect(error).toBeInstanceOf(WsFrameTooLargeError)
      expect((error as WsFrameTooLargeError).declaredBytes).toBe(MAX_FRAME_PAYLOAD_BYTES + 1)
    }
  })

  it('accepts a frame sized exactly at the configured cap', () => {
    const payload = 'x'.repeat(100)
    const frame = encodeMaskedTextFrame(payload)
    const { frames } = decodeWsFrames(frame, { maxPayloadBytes: 100 })
    expect(frames).toHaveLength(1)
    expect(frames[0].payload.toString('utf8')).toBe(payload)
  })
})
