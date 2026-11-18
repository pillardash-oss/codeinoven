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

/** Reasoning effort a session starts on. Kept local so the protocol stays self-contained. */
export type HostThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

const HOST_THINKING_LEVELS: readonly HostThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]

/** Create a new session, or resume one from an existing native transcript. */
export interface HostCreateSessionCommand {
  type: 'create_session'
  /** Working directory of the session; also selects the native session dir. */
  cwd: string
  /**
   * The account's Pi agent directory the session belongs to.
   *
   * Omitted when the account does not name one, which is an ordinary state for
   * a not-yet-configured account. The host then uses Pi's own default
   * (`~/.pi/agent`), exactly as the CLI would.
   */
  agentDir?: string
  /** Extension modules to load for this session only. */
  extensionPaths?: string[]
  /** Resume this native transcript instead of starting a fresh session. */
  sessionPath?: string
  /** Tool allowlist; omitted means Pi's default selection. */
  tools?: string[]
  /** Initial model, resolved against the session's own model runtime. */
  model?: { provider: string; id: string }
  /** Initial reasoning effort, resolved against the session's own model runtime. */
  thinkingLevel?: HostThinkingLevel
  /** Set for a sub-agent session: the session that spawned it. */
  parentSessionId?: string
  /**
   * Environment this session's extensions, model runtime and tools read.
   *
   * The CLI path hands the child process an environment built from the account
   * (provider keys, an isolated agent directory) and the custom-provider keys.
   * A hosted session has no child of its own, so that environment travels with
   * the session instead and the host applies it before building its services.
   * Never logged, never echoed back.
   */
  sessionEnv?: Record<string, string>
  /**
   * Bind the host's dialog context so extension questions reach the app.
   *
   * Off by default and on for the app's own sessions: binding needs the SDK's
   * interactive theme, which only exists once the extension runtime has one.
   */
  dialogs?: boolean
}

export type HostCommand =
  | HostCreateSessionCommand
  | { type: 'prompt'; message: string; images?: HostImageContent[] }
  | { type: 'steer'; message: string; images?: HostImageContent[] }
  | { type: 'follow_up'; message: string }
  | { type: 'abort' }
  /** Start a fresh native session in the same hosted session. */
  | { type: 'new_session' }
  /** Continue from an existing transcript, exactly like pi's `switch_session`. */
  | { type: 'switch_session'; sessionPath: string }
  /** Compact the hosted session's context now. */
  | { type: 'compact'; instructions?: string }
  /** Switch the model the session runs on. */
  | { type: 'set_model'; provider: string; modelId: string }
  /** Switch the reasoning effort the session runs at. */
  | { type: 'set_thinking_level'; level: HostThinkingLevel }
  /** Turn the SDK's automatic compaction on or off for this session. */
  | { type: 'set_auto_compaction'; enabled: boolean }
  /** Turn the SDK's automatic retry on or off for this session. */
  | { type: 'set_auto_retry'; enabled: boolean }
  /** Answer a dialog the host forwarded. The host never decides for the user. */
  | { type: 'ui_response'; requestId: string; response: HostUiResponse }
  | { type: 'dispose_session' }
  | { type: 'get_state' }
  /** Context usage, in the shape the app's usage panel reads. */
  | { type: 'get_session_stats' }
  /** Every model this account can start a session on. */
  | { type: 'get_available_models' }
  /** Slash commands; a hosted session exposes none yet, and answers an empty list. */
  | { type: 'get_commands' }
  | { type: 'get_messages' }
  | { type: 'list_sessions' }

/** One dialog a hosted session is blocked on. The app renders and answers it. */
export type HostUiResponse = { cancelled: true } | { value: string } | { confirmed: boolean }

export type HostUiRequest =
  | { id: string; method: 'select'; title: string; options: string[]; timeout: number | undefined }
  | { id: string; method: 'confirm'; title: string; message: string; timeout: number | undefined }
  | {
      id: string
      method: 'input'
      title: string
      placeholder: string | undefined
      timeout: number | undefined
    }
  | { id: string; method: 'editor'; title: string; prefill: string | undefined }
  | {
      id: string
      method: 'notify'
      message: string
      notifyType: 'info' | 'warning' | 'error' | undefined
    }
  | { id: string; method: 'setStatus'; statusKey: string; statusText: string | undefined }

export interface HostUiRequestEnvelope {
  type: 'ui_request'
  sessionId: string
  request: HostUiRequest
}

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
  /** The account directory the session runs under, so it can move to another host. */
  agentDir: string
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

function stringRecordField(
  record: Record<string, unknown>,
  key: string
): Record<string, string> | undefined {
  const value = record[key]
  if (!isRecord(value)) return undefined
  const entries: Record<string, string> = {}
  for (const [name, item] of Object.entries(value)) {
    if (typeof item !== 'string') return undefined
    entries[name] = item
  }
  return entries
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

/** Validate one dialog answer: cancelled, a value, or a confirmation. */
function uiResponseField(record: Record<string, unknown>, key: string): HostUiResponse | undefined {
  const value = record[key]
  if (!isRecord(value)) return undefined
  if (value['cancelled'] === true) return { cancelled: true }
  const confirmed = value['confirmed']
  if (typeof confirmed === 'boolean') return { confirmed }
  const text = value['value']
  if (typeof text === 'string') return { value: text }
  return undefined
}

function thinkingLevelField(record: Record<string, unknown>): HostThinkingLevel | undefined {
  const value = record['thinkingLevel']
  if (typeof value !== 'string') return undefined
  return HOST_THINKING_LEVELS.find((level) => level === value)
}

/**
 * The level the `set_thinking_level` command carries.
 *
 * The command names the field `level` because the SDK setter does; a create
 * request names it `thinkingLevel` because that is the field of the session
 * options. Both spellings are accepted here so a hand-written probe and the
 * app client cannot disagree about the wire format.
 */
function levelField(record: Record<string, unknown>): HostThinkingLevel | undefined {
  const value = record['level'] ?? record['thinkingLevel']
  if (typeof value !== 'string') return undefined
  return HOST_THINKING_LEVELS.find((level) => level === value)
}

function booleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key]
  return typeof value === 'boolean' ? value : undefined
}

/** Validate and narrow one parsed command object. */
function parseHostCommand(value: Record<string, unknown>): HostCommand | null {
  const type = value['type']
  switch (type) {
    case 'create_session': {
      const cwd = stringField(value, 'cwd')
      if (cwd === undefined) return null
      const agentDir = stringField(value, 'agentDir')
      const extensionPaths = stringArrayField(value, 'extensionPaths')
      const sessionPath = stringField(value, 'sessionPath')
      const tools = stringArrayField(value, 'tools')
      const model = modelField(value, 'model')
      const thinkingLevel = thinkingLevelField(value)
      const dialogs = value['dialogs'] === true
      const parentSessionId = stringField(value, 'parentSessionId')
      const sessionEnv = stringRecordField(value, 'sessionEnv')
      return {
        type,
        cwd,
        ...(sessionEnv === undefined ? {} : { sessionEnv }),
        ...(agentDir === undefined ? {} : { agentDir }),
        ...(extensionPaths === undefined ? {} : { extensionPaths }),
        ...(sessionPath === undefined ? {} : { sessionPath }),
        ...(tools === undefined ? {} : { tools }),
        ...(model === undefined ? {} : { model }),
        ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
        ...(dialogs ? { dialogs } : {}),
        ...(parentSessionId === undefined ? {} : { parentSessionId })
      }
    }
    case 'set_model': {
      const provider = stringField(value, 'provider')
      const modelId = stringField(value, 'modelId')
      if (provider === undefined || modelId === undefined) return null
      return { type, provider, modelId }
    }
    case 'set_thinking_level': {
      const level = levelField(value)
      if (level === undefined) return null
      return { type, level }
    }
    case 'set_auto_compaction':
    case 'set_auto_retry': {
      const enabled = booleanField(value, 'enabled')
      if (enabled === undefined) return null
      return { type, enabled }
    }
    case 'get_session_stats':
    case 'get_available_models':
    case 'get_commands':
      return { type }
    case 'new_session':
      return { type }
    case 'switch_session': {
      const sessionPath = stringField(value, 'sessionPath')
      if (sessionPath === undefined) return null
      return { type, sessionPath }
    }
    case 'compact': {
      const instructions = stringField(value, 'instructions')
      return { type, ...(instructions === undefined ? {} : { instructions }) }
    }
    case 'ui_response': {
      const requestId = stringField(value, 'requestId')
      const response = uiResponseField(value, 'response')
      if (requestId === undefined || response === undefined) return null
      return { type, requestId, response }
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
  const parsed = parseHostLine(line)
  return parsed.status === 'request' ? parsed.request : null
}

/**
 * What one input line means: a command to run, or a rejection to answer.
 *
 * A rejection is answered instead of dropped, and it carries the request id
 * whenever the line named one. A dropped line left the caller waiting for the
 * full request timeout, which is ten minutes in the app, so an unknown command
 * looked exactly like a hung host. Answering in milliseconds turns it into an
 * ordinary failed request that the driver can surface.
 */
export type HostLineParse =
  | { status: 'request'; request: HostRequestEnvelope }
  | { status: 'rejected'; id: string | null; sessionId: string | null; error: string }

export function parseHostLine(line: string): HostLineParse {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return { status: 'rejected', id: null, sessionId: null, error: 'Unparseable request line' }
  }
  if (!isRecord(value) || value['type'] !== 'request') {
    return { status: 'rejected', id: null, sessionId: null, error: 'Unparseable request line' }
  }
  const id = stringField(value, 'id') ?? null
  const sessionId = stringField(value, 'sessionId') ?? null
  if (id === null) {
    return { status: 'rejected', id: null, sessionId, error: 'Request has no id' }
  }
  const command = value['command']
  if (!isRecord(command)) {
    return { status: 'rejected', id, sessionId, error: 'Request has no command' }
  }
  const parsed = parseHostCommand(command)
  if (parsed === null) {
    const type = stringField(command, 'type') ?? 'unknown'
    return { status: 'rejected', id, sessionId, error: `Unsupported command: ${type}` }
  }
  return {
    status: 'request',
    request: {
      type: 'request',
      id,
      ...(sessionId === null ? {} : { sessionId }),
      command: parsed
    }
  }
}
