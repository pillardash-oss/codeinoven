/**
 * The app's contract with the Cua driver, as the gateway has to honour it.
 *
 * The driver is a computer-use MCP server whose window tools are addressed
 * through a snapshot registry with one slot per window. A snapshot returns a
 * screenshot plus a structured payload: `elements[]` (each row carrying an
 * `element_index` and an `element_token`), and the ids and geometry an action
 * needs (`snapshot_id`, `capture_id`, `screenshot_scale`, `window_bounds`).
 * Every later snapshot of the same window replaces that slot, and a reference
 * into a replaced snapshot is refused before anything is dispatched:
 * `stale_element_token`, `snapshot_id_required`, `capture_stale`,
 * `capture_not_found`, `capture_generation_mismatch`, `screenshot_context_missing`.
 *
 * That registry is shared by every client of the driver, and the app itself is
 * one of them twice over: the gateway serves the model's calls, while the
 * computer-use PiP photographs the same window at up to 15 frames a second to
 * show the run. A snapshot held across two model calls is therefore usually
 * superseded by the time the second call arrives, which is what made clicks
 * through the gateway unreliable.
 *
 * Two rules fix it, and both live here:
 *
 * 1. A model's `element_index` only means what it means inside the snapshot it
 *    read. The gateway keeps that snapshot per (pid, window) and supplies the
 *    ids the driver asks for, instead of hoping the model can hand them back.
 * 2. When the driver says a reference was superseded, the gateway re-anchors it
 *    against one fresh snapshot and tries once more. An element is re-anchored
 *    only when its identity is provable (same index with the same role and
 *    label, or one unambiguous row with the same role, label and frame); pixel
 *    addresses are mapped by the ratio between the two images. Anything else is
 *    refused with the reason, never guessed at.
 *
 * Pure shape logic with no Electron, `node:*` or SvelteKit import, so the main
 * process can consume it directly.
 */

import {
  SHAPED_GATEWAY_RESULT,
  type GatewayContentPart,
  type GatewayImagePart,
  type GatewayStructuredResult
} from './image-payload'

/** A rectangle in the driver's own units: window bounds in points, frames in
 *  window points. */
export interface CuaRect {
  x: number
  y: number
  width: number
  height: number
}

/** One actionable row of a snapshot's `elements[]`. */
export interface CuaElementRow {
  index: number
  token: string | null
  role: string
  label: string
  frame: CuaRect | null
}

/**
 * The snapshot the gateway handed the model for one window, kept so the model's
 * references can be paired with the snapshot in which they were true.
 */
export interface CuaSnapshotView {
  pid: number
  windowId: number
  snapshotId: string
  captureId: string | null
  /** Pixel space of the screenshot the model read, when it was given one. */
  imageWidth: number | null
  imageHeight: number | null
  /** Window bounds in points, as the driver reported them. */
  bounds: CuaRect | null
  elements: CuaElementRow[]
}

/** How one operation addresses a window snapshot. */
interface CuaAddressing {
  /** Field names carrying an element handle, or none. */
  element: readonly string[]
  /** Whether `capture_id` binds a pixel address on this tool. */
  capture: boolean
  /**
   * Which session the tool's screenshot context lives on. Every tool but one
   * carries the turn's session label, so the snapshot the gateway hands the
   * model serves the next action. `zoom` has no `session` field at all, so it
   * always answers on its connection's implicit session: a snapshot taken under
   * the turn's label can never serve it (measured: `screenshot_context_missing`
   * every time), and its pixels have to be re-read from a snapshot taken
   * without one.
   */
  session: 'labelled' | 'implicit'
}

/**
 * Which operations act on a window snapshot, and with which fields.
 *
 * The field lists are per tool on purpose: the driver's tool schemas set
 * `additionalProperties: false`, so an id sent to a tool that does not declare
 * it is a schema error rather than a helpful hint. `drag` and `zoom` address
 * pixels without accepting a capture id, and `zoom` takes no session at all.
 */
const CUA_ADDRESSING: ReadonlyMap<string, CuaAddressing> = new Map([
  [
    'click',
    {
      element: ['element_index', 'element_token', 'snapshot_id'],
      capture: true,
      session: 'labelled'
    }
  ],
  [
    'double_click',
    {
      element: ['element_index', 'element_token', 'snapshot_id'],
      capture: false,
      session: 'labelled'
    }
  ],
  [
    'right_click',
    {
      element: ['element_index', 'element_token', 'snapshot_id'],
      capture: false,
      session: 'labelled'
    }
  ],
  [
    'scroll',
    {
      element: ['element_index', 'element_token', 'snapshot_id'],
      capture: false,
      session: 'labelled'
    }
  ],
  [
    'type_text',
    {
      element: ['element_index', 'element_token', 'snapshot_id'],
      capture: false,
      session: 'labelled'
    }
  ],
  [
    'press_key',
    {
      element: ['element_index', 'element_token', 'snapshot_id'],
      capture: false,
      session: 'labelled'
    }
  ],
  [
    'set_value',
    {
      element: ['element_index', 'element_token', 'snapshot_id'],
      capture: false,
      session: 'labelled'
    }
  ],
  ['drag', { element: [], capture: false, session: 'labelled' }],
  ['zoom', { element: [], capture: false, session: 'implicit' }]
])

/** Which session one operation's screenshot context lives on, or null when the
 *  operation does not address a window snapshot at all. */
export function cuaToolSession(operation: string): 'labelled' | 'implicit' | null {
  return CUA_ADDRESSING.get(operation)?.session ?? null
}

/** Pixel field names per operation, in the pairs that must move together. */
const CUA_PIXEL_FIELDS: ReadonlyMap<string, readonly string[]> = new Map([
  ['click', ['x', 'y']],
  ['double_click', ['x', 'y']],
  ['right_click', ['x', 'y']],
  ['scroll', ['x', 'y']],
  ['type_text', ['x', 'y']],
  ['press_key', ['x', 'y']],
  ['drag', ['from_x', 'from_y', 'to_x', 'to_y']],
  ['zoom', ['x1', 'y1', 'x2', 'y2']]
])

/** What the model asked one action to address. */
export interface CuaActionReference {
  operation: string
  pid: number | null
  windowId: number | null
  /** The element index the model named, from `element_index` or a token. */
  elementIndex: number | null
  /** Whether the address is window-local pixels. */
  pixels: boolean
  /** The snapshot id the model named, when it named one. */
  snapshotId: string | null
  /** Whether this tool can bind pixels to an exact capture. */
  capture: boolean
  /** Which session this tool's screenshot context lives on. */
  session: 'labelled' | 'implicit'
}

/** The reference a driver refusal was about. */
export interface CuaRefusal {
  code: string
  message: string
}

/**
 * Why a call could not be paired with a snapshot.
 *
 * `foreign-snapshot` is the one the gateway answers for itself: the model named
 * a snapshot the app never handed out, so there is no way to prove what its
 * element index meant, and re-anchoring it would be a guess.
 */
export type CuaGroundingMiss =
  'not-addressed' | 'no-snapshot' | 'foreign-snapshot' | 'unknown-element'

export type CuaGrounding =
  | { kind: 'grounded'; input: Record<string, unknown> }
  | { kind: 'ungrounded'; reason: CuaGroundingMiss }

/**
 * Refusal codes that mean "the snapshot this reference belonged to is gone",
 * which a fresh snapshot can repair. Every one of them is answered before the
 * driver dispatches anything, so re-issuing the action is safe.
 */
const CUA_SUPERSEDED_CODES: ReadonlySet<string> = new Set([
  'stale_element_token',
  'snapshot_id_required',
  'snapshot_stale',
  'capture_stale',
  'capture_expired',
  'capture_not_found',
  'capture_generation_mismatch',
  'screenshot_context_missing',
  'zoom_context_missing'
])

const ELEMENT_TOKEN_PATTERN = /^(s[0-9a-f]{8}):(\d+)$/u

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** A rectangle from either of the driver's two field spellings. */
function rectValue(value: unknown): CuaRect | null {
  if (!isRecord(value)) return null
  const x = numberValue(value['x'])
  const y = numberValue(value['y'])
  const width = numberValue(value['width'] ?? value['w'])
  const height = numberValue(value['height'] ?? value['h'])
  if (x === null || y === null || width === null || height === null) return null
  return { x, y, width, height }
}

/** One `elements[]` row, or null when it carries no usable index. */
function elementRow(value: unknown): CuaElementRow | null {
  if (!isRecord(value)) return null
  const index = numberValue(value['element_index'])
  if (index === null) return null
  return {
    index,
    token: stringValue(value['element_token']),
    role: stringValue(value['role']) ?? '',
    label: stringValue(value['label']) ?? '',
    frame: rectValue(value['frame'])
  }
}

/**
 * The snapshot view of one driver result, or null when the result is not a
 * window snapshot (a refusal, a window list, a tool with no structured side).
 */
export function cuaSnapshotView(result: unknown): CuaSnapshotView | null {
  if (!isRecord(result)) return null
  const structured = result['structuredContent']
  if (!isRecord(structured)) return null
  const pid = numberValue(structured['pid'])
  const windowId = numberValue(structured['window_id'])
  const snapshotId = stringValue(structured['snapshot_id'])
  const elements = Array.isArray(structured['elements'])
    ? structured['elements'].map(elementRow).filter((row): row is CuaElementRow => row !== null)
    : []
  // A snapshot is identified by its handle and its window; without both, the
  // result is a window list or a refusal, and the model keeps it as it came.
  if (!snapshotId || pid === null || windowId === null) return null
  return {
    pid,
    windowId,
    snapshotId,
    captureId: stringValue(structured['capture_id']),
    imageWidth: numberValue(structured['screenshot_width']),
    imageHeight: numberValue(structured['screenshot_height']),
    bounds: rectValue(structured['window_bounds']),
    elements
  }
}

/** The refusal code and message inside a driver result, when it refused. */
export function cuaRefusal(result: unknown): CuaRefusal | null {
  if (!isRecord(result)) return null
  const structured = result['structuredContent']
  if (!isRecord(structured)) return null
  const refusal = isRecord(structured['refusal']) ? structured['refusal'] : null
  const code = stringValue(refusal?.['code']) ?? stringValue(structured['code'])
  if (!code) return null
  const message =
    stringValue(refusal?.['message']) ??
    stringValue(structured['message']) ??
    firstText(result) ??
    code
  return { code, message }
}

/** The first text part of a result, which is where the driver words a refusal. */
function firstText(result: Record<string, unknown>): string | null {
  const content = result['content']
  if (!Array.isArray(content)) return null
  for (const part of content) {
    if (isRecord(part) && part['type'] === 'text' && typeof part['text'] === 'string') {
      return part['text']
    }
  }
  return null
}

/** Whether a refusal means the reference outlived its snapshot. */
export function isSupersededSnapshotRefusal(result: unknown): boolean {
  const refusal = cuaRefusal(result)
  return refusal !== null && CUA_SUPERSEDED_CODES.has(refusal.code)
}

/**
 * What one operation addresses, or null when it does not address a window
 * snapshot at all (a window list, a desktop-scope action, a key press with no
 * element, a tool the app does not pair).
 */
export function cuaActionReference(
  operation: string,
  input: Record<string, unknown>
): CuaActionReference | null {
  const addressing = CUA_ADDRESSING.get(operation)
  if (!addressing) return null
  if (input['scope'] === 'desktop') return null
  const pid = numberValue(input['pid'])
  const windowId = numberValue(input['window_id'])
  const namedToken = stringValue(input['element_token'])
  const tokenMatch = namedToken ? ELEMENT_TOKEN_PATTERN.exec(namedToken) : null
  const elementIndex =
    numberValue(input['element_index']) ?? (tokenMatch ? Number(tokenMatch[2]) : null)
  const namedSnapshotId = stringValue(input['snapshot_id']) ?? tokenMatch?.[1] ?? null
  const pixelFields = CUA_PIXEL_FIELDS.get(operation) ?? []
  const pixelPair =
    pixelFields.length > 0 && pixelFields.every((field) => numberValue(input[field]) !== null)
  const pixels = elementIndex === null && pixelPair
  if (elementIndex === null && !pixels) return null
  return {
    operation,
    pid,
    windowId,
    elementIndex: pixels ? null : elementIndex,
    pixels,
    snapshotId: namedSnapshotId,
    capture: addressing.capture,
    session: addressing.session
  }
}

/** Whether one snapshot view answers for one reference's window. A reference
 *  that names neither a pid nor a window cannot be matched to a snapshot. */
function viewFor(
  reference: CuaActionReference,
  view: CuaSnapshotView | null
): CuaSnapshotView | null {
  if (!view) return null
  if (reference.pid === null && reference.windowId === null) return null
  if (reference.pid !== null && reference.pid !== view.pid) return null
  if (reference.windowId !== null && reference.windowId !== view.windowId) return null
  return view
}

/** Where an element address lands in one snapshot, in the driver's coordinate
 *  of truth: the index, plus the token that carries it when the snapshot
 *  published one. */
function elementHandles(
  view: CuaSnapshotView,
  index: number
): { element_index: number; element_token?: string; snapshot_id: string } {
  const row = view.elements.find((entry) => entry.index === index)
  return {
    element_index: index,
    ...(row?.token ? { element_token: row.token } : {}),
    snapshot_id: view.snapshotId
  }
}

/**
 * Prepare one acting call: fill in the ids of the snapshot the model's address
 * belongs to.
 *
 * Returns `ungrounded` whenever the app cannot prove what the address meant, so
 * the driver's own refusal reaches the model instead of a guessed action.
 */
export function groundCuaAction(
  operation: string,
  input: Record<string, unknown>,
  view: CuaSnapshotView | null
): CuaGrounding {
  const reference = cuaActionReference(operation, input)
  if (!reference) return { kind: 'ungrounded', reason: 'not-addressed' }
  const snapshot = viewFor(reference, view)
  if (!snapshot) return { kind: 'ungrounded', reason: 'no-snapshot' }
  // A named handle from another snapshot cannot be checked against this one: the
  // index it carries belonged to a tree the app never saw.
  if (reference.snapshotId !== null && reference.snapshotId !== snapshot.snapshotId) {
    return { kind: 'ungrounded', reason: 'foreign-snapshot' }
  }
  if (reference.elementIndex !== null) {
    if (!snapshot.elements.some((entry) => entry.index === reference.elementIndex)) {
      return { kind: 'ungrounded', reason: 'unknown-element' }
    }
    return {
      kind: 'grounded',
      input: {
        ...input,
        pid: snapshot.pid,
        window_id: snapshot.windowId,
        ...elementHandles(snapshot, reference.elementIndex)
      }
    }
  }
  // A pixel address is already in the window's screenshot space. Binding it to
  // the exact capture the model read makes the driver admit that capture or
  // refuse it, instead of silently reading pixels against someone else's
  // snapshot of the same window.
  if (reference.capture && snapshot.captureId) {
    return {
      kind: 'grounded',
      input: {
        ...input,
        pid: snapshot.pid,
        window_id: snapshot.windowId,
        capture_id: snapshot.captureId
      }
    }
  }
  return { kind: 'grounded', input }
}

/** What to tell the model when it addressed a snapshot the gateway never gave it. */
export function foreignSnapshotAdvice(
  reference: CuaActionReference,
  view: CuaSnapshotView | null
): string {
  const held = view
    ? `the current snapshot is ${view.snapshotId}`
    : 'the gateway holds no snapshot for this window'
  return (
    `The snapshot this call named (${reference.snapshotId ?? 'none'}) is not one the gateway handed out for this window ` +
    `(${held}), so the element it referred to cannot be checked. Take a new get_window_state, or repeat the call ` +
    'without snapshot_id or element_token to address the element by element_index in the current snapshot.'
  )
}

/** One pixel coordinate mapped from one image's space into another's. */
function mapCoordinate(
  value: number,
  fromSpan: number | null,
  toSpan: number | null
): number | null {
  if (fromSpan === null || toSpan === null || fromSpan <= 0) return null
  return Math.round((value / fromSpan) * toSpan)
}

/**
 * Re-anchor one refused action onto a fresh snapshot of the same window.
 *
 * An element is accepted only when its identity is provable, and a pixel
 * address only when both images state their size. Everything else is refused
 * with a reason that tells the model what to do next.
 */
export function reanchorCuaAction(
  operation: string,
  input: Record<string, unknown>,
  from: CuaSnapshotView | null,
  to: CuaSnapshotView | null
): { input: Record<string, unknown> } | { refusal: string } {
  const reference = cuaActionReference(operation, input)
  if (!reference || !from || !to) {
    return {
      refusal:
        'The window snapshot this action addressed is no longer available; take a new snapshot.'
    }
  }
  if (from.windowId !== to.windowId || from.pid !== to.pid) {
    return {
      refusal:
        'The action addressed a window the refreshed snapshot does not cover; take a new snapshot.'
    }
  }
  if (reference.elementIndex !== null) {
    const row = from.elements.find((entry) => entry.index === reference.elementIndex)
    if (!row) {
      return {
        refusal: `The gateway has no record of element [${reference.elementIndex}] in this window; take a new snapshot and act again.`
      }
    }
    const landed = sameIndexMatch(to, row) ?? uniqueFrameMatch(to, row)
    if (!landed) {
      return {
        refusal:
          `Element [${row.index}] "${row.label}" (${row.role}) is no longer at its recorded place in the refreshed snapshot, ` +
          'so the action was not performed. Take a new snapshot and choose the element again.'
      }
    }
    return {
      input: {
        ...input,
        pid: to.pid,
        window_id: to.windowId,
        ...elementHandles(to, landed.index)
      }
    }
  }
  const fields = CUA_PIXEL_FIELDS.get(operation) ?? []
  const mapped: Record<string, unknown> = {}
  for (const field of fields) {
    const value = numberValue(input[field])
    if (value === null)
      return { refusal: 'The action is missing a pixel coordinate; nothing was performed.' }
    // Every field name in the table ends in its own axis: x, from_x, to_x, x1.
    const horizontal = /(?:^|_)x\d*$/u.test(field)
    const coordinate = mapCoordinate(
      value,
      horizontal ? from.imageWidth : from.imageHeight,
      horizontal ? to.imageWidth : to.imageHeight
    )
    if (coordinate === null) {
      return {
        refusal:
          'The screenshot this action addressed did not state its size, so its coordinates cannot be moved onto a fresh one. ' +
          'Take a new snapshot and act again.'
      }
    }
    mapped[field] = coordinate
  }
  const capture = reference.capture && to.captureId ? { capture_id: to.captureId } : {}
  return { input: { ...input, pid: to.pid, window_id: to.windowId, ...mapped, ...capture } }
}

/** The identity of one element in a snapshot: what must still hold to press it. */
function sameIndexMatch(view: CuaSnapshotView, row: CuaElementRow): CuaElementRow | null {
  const candidate = view.elements.find((entry) => entry.index === row.index)
  if (!candidate) return null
  if (candidate.role !== row.role || candidate.label !== row.label) return null
  return candidate
}

function uniqueFrameMatch(view: CuaSnapshotView, row: CuaElementRow): CuaElementRow | null {
  const matches = view.elements.filter(
    (entry) =>
      entry.role === row.role &&
      entry.label === row.label &&
      entry.frame !== null &&
      row.frame !== null &&
      entry.frame.x === row.frame.x &&
      entry.frame.y === row.frame.y &&
      entry.frame.width === row.frame.width &&
      entry.frame.height === row.frame.height
  )
  return matches.length === 1 ? matches[0] : null
}

/**
 * How a snapshot reaches its readers: one text part with the structured
 * payload, then the screenshot as an image part, and the same payload as
 * `structuredContent` so a codemode script reads element tokens and geometry as
 * fields instead of parsing the text.
 *
 * Returns null for every result that is not a window snapshot, so a refusal, a
 * window list, a skill or any other MCP server keeps exactly the shape it has
 * today.
 */
export function shapeCuaResult(result: unknown): GatewayStructuredResult | null {
  if (!isRecord(result)) return null
  const structured = result['structuredContent']
  if (!isRecord(structured)) return null
  const isSnapshot =
    stringValue(structured['snapshot_id']) !== null || Array.isArray(structured['elements'])
  if (!isSnapshot) return null

  const images: GatewayImagePart[] = []
  const texts: string[] = []
  const sourceParts = Array.isArray(result['content']) ? result['content'] : []
  for (const part of sourceParts) {
    if (!isRecord(part)) continue
    if (part['type'] === 'image') {
      const data = stringValue(part['data'])
      if (data) {
        images.push({ type: 'image', data, mimeType: stringValue(part['mimeType']) ?? 'image/png' })
      }
      continue
    }
    if (part['type'] === 'text') {
      const text = stringValue(part['text'])
      if (text) texts.push(text)
    }
  }

  const payload: Record<string, unknown> = { ...result }
  delete payload['content']
  payload['structuredContent'] = shapeCuaStructured(structured, images)
  const parts: GatewayContentPart[] = [{ type: 'text', text: JSON.stringify(payload) }]
  // The driver's own text is the same tree the elements array states, except on
  // the snapshots that carry no tree at all (a window whose accessibility
  // surface could not be resolved). Those keep their words.
  const elements = Array.isArray(structured['elements']) ? structured['elements'] : []
  if (elements.length === 0) parts.push(...texts.map((text) => ({ type: 'text' as const, text })))
  // Marked as already shaped: the route exit must forward a snapshot as it is,
  // not walk it a second time.
  return {
    content: [...parts, ...images],
    structuredContent: payload,
    [SHAPED_GATEWAY_RESULT]: true
  }
}

/**
 * One snapshot's structured payload as the model should read it: the tree once,
 * and no base64 where a real image part can carry the pixels instead.
 *
 * `tree_markdown` is the same tree the `elements[]` array already states, and it
 * is what the model paid for twice; it stays only where there is no structured
 * tree to read.
 */
function shapeCuaStructured(
  structured: Record<string, unknown>,
  images: GatewayImagePart[]
): Record<string, unknown> {
  const shape: Record<string, unknown> = {}
  const elements = Array.isArray(structured['elements']) ? structured['elements'] : []
  for (const [key, value] of Object.entries(structured)) {
    if (key === '_note') continue
    if (key === 'tree_markdown' && elements.length > 0) continue
    shape[key] = value
  }
  const mimeType = stringValue(structured['screenshot_mime_type']) ?? 'image/png'
  for (const key of Object.keys(shape)) {
    if (!/_b64$/u.test(key)) continue
    const data = shape[key]
    if (typeof data !== 'string' || data.length === 0) continue
    if (!images.some((image) => image.data === data)) {
      images.push({ type: 'image', data, mimeType })
    }
    shape[key] = `[delivered as an image content part: ${mimeType}]`
  }
  return shape
}
