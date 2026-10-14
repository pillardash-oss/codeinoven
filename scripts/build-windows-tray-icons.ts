import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import pngToIco from 'png-to-ico'
import { Logger } from '../src/main/system/logger'

// 100%, 125%, 150%, 175%, 200%, 250%, 300%, and 400% of the
// Windows 16px notification-area icon. Render each directly from vector art.
const TRAY_SIZES = [16, 20, 24, 28, 32, 40, 48, 64]
const SOURCE_SIZE = 1254

/** Remove the brand artwork's transparent margins, leaving one pixel at 100%. */
function frameTrayArtwork(svg: string): string {
  const rendered = new Resvg(svg, { fitTo: { mode: 'width', value: SOURCE_SIZE } }).render()
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
  return svg.replace('viewBox="0 0 1254 1254"', `viewBox="${x} ${y} ${extent} ${extent}"`)
}

/**
 * Build native Windows ICOs from the same normal/attention mark as macOS,
 * weighted for the notification area.
 *
 * The caller passes artwork already stroked at `WINDOWS_TRAY_STROKE_WIDTH`,
 * which is lighter than the macOS menu bar template. Windows draws the 16px
 * entry at 100% display scaling, where the macOS weight inks over the artwork's
 * own sub-pixel walls and closes the gaps between the oven's window, handle, and
 * code glyph. Do not pass the macOS masters here.
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
