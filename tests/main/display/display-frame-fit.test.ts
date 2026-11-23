import { describe, expect, it, vi } from 'vitest'

// The resize path uses Electron's nativeImage, which has no meaning in a unit
// test; the decision it guards is what these tests pin.
vi.mock('electron', () => ({ nativeImage: { createFromBuffer: vi.fn() } }))

const { FIT_SLACK, fitFrameToDemand, needsFit } =
  await import('../../../src/main/display/display-frame-fit')

function frame(width: number, height: number) {
  return {
    bytes: new Uint8Array([1, 2, 3]),
    mime: 'image/png',
    width,
    height
  }
}

/**
 * Real numbers from the app's own log: an iOS simulator frame arrived as
 * 1179x2556 for a stage that asked for 1280px. Three megapixels per frame were
 * carried over IPC and decoded and scaled again by the renderer.
 */
describe('needsFit', () => {
  it('resizes a phone screenshot asked for at stage size', () => {
    expect(needsFit({ width: 1179, height: 2556 }, 1280)).toBe(true)
  })

  it('leaves a frame that already suits the demand untouched', () => {
    expect(needsFit({ width: 1280, height: 720 }, 1280)).toBe(false)
    expect(needsFit({ width: 900, height: 600 }, 1280)).toBe(false)
  })

  it('tolerates a frame only slightly larger than the demand', () => {
    // 1280 * FIT_SLACK is the point past which a resize saves real bytes; a frame
    // a hair over the demand is not worth a decode and an encode.
    expect(needsFit({ width: 1280 * FIT_SLACK - 1, height: 800 }, 1280)).toBe(false)
    expect(needsFit({ width: 1280 * FIT_SLACK + 1, height: 800 }, 1280)).toBe(true)
  })

  it('refuses to reason about a nonsense demand or a nonsense frame', () => {
    expect(needsFit({ width: 2556, height: 1179 }, 0)).toBe(false)
    expect(needsFit({ width: 2556, height: 1179 }, Number.NaN)).toBe(false)
    expect(needsFit({ width: Number.NaN, height: 1179 }, 1280)).toBe(false)
  })
})

describe('fitFrameToDemand', () => {
  it('returns the very same frame when no fit is needed', () => {
    const small = frame(640, 480)
    expect(fitFrameToDemand(small, 1280)).toBe(small)
  })

  it('returns the original frame when Electron cannot decode it', () => {
    // A frame that cannot be shrunk is still a frame: a mirror at full
    // resolution is a working mirror, an empty stage is not.
    const original = frame(1179, 2556)
    expect(fitFrameToDemand(original, 1280)).toBe(original)
  })
})
