import type { PermissionReply } from '../../../lib/types'
import { isCodexPermissionRequest } from '../codex/codex-tools'
import type { CodexDriver } from '../codex-driver'

/** CodexDriver approvals: one concern, moved verbatim from the composition root. */
export class CodexDriverApprovals {
  constructor(
    private readonly host: CodexDriver,
    private readonly base: CodexDriver['base']
  ) {}

  async replyPermission(
    _projectPath: string,
    requestId: string,
    reply: PermissionReply,
    message?: string,
    _sessionId?: string
  ): Promise<void> {
    const request = this.host.serverRequests.get(requestId)
    if (!request || !isCodexPermissionRequest(request.method)) {
      throw new Error(`Codex permission request is no longer pending: ${requestId}`)
    }
    const decision =
      reply === 'reject' ? 'decline' : reply === 'always' ? 'acceptForSession' : 'accept'
    const result: Record<string, unknown> =
      request.method === 'item/permissions/requestApproval'
        ? {
            permissions: reply === 'reject' ? {} : (request.params['permissions'] ?? {}),
            scope: reply === 'always' ? 'session' : 'turn'
          }
        : { decision, ...(message ? { message } : {}) }
    this.host.units['protocol'].writeServerResponse(request, result)
    this.host.serverRequests.delete(requestId)
  }
}
