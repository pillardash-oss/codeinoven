import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import pngToIco from 'png-to-ico'
import { Logger } from '../src/main/system/logger'

// 100%, 125%, 150%, 175%, 200%, 250%, 300%, and 400% of the
// Windows 16px notification-area icon. Render each directly from vector art.
const TRAY_SIZES = [16, 20, 24, 28, 32, 40, 48, 64]
/** Raster size used only to measure where the artwork's ink ends. */
const MEASURE_PX = 1024

/**
 * Fit the artwork to the notification-area slot by cropping to its ink and
 * re-framing it on a square that leaves one pixel at 100% display scaling.
 * Without this the mark floats at whatever margin the drawing used, so the two
 * states (brackets and exclamation) would not sit at the same optical size.
 */
function frameTrayArtwork(svg: string): string {
  const rendered = new Resvg(svg, { fitTo: { mode: 'width', value: MEASURE_PX } }).render()
  const pixels = rendered.pixels
  let left = rendered.width
  let top = rendered.height
  let right = -1
  let bottom = -1
  for (let y = 0; y < rendered.height; y++) {
    for (let x = 0; x < rendered.width; x++) {
      if (pixels[(y * rendered.width + x) * 4 + 3] === 0) continue
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x)
      bottom = Math.max(bottom, y)
    }
  }
  if (right < left) throw new Error('Windows tray artwork is empty')
  const extent = Math.max(right - left + 1, bottom - top + 1) * (16 / 14)
  const x = (left + right + 1 - extent) / 2
  const y = (top + bottom + 1 - extent) / 2
  const viewBox = svg.match(/viewBox="[^"]*"/)
  if (!viewBox) throw new Error('Windows tray artwork has no viewBox to re-frame')
  return svg.replace(viewBox[0], `viewBox="${x} ${y} ${extent} ${extent}"`)
}

/**
 * Build the Windows notification-area ICOs from the small-size mono marks
 * (`icon-mono-small.svg` and its attention sibling), one ICO per state and
 * taskbar theme.
 *
 * The artwork arrives already at tray weight, so nothing here strokes or scales
 * it: a solid slab with one knockout is bold at 16px by construction. Every size
 * uses that same art on purpose. A tray glyph is drawn at roughly 16pt whatever
 * the display scaling, so the extra device pixels in the 40/48/64 entries buy
 * resolution, not room for a second, more detailed mark. Those detailed masters
 * are for the app icon, not the tray.
 *
 * Ink is taken from the art's `#000000`: the light ICOs keep it, the dark ICOs
 * swap it for white, so one drawing covers both taskbar themes.
 */
export async function buildWindowsTrayIcons(
  normal: string,
  attention: string,
  outputDir: string
): Promise<void> {
  mkdirSync(outputDir, { recursive: true })
  for (const [state, source] of [
    ['', normal],
    ['Attention', attention]
  ] as const) {
    const framed = frameTrayArtwork(source)
    for (const [theme, ink] of [
      ['light', '#000000'],
      ['dark', '#ffffff']
    ] as const) {
      const svg = framed.replaceAll('#000000', ink)
      const images = TRAY_SIZES.map((size) =>
        Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng())
      )
      writeFileSync(join(outputDir, `tray${state}-${theme}.ico`), await pngToIco(images))
    }
  }
  Logger.dev(`[build-app-icons] Wrote Windows tray ICOs (${TRAY_SIZES.join('/')}px).`)
}
