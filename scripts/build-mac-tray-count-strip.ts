/**
 * Build the macOS menu bar's working-thread strip.
 *
 * The strip holds every figure the menu bar icon can show, one cell each, cut on
 * the grid in `src/lib/tray-count-art.ts`: the squared C/O mark unchanged, with
 * the figure in the slot the attention exclamation occupies. It ships as a pair
 * of template images (`trayCountTemplate.png` and its `@2x`), and the main
 * process cuts the cell it needs out of it rather than the repository carrying a
 * hundred near-identical templates.
 *
 * Both resolutions are drawn from the same vectors, so the `@2x` file is real
 * artwork rather than a resampled 1x, which is what a menu bar figure needs: a
 * numeral is six or seven device pixels tall at 1x and every stroke edge shows.
 *
 * The figures are filled Oven Box outlines extracted into
 * `scripts/tray-count-digits.ts`, so rasterization needs no system font.
 *
 * Only macOS gets the figure. The Windows notification area draws every icon
 * into a fixed small square, so an appended figure there would be scaled down
 * with the mark; Windows keeps its own two states.
 */
import { Resvg } from '@resvg/resvg-js'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Logger } from '../src/main/system/logger'
import {
  trayCountCells,
  trayCountMetrics,
  trayCountStripWidth,
  type TrayCountScale
} from '../src/lib/tray-count-art'
import { TRAY_COUNT_FONT_SHA256, trayNumeralPaths } from './tray-count-digits'

/** The band inside an SVG that belongs to the document, not to its root tag. */
function inner(svg: string): string {
  return svg.slice(svg.indexOf('>', svg.indexOf('<svg')) + 1, svg.lastIndexOf('</svg>'))
}

/**
 * Check the master against the frame the grid assumes, so artwork that is
 * re-framed later cannot silently shift every figure.
 */
function assertFrameMatches(mark: string, extent: number): void {
  const match = /viewBox="([^"]*)"/.exec(mark)
  if (!match?.[1]) throw new Error('macOS tray artwork has no viewBox')
  const [, , width, height] = match[1].split(/\s+/).map(Number)
  if (Math.max(width, height) !== extent) {
    throw new Error(
      `macOS tray artwork is ${width}x${height}, but the figure grid assumes a ${extent}-unit frame`
    )
  }
}

/**
 * One resolution of the strip, drawn at that resolution rather than resampled.
 *
 * Cells are laid out on the shared grid, so a cell's left edge in the SVG is the
 * same number the reader crops on. The mark is placed by the frame transform and
 * the figure by a translate on the grid, both inside the same artwork coordinate
 * system. Filled glyphs retain the font's own stroke weight.
 */
function buildStrip(mark: string, scale: TrayCountScale): Buffer {
  const metrics = trayCountMetrics(scale)
  const { frame } = metrics
  const width = trayCountStripWidth(scale)
  const unit = metrics.height / frame.extent
  const markGroup = `<g transform="scale(${unit}) translate(${-frame.x} ${-frame.y})">${inner(mark)}</g>`
  const figureStyle = 'fill="#000000" stroke="none"'

  const cells = trayCountCells(scale)
    .map((cell) => {
      // The figure's origin is relative to the cell and expressed in artwork
      // units, like the mark: it is placed by the same frame transform the mark
      // uses, then scaled, so one artwork unit means one thing everywhere in the
      // strip. The group below already carries the cell's own offset, so adding
      // it again would push every figure a cell too far to the right.
      const figures = [...cell.label]
        .map((character, index) => {
          const paths = trayNumeralPaths(character)
            .map((path) => `<path d="${path}"/>`)
            .join('')
          const originX = (metrics.figureLeft + index * metrics.glyphAdvance - frame.x) * unit
          const originY = (metrics.figureTop - frame.y) * unit
          return `<g transform="translate(${originX} ${originY}) scale(${unit})">${paths}</g>`
        })
        .join('')
      return (
        `<g transform="translate(${cell.x} 0)">${markGroup}` +
        `<g ${figureStyle}>${figures}</g></g>`
      )
    })
    .join('')

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${metrics.height}" ` +
    `viewBox="0 0 ${width} ${metrics.height}">${cells}</svg>`

  const rendered = new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render()
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
  const font = readFileSync(join(import.meta.dir, '../resources/fonts/oven/oven-box.woff2'))
  if (createHash('sha256').update(font).digest('hex') !== TRAY_COUNT_FONT_SHA256) {
    throw new Error(
      'Oven Box changed: regenerate outlines with scripts/extract-tray-count-digits.py'
    )
  }
  assertFrameMatches(mark, trayCountMetrics(1).frame.extent)
  const outputs: Array<[string, Buffer]> = [
    ['trayCountTemplate.png', buildStrip(mark, 1)],
    ['trayCountTemplate@2x.png', buildStrip(mark, 2)]
  ]
  for (const [name, buffer] of outputs) {
    writeFileSync(join(outputDir, name), buffer)
  }
  Logger.dev(`[build-app-icons] Wrote ${outputs.length} menu bar count template assets.`)
}
