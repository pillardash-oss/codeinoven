import { nativeImage } from 'electron'
import { ownedBytes, type CapturedFrame } from './display-capture'

/**
 * Shrink a device frame to the size the stage actually asked for.
 *
 * The stage publishes the size it needs (`DisplayFrameDemand.maxDimension`), and
 * the device adapters cannot honour it: neither `simctl io screenshot` nor
 * `adb exec-out screencap -p` has a scale flag, so both hand back the panel's own
 * resolution. Measured on this workstation, an iOS simulator frame arrived as
 * 1179x2556 — three megapixels — for a stage that had asked for 1280px, and every
 * one of those frames was then carried over IPC as a one-to-four megabyte PNG and
 * decoded and scaled again by the renderer.
 *
 * Resizing here is the one place the app can act on the demand. It costs one
 * decode and one encode in this process; it saves a payload an order of magnitude
 * larger, its structured clone, the renderer's decode of the full-resolution
 * bitmap, and a GPU texture that was three times bigger than anything on screen.
 * The capture that produced the frame costs 400-7000ms on the same machine
 * (measured), so this work is noise beside it.
 *
 * Nothing is resized unless it is meaningfully larger than the demand: a frame the
 * stage can use as-is keeps its exact original bytes.
 */

/** How much larger than the demand a frame may be before it is worth resizing. */
export const FIT_SLACK = 1.1

/** JPEG quality for a resized mirror frame. A mirror is a preview of a screen,
 *  not an asset: at this quality the difference is invisible and the payload is
 *  a tenth of the PNG's. */
const FIT_JPEG_QUALITY = 82

/** Whether a frame is big enough that shrinking it would actually save work. */
export function needsFit(
  frame: Pick<CapturedFrame, 'width' | 'height'>,
  maxDimension: number
): boolean {
  if (!Number.isFinite(maxDimension) || maxDimension <= 0) return false
  if (!Number.isFinite(frame.width) || !Number.isFinite(frame.height)) return false
  return Math.max(frame.width, frame.height) > maxDimension * FIT_SLACK
}

/**
 * The frame at the demanded size, or the frame unchanged.
 *
 * Failing to resize returns the original: a mirror that shows the full-resolution
 * picture is still a working mirror, and a capture this process cannot decode must
 * never turn into an empty stage.
 */
export function fitFrameToDemand(frame: CapturedFrame, maxDimension: number): CapturedFrame {
  if (!needsFit(frame, maxDimension)) return frame
  try {
    const source = Buffer.from(frame.bytes.buffer, frame.bytes.byteOffset, frame.bytes.byteLength)
    const image = nativeImage.createFromBuffer(source)
    if (image.isEmpty()) return frame
    const size = image.getSize()
    const longest = Math.max(size.width, size.height)
    if (longest <= 0) return frame
    const scale = maxDimension / longest
    const resized = image.resize({
      width: Math.max(1, Math.round(size.width * scale)),
      height: Math.max(1, Math.round(size.height * scale)),
      quality: 'good'
    })
    const bytes = resized.toJPEG(FIT_JPEG_QUALITY)
    if (bytes.byteLength === 0) return frame
    const fittedSize = resized.getSize()
    if (fittedSize.width <= 0 || fittedSize.height <= 0) return frame
    return {
      bytes: ownedBytes(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)),
      mime: 'image/jpeg',
      width: fittedSize.width,
      height: fittedSize.height
    }
  } catch {
    return frame
  }
}
