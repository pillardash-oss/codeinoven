/**
 * Real input for the agent's browser operations.
 *
 * A click and a key press are the two things a page can tell apart from a script:
 * `element.click()` and a synthesized `KeyboardEvent` carry `isTrusted: false`, so
 * a canvas app, a drag handle, a captcha-free "are you human" check and anything
 * that reads pointer movement ignore them. Electron's `sendInputEvent` goes in
 * through the browser's own input pipeline instead, which is what makes an agent
 * able to *use* a page rather than only poke its DOM.
 *
 * Two rules keep that trustworthy rather than noisy:
 *
 * - A press is a real sequence. Chromium commits nothing from half of one, so a
 *   click is move, press, release and a key is down, character, up, each given the
 *   event loop a turn to deliver.
 * - A keystroke is named the way a person names it. Accelerator spelling is
 *   Electron's, so "Enter", "ArrowLeft", "PageDown" and friends are normalised
 *   here once instead of at every call site, and an unnameable key fails loudly
 *   rather than silently pressing nothing.
 */

import type { WebContents } from 'electron'

/** The modifiers a press may carry, in Electron's spelling. */
export type AgentModifier = 'shift' | 'control' | 'alt' | 'meta'

/** Turns between bytes of one gesture, so Chromium sees a sequence, not a burst. */
const INPUT_SETTLE_MS = 12
/** Turns between the interpolated moves of one drag. */
const DRAG_STEP_MS = 10
/** Moves a drag interpolates through, so a slider or canvas sees a real path. */
const MAX_DRAG_STEPS = 24
/** Repeats one press may ask for, so a held key cannot flood the page. */
const MAX_KEY_REPEATS = 20

/** Names a person uses for the keys that carry no character. */
const KEY_ALIASES: Readonly<Record<string, string>> = {
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  escape: 'Escape',
  esc: 'Escape',
  space: 'Space',
  spacebar: 'Space',
  ' ': 'Space',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  plus: 'Plus',
  minus: 'Minus'
}

/** The modifier spelling a call site may use, mapped to Electron's. */
const MODIFIER_ALIASES: Readonly<Record<string, AgentModifier>> = {
  shift: 'shift',
  control: 'control',
  ctrl: 'control',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  super: 'meta'
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * The accelerator key code for one named key.
 *
 * A single printable character is its own key code, which is how a caret appends
 * it; everything else is looked up by the name a person would use. Anything else
 * is refused, because pressing an unknown key would report success and do nothing.
 */
export function agentKeyCode(key: string): string {
  const trimmed = key.trim()
  if (trimmed.length === 0) throw new TypeError('key must name a key to press')
  if (trimmed.length > 12) throw new TypeError(`"${key}" is not a key name`)
  const alias = KEY_ALIASES[trimmed.toLowerCase()]
  if (alias) return alias
  if (/^f([1-9]|1[0-9]|2[0-4])$/iu.test(trimmed)) return trimmed.toUpperCase()
  if (trimmed.length === 1) return trimmed
  throw new TypeError(`"${key}" is not a key name`)
}

/** Read a modifier list from tool input, tolerant of order and spelling. */
export function normalizeAgentModifiers(value: unknown): AgentModifier[] {
  if (value === undefined || value === null) return []
  const raw = typeof value === 'string' ? value.split(/[,+\s]+/u) : value
  if (!Array.isArray(raw)) throw new TypeError('modifiers must be a list of modifier names')
  const modifiers: AgentModifier[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim().toLowerCase()
    if (trimmed.length === 0) continue
    const modifier = MODIFIER_ALIASES[trimmed]
    if (!modifier)
      throw new TypeError(`"${entry}" is not a modifier; use shift, control, alt, or meta`)
    if (!modifiers.includes(modifier)) modifiers.push(modifier)
  }
  return modifiers
}

/** Read a clamped whole number from tool input. */
export function agentCount(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(1, Math.min(Math.trunc(value), max))
}

/**
 * Press one key, or repeat it, through the browser's input pipeline.
 *
 * A printable key is down, character, up so a caret receives the text; a named key
 * is down, up, because its meaning lives in the key event. Returned are the events
 * actually sent, so a caller can report what it did instead of assuming it.
 */
export async function pressAgentKey(
  contents: WebContents,
  request: { key: string; modifiers: AgentModifier[]; times: number }
): Promise<{ pressed: number; keyCode: string; modifiers: AgentModifier[] }> {
  if (contents.isDestroyed()) throw new Error('The browser page is no longer available')
  const keyCode = agentKeyCode(request.key)
  const times = agentCount(request.times, 1, MAX_KEY_REPEATS)
  const printable = keyCode.length === 1
  const modifiers = request.modifiers.length > 0 ? request.modifiers : undefined
  for (let index = 0; index < times; index += 1) {
    contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    if (printable) contents.sendInputEvent({ type: 'char', keyCode, modifiers })
    await delay(INPUT_SETTLE_MS)
    contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await delay(INPUT_SETTLE_MS)
  }
  return { pressed: times, keyCode, modifiers: request.modifiers }
}

/** One pointer event the agent asks for. */
export interface AgentMouseRequest {
  action: 'move' | 'hover' | 'click' | 'down' | 'up' | 'wheel'
  x: number
  y: number
  button?: 'left' | 'right' | 'middle'
  clickCount?: number
  deltaX?: number
  deltaY?: number
  modifiers: AgentModifier[]
}

/**
 * Deliver one pointer event through the browser's input pipeline.
 *
 * A hover is a move and nothing else, which is what opens a menu that only exists
 * while the pointer rests on its trigger. A click is move, press, release at one
 * point, the order Chromium requires before it will treat them as one click.
 */
export async function sendAgentMouse(
  contents: WebContents,
  request: AgentMouseRequest
): Promise<void> {
  if (contents.isDestroyed()) throw new Error('The browser page is no longer available')
  const modifiers = request.modifiers.length > 0 ? request.modifiers : undefined
  const button = request.button ?? 'left'
  const point = { x: Math.round(request.x), y: Math.round(request.y) }
  if (request.action === 'wheel') {
    contents.sendInputEvent({
      type: 'mouseWheel',
      ...point,
      deltaX: request.deltaX ?? 0,
      deltaY: request.deltaY ?? 0,
      canScroll: true,
      modifiers
    })
    await delay(INPUT_SETTLE_MS)
    return
  }
  if (request.action === 'move' || request.action === 'hover') {
    contents.sendInputEvent({ type: 'mouseMove', ...point, modifiers })
    await delay(INPUT_SETTLE_MS)
    return
  }
  if (request.action === 'down' || request.action === 'click') {
    contents.sendInputEvent({ type: 'mouseMove', ...point, modifiers })
    await delay(INPUT_SETTLE_MS)
    contents.sendInputEvent({
      type: 'mouseDown',
      ...point,
      button,
      clickCount: request.clickCount ?? 1,
      modifiers
    })
    await delay(INPUT_SETTLE_MS)
  }
  if (request.action === 'up' || request.action === 'click') {
    const clickCount = request.clickCount ?? 1
    for (let count = 1; count <= clickCount; count += 1) {
      contents.sendInputEvent({
        type: 'mouseUp',
        ...point,
        button,
        clickCount: count,
        modifiers
      })
      if (count > 1) {
        contents.sendInputEvent({
          type: 'mouseDown',
          ...point,
          button,
          clickCount: count,
          modifiers
        })
      }
      await delay(INPUT_SETTLE_MS)
    }
    // A double click is press, release, press, release; the loop above emits the
    // closing release with the count Chromium uses to recognise the pair.
  }
}

/**
 * Drag one point to another, in steps, through the input pipeline.
 *
 * Every step is a real move, so a canvas, a slider and a drag-and-drop target all
 * follow the same path a hand would take instead of jumping to the end.
 */
export async function dragAgentMouse(
  contents: WebContents,
  request: {
    from: { x: number; y: number }
    to: { x: number; y: number }
    modifiers: AgentModifier[]
  }
): Promise<{ steps: number }> {
  const distance = Math.hypot(request.to.x - request.from.x, request.to.y - request.from.y)
  const steps = Math.max(2, Math.min(MAX_DRAG_STEPS, Math.round(distance / 24) + 2))
  await sendAgentMouse(contents, {
    action: 'move',
    x: request.from.x,
    y: request.from.y,
    modifiers: request.modifiers
  })
  await sendAgentMouse(contents, {
    action: 'down',
    x: request.from.x,
    y: request.from.y,
    modifiers: request.modifiers
  })
  for (let step = 1; step <= steps; step += 1) {
    const progress = step / steps
    contents.sendInputEvent({
      type: 'mouseMove',
      x: Math.round(request.from.x + (request.to.x - request.from.x) * progress),
      y: Math.round(request.from.y + (request.to.y - request.from.y) * progress),
      modifiers: request.modifiers.length > 0 ? request.modifiers : undefined
    })
    await delay(DRAG_STEP_MS)
  }
  await sendAgentMouse(contents, {
    action: 'up',
    x: request.to.x,
    y: request.to.y,
    modifiers: request.modifiers
  })
  return { steps }
}
