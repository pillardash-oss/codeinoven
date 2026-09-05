/**
 * Render every platform app-icon asset from the master SVG
 * (`src/renderer/static/icon.svg`) so all platforms ship one identical,
 * current brand mark:
 *
 *  - `icon.png`                       → electron-builder source for win/linux
 *  - `favicon.ico`                    → multi-size Windows/browser favicon
 *  - `favicon.png`, `icon-192.png`,
 *    `icon-512.png`                   → renderer favicon + PWA manifest
 *  - `icon-maskable-512.png`          → full-bleed PWA maskable variant
 *  - `macos/AppIcon*.png` + `.icns`   → macOS Dock/Finder (via `iconutil`)
 *  - `logo.png`                       → large opaque logo raster
 *
 * Rerun after editing the master SVG: `bun scripts/build-app-icons.ts`.
 * Requires macOS for the `.icns` step (`iconutil`); every other output is
 * platform-independent (pure `@resvg/resvg-js` + `png-to-ico`).
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import pngToIco from 'png-to-ico'
import { Logger } from '../src/main/system/logger'

const root = join(import.meta.dir, '..')
const staticDir = join(root, 'src/renderer/static')
const macosDir = join(staticDir, 'macos')
const master = readFileSync(join(staticDir, 'icon.svg'), 'utf8')

/** Exact geometry strings from the master SVG that the maskable variant retargets. */
const TILE_GEOMETRY = 'x="112" y="112" width="800"'
/** Corner radius of the squircle — maskable tiles must be fully square so the
 * launcher's mask never reveals transparent slivers at the canvas corners. */
const TILE_RADIUS = 'rx="184" ry="184"'
const MARK_TRANSFORM = 'translate(215.6,215.6) scale(0.474)'

/** Full-bleed maskable variant: tile covers the whole canvas, mark shrunk into
 * the PWA safe zone (well inside the centered 80% circle). */
const maskable = master
  .replaceAll(TILE_GEOMETRY, 'x="0" y="0" width="1024"')
  .replaceAll(TILE_RADIUS, 'rx="0" ry="0"')
  .replace(MARK_TRANSFORM, 'translate(316,316) scale(0.31)')

/** Render an SVG string to a PNG buffer at the requested pixel size. */
function renderPng(svg: string, size: number): Buffer {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng()
  return Buffer.from(png)
}

/** Render the master (or a variant) flattened onto an opaque backdrop for
 * consumers that must not receive alpha (Windows taskbar, logo usage). */
function renderOpaque(svg: string, size: number, backdrop: string): Buffer {
  const withBackdrop = svg.replace(
    '<defs>',
    `<rect x="0" y="0" width="1024" height="1024" fill="${backdrop}"/><defs>`
  )
  return renderPng(withBackdrop, size)
}

const outputs: Array<[string, Buffer]> = [
  ['icon.png', renderPng(master, 1024)],
  ['favicon.png', renderPng(master, 180)],
  ['icon-192.png', renderPng(master, 192)],
  ['icon-512.png', renderPng(master, 512)],
  ['icon-maskable-512.png', renderPng(maskable, 512)],
  // Opaque rasters: Windows shows taskbar/window icons over arbitrary
  // surfaces, and the historic flat black look came from a fully opaque
  // square — keep those rasters opaque but let the squircle corners show the
  // dark backdrop instead of pure black.
  ['logo.png', renderOpaque(master, 1254, '#0c0c10')]
]

for (const [name, buffer] of outputs) {
  writeFileSync(join(staticDir, name), buffer)
}
Logger.dev(`[build-app-icons] Wrote ${outputs.length} raster assets to ${staticDir}.`)

// Multi-size Windows favicon: PNG-compressed 16→256 entries in one .ico.
const icoSizes = [16, 24, 32, 48, 64, 128, 256]
const ico = await pngToIco(icoSizes.map((size) => renderPng(master, size)))
writeFileSync(join(staticDir, 'favicon.ico'), ico)
Logger.dev(`[build-app-icons] Wrote favicon.ico (${icoSizes.join('/')}px).`)

// macOS iconset → icns. Apple's own guidance: the artwork supplies the squircle
// shape with transparent margins; macOS composites its own drop shadow.
const iconSizes = [16, 32, 64, 128, 256, 512, 1024]
mkdirSync(macosDir, { recursive: true })
for (const size of iconSizes) {
  writeFileSync(join(macosDir, `AppIcon${size}.png`), renderPng(master, size))
}
if (process.platform === 'darwin') {
  const iconset = mkdtempSync(join(tmpdir(), 'cio-iconset-'))
  const setDir = join(iconset, 'AppIcon.iconset')
  mkdirSync(setDir)
  const entries: Array<[string, number]> = [
    ['icon_16x16.png', 16],
    ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32],
    ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128],
    ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256],
    ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512],
    ['icon_512x512@2x.png', 1024]
  ]
  for (const [name, size] of entries) {
    writeFileSync(join(setDir, name), renderPng(master, size))
  }
  execFileSync('iconutil', [
    '-c',
    'icns',
    setDir,
    '-o',
    join(macosDir, 'AppIcon.icns')
  ])
  rmSync(iconset, { recursive: true, force: true })
  Logger.dev('[build-app-icons] Wrote macos/AppIcon.icns.')
}
Logger.dev('[build-app-icons] Done.')
