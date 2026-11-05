import { permissionPatterns } from '../../../lib/agent-interactions'
import type { PermissionReply, PermissionRequest } from '../../../lib/types'
import { PermissionRequestGoneError } from '../driver.interface'
import {
  acpArray,
  acpRecord,
  acpString,
  type AcpPermissionOption,
  type AcpPermissionOptionKind,
  type AcpRequestPermissionParams,
  type AcpRequestPermissionResponse,
  type AcpToolCallKind
} from './acp-protocol'

/** One `session/request_permission` awaiting the user's decision. */
export interface AcpPendingPermission {
  requestId: string
  sessionId: string
  options: readonly AcpPermissionOption[]
  settle: (response: AcpRequestPermissionResponse) => void
}

/** Map an ACP tool kind onto the app's provider-neutral permission category. */
export function acpPermissionCategory(
  kind: AcpToolCallKind | undefined,
  title: string | undefined
): string {
  switch (kind) {
    case 'execute':
      return 'bash'
    case 'edit':
    case 'delete':
    case 'move':
      return 'write'
    case 'read':
    case 'search':
      return 'read'
    case 'fetch':
      return 'network'
    case 'switch_mode':
      return 'mode'
    default:
      break
  }
  const word = /^[a-z0-9_-]+/iu.exec((title ?? '').trim())?.[0]
  return word ? word.toLowerCase() : 'tool'
}

function optionKind(value: unknown): AcpPermissionOptionKind | null {
  switch (value) {
    case 'allow_once':
    case 'allow_always':
    case 'reject_once':
    case 'reject_always':
      return value
    default:
      return null
  }
}

/** Parse the option list of a permission request, dropping entries we cannot answer with. */
export function acpPermissionOptions(params: unknown): AcpPermissionOption[] {
  const options: AcpPermissionOption[] = []
  for (const entry of acpArray(acpRecord(params)?.['options'])) {
    const record = acpRecord(entry)
    if (!record) continue
    const optionId = acpString(record['optionId'])
    const kind = optionKind(record['kind'])
    if (!optionId || !kind) continue
    options.push({ optionId, kind, name: acpString(record['name']) ?? kind })
  }
  return options
}

/**
 * Translate one agent permission request into the app's card payload.
 *
 * The tool call's own `rawInput` supplies the paths and commands the app's
 * policy evaluates, so a command the user should see never arrives without the
 * string it will run.
 */
export function acpPermissionRequest(
  params: AcpRequestPermissionParams,
  requestId: string
): PermissionRequest {
  const toolCall = acpRecord(params.toolCall) ?? {}
  const input = acpRecord(toolCall['rawInput']) ?? {}
  const title = acpString(toolCall['title'])
  const kind = acpString(toolCall['kind']) as AcpToolCallKind | undefined
  return {
    id: requestId,
    sessionId: params.sessionId,
    permission: acpPermissionCategory(kind, title),
    patterns: permissionPatterns(input),
    metadata: {
      tool: acpString(toolCall['toolCallId']) ?? requestId,
      input,
      ...(title ? { title } : {}),
      ...(kind ? { kind } : {}),
      ...(params.options.length > 0 ? { options: params.options.map((option) => option.kind) } : {})
    }
  }
}

/**
 * Pick the option that expresses the user's reply.
 *
 * ACP separates "once" from "always" on both sides, so a card answered "always"
 * chooses the persistent option when the agent offers one and otherwise falls
 * back to the single-shot one rather than failing the request.
 */
export function acpReplyOptionId(
  options: readonly AcpPermissionOption[],
  reply: PermissionReply
): string {
  const wanted: AcpPermissionOptionKind[] =
    reply === 'reject'
      ? ['reject_once', 'reject_always']
      : reply === 'always'
        ? ['allow_always', 'allow_once']
        : ['allow_once', 'allow_always']
  for (const kind of wanted) {
    const match = options.find((option) => option.kind === kind)
    if (match) return match.optionId
  }
  const fallback = options[0]
  return fallback?.optionId ?? (reply === 'reject' ? 'reject_once' : 'allow_once')
}

/** Bookkeeping for every permission the driver has surfaced and not yet answered. */
export class AcpPermissionRegistry {
  private readonly pending = new Map<string, AcpPendingPermission>()
  private sequence = 0

  constructor(private readonly driverName: string) {}

  /**
   * Register a new request. The returned decision resolves when the user's reply
   * arrives, so the agent's request stays blocked on the protocol until then.
   */
  open(params: AcpRequestPermissionParams): {
    requestId: string
    request: PermissionRequest
    decision: Promise<AcpRequestPermissionResponse>
  } {
    this.sequence += 1
    const requestId = `acp:${params.sessionId}:${params.toolCall.toolCallId || this.sequence}`
    const options = acpPermissionOptions(params)
    const decision = new Promise<AcpRequestPermissionResponse>((resolve) => {
      this.pending.set(requestId, {
        requestId,
        sessionId: params.sessionId,
        options,
        settle: resolve
      })
    })
    const request = acpPermissionRequest({ ...params, options }, requestId)
    return { requestId, request, decision }
  }

  /** Answer a pending request with the option matching the user's reply. */
  reply(requestId: string, reply: PermissionReply): AcpRequestPermissionResponse {
    const entry = this.pending.get(requestId)
    if (!entry) throw new PermissionRequestGoneError(undefined, requestId, this.driverName)
    this.pending.delete(requestId)
    const response: AcpRequestPermissionResponse = {
      outcome: { outcome: 'selected', optionId: acpReplyOptionId(entry.options, reply) }
    }
    entry.settle(response)
    return response
  }

  /** Cancel every pending request, e.g. when the agent process goes away. */
  cancelAll(): void {
    for (const entry of this.pending.values()) entry.settle({ outcome: { outcome: 'cancelled' } })
    this.pending.clear()
  }

  has(requestId: string): boolean {
    return this.pending.has(requestId)
  }

  ids(): string[] {
    return [...this.pending.keys()]
  }
}
