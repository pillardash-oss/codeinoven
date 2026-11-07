import type {
  DisplayControlAction,
  DisplayInputGesture,
  DisplaySourceKind
} from '../../lib/ipc/display'

/**
 * One mirrorable target, as the display service drives it.
 *
 * Every adapter answers the same two questions: what am I, and give me one frame.
 * Nothing in the contract says "run adb here" or "read this file": a frame is
 * whatever encoded image the adapter can produce, which is what lets a future
 * remote-Oven preview become another adapter instead of a second panel.
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
  /**
   * Work the target's own screen.
   *
   * The same channel that presses a hardware key, carried one step further: a
   * tap, a drag, a typed word. Only a target that can be touched implements it,
   * and the service checks that before it forwards anything.
   */
  input?(gesture: DisplayInputGesture): Promise<void>
  /** Why `input` is missing, phrased for the panel. Absent when input works. */
  readonly inputProblem?: string
  /**
   * One encoded frame, or null when there is nothing to paint.
   *
   * An adapter hands back bytes it did not produce if it can: a device's own PNG
   * travels from the device to the renderer untouched, and only a source whose
   * pixels exist nowhere except inside this process (the desktop) encodes them, in
   * a worker. `maxDimension` is a hint for a source that can capture small in the
   * first place, and nothing more.
   */
  grab(maxDimension: number): Promise<CapturedFrame | null>
  /** Release whatever the adapter holds. Never throws. */
  dispose(): void
}

/**
 * One frame as it leaves an adapter: encoded bytes plus what they are and how big
 * the picture inside them is.
 *
 * The size comes from the image's own header, not from decoding it, so nothing on
 * this path ever builds a pixel buffer on the main thread.
 */
export interface CapturedFrame {
  bytes: Uint8Array<ArrayBuffer>
  mime: string
  width: number
  height: number
}

/**
 * Bounds on the demand a stage can ask for.
 *
 * The floor keeps a collapsed dock from asking for a thumbnail no one can read;
 * the ceiling is the point past which a still frame buys no visible fidelity for
 * the bytes it costs. The dock can be dragged to 1600 CSS px, so 1280 device
 * pixels is the honest headroom for a 2x display.
 */
export const DISPLAY_MIN_DIMENSION = 160
export const DISPLAY_MAX_DIMENSION = 1280
/** Quantization step for the demand, so layout jitter never asks for a new size. */
export const DISPLAY_DEMAND_STEP = 64

/**
 * Round a reported demand to a stable step inside the hard bounds.
 *
 * A stage that reports 641 px and then 645 px in the same second is the same
 * preview; quantizing means the transport sees one size.
 */
export function quantizeDemand(requested: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return DISPLAY_MIN_DIMENSION
  const bounded = Math.min(DISPLAY_MAX_DIMENSION, Math.max(DISPLAY_MIN_DIMENSION, requested))
  const stepped = Math.round(bounded / DISPLAY_DEMAND_STEP) * DISPLAY_DEMAND_STEP
  return Math.min(DISPLAY_MAX_DIMENSION, Math.max(DISPLAY_MIN_DIMENSION, stepped))
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const
/** Offset of the IHDR payload: signature (8) plus its length (4) and type (4). */
const PNG_HEADER_OFFSET = 16

/**
 * The same bytes, typed as the plain owned buffer that goes across the boundary.
 *
 * A `Buffer` is a view that may point into a shared pool, so its buffer type is the
 * wide one. Everything an adapter hands on is a normal array-backed view already:
 * this says so without copying, and copies only in the case that should never occur.
 */
export function ownedBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.buffer instanceof ArrayBuffer) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  return Uint8Array.from(bytes)
}

/**
 * Wrap a PNG the target produced, reading its size from the IHDR header.
 *
 * Two integer reads, no decode: this is the whole of the main process's involvement
 * with a device frame, which is what keeps a 1080x2400 phone's picture free to
 * mirror. Anything that is not a PNG is refused rather than guessed at.
 */
export function pngFrame(bytes: Uint8Array): CapturedFrame | null {
  if (bytes.byteLength < PNG_HEADER_OFFSET + 8) return null
  for (const [index, value] of PNG_SIGNATURE.entries()) {
    if (bytes[index] !== value) return null
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint32(PNG_HEADER_OFFSET)
  const height = view.getUint32(PNG_HEADER_OFFSET + 4)
  if (width <= 0 || height <= 0) return null
  return { bytes: ownedBytes(bytes), mime: 'image/png', width, height }
}
