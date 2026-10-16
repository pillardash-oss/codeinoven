import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'

const escapeXml = (value) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')

/**
 * Bake the complete signature once during packaging, never during startup.
 * Font files: https://github.com/JetBrains/JetBrainsMono/tree/v2.304/fonts/ttf
 * Redistributed under resources/fonts/jetbrains-mono/OFL.txt.
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
    <g font-family="JetBrains Mono" fill="${foreground}">
      <text x="176" y="145" font-size="30" font-weight="700" letter-spacing="-2.85">CodeInOven</text>
      <g fill="${muted}" font-size="10">
        <text x="176" y="168">A workstation for coordinated</text>
        <text x="176" y="184">engineering agents</text>
      </g>
      <g fill="${muted}" font-size="10" text-anchor="middle">
        <text x="210" y="260">v${escapeXml(version.replace(/^v/i, ''))}</text>
        <text x="210" y="278">Pillardash Solutions Limited</text>
      </g>
    </g>
  </svg>`
  const renderer = new Resvg(svg, {
    fitTo: { mode: 'width', value: 840 },
    font: {
      loadSystemFonts: false,
      fontFiles: ['Regular', 'Bold'].map((weight) =>
        join(repositoryRoot, `resources/fonts/jetbrains-mono/JetBrainsMono-${weight}.ttf`)
      )
    }
  })
  return Buffer.from(renderer.render().asPng())
}
