/**
 * Types and pure parsing for the app-owned Android target capability
 * (`cio:adb`). Everything here is side-effect free: the shapes the service
 * exchanges with the gateway, the `uiautomator` tree parser, and the selector
 * matcher.
 *
 * The tree parser exists because `uiautomator dump` writes a flat, regular XML
 * document and every agent session so far has rewritten the same fragile parser
 * inline. Parsing it once, here, is the whole point of the capability.
 */

/** A rectangle in physical pixels, as `uiautomator` reports it. */
export interface AdbBounds {
  x1: number
  y1: number
  x2: number
  y2: number
}

/** How much of a node's user-visible text a result carries back to the model. */
export type AdbTextMode = 'omit' | 'length' | 'include'

/** One node of the accessibility view tree. */
export interface AdbNode {
  index: number
  depth: number
  className: string
  resourceId: string
  contentDesc: string
  packageName: string
  bounds: AdbBounds
  /** Tap point: the centre of `bounds`. */
  center: { x: number; y: number }
  clickable: boolean
  longClickable: boolean
  editable: boolean
  focused: boolean
  scrollable: boolean
  enabled: boolean
  /** `null` when the caller asked for text "omit". */
  text: string | null
  /** Always present, even when `text` is null, so a caller can tell empty from elided. */
  textLength: number
}

/** Node predicate accepted by `find` and by the selector forms of `tap` and `wait_for`. */
export interface AdbSelector {
  resourceId?: string
  contentDesc?: string
  text?: string
  textContains?: string
  className?: string
  editable?: boolean
  clickable?: boolean
  focused?: boolean
  packageName?: string
}

/** A parsed `adb devices -l` row, enriched with the properties a caller needs. */
export interface AdbTarget {
  serial: string
  /** `device`, `unauthorized`, `offline`, `bootloader`, `recovery`, ... */
  state: string
  /** True only for `device`, the single state this capability can drive. */
  ready: boolean
  kind: 'emulator' | 'usb' | 'network' | 'unknown'
  usb?: string
  transportId?: string
  model?: string
  product?: string
  device?: string
  /** `ro.build.version.sdk`, when the target is ready. */
  sdk?: number
  release?: string
  size?: string
  density?: number
  /** True when this app instance's thread holds the exclusive lease. */
  leasedByMe: boolean
  /** Holder description when another session holds the lease. */
  leasedBy?: string
  /** When the current lease expires, as an epoch millisecond value. */
  leaseExpiresAt?: number
}

/** The exclusive lease one thread holds over one target. */
export interface AdbLease {
  serial: string
  threadId: string
  projectId: string
  /** Process that claimed it, so a crashed app instance can be reclaimed. */
  pid: number
  heldSince: number
  heartbeatAt: number
  expiresAt: number
}

/** A native window sitting above the app, which is what prunes a WebView's tree. */
export interface AdbWindowWarning {
  kind: 'dialog' | 'other-package' | 'system'
  className: string
  packageName: string
  summary: string
}

/** The result of one tree read, including how hard it had to work. */
export interface AdbTreeRead {
  nodes: AdbNode[]
  /** How many dumps it took before the tree stopped growing. */
  attempts: number
  /** Node counts per attempt, so an unstable tree is visible rather than hidden. */
  attemptNodeCounts: number[]
  rotation: string
  /** Non-empty when something on top of the app is pruning the tree. */
  windows: AdbWindowWarning[]
  /** Plain-language caution for the caller, or `null` when the read looks clean. */
  caution: string | null
}

const BOUNDS_PATTERN = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/u
const ATTRIBUTE_PATTERN = /([\w-]+)="([^"]*)"/gu
const NODE_OPEN_PATTERN = /<node\b([^>]*?)(\/?)>/gu
const NODE_CLOSE_PATTERN = /<\/node>/gu
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' '
}

/** Decode the entity set Android's XML serializer emits. */
export function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[\w]+);/gu, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return NAMED_ENTITIES[entity] ?? match
  })
}

/** Parse `bounds="[x1,y1][x2,y2]"`. Returns `null` for the degenerate `[0,0][0,0]`. */
export function parseBounds(value: string | undefined): AdbBounds | null {
  if (!value) return null
  const match = BOUNDS_PATTERN.exec(value.trim())
  if (!match) return null
  const bounds: AdbBounds = {
    x1: Number(match[1]),
    y1: Number(match[2]),
    x2: Number(match[3]),
    y2: Number(match[4])
  }
  if (bounds.x2 <= bounds.x1 || bounds.y2 <= bounds.y1) return null
  return bounds
}

/** Tap point for a rectangle. */
export function boundsCenter(bounds: AdbBounds): { x: number; y: number } {
  return {
    x: Math.round((bounds.x1 + bounds.x2) / 2),
    y: Math.round((bounds.y1 + bounds.y2) / 2)
  }
}

function attributeBoolean(attributes: Map<string, string>, key: string): boolean {
  return attributes.get(key) === 'true'
}

/**
 * Parse one `uiautomator dump` document into nodes.
 *
 * `uiautomator` emits either `<node .../>` or a nested `<node ...>...</node>`
 * form depending on the platform version, so depth is tracked by walking open
 * and close tags rather than by assuming self-closing elements. `checksum` and
 * the trailing byte count are ignored, and a truncated document yields the nodes
 * that did parse rather than throwing.
 */
export function parseUiTree(xml: string, textMode: AdbTextMode): AdbNode[] {
  const nodes: AdbNode[] = []
  const pattern = new RegExp(`${NODE_OPEN_PATTERN.source}|${NODE_CLOSE_PATTERN.source}`, 'gu')
  let depth = 0
  for (const match of xml.matchAll(pattern)) {
    if (match[0].startsWith('</')) {
      depth = Math.max(0, depth - 1)
      continue
    }
    const attributes = new Map<string, string>()
    for (const attribute of match[1]!.matchAll(ATTRIBUTE_PATTERN)) {
      attributes.set(attribute[1]!, decodeXmlEntities(attribute[2]!))
    }
    const selfClosing = match[2] === '/'
    const bounds = parseBounds(attributes.get('bounds'))
    const rawText = attributes.get('text') ?? ''
    if (bounds) {
      nodes.push({
        index: nodes.length,
        depth,
        className: attributes.get('class') ?? '',
        resourceId: attributes.get('resource-id') ?? '',
        contentDesc: attributes.get('content-desc') ?? '',
        packageName: attributes.get('package') ?? '',
        bounds,
        center: boundsCenter(bounds),
        clickable: attributeBoolean(attributes, 'clickable'),
        longClickable: attributeBoolean(attributes, 'long-clickable'),
        editable: attributeBoolean(attributes, 'editable'),
        focused: attributeBoolean(attributes, 'focused'),
        scrollable: attributeBoolean(attributes, 'scrollable'),
        enabled: attributes.get('enabled') !== 'false',
        text: textMode === 'include' ? rawText : null,
        textLength: rawText.length
      })
    }
    if (!selfClosing) depth += 1
  }
  return nodes
}

function matchesId(candidate: string, wanted: string): boolean {
  if (candidate === wanted) return true
  // Android resource ids arrive fully qualified as `package:id/name`, while an
  // agent reading the app's source usually has the bare `name`.
  const candidateName = candidate.includes('/')
    ? candidate.slice(candidate.lastIndexOf('/') + 1)
    : candidate
  const wantedName = wanted.includes('/') ? wanted.slice(wanted.lastIndexOf('/') + 1) : wanted
  return candidateName === wantedName
}

function matchesClassName(candidate: string, wanted: string): boolean {
  if (candidate === wanted) return true
  // `EditText` and `WebView` are the forms agents read out of app source.
  return !wanted.includes('.') && candidate.endsWith(`.${wanted}`)
}

/** True when a node satisfies every field the selector names. */
export function nodeMatchesSelector(node: AdbNode, selector: AdbSelector): boolean {
  if (selector.resourceId !== undefined && !matchesId(node.resourceId, selector.resourceId)) {
    return false
  }
  if (selector.contentDesc !== undefined && node.contentDesc !== selector.contentDesc) {
    return false
  }
  if (selector.text !== undefined) {
    // Text was elided from the parsed node. The service parses with text
    // "include" whenever a selector needs to look at text, so reaching this
    // branch means the caller used `nodeMatchesSelector` directly on an
    // elided tree, which must not silently match.
    if (node.text === null) return false
    if (node.text !== selector.text) return false
  }
  if (selector.textContains !== undefined) {
    if (node.text === null) return false
    if (!node.text.toLowerCase().includes(selector.textContains.toLowerCase())) return false
  }
  if (selector.className !== undefined && !matchesClassName(node.className, selector.className)) {
    return false
  }
  if (selector.editable !== undefined && node.editable !== selector.editable) return false
  if (selector.clickable !== undefined && node.clickable !== selector.clickable) return false
  if (selector.focused !== undefined && node.focused !== selector.focused) return false
  if (selector.packageName !== undefined && node.packageName !== selector.packageName) return false
  return true
}

/** True when the selector names at least one field, so an empty match is a caller error. */
export function selectorIsEmpty(selector: AdbSelector): boolean {
  return Object.values(selector).every((value) => value === undefined)
}

/** One-line node summary for a result payload. Never includes elided text. */
export function describeNode(node: AdbNode): string {
  const label = node.contentDesc || node.text || ''
  const parts = [node.className || 'node']
  if (node.resourceId) parts.push(node.resourceId)
  if (label) parts.push(`"${label.length > 48 ? `${label.slice(0, 48)}...` : label}"`)
  parts.push(`[${node.bounds.x1},${node.bounds.y1}][${node.bounds.x2},${node.bounds.y2}]`)
  return parts.join(' ')
}
