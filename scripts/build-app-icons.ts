/**
 * Render every platform app-icon and tray asset from the two brand masters, so
 * all platforms ship one identical, current brand mark:
 *
 *  - `icon.png`                       → electron-builder source for win/linux
 *  - `favicon.ico`                    → multi-size Windows/browser favicon
 *  - `favicon.png`                    → renderer favicon
 *  - `macos/AppIcon*.png` + `.icns`   → macOS Dock/Finder (via `iconutil`)
 *  - `macos/tray*.png`                → macOS menu bar templates
 *  - `windows/tray*.ico`              → Windows notification-area ICOs
 *  - `logo.png`                       → large opaque logo raster
 *  - `../build/appx/*.png`            → MSIX Store tile and taskbar logos
 *  - `../build/icon.ico`              → Windows executable, taskbar, Explorer
 *
 * Two masters feed this. `icon.svg` is the full app tile with its gloss, rim,
 * reflections and detailed oven; `icon-small.svg` is its optical-size partner
 * for the sizes where none of that survives. App-icon entries below
 * `SMALL_ART_MAX_PX` take the small tile, everything from there up takes the
 * master. Tray entries all take the small-size mono marks (`icon-mono-small.svg`
 * and its attention sibling), because a tray glyph is drawn at roughly 16pt
 * however many device pixels back it.
 *
 * Rerun after editing any master: `bun scripts/build-app-icons.ts`.
 * Requires macOS for the `.icns` step (`iconutil`); every other output is
 * platform-independent (pure `@resvg/resvg-js` + `png-to-ico`).
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import pngToIco from 'png-to-ico'
import { Logger } from '../src/main/system/logger'
import { buildWindowsTrayIcons } from './build-windows-tray-icons'

const root = join(import.meta.dir, '..')
const staticDir = join(root, 'src/renderer/static')
const macosDir = join(staticDir, 'macos')
const buildDir = join(root, 'build')
/**
 * MSIX user assets. electron-builder's `appx` target reads its user asset
 * directory straight out of the build resources directory by this name
 * (`APPX_ASSETS_DIR_NAME`), and maps whatever it finds to `assets\` inside the
 * package, so the manifest references these exact file names.
 */
const appxDir = join(buildDir, 'appx')
const master = readFileSync(join(staticDir, 'icon.svg'), 'utf8')
/** Small-size app tile: same tile and palette, no depth layers, one bold mark. */
const smallTile = readFileSync(join(staticDir, 'icon-small.svg'), 'utf8')
/**
 * Device-pixel size below which app-icon entries take the small tile. At 16px
 * the master's gloss, rim, reflections and detailed oven collapse into a smear;
 * from 48px up every one of those layers reads, so the master keeps them.
 */
const SMALL_ART_MAX_PX = 48

/** The app-icon master for a device-pixel size: small tile first, full art up. */
function appArt(size: number): string {
  return size < SMALL_ART_MAX_PX ? smallTile : master
}

/** Render an SVG string to a PNG buffer at the requested pixel size. */
function renderPng(svg: string, size: number): Buffer {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng()
  return Buffer.from(png)
}

/**
 * Render an app-icon master centred on a wider transparent canvas.
 *
 * MSIX tile art is landscape (a 310x150 wide tile), while the master is a square
 * squircle that already draws its own tile body. Rendering the square straight
 * into a landscape canvas would stretch it, so the master's inner content is
 * re-wrapped in an outer document and scaled to sit centred at `mark` pixels.
 * The squircle's own fill rules have to be repeated on the wrapping group: they
 * are set as attributes on the master's root element, and attributes do not
 * inherit through a child `<g>`.
 */
function renderTile(svg: string, width: number, height: number, mark: number): Buffer {
  const scale = mark / 1024
  const inner = svg.slice(svg.indexOf('>', svg.indexOf('<svg')) + 1, svg.lastIndexOf('</svg>'))
  const wrapped =
    `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" ` +
    `xmlns="http://www.w3.org/2000/svg"><g fill-rule="evenodd" clip-rule="evenodd" ` +
    `transform="translate(${(width - mark) / 2} ${(height - mark) / 2}) scale(${scale})">` +
    `${inner}</g></svg>`
  return renderPng(wrapped, width)
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

// Allow tray-only regeneration without rewriting unrelated app/Dock assets.
if (!Bun.argv.includes('--windows-tray-only')) {
  const outputs: Array<[string, Buffer]> = [
    ['icon.png', renderPng(master, 1024)],
    ['favicon.png', renderPng(appArt(180), 180)],
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

  // Multi-size Windows favicon: 16→256 entries in one .ico, small tile first.
  const icoSizes = [16, 24, 32, 48, 64, 128, 256]
  const ico = await pngToIco(icoSizes.map((size) => renderPng(appArt(size), size)))
  writeFileSync(join(staticDir, 'favicon.ico'), ico)
  Logger.dev(`[build-app-icons] Wrote favicon.ico (${icoSizes.join('/')}px).`)

  // The Windows executable, taskbar and Explorer icon. electron-builder reads
  // this path directly (`win.icon`), and one entry per size keeps the shell from
  // rescaling a neighbouring size: 20/24/40 are what 125%, 150% and 250% display
  // scaling pick, and they are the entries a hand-held ICO most often misses.
  const winIcoSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
  const winIco = await pngToIco(winIcoSizes.map((size) => renderPng(appArt(size), size)))
  writeFileSync(join(buildDir, 'icon.ico'), winIco)
  Logger.dev(`[build-app-icons] Wrote build/icon.ico (${winIcoSizes.join('/')}px).`)

  // macOS iconset → icns. Apple's own guidance: the artwork supplies the squircle
  // shape with transparent margins; macOS composites its own drop shadow.
  const iconSizes = [16, 32, 64, 128, 256, 512, 1024]
  mkdirSync(macosDir, { recursive: true })
  for (const size of iconSizes) {
    writeFileSync(join(macosDir, `AppIcon${size}.png`), renderPng(appArt(size), size))
  }
  // MSIX tile and taskbar logos. The four base names are the ones the generated
  // manifest references: `Properties/Logo` (StoreLogo), both `VisualElements`
  // square logos, and a wide tile, which the template always emits even though
  // the schema calls it optional. `Square44x44Logo` additionally gets targetsize
  // variants, which is what Windows uses for the taskbar, Alt+Tab, Task View and
  // the Start tile corner; providing any variant also makes electron-builder run
  // `makepri` and ship a `resources.pri` alongside them.
  mkdirSync(appxDir, { recursive: true })
  const square44TargetSizes = [16, 24, 32, 48, 256]
  const appxOutputs: Array<[string, Buffer]> = [
    ['StoreLogo.png', renderPng(appArt(50), 50)],
    ['Square150x150Logo.png', renderPng(appArt(150), 150)],
    ['Square44x44Logo.png', renderPng(appArt(44), 44)],
    ...square44TargetSizes.map(
      (size) =>
        [`Square44x44Logo.targetsize-${size}.png`, renderPng(appArt(size), size)] as [
          string,
          Buffer
        ]
    ),
    ['Wide310x150Logo.png', renderTile(appArt(120), 310, 150, 120)]
  ]
  for (const [name, buffer] of appxOutputs) {
    writeFileSync(join(appxDir, name), buffer)
  }
  Logger.dev(`[build-app-icons] Wrote ${appxOutputs.length} MSIX assets to ${appxDir}.`)

  if (process.platform === 'darwin') {
    const scratchDir = join(root, '.cio/tmp')
    mkdirSync(scratchDir, { recursive: true })
    const iconset = mkdtempSync(join(scratchDir, 'cio-iconset-'))
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
      writeFileSync(join(setDir, name), renderPng(appArt(size), size))
    }
    execFileSync('iconutil', ['-c', 'icns', setDir, '-o', join(macosDir, 'AppIcon.icns')])
    rmSync(iconset, { recursive: true, force: true })
    Logger.dev('[build-app-icons] Wrote macos/AppIcon.icns.')
  }
}

// Menu bar tray template images.
//
// macOS treats a `...Template.png` filename as a template image and derives its
// own tint from the alpha channel, so the mark is rendered in solid black and a
// matching `@2x` file is picked up automatically for Retina menu bars. The
// artwork is the small-size mono mark, and its idle and attention states share
// one slab so only the shape inside the mark ever changes. Unlike the app icon
// these are not rendered from the full oven: the menu bar and the Windows
// notification area both draw a tray glyph at roughly 16pt, and the full mark's
// walls land on fractions of a pixel there and close the gaps between its
// window, handle and code glyph. Tray weight therefore comes from the mark's own
// geometry, and the same art feeds both platforms.
const monoSmall = readFileSync(join(staticDir, 'icon-mono-small.svg'), 'utf8')
const monoSmallAttention = readFileSync(join(staticDir, 'icon-mono-small-attention.svg'), 'utf8')
if (!Bun.argv.includes('--windows-tray-only')) {
  const trayOutputs: Array<[string, Buffer]> = [
    ['trayTemplate.png', renderPng(monoSmall, 16)],
    ['trayTemplate@2x.png', renderPng(monoSmall, 32)],
    ['trayAttentionTemplate.png', renderPng(monoSmallAttention, 16)],
    ['trayAttentionTemplate@2x.png', renderPng(monoSmallAttention, 32)]
  ]
  for (const [name, buffer] of trayOutputs) {
    writeFileSync(join(macosDir, name), buffer)
  }
  Logger.dev(
    `[build-app-icons] Wrote ${trayOutputs.length} menu bar template assets to ${macosDir}.`
  )
}
await buildWindowsTrayIcons(monoSmall, monoSmallAttention, join(staticDir, 'windows'))
Logger.dev('[build-app-icons] Done.')
