import { nativeImage, type NativeImage } from 'electron'
import type { DisplayControlAction, DisplaySourceKind } from '../../lib/ipc/display'

/**
 * One mirrorable target, as the display service drives it.
 *
 * Every adapter answers the same two questions: what am I, and give me one
 * frame at most `maxDimension` pixels on its longest edge. Nothing in the
 * contract says "run adb here" or "read this file": a frame is whatever the
 * adapter can produce, which is what lets a future remote-Oven preview become
 * another adapter instead of a second panel.
 */
export interface DisplayCapture {
  readonly kind: DisplaySourceKind
  readonly sourceId: string
  /** Name the task manager shows for this session's row. */
  readonly label: string
  /**
   * Press one of the target's own buttons.
   *
   * Only the targets that answer for hardware keys implement it, and only for the
   * actions their kind advertises in `DISPLAY_CONTROLS_BY_KIND`: a screen has no
   * home button, and offering one would be a lie in the rail.
   */
  control?(action: DisplayControlAction): Promise<void>
  /** One frame at the target's own resolution, or null when there is nothing to paint.
   *  Downscaling and encoding are the service's job, so every adapter hands back
   *  the same thing: pixels. `maxDimension` is offered to an adapter that can
   *  capture small in the first place (the desktop one asks Electron for a
   *  thumbnail at that size); the rest ignore it. */
  grab(maxDimension: number): Promise<NativeImage | null>
  /** Release whatever the adapter holds. Never throws. */
  dispose(): void
}

/**
 * Bounds on the demand a stage can ask for.
 *
 * The floor keeps a collapsed dock from asking for a thumbnail no one can read;
 * the ceiling is the point past which a still frame buys no visible fidelity for
 * the decode and the bytes it costs. The dock can be dragged to 1600 CSS px, so
 * 1280 device pixels is the honest headroom for a 2x display.
 */
export const DISPLAY_MIN_DIMENSION = 160
export const DISPLAY_MAX_DIMENSION = 1280
/** Quantization step for the demand, so layout jitter never re-encodes a frame. */
export const DISPLAY_DEMAND_STEP = 64
/** JPEG quality: a preview, not an export. */
const DISPLAY_JPEG_QUALITY = 82

/**
 * Round a reported demand to a stable step inside the hard bounds.
 *
 * A stage that reports 641 px and then 645 px in the same second is the same
 * preview; quantizing means the encoder and the transport see one size.
 */
export function quantizeDemand(requested: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return DISPLAY_MIN_DIMENSION
  const bounded = Math.min(DISPLAY_MAX_DIMENSION, Math.max(DISPLAY_MIN_DIMENSION, requested))
  const stepped = Math.round(bounded / DISPLAY_DEMAND_STEP) * DISPLAY_DEMAND_STEP
  return Math.min(DISPLAY_MAX_DIMENSION, Math.max(DISPLAY_MIN_DIMENSION, stepped))
}

/** A frame's pixels and its encoded form, ready to cross the process boundary. */
export interface EncodedDisplayFrame {
  dataUrl: string
  width: number
  height: number
}

/**
 * Downscale one captured image to the demand and encode it as JPEG.
 *
 * The resize happens before the encode, so a 4K screen or a 1080x2400 phone PNG
 * is never handed to the renderer at native size. The same rule the computer-use
 * preview uses applies here: pay for the pixels the stage paints, nothing more.
 */
export function encodeDisplayFrame(
  image: NativeImage,
  maxDimension: number
): EncodedDisplayFrame | null {
  if (image.isEmpty()) return null
  const source = image.getSize()
  if (source.width <= 0 || source.height <= 0) return null
  const scale = Math.min(1, maxDimension / Math.max(source.width, source.height))
  const resized =
    scale < 1
      ? image.resize({
          width: Math.max(1, Math.round(source.width * scale)),
          height: Math.max(1, Math.round(source.height * scale)),
          quality: 'good'
        })
      : image
  const size = resized.getSize()
  const encoded = resized.toJPEG(DISPLAY_JPEG_QUALITY)
  if (encoded.byteLength === 0) return null
  return {
    dataUrl: `data:image/jpeg;base64,${encoded.toString('base64')}`,
    width: size.width,
    height: size.height
  }
}

/** Decode encoded bytes (PNG from `screencap`/`simctl`) into a native image. */
export function decodeDisplayImage(bytes: Buffer): NativeImage | null {
  if (bytes.byteLength === 0) return null
  const image = nativeImage.createFromBuffer(bytes)
  return image.isEmpty() ? null : image
}
