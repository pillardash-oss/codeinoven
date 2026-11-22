/**
 * The scrcpy wire format, as the pinned server release speaks it.
 *
 * Verified against scrcpy v5.0.1 (`doc/develop.md` and `app/tests/test_control_msg_serialize.c`
 * of that tag). The protocol is internal to scrcpy and changes between releases, so
 * `SCRCPY_VERSION` must match the bundled server file exactly: the server refuses a
 * client whose version string differs.
 */

export const SCRCPY_VERSION = '5.0.1'

/** The `"h264"` codec id the video socket opens with. */
const CODEC_ID_H264 = 0x68323634
const DUMMY_BYTE_LENGTH = 1
const CODEC_ID_LENGTH = 4
const HEADER_LENGTH = 12
const SESSION_FLAG = 0x80
const CONFIG_FLAG = 0x40
const KEY_FRAME_FLAG = 0x20
/** A packet larger than this is a corrupt stream, not a frame. */
const MAX_PACKET_BYTES = 32 * 1024 * 1024

export type ScrcpyVideoEvent =
  | { type: 'session'; width: number; height: number }
  | { type: 'packet'; config: boolean; key: boolean; ptsUs: number; data: Uint8Array }

/**
 * Reads the video socket: a dummy byte, the codec id, then session packets (the
 * picture size, again after a rotation) and media packets (config, key, delta).
 *
 * It keeps only the bytes of an unfinished packet, so a stream of any length costs
 * one packet of memory.
 */
export class ScrcpyVideoParser {
  private pending: Uint8Array = new Uint8Array(0)
  private handshake: 'dummy' | 'codec' | 'packets' = 'dummy'

  /** Feed bytes as they arrive; returns the complete events they finish. */
  push(chunk: Uint8Array): ScrcpyVideoEvent[] {
    this.pending = this.pending.length === 0 ? chunk : joinBytes(this.pending, chunk)
    const events: ScrcpyVideoEvent[] = []
    for (;;) {
      if (this.handshake === 'dummy') {
        if (this.pending.length < DUMMY_BYTE_LENGTH) break
        this.pending = this.pending.subarray(DUMMY_BYTE_LENGTH)
        this.handshake = 'codec'
        continue
      }
      if (this.handshake === 'codec') {
        if (this.pending.length < CODEC_ID_LENGTH) break
        const codec = view(this.pending).getUint32(0)
        if (codec !== CODEC_ID_H264) {
          throw new Error(`The device encoder did not produce H.264 (codec id ${codec})`)
        }
        this.pending = this.pending.subarray(CODEC_ID_LENGTH)
        this.handshake = 'packets'
        continue
      }
      if (this.pending.length < HEADER_LENGTH) break
      const header = view(this.pending)
      const flags = this.pending[0] ?? 0
      if (flags & SESSION_FLAG) {
        events.push({ type: 'session', width: header.getUint32(4), height: header.getUint32(8) })
        this.pending = this.pending.subarray(HEADER_LENGTH)
        continue
      }
      const size = header.getUint32(8)
      if (size > MAX_PACKET_BYTES) throw new Error(`Corrupt video packet of ${size} bytes`)
      if (this.pending.length < HEADER_LENGTH + size) break
      const high = header.getUint32(0) & 0x1fffffff
      const low = header.getUint32(4)
      events.push({
        type: 'packet',
        config: (flags & CONFIG_FLAG) !== 0,
        key: (flags & KEY_FRAME_FLAG) !== 0,
        ptsUs: high * 0x1_0000_0000 + low,
        data: this.pending.subarray(HEADER_LENGTH, HEADER_LENGTH + size)
      })
      this.pending = this.pending.subarray(HEADER_LENGTH + size)
    }
    // A leftover that still points into the caller's chunk must not keep a stale
    // copy alive for the next push, so it is owned here.
    if (this.pending.length > 0) this.pending = new Uint8Array(this.pending)
    return events
  }
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function joinBytes(first: Uint8Array, second: Uint8Array): Uint8Array {
  const joined = new Uint8Array(first.length + second.length)
  joined.set(first, 0)
  joined.set(second, first.length)
  return joined
}

const TYPE_INJECT_KEYCODE = 0
const TYPE_INJECT_TEXT = 1
const TYPE_INJECT_TOUCH_EVENT = 2
const TYPE_INJECT_SCROLL_EVENT = 3
const TYPE_RESET_VIDEO = 17
/** The longest text one message may carry. */
const TEXT_MAX_BYTES = 300

export const ANDROID_ACTION_DOWN = 0
export const ANDROID_ACTION_UP = 1
export const ANDROID_ACTION_MOVE = 2
const BUTTON_PRIMARY = 1
/** scrcpy's id for the mouse, which the server maps to the device's first pointer. */
const POINTER_ID_MOUSE = 0xffffffffffffffffn

export type TouchAction =
  typeof ANDROID_ACTION_DOWN | typeof ANDROID_ACTION_UP | typeof ANDROID_ACTION_MOVE

/** A touch event, 32 bytes. `x` and `y` are in the video's own pixels. */
export function encodeTouch(
  action: TouchAction,
  x: number,
  y: number,
  width: number,
  height: number
): Uint8Array {
  const message = new Uint8Array(32)
  const out = new DataView(message.buffer)
  const pressed = action !== ANDROID_ACTION_UP
  out.setUint8(0, TYPE_INJECT_TOUCH_EVENT)
  out.setUint8(1, action)
  out.setBigUint64(2, POINTER_ID_MOUSE)
  out.setInt32(10, Math.round(x))
  out.setInt32(14, Math.round(y))
  out.setUint16(18 + 0, width)
  out.setUint16(18 + 2, height)
  out.setUint16(22, pressed ? 0xffff : 0)
  out.setUint32(24, action === ANDROID_ACTION_MOVE ? 0 : BUTTON_PRIMARY)
  out.setUint32(28, pressed ? BUTTON_PRIMARY : 0)
  return message
}

/** Restart the encoder, which answers with a fresh config and key frame. One byte. */
export function encodeResetVideo(): Uint8Array {
  return Uint8Array.of(TYPE_RESET_VIDEO)
}

/** A key press or release, 14 bytes. */
export function encodeKeycode(action: 0 | 1, keycode: number): Uint8Array {
  const message = new Uint8Array(14)
  const out = new DataView(message.buffer)
  out.setUint8(0, TYPE_INJECT_KEYCODE)
  out.setUint8(1, action)
  out.setInt32(2, keycode)
  out.setInt32(6, 0)
  out.setInt32(10, 0)
  return message
}

/** Typed text. Cut at a whole character if it is longer than the protocol allows. */
export function encodeText(text: string): Uint8Array {
  let bytes = new TextEncoder().encode(text)
  if (bytes.length > TEXT_MAX_BYTES) {
    let end = TEXT_MAX_BYTES
    // Step back off a UTF-8 continuation byte so a character is never split.
    while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1
    bytes = bytes.subarray(0, end)
  }
  const message = new Uint8Array(5 + bytes.length)
  const out = new DataView(message.buffer)
  out.setUint8(0, TYPE_INJECT_TEXT)
  out.setUint32(1, bytes.length)
  message.set(bytes, 5)
  return message
}

function scrollFixedPoint(amount: number): number {
  const scaled = Math.max(-1, Math.min(1, amount / 16))
  return Math.round(scaled < 0 ? scaled * 0x8000 : scaled * 0x7fff)
}

/** A scroll wheel step at a point, 21 bytes. Amounts are in wheel notches, clamped to ±16. */
export function encodeScroll(
  x: number,
  y: number,
  width: number,
  height: number,
  horizontal: number,
  vertical: number
): Uint8Array {
  const message = new Uint8Array(21)
  const out = new DataView(message.buffer)
  out.setUint8(0, TYPE_INJECT_SCROLL_EVENT)
  out.setInt32(1, Math.round(x))
  out.setInt32(5, Math.round(y))
  out.setUint16(9, width)
  out.setUint16(11, height)
  out.setInt16(13, scrollFixedPoint(horizontal))
  out.setInt16(15, scrollFixedPoint(vertical))
  out.setUint32(17, 0)
  return message
}
