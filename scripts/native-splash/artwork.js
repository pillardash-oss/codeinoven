import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'

const escapeXml = (value) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')

/**
 * The lockup's two faces, cut from the app's own Oven Box build by
 * scripts/build-native-splash-fonts.py and distributed under
 * resources/fonts/oven/OFL.txt.
 *
 * resvg rasterises this artwork, and it reads plain TTF/OTF only: handed the
 * shipped WOFF2 it draws no text at all, and it renders a variable font at its
 * axis default however light the requested weight is. The faces are therefore
 * static and committed, which also keeps Python out of packaging. The manifest
 * pins them to the Oven Box build they were cut from, so a rebuilt family fails
 * packaging here instead of quietly leaving a stale lockup on screen.
 */
const FACE_DIRECTORY = 'resources/fonts/oven/native'
const WORDMARK_WEIGHT = 800
const PROSE_WEIGHT = 400

function splashFaces(repositoryRoot) {
  const directory = join(repositoryRoot, FACE_DIRECTORY)
  const manifest = JSON.parse(readFileSync(join(directory, 'instances.json'), 'utf8'))
  const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
  const source = join(repositoryRoot, 'resources/fonts/oven', manifest.source.file)
  if (digest(source) !== manifest.source.sha256) {
    throw new Error(
      `Oven Box changed: recut the native splash faces with \`.cio/tmp/typeface/venv/bin/python ${manifest.generator}\``
    )
  }
  return manifest.faces.map((face) => {
    const path = join(directory, face.file)
    if (digest(path) !== face.sha256) {
      throw new Error(`${face.file} does not match ${manifest.generator}; recut the splash faces`)
    }
    return path
  })
}

/**
 * Bake the complete signature once during packaging, never during startup.
 */
export function renderNativeSplash(repositoryRoot, version) {
  const css = readFileSync(join(repositoryRoot, 'src/renderer/app.css'), 'utf8')
  const darkCss = css.slice(css.indexOf('.dark {'))
  const token = (name, source = darkCss) => {
    const match = source.match(new RegExp(`--color-${name}:\\s*(#[a-fA-F0-9]+)`))
    if (!match) throw new Error(`Missing splash color token: ${name}`)
    return match[1]
  }
  const background = token('app')
  const foreground = token('foreground')
  const muted = token('muted')
  const master = readFileSync(join(repositoryRoot, 'src/renderer/static/icon-mark.svg'), 'utf8')
  const mark = master.slice(
    master.indexOf('>', master.indexOf('<svg')) + 1,
    master.lastIndexOf('</svg>')
  )
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="320" viewBox="0 0 420 320">
    <rect width="420" height="320" fill="${background}"/>
    <g color="${foreground}"><svg x="54" y="104" width="104" height="104" viewBox="0 0 96 96">${mark}</svg></g>
    <g font-family="Oven Box" fill="${foreground}">
      <text x="176" y="145" font-size="30" font-weight="${WORDMARK_WEIGHT}" letter-spacing="-2.85">CodeInOven</text>
      <g fill="${muted}" font-size="10" font-weight="${PROSE_WEIGHT}">
        <text x="176" y="168">A workstation for coordinated</text>
        <text x="176" y="184">engineering agents</text>
      </g>
      <g fill="${muted}" font-size="10" font-weight="${PROSE_WEIGHT}" text-anchor="middle">
        <text x="210" y="260">v${escapeXml(version.replace(/^v/i, ''))}</text>
        <text x="210" y="278">Pillardash Solutions Limited</text>
      </g>
    </g>
  </svg>`
  const renderer = new Resvg(svg, {
    fitTo: { mode: 'width', value: 840 },
    font: { loadSystemFonts: false, fontFiles: splashFaces(repositoryRoot) }
  })
  return Buffer.from(renderer.render().asPng())
}
