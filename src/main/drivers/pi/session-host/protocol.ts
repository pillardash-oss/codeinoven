/**
 * Wire protocol for the Pi session host: newline-delimited JSON over stdio.
 *
 * The app owns the session key (its own thread session id); the host keeps one
 * AgentSession per key. Every command carries its target key and every event
 * carries the key it came from, so requests and streams from many sessions can
 * share one pipe.
 *
 * This module deliberately has no Pi SDK imports: the Electron main process
 * imports the protocol without pulling the harness runtime into the app
 * bundle. The host side (see `session-host.ts`) performs the SDK calls.
 */

/** An image attachment on a prompt, mirroring Pi's `ImageContent` shape. */
export interface HostImageContent {
  type: 'image'
  data: string
  mimeType: string
}

/** Create a new session, or resume one from an existing native transcript. */
export interface HostCreateSessionCommand {
  type: 'create_session'
  /** Working directory of the session; also selects the native session dir. */
  cwd: string
  /** The account's Pi agent directory the session belongs to. */
  agentDir: string
  /** Extension modules to load for this session only. */
  extensionPaths?: string[]
  /** Resume this native transcript instead of starting a fresh session. */
  sessionPath?: string
  /** Tool allowlist; omitted means Pi's default selection. */
  tools?: string[]
  /** Initial model, resolved against the session's own model runtime. */
  model?: { provider: string; id: string }
}

export type HostCommand =
  | HostCreateSessionCommand
  | { type: 'prompt'; message: string; images?: HostImageContent[] }
  | { type: 'steer'; message: string; images?: HostImageContent[] }
  | { type: 'follow_up'; message: string }
  | { type: 'abort' }
  | { type: 'dispose_session' }
  | { type: 'get_state' }
  | { type: 'get_messages' }
  | { type: 'list_sessions' }

/** One command line from the app to the host. */
export interface HostRequestEnvelope {
  type: 'request'
  id: string
  /** Target session. Absent only for host-level commands (`list_sessions`). */
  sessionId?: string
  command: HostCommand
}

export type HostResponseEnvelope =
  | { type: 'response'; id: string; sessionId?: string; ok: true; data?: unknown }
  | { type: 'response'; id: string; sessionId?: string; ok: false; error: string }

/** An unsolicited host-level message, such as a background turn failure. */
export interface HostNoticeEnvelope {
  type: 'host_notice'
  sessionId?: string
  level: 'info' | 'error'
  message: string
}

/** One session event, carrying the SDK event payload unchanged. */
export interface HostEventEnvelope {
  type: 'event'
  sessionId: string
  event: unknown
}

export type HostLine =
  HostRequestEnvelope | HostResponseEnvelope | HostEventEnvelope | HostNoticeEnvelope

/** Snapshot of one hosted session; mirrors what the app needs per thread. */
export interface HostSessionState {
  sessionId: string
  nativeSessionId: string
  sessionFile?: string
  cwd: string
  model?: { provider: string; id: string }
  thinkingLevel: string
  isStreaming: boolean
  isCompacting: boolean
  messageCount: number
  pendingMessageCount: number
}

export interface HostSessionListEntry {
  sessionId: string
  nativeSessionId: string
  cwd: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function stringArrayField(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key]
  if (!Array.isArray(value)) return undefined
  const items: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return undefined
    items.push(item)
  }
  return items
}

function imagesField(record: Record<string, unknown>, key: string): HostImageContent[] | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return undefined
  const images: HostImageContent[] = []
  for (const item of value) {
    if (!isRecord(item)) return undefined
    const data = stringField(item, 'data')
    const mimeType = stringField(item, 'mimeType')
    if (item['type'] !== 'image' || data === undefined || mimeType === undefined) return undefined
    images.push({ type: 'image', data, mimeType })
  }
  return images
}

function modelField(
  record: Record<string, unknown>,
  key: string
): { provider: string; id: string } | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (!isRecord(value)) return undefined
  const provider = stringField(value, 'provider')
  const id = stringField(value, 'id')
  if (provider === undefined || id === undefined) return undefined
  return { provider, id }
}

/** Validate and narrow one parsed command object. */
function parseHostCommand(value: Record<string, unknown>): HostCommand | null {
  const type = value['type']
  switch (type) {
    case 'create_session': {
      const cwd = stringField(value, 'cwd')
      const agentDir = stringField(value, 'agentDir')
      if (cwd === undefined || agentDir === undefined) return null
      const extensionPaths = stringArrayField(value, 'extensionPaths')
      const sessionPath = stringField(value, 'sessionPath')
      const tools = stringArrayField(value, 'tools')
      const model = modelField(value, 'model')
      return {
        type,
        cwd,
        agentDir,
        ...(extensionPaths === undefined ? {} : { extensionPaths }),
        ...(sessionPath === undefined ? {} : { sessionPath }),
        ...(tools === undefined ? {} : { tools }),
        ...(model === undefined ? {} : { model })
      }
    }
    case 'prompt':
    case 'steer': {
      const message = stringField(value, 'message')
      if (message === undefined) return null
      const images = imagesField(value, 'images')
      return { type, message, ...(images === undefined ? {} : { images }) }
    }
    case 'follow_up': {
      const message = stringField(value, 'message')
      return message === undefined ? null : { type, message }
    }
    case 'abort':
    case 'dispose_session':
    case 'get_state':
    case 'get_messages':
    case 'list_sessions':
      return { type }
    default:
      return null
  }
}

/** Parse one request line; returns null for anything malformed. */
export function parseHostRequestLine(line: string): HostRequestEnvelope | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (!isRecord(value) || value['type'] !== 'request') return null
  const id = stringField(value, 'id')
  if (id === undefined) return null
  const sessionId = stringField(value, 'sessionId')
  const command = value['command']
  if (!isRecord(command)) return null
  const parsed = parseHostCommand(command)
  if (parsed === null) return null
  return { type: 'request', id, ...(sessionId === undefined ? {} : { sessionId }), command: parsed }
}
