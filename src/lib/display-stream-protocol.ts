import type { DisplayControlAction, DisplayInputKey } from './ipc/display'

/**
 * What a live device stream says over its message port.
 *
 * A mirrored device is a video stream with a touch channel beside it. Both travel
 * on one `MessagePort` between the stream's utility process and the renderer, so
 * no frame and no pointer event ever passes through the main process. The messages
 * are plain structured-clone data: nothing here imports Electron or the renderer.
 */

export type StreamPhase = 'starting' | 'live' | 'ended'

/** The decoder settings for what follows. Sent first, and again after a rotation. */
export interface StreamConfigMessage {
  type: 'config'
  /** The WebCodecs codec string, read from the stream's own SPS. */
  codec: string
  width: number
  height: number
}

/** One H.264 access unit in Annex B form, with the parameter sets in front of a key frame. */
export interface StreamChunkMessage {
  type: 'chunk'
  key: boolean
  timestampUs: number
  data: ArrayBuffer
}

export interface StreamStateMessage {
  type: 'state'
  phase: StreamPhase
  detail?: string
}

export type StreamOutbound = StreamConfigMessage | StreamChunkMessage | StreamStateMessage

export type StreamPointerAction = 'down' | 'move' | 'up' | 'cancel'

/** A pointer position as a fraction of the picture, the convention of `DisplayInputGesture`. */
export interface StreamPointerMessage {
  type: 'pointer'
  action: StreamPointerAction
  x: number
  y: number
}

export interface StreamKeyMessage {
  type: 'key'
  key: DisplayInputKey
}

export interface StreamTextMessage {
  type: 'text'
  text: string
}

export interface StreamScrollMessage {
  type: 'scroll'
  x: number
  y: number
  dx: number
  dy: number
}

export interface StreamControlMessage {
  type: 'control'
  action: DisplayControlAction
}

/** The renderer gives up on a stream it cannot decode, so the panel can fall back. */
export interface StreamAbortMessage {
  type: 'abort'
  reason: string
}

export type StreamInbound =
  | StreamPointerMessage
  | StreamKeyMessage
  | StreamTextMessage
  | StreamScrollMessage
  | StreamControlMessage
  | StreamAbortMessage

/** The one message the main process sends a stream host, beside its port. */
export interface StreamStartMessage {
  type: 'start'
  kind: 'android'
  serial: string
  adb: string
  serverPath: string
  /** The longest edge the encoder may produce, in pixels. */
  maxSize: number
}

/** Posted to the renderer with the port: which session the port belongs to. */
export interface StreamPortAnnouncement {
  sessionId: string
}

/** The window message name the preload uses to hand a port to the page. */
export const DISPLAY_STREAM_PORT_MESSAGE = 'cio-display-stream-port'

const POINTER_ACTIONS: readonly string[] = ['down', 'move', 'up', 'cancel']
const INPUT_KEYS: readonly string[] = [
  'enter',
  'backspace',
  'tab',
  'escape',
  'up',
  'down',
  'left',
  'right'
]
const CONTROL_ACTIONS: readonly string[] = [
  'home',
  'back',
  'recents',
  'volume-up',
  'volume-down',
  'power',
  'appearance'
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isFraction(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

export function isStreamInbound(value: unknown): value is StreamInbound {
  if (!isRecord(value)) return false
  switch (value.type) {
    case 'pointer':
      return (
        typeof value.action === 'string' &&
        POINTER_ACTIONS.includes(value.action) &&
        isFraction(value.x) &&
        isFraction(value.y)
      )
    case 'key':
      return typeof value.key === 'string' && INPUT_KEYS.includes(value.key)
    case 'text':
      return typeof value.text === 'string' && value.text.length > 0 && value.text.length <= 256
    case 'scroll':
      return (
        isFraction(value.x) &&
        isFraction(value.y) &&
        typeof value.dx === 'number' &&
        Number.isFinite(value.dx) &&
        typeof value.dy === 'number' &&
        Number.isFinite(value.dy)
      )
    case 'control':
      return typeof value.action === 'string' && CONTROL_ACTIONS.includes(value.action)
    case 'abort':
      return typeof value.reason === 'string'
    default:
      return false
  }
}

export function isStreamStart(value: unknown): value is StreamStartMessage {
  return (
    isRecord(value) &&
    value.type === 'start' &&
    value.kind === 'android' &&
    typeof value.serial === 'string' &&
    typeof value.adb === 'string' &&
    typeof value.serverPath === 'string' &&
    typeof value.maxSize === 'number' &&
    Number.isFinite(value.maxSize)
  )
}

export function isStreamOutbound(value: unknown): value is StreamOutbound {
  if (!isRecord(value)) return false
  switch (value.type) {
    case 'config':
      return (
        typeof value.codec === 'string' &&
        typeof value.width === 'number' &&
        typeof value.height === 'number'
      )
    case 'chunk':
      return (
        typeof value.key === 'boolean' &&
        typeof value.timestampUs === 'number' &&
        value.data instanceof ArrayBuffer
      )
    case 'state':
      return value.phase === 'starting' || value.phase === 'live' || value.phase === 'ended'
    default:
      return false
  }
}
