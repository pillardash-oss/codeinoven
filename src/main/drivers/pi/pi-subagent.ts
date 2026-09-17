import type { AgentPart, AgentSubagentActivity, AgentToolStatus } from '../../../lib/types'
import { parseRecord } from '../../../lib/agent-interactions'
import { CIO_SPAWN_AGENT_TOOL_NAME, CIO_SUBAGENT_DONE_MESSAGE_TYPE } from '../../../lib/core-tools'
import { CIO_SUBAGENT_MARKER } from '../pi-core-tools-extension'
import type { CliLineParseResult } from '../persistent-cli-driver'
import type { PiStreamContext } from './pi-stream-types'
import { record, stringValue } from './pi-values'

/** Sub-agent activity part construction and `cio-subagent:` payload folding. */

/** Sub-agent lifecycle states that mean the worker is over, whatever its
 *  outcome. Every consumer that closes or merges a card must agree on this set. */
const TERMINAL_SUBAGENT_STATUSES: ReadonlySet<AgentToolStatus> = new Set([
  'completed',
  'error',
  'aborted'
])

/** The extension tool whose calls render as sub-agent activity cards. */
const CIO_SPAWN_TOOL = CIO_SPAWN_AGENT_TOOL_NAME

/** Build a sub-agent activity part for one spawn-tool call. */
function cioSubagentPart(
  messageId: string,
  callID: string,
  input: Record<string, unknown> | null | undefined,
  patch?: Partial<AgentSubagentActivity>
): Extract<AgentPart, { type: 'subagent' }> {
  const purpose = stringValue(input?.['purpose']) ?? 'sub-agent'
  return {
    type: 'subagent',
    id: `pi-subagent-${callID}`,
    messageID: messageId,
    callID,
    activity: {
      status: 'pending',
      agent: purpose,
      description: purpose,
      prompt: stringValue(input?.['instructions']),
      background: input?.['background'] === true,
      ...patch
    }
  }
}

/** Find the running sub-agent part for a spawn call id. */
function findSubagentPart(
  context: PiStreamContext,
  callId: string
): Extract<AgentPart, { type: 'subagent' }> | undefined {
  for (const message of [...context.session.messages].reverse()) {
    const part = message.parts.find(
      (candidate): candidate is Extract<AgentPart, { type: 'subagent' }> =>
        candidate.type === 'subagent' && candidate.callID === callId
    )
    if (part) return part
  }
  return undefined
}

/** Find a sub-agent part by its child session id (spawn call id may be unknown). */
function findSubagentPartByChildSession(
  context: PiStreamContext,
  childSessionId: string | undefined
): Extract<AgentPart, { type: 'subagent' }> | undefined {
  if (!childSessionId) return undefined
  for (const message of [...context.session.messages].reverse()) {
    const part = message.parts.find(
      (candidate): candidate is Extract<AgentPart, { type: 'subagent' }> =>
        candidate.type === 'subagent' && candidate.activity.childSessionId === childSessionId
    )
    if (part) return part
  }
  return undefined
}

/**
 * Activity fields one structured sub-agent payload contributes. Partial on
 * purpose: the immediate spawn acknowledgement carries no `purpose`, and a
 * patch that named the task 'sub-agent' would overwrite the real task type
 * (the spawn tool's own arguments already knew it) for the worker's whole run.
 */
type SubagentActivityPatch = Partial<AgentSubagentActivity>

/**
 * Time range for one sub-agent activity snapshot. Only a terminal worker
 * freezes its end: a background spawn returns immediately from its tool call
 * while the worker keeps running, and stamping an end there would both show a
 * stuck duration and make the card look finished to every terminal-state
 * check in the UI.
 */
function subagentTimeRange(
  base: AgentSubagentActivity,
  status: AgentToolStatus
): AgentSubagentActivity['time'] {
  const start = base.time?.start ?? Date.now()
  // An end that is already recorded is the worker's real finish; a later
  // snapshot of the same terminal state must not stretch the duration.
  return TERMINAL_SUBAGENT_STATUSES.has(status)
    ? { start, end: base.time?.end ?? Date.now() }
    : { start }
}

/**
 * Parse a `cio-subagent:` marker payload (structured sub-agent progress
 * streamed through tool-execution updates) into activity fields.
 */
function parseSubagentPayload(output: string | undefined): SubagentActivityPatch | undefined {
  if (!output || !output.startsWith(CIO_SUBAGENT_MARKER)) return undefined
  return subagentActivityFromPayload(parseRecord(output.slice(CIO_SUBAGENT_MARKER.length)))
}

/** Activity fields from the extension's structured sub-agent payload. */
function subagentActivityFromPayload(
  payload: Record<string, unknown> | undefined
): SubagentActivityPatch | undefined {
  if (!payload || !stringValue(payload['agentId'])) return undefined
  const status = stringValue(payload['status'])
  const purpose = stringValue(payload['purpose'])
  const childSessionId = stringValue(payload['childSessionId'])
  const modelId = stringValue(payload['model'])
  const output = stringValue(payload['output'])
  const error = stringValue(payload['error'])
  const sessionFile = stringValue(payload['sessionFile'])
  const files = Array.isArray(payload['files'])
    ? payload['files'].filter((file): file is string => typeof file === 'string')
    : undefined
  return {
    status: normalizeSubagentStatus(status),
    // Only the payload that names the task may label the card.
    ...(purpose ? { agent: purpose, description: purpose } : {}),
    ...(childSessionId ? { childSessionId } : {}),
    ...(modelId ? { modelId } : {}),
    ...(files && files.length > 0 ? { files } : {}),
    ...(output ? { output } : {}),
    ...(error ? { error } : {}),
    ...(sessionFile ? { metadata: { sessionFile } } : {})
  }
}

/** Lifecycle status reported by a sub-agent payload, defaulting to `pending`
 *  for anything the app does not model. */
function normalizeSubagentStatus(status: string | undefined): AgentToolStatus {
  if (status === 'completed' || status === 'error' || status === 'aborted') return status
  return status === 'running' ? 'running' : 'pending'
}

/**
 * Activity patch for a spawn call whose tool result is a plain failure object
 * (`{ spawned: false, error }`) instead of a `cio-subagent:` marker payload.
 * Failed spawns carry no agentId, so subagentActivityFromPayload skips them  
 * without this patch the driver would mark the card 'completed' with no error,
 * hiding why the sub-agent never ran.
 */
function spawnFailurePatch(output: string | undefined): AgentSubagentActivity | undefined {
  if (!output) return undefined
  const payload = parseRecord(output)
  if (!payload || stringValue(payload['agentId'])) return undefined
  const error = stringValue(payload['error'])
  if (!error) return undefined
  return {
    status: 'error',
    agent: 'sub-agent',
    description: 'sub-agent',
    background: false,
    error
  }
}

/**
 * Close a sub-agent card from the `cio-subagent-done` custom message. Once a
 * background spawn's tool call has returned, pi drops tool-execution updates
 * (`acceptingUpdates` is false after execute resolves), so the extension's
 * terminal marker payload can never arrive through the tool channel and the
 * card would stay "Working" forever. The extension therefore rides the
 * completion notification   a display:false custom message the model still
 * needs for its final output   with the structured payload in `details`.
 */
function spawnDoneCustomEvent(
  message: Record<string, unknown>,
  context: PiStreamContext
): CliLineParseResult | null {
  if (stringValue(message['customType']) !== CIO_SUBAGENT_DONE_MESSAGE_TYPE) {
    return { events: [] }
  }
  const payload = record(message['details']) ?? undefined
  const activity = subagentActivityFromPayload(payload)
  const existing = findSubagentPartByChildSession(context, stringValue(payload?.['childSessionId']))
  if (!activity || !existing) return { events: [] }
  const status: AgentToolStatus = activity.status ?? existing.activity.status
  return {
    events: [
      {
        type: 'message.part.updated',
        sessionId: context.sessionId,
        part: {
          type: 'subagent',
          id: existing.id,
          messageID: existing.messageID,
          callID: existing.callID,
          activity: {
            ...existing.activity,
            ...activity,
            status,
            background: existing.activity.background,
            time: subagentTimeRange(existing.activity, status)
          }
        }
      }
    ]
  }
}

export {
  TERMINAL_SUBAGENT_STATUSES,
  CIO_SPAWN_TOOL,
  cioSubagentPart,
  findSubagentPart,
  findSubagentPartByChildSession,
  subagentTimeRange,
  parseSubagentPayload,
  subagentActivityFromPayload,
  spawnFailurePatch,
  spawnDoneCustomEvent
}
