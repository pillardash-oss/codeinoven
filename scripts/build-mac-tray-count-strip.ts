/**
 * Build the macOS menu bar's working-thread strip.
 *
 * The strip holds every figure the menu bar icon can show, one cell each, cut
 * on the grid in `src/lib/tray-count-art.ts`: the C/O mark unchanged, with the
 * figure in the slot the attention exclamation occupies. It ships as a pair of
 * template images (`trayCountTemplate.png` and its `@2x`), and the main process
 * cuts the cell it needs out of it rather than the repository carrying a
 * hundred near-identical templates.
 *
 * Only macOS gets the figure. The Windows notification area draws every icon
 * into a fixed small square, so an appended figure there would be scaled down
 * with the mark; Windows keeps its own two states.
 */
import { Resvg } from '@resvg/resvg-js'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Logger } from '../src/main/system/logger'
import {
  trayCountCells,
  trayCountMetrics,
  trayCountStripWidth,
  type TrayCountScale
} from '../src/lib/tray-count-art'

/** The squared frame macOS renders the mark's viewBox into, as a template. */
interface MarkFrame {
  x: number
  y: number
  extent: number
}

/** The band inside an SVG that belongs to the document, not to its root tag. */
function inner(svg: string): string {
  return svg.slice(svg.indexOf('>', svg.indexOf('<svg')) + 1, svg.lastIndexOf('</svg>'))
}

/**
 * Square the mark's viewBox about its own centre, exactly as the plain and
 * attention tray templates do, so the mark's ink lands on the same pixels here
 * as it does in the icons that are already shipped.
 */
function markFrame(mark: string): MarkFrame {
  const match = /viewBox="([^"]*)"/.exec(mark)
  if (!match?.[1]) throw new Error('macOS tray artwork has no viewBox')
  const [x, y, width, height] = match[1].split(/\s+/).map(Number)
  const extent = Math.max(width, height)
  return { x: x + (width - extent) / 2, y: y + (height - extent) / 2, extent }
}

/**
 * One resolution of the strip, drawn at that resolution rather than resampled.
 *
 * Cells are laid out on the shared grid, so a cell's left edge in the SVG is
 * the same number the reader crops on.
 */
function buildStrip(mark: string, fontFile: string, scale: TrayCountScale): Buffer {
  const metrics = trayCountMetrics(scale)
  const frame = markFrame(mark)
  const width = trayCountStripWidth(scale)
  const unit = metrics.height / frame.extent
  const markGroup = `<g transform="scale(${unit}) translate(${-frame.x} ${-frame.y})">${inner(mark)}</g>`

  const cells = trayCountCells(scale)
    .map((cell) => {
      // The figure's x is relative to the cell: the group below already carries
      // the cell's own offset, so adding it again would push every figure a
      // cell too far to the right.
      const figures = [...cell.label]
        .map(
          (character, index) =>
            `<text x="${metrics.baseWidth + index * metrics.charWidth}" ` +
            `y="${metrics.baseline}" font-family="JetBrains Mono" font-weight="bold" ` +
            `font-size="${metrics.fontSize}" fill="#000000">${character}</text>`
        )
        .join('')
      return `<g transform="translate(${cell.x} 0)">${markGroup}${figures}</g>`
    })
    .join('')

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${metrics.height}" ` +
    `viewBox="0 0 ${width} ${metrics.height}">${cells}</svg>`

  const rendered = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: { fontFiles: [fontFile], loadSystemFonts: false, defaultFontFamily: 'JetBrains Mono' }
  }).render()
  if (rendered.width !== width || rendered.height !== metrics.height) {
    throw new Error(
      `menu bar count strip rendered ${rendered.width}x${rendered.height}, expected ${width}x${metrics.height}`
    )
  }
  return Buffer.from(rendered.asPng())
}

/**
 * Write the strip pair into `outputDir`. The `@2x` file is what a Retina menu
 * bar picks up, so both are generated at their own resolution.
 */
export function buildMacTrayCountStrip(mark: string, outputDir: string): void {
  const fontFile = join(
    import.meta.dir,
    '..',
    'resources/fonts/jetbrains-mono/JetBrainsMono-Bold.ttf'
  )
  const outputs: Array<[string, Buffer]> = [
    ['trayCountTemplate.png', buildStrip(mark, fontFile, 1)],
    ['trayCountTemplate@2x.png', buildStrip(mark, fontFile, 2)]
  ]
  for (const [name, buffer] of outputs) {
    writeFileSync(join(outputDir, name), buffer)
  }
  Logger.dev(`[build-app-icons] Wrote ${outputs.length} menu bar count template assets.`)
}
