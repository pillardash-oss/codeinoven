import type { AgentEvent, AgentQuestion, PermissionReply } from '../../../lib/types'
import { normalizeAgentQuestions } from '../../../lib/agent-interactions'
import { Logger } from '../../system/logger'
import { PermissionRequestGoneError, QuestionRequestGoneError } from '../driver.interface'
import type { PiRpcClient } from '../pi-rpc-client'
import { permissionMarkerPayload, questionMarkerPayload } from './pi-ui-markers'
import { stringValue } from './pi-values'

interface PiUiRequest {
  sessionId: string
  method: string
  client: PiRpcClient
  request: Record<string, unknown>
}

/** Everything the dialog board needs from the driver. */
export interface PiUiRequestHost {
  readonly name: string
  rpcClient(sessionId: string): PiRpcClient | undefined
  emitEvent(event: AgentEvent): void
}

/**
 * Pi's dialog channel: pending permission and question cards, and the replies
 * that settle them.
 *
 * Pi has no structured question RPC method. The core-tools extension sends one
 * tagged envelope through the dialog channel and the board unwraps it into the
 * shared question contract; a plain `confirm`/`input`/`select` record becomes a
 * question card in the same contract.
 */
export class PiUiRequestBoard {
  private readonly pendingUiRequests = new Map<string, PiUiRequest>()

  constructor(private readonly host: PiUiRequestHost) {}

  handleUiRequest(record: Record<string, unknown>, sessionId: string): void {
    const rawId = record['id']
    const method = stringValue(record['method'])
    const client = this.host.rpcClient(sessionId)
    if ((typeof rawId !== 'string' && typeof rawId !== 'number') || !method || !client) return
    const requestId = `pi-ui-${sessionId}-${String(rawId)}`.replace(/[^a-zA-Z0-9._-]/gu, '-')
    // Keep one authoritative pending entry for a raw Pi dialog until the user
    // or policy resolves it. Repeated transport records must not create two UI
    // decisions for one blocked tool call.
    if (this.pendingUiRequests.has(requestId)) return
    // The core-tools extension's permission gate marks its confirm dialogs
    // with a structured payload so they surface as real permission cards
    // (policy enrichment, allow/reject) instead of plain question cards.
    const permissionPayload = permissionMarkerPayload(record)
    if (permissionPayload) {
      this.pendingUiRequests.set(requestId, {
        sessionId,
        method: 'cio-permission',
        client,
        request: record
      })
      this.host.emitEvent({
        type: 'permission.asked',
        sessionId,
        permission: {
          id: requestId,
          sessionId,
          permission: permissionPayload.permission,
          patterns: permissionPayload.patterns,
          metadata: {
            ...(permissionPayload.tool ? { tool: permissionPayload.tool } : {}),
            ...(permissionPayload.command ? { command: permissionPayload.command } : {}),
            ...(permissionPayload.review ? { arguments: permissionPayload.review } : {}),
            ...(permissionPayload.surface ? { surface: permissionPayload.surface } : {}),
            ...(permissionPayload.matchedPatterns
              ? { matchedPatterns: permissionPayload.matchedPatterns }
              : {}),
            ...(permissionPayload.justification
              ? { justification: permissionPayload.justification }
              : {}),
            reason:
              permissionPayload.reason ??
              stringValue(record['title']) ??
              'Destructive action requires approval'
          }
        }
      })
      return
    }
    // Pi has no structured question RPC method. The core-tools extension sends
    // one tagged envelope through the dialog channel and the driver unwraps it
    // directly into the shared question contract.
    const markedQuestions = questionMarkerPayload(record)
    if (markedQuestions) {
      this.pendingUiRequests.set(requestId, {
        sessionId,
        method: 'cio-question',
        client,
        request: record
      })
      this.host.emitEvent({
        type: 'question.asked',
        sessionId,
        requestId,
        questions: markedQuestions
      })
      return
    }
    const questions: AgentQuestion[] = normalizeAgentQuestions({
      questions: [
        {
          prompt:
            stringValue(record['title']) ??
            stringValue(record['message']) ??
            'Pi needs your input.',
          header: stringValue(record['title']),
          description: stringValue(record['message']),
          options: Array.isArray(record['options']) ? record['options'] : undefined,
          custom: method !== 'confirm'
        }
      ]
    })
    this.pendingUiRequests.set(requestId, { sessionId, method, client, request: record })
    this.host.emitEvent({ type: 'question.asked', sessionId, requestId, questions })
  }

  /** Queue corrective feedback before resolving the blocked permission gate. */
  async replyPermission(
    requestId: string,
    reply: PermissionReply,
    message?: string,
    sessionId?: string
  ): Promise<void> {
    const request = this.pendingUiRequests.get(requestId)
    if (!request || request.method !== 'cio-permission') {
      throw new PermissionRequestGoneError(sessionId, requestId, this.host.name)
    }
    if (
      reply === 'always' &&
      permissionMarkerPayload(request.request)?.permission === 'bundled-pi-sensitive-files'
    ) {
      throw new Error('Protected file access can only be approved once')
    }
    const rawId = request.request['id']
    if (typeof rawId !== 'string' && typeof rawId !== 'number') {
      throw new Error(`Pi permission request has an invalid id: ${requestId}`)
    }
    // The engine persists the alternative for display, but does not send a
    // second prompt. Queue it while the tool is still blocked so Pi sees the
    // user's correction before continuing after the denial.
    const dialogMethod = stringValue(request.request['method'])
    const answer = reply === 'reject' ? (message?.trim() ? message.trim() : 'deny') : 'allow'
    if (dialogMethod === 'input') {
      // The input dialog is how the user's own words reach the blocked tool
      // result, so the model continues from their alternative rather than a
      // generic refusal. No second prompt is needed.
      request.client.respondToExtensionUiRequest(rawId, { value: answer })
      this.pendingUiRequests.delete(requestId)
      return
    }
    if (reply === 'reject' && message?.trim()) {
      await request.client.steer(
        [
          'The user rejected the requested action. Do not retry it unchanged.',
          'Continue this turn by following the user-provided alternative:',
          message
        ].join('\n\n'),
        []
      )
    }
    request.client.respondToExtensionUiRequest(
      rawId,
      reply === 'reject' ? { cancelled: true } : { confirmed: true }
    )
    this.pendingUiRequests.delete(requestId)
  }

  async replyToQuestion(sessionId: string, requestId: string, answers: string[][]): Promise<void> {
    const request = this.pendingUiRequests.get(requestId)
    if (!request || request.sessionId !== sessionId) {
      throw new QuestionRequestGoneError(sessionId, requestId, this.host.name)
    }
    const answer = answers[0]?.[0] ?? ''
    const rawId = request.request['id']
    if (typeof rawId !== 'string' && typeof rawId !== 'number') {
      throw new Error(`Pi question request has an invalid id: ${requestId}`)
    }
    if (request.method === 'confirm') {
      request.client.respondToExtensionUiRequest(rawId, {
        confirmed: /^(true|yes|y|allow|ok)$/iu.test(answer)
      })
    } else if (request.method === 'cio-question') {
      request.client.respondToExtensionUiRequest(rawId, { value: JSON.stringify(answers) })
    } else {
      request.client.respondToExtensionUiRequest(rawId, { value: answer })
    }
    this.pendingUiRequests.delete(requestId)
  }

  async rejectQuestion(sessionId: string, requestId: string): Promise<void> {
    const request = this.pendingUiRequests.get(requestId)
    if (!request || request.sessionId !== sessionId) {
      throw new QuestionRequestGoneError(sessionId, requestId, this.host.name)
    }
    const rawId = request.request['id']
    if (typeof rawId !== 'string' && typeof rawId !== 'number') {
      throw new Error(`Pi question request has an invalid id: ${requestId}`)
    }
    request.client.respondToExtensionUiRequest(rawId, { cancelled: true })
    this.pendingUiRequests.delete(requestId)
  }

  /**
   * Cancel every dialog pi still holds open for this session.
   *
   * The app never leaves a dialog unanswered: a card that disappears (a stop, a
   * rejected permission, a retired session) would otherwise leave pi waiting on
   * `ctx.ui.confirm` for an answer that cannot come, and the run behind it can
   * neither continue nor abort. Answering with `cancelled` is the same outcome a
   * dismissed card already produces, so the harness resumes with the blocked
   * call denied instead of hanging on it.
   */
  cancelPendingDialogs(sessionId: string): void {
    for (const [requestId, request] of [...this.pendingUiRequests]) {
      if (request.sessionId !== sessionId) continue
      this.pendingUiRequests.delete(requestId)
      const rawId = request.request['id']
      if (typeof rawId !== 'string' && typeof rawId !== 'number') continue
      try {
        request.client.respondToExtensionUiRequest(rawId, { cancelled: true })
      } catch (error) {
        Logger.dev('Pi dialog cancellation failed:', error)
      }
    }
  }

  /** True while the user still owes this session an answer. Pending requests are
   *  keyed by their RPC request id, so they are matched on the session they
   *  belong to: a card on screen must never lose the process that asked for it. */
  hasPendingUiRequest(sessionId: string): boolean {
    for (const request of this.pendingUiRequests.values()) {
      if (request.sessionId === sessionId) return true
    }
    return false
  }

  clear(): void {
    this.pendingUiRequests.clear()
  }
}
