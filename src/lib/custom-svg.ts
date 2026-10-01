import { DOMParser, XMLSerializer, type Element } from '@xmldom/xmldom'
import { getCustomSvgDataUrl } from './custom-svg-tint'

/** The tinting half of this pipeline lives apart from the parser above, because
 *  the icons that tint an already-sanitized SVG resolve on the first paint while
 *  a paste that needs sanitizing never does. Re-exported so a caller that wants
 *  both still imports them from one place. */
export { getCustomSvgDataUrl }

const MAX_CUSTOM_SVG_LENGTH = 16_384
const ALLOWED_ELEMENTS = new Set([
  'svg',
  'g',
  'path',
  'circle',
  'ellipse',
  'rect',
  'line',
  'polyline',
  'polygon'
])
const ALLOWED_ATTRIBUTES = new Set([
  'viewBox',
  'd',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'width',
  'height',
  'points',
  'transform',
  'fill',
  'fill-rule',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-opacity',
  'opacity'
])
const NEUTRAL_NAMES = new Set([
  'black',
  'white',
  'gray',
  'grey',
  'silver',
  'dimgray',
  'dimgrey',
  'lightgray',
  'lightgrey',
  'darkgray',
  'darkgrey',
  'gainsboro',
  'whitesmoke'
])

function isNeutralColor(value: string): boolean {
  const color = value.trim().toLowerCase()
  if (color === 'none' || color === 'currentcolor' || color === 'transparent') return true
  if (NEUTRAL_NAMES.has(color)) return true
  const hex = color.match(/^#([\da-f]{3,8})$/i)?.[1]
  if (hex && (hex.length === 3 || hex.length === 4 || hex.length === 6 || hex.length === 8)) {
    const rgb =
      hex.length < 5
        ? [...hex.slice(0, 3)].map((channel) => channel.repeat(2))
        : hex.slice(0, 6).match(/../g)
    return Boolean(
      rgb &&
      rgb[0]?.toLowerCase() === rgb[1]?.toLowerCase() &&
      rgb[1]?.toLowerCase() === rgb[2]?.toLowerCase()
    )
  }
  const rgb = color.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/)
  if (rgb) return rgb[1] === rgb[2] && rgb[2] === rgb[3]
  const hsl = color.match(/^hsla?\(\s*[-\d.]+(?:deg)?[,\s]+([\d.]+)%/)
  return Boolean(hsl && Number(hsl[1]) === 0)
}

function cleanTree(node: Element): void {
  const style = node.getAttribute('style')
  if (style) {
    for (const declaration of style.split(';')) {
      const match = declaration.match(/^\s*(fill|stroke)\s*:\s*([^;]+)\s*$/i)
      if (!match) continue
      const property = match[1].toLowerCase()
      const value = match[2].replace(/\s*!important\s*$/i, '').trim()
      if (/url\s*\(/i.test(value)) continue
      node.setAttribute(property, isNeutralColor(value) ? value : 'currentColor')
    }
  }

  for (let index = node.attributes.length - 1; index >= 0; index -= 1) {
    const attribute = node.attributes.item(index)
    if (!attribute) continue
    const name = attribute.name
    if (name === 'xmlns' && node.tagName === 'svg') continue
    if (!ALLOWED_ATTRIBUTES.has(name)) {
      node.removeAttribute(name)
      continue
    }
    if (name === 'fill' || name === 'stroke') {
      const value = attribute.value.trim()
      if (/url\s*\(/i.test(value)) node.removeAttribute(name)
      else if (!isNeutralColor(value)) node.setAttribute(name, 'currentColor')
    }
  }

  for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
    const child = node.childNodes.item(index)
    if (!child || child.nodeType !== 1) {
      if (child) node.removeChild(child)
      continue
    }
    const element = child as Element
    if (!ALLOWED_ELEMENTS.has(element.tagName)) node.removeChild(element)
    else cleanTree(element)
  }
}

/** Parse a user SVG into a small safe subset and mark chromatic paint for tinting. */
export function sanitizeCustomSvg(input: string): string {
  const source = input.trim()
  if (!source || new TextEncoder().encode(source).byteLength > MAX_CUSTOM_SVG_LENGTH) {
    throw new TypeError('Paste an SVG smaller than 16 KB')
  }
  const document = new DOMParser({
    onError: (_level, message) => {
      throw new TypeError(`Invalid SVG: ${message}`)
    }
  }).parseFromString(source, 'image/svg+xml')
  const root = document.documentElement
  if (!root || root.tagName !== 'svg' || !root.getAttribute('viewBox')) {
    throw new TypeError('SVG must have an <svg> root and a viewBox')
  }
  cleanTree(root)
  root.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  return new XMLSerializer().serializeToString(root)
}
