/**
 * The Agent Client Protocol (ACP) wire vocabulary.
 *
 * ACP is newline-delimited JSON-RPC 2.0 between a client (CodeInOven) and an
 * agent process. This module is types and narrowings only: no I/O, no state,
 * so both the transport and the turn fold can share it without a cycle.
 *
 * Shapes follow the schema the installed agents ship (verified against the
 * schema embedded in `cline 3.0.61`, `session/*` + `fs/*` method set).
 */

/** JSON-RPC id: ACP allows a string or a number. */
export type AcpRequestId = string | number

export interface AcpRequestMessage {
  jsonrpc: '2.0'
  id: AcpRequestId
  method: string
  params?: unknown
}

export interface AcpNotificationMessage {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export interface AcpErrorObject {
  code: number
  message: string
  data?: unknown
}

export type AcpResponseMessage =
  | { jsonrpc: '2.0'; id: AcpRequestId; result: unknown }
  | { jsonrpc: '2.0'; id: AcpRequestId; error: AcpErrorObject }

/** JSON-RPC error for a client-side handler that is not implemented. */
export const ACP_METHOD_NOT_FOUND = -32601

/** ACP client capabilities we advertise to the agent. */
export interface AcpClientCapabilities {
  fs: { readTextFile: boolean; writeTextFile: boolean }
  terminal: boolean
  auth: { terminal: boolean }
}

export interface AcpInitializeParams {
  protocolVersion: number
  clientCapabilities: AcpClientCapabilities
  clientInfo: { name: string; title?: string; version?: string }
}

export interface AcpAgentCapabilities {
  loadSession: boolean
  promptCapabilities: AcpPromptCapabilities
}

/** Binary prompt blocks the agent accepts, from its `initialize` capabilities. */
export interface AcpPromptCapabilities {
  image: boolean
  audio: boolean
  embeddedContext: boolean
}

export interface AcpInitializeResult {
  protocolVersion: number
  agentCapabilities: AcpAgentCapabilities
  agentInfo?: { name: string; title?: string; version?: string }
}

/**
 * One MCP server handed to the agent at `session/new`.
 *
 * ACP asks the agent to launch stdio servers itself, so the app's own gateway
 * (a stdio MCP bridge over the turn's loopback endpoint) reaches an ACP agent
 * the same way a user's MCP utility does. Env and headers travel as name/value
 * pairs, which is the shape the protocol defines.
 */
export type AcpMcpServer =
  | {
      name: string
      command: string
      args?: string[]
      env?: { name: string; value: string }[]
    }
  | {
      name: string
      type: 'http' | 'sse'
      url: string
      headers?: { name: string; value: string }[]
    }

export interface AcpNewSessionParams {
  cwd: string
  mcpServers: readonly AcpMcpServer[]
}

export interface AcpModelOption {
  modelId: string
  name: string
  description?: string
}

export interface AcpSessionModels {
  availableModels: readonly AcpModelOption[]
  currentModelId?: string
}

export interface AcpSessionModeOption {
  id: string
  name: string
  description?: string
}

export interface AcpSessionModes {
  availableModes: readonly AcpSessionModeOption[]
  currentModeId?: string
}

/** One selectable value the agent exposes as a session config option. */
export interface AcpConfigSelectOption {
  name: string
  value: string
  description?: string
}

export interface AcpConfigOption {
  id: string
  name: string
  description?: string
  category?: string
  type: 'select' | 'boolean'
  currentValue: string | boolean
  options?: readonly AcpConfigSelectOption[]
}

export interface AcpNewSessionResult {
  sessionId: string
  models?: AcpSessionModels
  modes?: AcpSessionModes
  configOptions?: readonly AcpConfigOption[]
}

/** ACP content blocks. */
export type AcpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string; uri?: string }
  | { type: 'audio'; data: string; mimeType: string }
  | {
      type: 'resource_link'
      uri: string
      name: string
      mimeType?: string
      description?: string
      size?: number
      title?: string
    }
  | {
      type: 'resource'
      resource:
        | { text: string; uri: string; mimeType?: string }
        | { blob: string; mimeType: string; uri: string }
    }

export interface AcpPromptParams {
  sessionId: string
  prompt: readonly AcpContentBlock[]
}

export type AcpStopReason =
  'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled'

export interface AcpPromptUsage {
  inputTokens?: number
  outputTokens?: number
  thoughtTokens?: number
  totalTokens?: number
  cachedReadTokens?: number
  cachedWriteTokens?: number
}

export interface AcpPromptResult {
  stopReason: AcpStopReason
  usage?: AcpPromptUsage
}

export type AcpPermissionOptionKind =
  'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'

export interface AcpPermissionOption {
  optionId: string
  name: string
  kind: AcpPermissionOptionKind
}

export type AcpToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

export type AcpToolCallKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other'

export type AcpToolCallContent =
  | { type: 'content'; content: AcpContentBlock }
  | { type: 'diff'; path: string; oldText?: string; newText: string }
  | { type: 'terminal'; terminalId: string }

export interface AcpToolCall {
  toolCallId: string
  title?: string
  kind?: AcpToolCallKind
  status?: AcpToolCallStatus
  rawInput?: unknown
  rawOutput?: unknown
  content?: readonly AcpToolCallContent[]
  locations?: readonly { path: string; line?: number }[]
}

export interface AcpToolCallUpdate {
  toolCallId: string
  title?: string | null
  kind?: AcpToolCallKind | null
  status?: AcpToolCallStatus | null
  rawInput?: unknown
  rawOutput?: unknown
  content?: readonly AcpToolCallContent[] | null
  locations?: readonly { path: string; line?: number }[] | null
}

export interface AcpRequestPermissionParams {
  sessionId: string
  toolCall: AcpToolCallUpdate
  options: readonly AcpPermissionOption[]
}

export type AcpRequestPermissionResult =
  { outcome: 'cancelled' } | { outcome: 'selected'; optionId: string }

/**
 * What a client answers `session/request_permission` with: the outcome nested
 * under `outcome`. Agents read `response.outcome.optionId`, so a flat answer
 * reaches them as an unknown option.
 */
export interface AcpRequestPermissionResponse {
  outcome: AcpRequestPermissionResult
}

/** One `session/update` payload. */
export type AcpSessionUpdate =
  | { sessionUpdate: 'user_message_chunk'; content: AcpContentBlock; messageId?: string }
  | { sessionUpdate: 'agent_message_chunk'; content: AcpContentBlock; messageId?: string }
  | { sessionUpdate: 'agent_thought_chunk'; content: AcpContentBlock; messageId?: string }
  | {
      sessionUpdate: 'tool_call'
      toolCallId: string
      title: string
      kind?: AcpToolCallKind
      status?: AcpToolCallStatus
      rawInput?: unknown
      rawOutput?: unknown
      content?: readonly AcpToolCallContent[]
      locations?: readonly { path: string; line?: number }[]
    }
  | ({ sessionUpdate: 'tool_call_update' } & AcpToolCallUpdate)
  | {
      sessionUpdate: 'plan'
      entries: readonly {
        content: string
        priority: 'high' | 'medium' | 'low'
        status: 'pending' | 'in_progress' | 'completed'
      }[]
    }
  | {
      sessionUpdate: 'available_commands_update'
      availableCommands: readonly { name: string; description: string; input?: { hint: string } }[]
    }
  | { sessionUpdate: 'current_mode_update'; currentModeId: string }
  | { sessionUpdate: 'config_option_update'; configOptions: readonly AcpConfigOption[] }
  | { sessionUpdate: 'session_info_update'; title?: string | null; updatedAt?: string | null }
  | {
      sessionUpdate: 'usage_update'
      used: number
      size: number
      cost?: { amount: number; currency: string } | null
    }

/** Narrowing helpers shared by every ACP unit. */
export function acpRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function acpString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function acpNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function acpArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** Read the `sessionId` of a `session/update` notification payload. */
export function acpSessionIdOf(params: unknown): string | undefined {
  return acpString(acpRecord(params)?.['sessionId'])
}
