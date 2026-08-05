/**
 * Native mouse capture for the embedded ghostty-web terminal.
 *
 * ghostty-web (v0.4.0) parses and stores DECSET mouse-tracking modes but never
 * forwards mouse events to the PTY, and upstream's own mouse-tracking fix is
 * wheel-broken: the Terminal's capture-phase `handleWheel` calls
 * `stopPropagation()` and emits arrow keys on the alternate screen, so an
 * in-library SGR wheel handler can never run.
 *
 * We implement capture in-app instead: document-phase listeners that run before
 * anything ghostty registers, gated on `term.hasMouseTracking()`. While an app
 * (nvim, htop, tmux...) owns the mouse, clicks, drags, and the wheel are encoded
 * as SGR/X10 sequences and written straight to the PTY; otherwise events fall
 * through to ghostty's own selection, link, and scroll handling.
 */

const MODE_SGR = 1006
const MODE_BUTTON_EVENT = 1002
const MODE_ANY_EVENT = 1003

const enum MouseButton {
  Left = 0,
  Middle = 1,
  Right = 2
}

const enum WheelButton {
  Up = 64,
  Down = 65,
  Left = 66,
  Right = 67
}

/** Motion events use base button 32 in SGR (bit 5 set). */
const MOTION_INDICATOR = 32

interface Cell {
  col: number
  row: number
}

export interface MouseTrackingTerminal {
  hasMouseTracking(): boolean
  getMode(mode: number, isAnsi?: boolean): boolean
  cols: number
  rows: number
}

export interface MouseTrackingHost {
  term: MouseTrackingTerminal
  host: HTMLElement
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function modifierBits(event: MouseEvent): number {
  let bits = 0
  if (event.shiftKey) bits += 4
  if (event.altKey || event.metaKey) bits += 8
  if (event.ctrlKey) bits += 16
  return bits
}

function cellFromEvent(target: MouseTrackingHost, event: MouseEvent): Cell | null {
  const canvas = target.host.querySelector('canvas')
  if (!canvas) return null
  const rect = canvas.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  const cols = Math.max(1, target.term.cols)
  const rows = Math.max(1, target.term.rows)
  const col = Math.floor(((event.clientX - rect.left) / rect.width) * cols) + 1
  const row = Math.floor(((event.clientY - rect.top) / rect.height) * rows) + 1
  return {
    col: clamp(col, 1, cols),
    row: clamp(row, 1, rows)
  }
}

function encodeSgr(code: number, cell: Cell, release: boolean): string {
  return `\x1b[<${code};${cell.col};${cell.row}${release ? 'm' : 'M'}`
}

function encodeX10(button: number, cell: Cell, release: boolean): string {
  const code = release ? 3 : button
  return (
    '\x1b[M' +
    String.fromCharCode(Math.min(code + 32, 255)) +
    String.fromCharCode(Math.min(cell.col + 32, 255)) +
    String.fromCharCode(Math.min(cell.row + 32, 255))
  )
}

/**
 * Attach native mouse-capture listeners for one terminal session.
 *
 * Returns a disposer that removes every listener and marks the capture dead.
 * The listeners live on `document` in the capture phase so they always run
 * ahead of ghostty's own canvas/document handlers.
 */
export function attachMouseTracking(
  target: MouseTrackingHost,
  send: (data: string) => void
): () => void {
  let disposed = false
  let pressed = 0
  let lastMotionCell: Cell | undefined

  const sgr = (): boolean => target.term.getMode(MODE_SGR)

  const captureEnabled = (): boolean => {
    if (disposed) return false
    try {
      return target.term.hasMouseTracking()
    } catch {
      return false
    }
  }

  const withinHost = (event: MouseEvent): boolean => target.host.contains(event.target as Node)

  const emit = (button: number, cell: Cell, release: boolean, event: MouseEvent): void => {
    if (sgr()) {
      send(encodeSgr(button + modifierBits(event), cell, release))
    } else {
      send(encodeX10(button, cell, release))
    }
  }

  const handleMouseDown = (event: MouseEvent): void => {
    if (event.button > MouseButton.Right || event.shiftKey) return
    if (!captureEnabled() || !withinHost(event)) return
    const cell = cellFromEvent(target, event)
    if (!cell) return
    pressed |= 1 << event.button
    lastMotionCell = undefined
    emit(event.button, cell, false, event)
    event.preventDefault()
    event.stopPropagation()
    target.host.querySelector('textarea')?.focus()
  }

  const handleMouseUp = (event: MouseEvent): void => {
    if (event.button > MouseButton.Right || !captureEnabled()) return
    const inside = withinHost(event)
    const wasPressed = (pressed & (1 << event.button)) !== 0
    pressed &= ~(1 << event.button)
    lastMotionCell = undefined
    if (!inside && !wasPressed) return
    const cell = cellFromEvent(target, event)
    if (!cell) return
    emit(event.button, cell, true, event)
    event.preventDefault()
    event.stopPropagation()
  }

  const handleMouseMove = (event: MouseEvent): void => {
    if (!captureEnabled() || event.shiftKey) return
    const dragging = pressed !== 0
    if (!withinHost(event) && !dragging) return
    const buttonMode = target.term.getMode(MODE_BUTTON_EVENT)
    const anyMode = target.term.getMode(MODE_ANY_EVENT)
    if (!buttonMode && !anyMode) {
      if (dragging) {
        event.preventDefault()
        event.stopPropagation()
      }
      return
    }
    if (buttonMode && !anyMode && !dragging) return
    const cell = cellFromEvent(target, event)
    if (!cell) return
    if (lastMotionCell && lastMotionCell.col === cell.col && lastMotionCell.row === cell.row) {
      return
    }
    lastMotionCell = cell
    let button = MOTION_INDICATOR
    if (pressed & (1 << MouseButton.Middle)) button += 1
    else if (pressed & (1 << MouseButton.Right)) button += 2
    emit(button, cell, false, event)
    event.preventDefault()
  }

  const handleWheel = (event: WheelEvent): void => {
    if (!captureEnabled() || !withinHost(event)) return
    const cell = cellFromEvent(target, event)
    if (!cell) return
    const button =
      event.deltaY < 0
        ? WheelButton.Up
        : event.deltaY > 0
          ? WheelButton.Down
          : event.deltaX < 0
            ? WheelButton.Left
            : WheelButton.Right
    emit(button, cell, false, event)
    event.preventDefault()
    event.stopPropagation()
  }

  const suppressCaptureGesture = (event: Event): void => {
    if (!captureEnabled()) return
    const mouse = event as MouseEvent
    if (!withinHost(mouse)) return
    event.preventDefault()
    event.stopPropagation()
  }

  const options: AddEventListenerOptions = { capture: true }
  document.addEventListener('mousedown', handleMouseDown, options)
  document.addEventListener('mouseup', handleMouseUp, options)
  document.addEventListener('mousemove', handleMouseMove, options)
  document.addEventListener('wheel', handleWheel, options)
  document.addEventListener('click', suppressCaptureGesture, options)
  document.addEventListener('dblclick', suppressCaptureGesture, options)
  document.addEventListener('contextmenu', suppressCaptureGesture, options)

  return () => {
    disposed = true
    document.removeEventListener('mousedown', handleMouseDown, options)
    document.removeEventListener('mouseup', handleMouseUp, options)
    document.removeEventListener('mousemove', handleMouseMove, options)
    document.removeEventListener('wheel', handleWheel, options)
    document.removeEventListener('click', suppressCaptureGesture, options)
    document.removeEventListener('dblclick', suppressCaptureGesture, options)
    document.removeEventListener('contextmenu', suppressCaptureGesture, options)
  }
}
