import type { BrowserViewBounds } from './ipc/browser'

/** Only inert markup and button identities cross into the non-focusable overlay. */
export interface NativeDockNode {
  tag: string
  attributes: Record<string, string>
  children: Array<NativeDockNode | string>
}
export interface NativeDockRequest {
  id: string
  revision: number
  /** Painted content that never receives pointer or keyboard input. */
  passive?: boolean
  /** A canonical Modal panel, with a native backdrop and hover selection. */
  modal?: boolean
  /** A complete bounded native panel without a modal backdrop. */
  panel?: boolean
  /** The source row selected by keyboard navigation. */
  selectedAction?: string | null
  typography?: { fontFamily: string; fontSize: number; fontWeight: number }
  /** Newly introduced image resources. Nodes reference them by identity. */
  images?: Record<string, string>
  bounds: BrowserViewBounds
  theme: 'light' | 'dark'
  nodes: Array<NativeDockNode | string>
}
export interface NativeDockAck {
  id: string
  revision: number
}
export interface NativeDockCommit {
  id: string
  selectedKey: string | null
  keyboardAt: number
}
/** Native keyboard input routed back to the canonical modal's handlers. */
export interface NativeDockKey {
  id: string
  type: 'keydown' | 'keyup'
  key: string
  code: string
  control: boolean
  shift: boolean
  alt: boolean
  meta: boolean
  isAutoRepeat: boolean
}
export type NativeDockInteraction =
  | { id: string; kind: 'field'; field: string; value: string; version: number }
  | (NativeDockKey & { kind: 'fieldKey'; field: string })
  | {
      id: string
      kind: 'click' | 'context'
      action: string
      control?: boolean
      shift?: boolean
      meta?: boolean
      alt?: boolean
    }
  | { id: string; kind: 'hover'; action: string }
  | { id: string; kind: 'commit'; key: string }
  | { id: string; kind: 'dismiss' }
  | { id: string; kind: 'scroll'; target: string; top: number }
  | { id: string; kind: 'drag'; dx: number; dy: number; done: boolean }
  | { id: string; kind: 'edge'; key: string }

export const NATIVE_DOCK_TAGS = new Set([
  'div',
  'aside',
  'span',
  'kbd',
  'button',
  'svg',
  'path',
  'circle',
  'rect',
  'line',
  'polyline',
  'polygon',
  'ellipse',
  'g',
  'title',
  'img',
  'header',
  'footer',
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'section',
  'article',
  'ul',
  'ol',
  'li',
  'strong',
  'em',
  'small',
  'b',
  'code',
  'pre',
  'dl',
  'dt',
  'dd',
  'br',
  'hr',
  'label',
  'input',
  'textarea'
])
export const NATIVE_DOCK_ATTRIBUTES = new Set([
  'class',
  'style',
  'title',
  'aria-label',
  'aria-hidden',
  'role',
  'disabled',
  'type',
  'viewBox',
  'width',
  'height',
  'fill',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'd',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'x',
  'y',
  'x1',
  'x2',
  'y1',
  'y2',
  'points',
  'transform',
  'xmlns',
  'src',
  'alt',
  'data-shortcut',
  'data-native-dock-action',
  'data-native-dock-handle',
  'data-popover-drag-handle',
  'aria-selected',
  'aria-current',
  'aria-pressed',
  'aria-expanded',
  'draggable',
  'data-browser-tab-id',
  'aria-modal',
  'aria-disabled',
  'aria-checked',
  'aria-labelledby',
  'aria-describedby',
  'id',
  'tabindex',
  'data-state',
  'data-modal-primary',
  'data-modal-dismiss',
  'data-modal-footer',
  'data-native-dock-scroll',
  'data-native-dock-scroll-top',
  'data-native-dock-key',
  'data-native-dock-image',
  'for',
  'placeholder',
  'maxlength',
  'readonly',
  'spellcheck',
  'autocomplete',
  'data-native-dock-field',
  'data-native-dock-focus',
  'data-native-dock-value',
  'data-native-dock-version',
  'data-native-dock-select',
  'data-native-dock-keys'
])
export const MAX_NATIVE_DOCK_NODES = 4096
const MAX_TEXT = 48_000
export const MAX_NATIVE_DOCK_IMAGE_CHARS = 4_000_000
const NATIVE_DOCK_IMAGE_ID = /^image-[0-9]{1,8}$/

/** Images have their own bounded budget, independent of the markup text. */
export function validateNativeDockImages(value: unknown): Record<string, string> {
  const images = record(value)
  const entries = Object.entries(images)
  if (entries.length > 64) throw new TypeError('Too many native dock images')
  let size = 0
  const result: Record<string, string> = {}
  for (const [id, source] of entries) {
    if (
      !NATIVE_DOCK_IMAGE_ID.test(id) ||
      typeof source !== 'string' ||
      !source.startsWith('data:image/')
    )
      throw new TypeError('Invalid native dock image')
    size += source.length
    if (size > MAX_NATIVE_DOCK_IMAGE_CHARS) throw new TypeError('Native dock images are too large')
    result[id] = source
  }
  return result
}

/** References currently painted, so source and native caches can drop old icons. */
export function nativeDockImageIds(nodes: readonly (NativeDockNode | string)[]): Set<string> {
  const ids = new Set<string>()
  function visit(children: readonly (NativeDockNode | string)[]): void {
    for (const node of children) {
      if (typeof node === 'string') continue
      const id = node.attributes['data-native-dock-image']
      if (id) ids.add(id)
      visit(node.children)
    }
  }
  visit(nodes)
  return ids
}

/** Copy only inert sizing and badge colours, never arbitrary CSS or URLs. */
export function nativeDockStyleAllowed(style: string): boolean {
  return style.split(';').every((declaration) => {
    if (!declaration.trim()) return true
    const separator = declaration.indexOf(':')
    const property = declaration.slice(0, separator).trim()
    const value = declaration.slice(separator + 1).trim()
    if (['width', 'height', 'max-height', 'font-size'].includes(property))
      return /^[0-9.]+(?:px|rem|em|%)$/.test(value)
    return (
      [
        'color',
        'background',
        'background-color',
        'border-top-color',
        'border-right-color'
      ].includes(property) && /^(?:var\(--color-[a-z0-9-]+\)|#[a-fA-F0-9]{3,8})$/.test(value)
    )
  })
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Invalid native dock object')
  return value as Record<string, unknown>
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9:_-]{1,120}$/.test(value))
    throw new TypeError('Invalid native dock identity')
  return value
}
function finite(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 100_000)
    throw new TypeError('Invalid native dock coordinate')
  return value
}
export function validateNativeDockAck(value: unknown): NativeDockAck {
  const input = record(value)
  const revision = finite(input.revision)
  if (!Number.isSafeInteger(revision) || revision < 0)
    throw new TypeError('Invalid native dock revision')
  return { id: identifier(input.id), revision }
}
export function validateNativeDockRequest(value: unknown): NativeDockRequest {
  const input = record(value)
  const ack = validateNativeDockAck(value)
  const bounds = record(input.bounds)
  let count = 0
  let text = 0
  // A modal or a bounded panel is a full surface of its own: both carry a whole
  // canonical panel's markup, so both get the modal-sized budgets.
  const fullSurface = input.modal === true || input.panel === true
  const textLimit = fullSurface ? 256_000 : MAX_TEXT
  const nodes = (value: unknown, depth = 0): Array<NativeDockNode | string> => {
    if (!Array.isArray(value) || depth > 24) throw new TypeError('Invalid native dock tree')
    return value.map((item: unknown) => {
      if (++count > (fullSurface ? MAX_NATIVE_DOCK_NODES : 512))
        throw new TypeError('Native dock tree is too large')
      if (typeof item === 'string') {
        text += item.length
        if (text > textLimit) throw new TypeError('Native dock text is too large')
        return item
      }
      const node = record(item)
      if (typeof node.tag !== 'string' || !NATIVE_DOCK_TAGS.has(node.tag))
        throw new TypeError(`Invalid native dock tag: ${String(node.tag).slice(0, 32)}`)
      const attributes: Record<string, string> = {}
      for (const [key, value] of Object.entries(record(node.attributes))) {
        if (!NATIVE_DOCK_ATTRIBUTES.has(key) || typeof value !== 'string')
          throw new TypeError(`Invalid native dock attribute: ${String(key).slice(0, 48)}`)
        if (key === 'data-native-dock-image' && !NATIVE_DOCK_IMAGE_ID.test(value))
          throw new TypeError('Invalid native dock image reference')
        text += value.length
        if (text > textLimit) throw new TypeError('Native dock text is too large')
        if (
          key === 'src' &&
          !value.startsWith('data:image/') &&
          !(/^\.?\/assets\/[a-zA-Z0-9_./-]+$/.test(value) && !value.includes('..'))
        )
          throw new TypeError('Native dock images must be bundled or inline')
        if (key === 'style' && !nativeDockStyleAllowed(value))
          throw new TypeError('Invalid native dock sizing style')
        attributes[key] = value
      }
      return { tag: node.tag, attributes, children: nodes(node.children, depth + 1) }
    })
  }
  if (input.theme !== 'light' && input.theme !== 'dark')
    throw new TypeError('Invalid native dock theme')
  const rect = {
    x: finite(bounds.x),
    y: finite(bounds.y),
    width: finite(bounds.width),
    height: finite(bounds.height)
  }
  if (rect.width <= 0 || rect.height <= 0) throw new TypeError('Invalid native dock dimensions')
  if (input.passive !== undefined && typeof input.passive !== 'boolean')
    throw new TypeError('Invalid native dock passive flag')
  if (input.modal !== undefined && typeof input.modal !== 'boolean')
    throw new TypeError('Invalid native modal flag')
  const selectedAction = input.selectedAction == null ? null : identifier(input.selectedAction)
  const typography =
    input.typography === undefined ? undefined : validateNativeDockTypography(input.typography)
  return {
    ...ack,
    bounds: rect,
    theme: input.theme,
    nodes: nodes(input.nodes),
    passive: input.passive === true,
    modal: input.modal === true,
    panel: input.panel === true,
    selectedAction,
    typography,
    images: validateNativeDockImages(input.images ?? {})
  }
}
export function validateNativeDockInteraction(value: unknown): NativeDockInteraction {
  const input = record(value)
  const id = identifier(input.id)
  if (input.kind === 'field') {
    if (
      typeof input.value !== 'string' ||
      input.value.length > 64_000 ||
      !Number.isSafeInteger(input.version) ||
      Number(input.version) < 0
    )
      throw new TypeError('Invalid native field value')
    return {
      id,
      kind: 'field',
      field: identifier(input.field),
      value: input.value,
      version: Number(input.version)
    }
  }
  if (input.kind === 'fieldKey') {
    if (
      !['keydown', 'keyup'].includes(String(input.type)) ||
      typeof input.key !== 'string' ||
      input.key.length > 64 ||
      typeof input.code !== 'string' ||
      input.code.length > 64 ||
      ['control', 'shift', 'alt', 'meta', 'isAutoRepeat'].some(
        (key) => typeof input[key] !== 'boolean'
      )
    )
      throw new TypeError('Invalid native field key')
    return {
      id,
      kind: 'fieldKey',
      field: identifier(input.field),
      type: input.type as 'keydown' | 'keyup',
      key: input.key,
      code: input.code,
      control: input.control as boolean,
      shift: input.shift as boolean,
      alt: input.alt as boolean,
      meta: input.meta as boolean,
      isAutoRepeat: input.isAutoRepeat as boolean
    }
  }
  if (input.kind === 'click' || input.kind === 'context')
    return {
      id,
      kind: input.kind,
      action: identifier(input.action),
      control: input.control === true,
      shift: input.shift === true,
      meta: input.meta === true,
      alt: input.alt === true
    }
  if (input.kind === 'hover') return { id, kind: 'hover', action: identifier(input.action) }
  if (input.kind === 'commit') return { id, kind: 'commit', key: identifier(input.key) }
  if (input.kind === 'dismiss') return { id, kind: 'dismiss' }
  if (input.kind === 'scroll') {
    const top = finite(input.top)
    if (top < 0) throw new TypeError('Invalid native scroll position')
    return { id, kind: 'scroll', target: identifier(input.target), top }
  }
  if (input.kind === 'drag' && typeof input.done === 'boolean')
    return { id, kind: 'drag', dx: finite(input.dx), dy: finite(input.dy), done: input.done }
  if (
    input.kind === 'edge' &&
    typeof input.key === 'string' &&
    ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(input.key)
  )
    return { id, kind: 'edge', key: input.key }
  throw new TypeError('Invalid native dock interaction')
}
export function validateNativeDockCommit(value: unknown): NativeDockCommit {
  const input = record(value)
  const keyboardAt = input.keyboardAt
  if (
    typeof keyboardAt !== 'number' ||
    !Number.isFinite(keyboardAt) ||
    keyboardAt < 0 ||
    keyboardAt > Number.MAX_SAFE_INTEGER
  )
    throw new TypeError('Invalid native keyboard timestamp')
  return {
    id: identifier(input.id),
    selectedKey: input.selectedKey === null ? null : identifier(input.selectedKey),
    keyboardAt
  }
}
export { identifier as validateNativeDockId }

/** Appearance values shared by native modal and notification documents. */
export function validateNativeDockTypography(
  value: unknown
): NonNullable<NativeDockRequest['typography']> {
  const font = record(value)
  if (typeof font.fontFamily !== 'string' || font.fontFamily.length > 512)
    throw new TypeError('Invalid native font family')
  const fontSize = finite(font.fontSize)
  const fontWeight = finite(font.fontWeight)
  if (fontSize < 8 || fontSize > 64 || fontWeight < 1 || fontWeight > 1000)
    throw new TypeError('Invalid native typography')
  return { fontFamily: font.fontFamily, fontSize, fontWeight }
}
