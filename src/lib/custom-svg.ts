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

/**
 * Paint that draws nothing.
 *
 * Everything else becomes `currentColor`: the icon is a glyph in a slot, and it
 * has to follow the accent the entity wears, just like the built-in set does.
 * That is why a pasted black-on-transparent outline stops being a fixed black
 * and starts switching with the colour the user picks. Neutrals are deliberately
 * not exempt any more   leaving them literal was what froze an outline to black.
 */
function isUnpainted(value: string): boolean {
  const color = value.trim().toLowerCase()
  return color === 'none' || color === 'transparent'
}

const SVG_NUMBER = /-?\d*\.?\d+(?:e[-+]?\d+)?/gi

/** Round every number in a geometry string, so an icon keeps icon precision. */
function roundNumbers(value: string, precision = 2): string {
  return value.replace(SVG_NUMBER, (match) => {
    const number = Number(match)
    if (!Number.isFinite(number)) return match
    return String(Number(number.toFixed(precision)))
  })
}

/** Geometry attributes whose numbers are safe to round and whose spaces we trim. */
const NUMERIC_ATTRIBUTES = new Set([
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
  'points',
  'transform',
  'stroke-width',
  'stroke-dasharray',
  'stroke-dashoffset'
])

function hasElementChild(node: Element): boolean {
  for (let index = 0; index < node.childNodes.length; index += 1) {
    if (node.childNodes.item(index)?.nodeType === 1) return true
  }
  return false
}

function cleanTree(node: Element): void {
  const style = node.getAttribute('style')
  if (style) {
    for (const declaration of style.split(';')) {
      const match = declaration.match(/^\s*(fill|stroke)\s*:\s*([^;]+)\s*$/i)
      if (!match) continue
      const property = match[1].toLowerCase()
      const value = match[2].replace(/\s*!important\s*$/i, '').trim()
      node.setAttribute(property, isUnpainted(value) ? 'none' : 'currentColor')
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
      node.setAttribute(name, isUnpainted(attribute.value) ? 'none' : 'currentColor')
    } else if (NUMERIC_ATTRIBUTES.has(name)) {
      node.setAttribute(name, roundNumbers(attribute.value))
    }
  }

  for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
    const child = node.childNodes.item(index)
    if (!child || child.nodeType !== 1) {
      if (child) node.removeChild(child)
      continue
    }
    const element = child as Element
    if (!ALLOWED_ELEMENTS.has(element.tagName)) {
      node.removeChild(element)
      continue
    }
    cleanTree(element)
    // A group that holds nothing draws nothing, so it is dead weight in an icon.
    if (element.tagName === 'g' && !hasElementChild(element)) node.removeChild(element)
  }
}

/** Parse a user SVG into a small safe subset, optimize it, and mark its paint for tinting. */
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
  // The icon slot is 16 px, so the intrinsic size is pinned to it. The viewBox
  // keeps the original geometry; only the box it maps into is standardized, so
  // one icon never asks to be drawn larger than another.
  root.setAttribute('width', '16')
  root.setAttribute('height', '16')
  const optimized = new XMLSerializer().serializeToString(root)
  if (new TextEncoder().encode(optimized).byteLength > MAX_CUSTOM_SVG_LENGTH) {
    throw new TypeError('This SVG is too detailed for an icon')
  }
  return optimized
}
