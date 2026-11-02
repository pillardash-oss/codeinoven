import { randomUUID } from 'crypto'
import { Logger } from '../../system/logger'
import type { AgentMcpSignInTarget } from '../../../lib/types'
import { mcpSignInQuestion, type AgentMcpSignInResolution } from '../../../lib/mcp-sign-in'
import type { McpSignInContext } from '../../utilities/utility-orchestration-service'
import type { PendingQuestionInfo } from './chat-engine-types'
import type { ChatEngine } from '../chat-engine'

/**
 * ChatEngine MCP sign-in: the card an MCP server's own refusal surfaces.
 *
 * A remote server that answers a tool call with an OAuth challenge has told the
 * app, not the agent, what to do: the user has to authorize the server once in a
 * browser. This unit is the app half of that conversation. The gateway call that
 * hit the refusal waits on the card, the card signs the user in through the same
 * flow the Utilities page uses, and the grant it produces lives in the encrypted
 * vault, so the server never asks again on another thread or in another project.
 */
export class ChatEngineMcpSignIn {
  constructor(private readonly host: ChatEngine) {}

  /**
   * Surface one sign-in card and resolve when the user finishes or declines.
   *
   * The request is app-owned, so nothing is sent to a harness: this registers the
   * pending question, broadcasts it, and settles a promise. The sign-in itself is
   * the renderer's call into the shared OAuth service, exactly like the Utilities
   * page, so there is one authorization path and one grant.
   */
  async requestMcpSignIn(
    target: AgentMcpSignInTarget,
    context: McpSignInContext
  ): Promise<AgentMcpSignInResolution> {
    const requestId = `cio-signin-${randomUUID()}`
    const pending = this.host.registerPendingQuestion(
      context.harnessId,
      context.projectId,
      context.threadId,
      context.projectPath,
      {
        requestId,
        sessionId: context.sessionId,
        questions: [mcpSignInQuestion(target)]
      },
      await this.host.units['questions'].pendingQuestionTimeoutMs()
    )
    const settled = new Promise<AgentMcpSignInResolution>((resolve) => {
      pending.settleMcpSignIn = resolve
    })
    await this.host.threadManager.setStatus(
      context.projectId,
      context.threadId,
      'awaiting_approval',
      { read: false }
    )
    this.host.broadcast({
      type: 'question.asked',
      sessionId: context.sessionId,
      requestId,
      questions: pending.request.questions
    })
    return await settled
  }

  /**
   * Close an abandoned sign-in card, and stop a browser flow it still has open.
   *
   * Nothing can authorize a server on the user's behalf, so an expired card is a
   * decline the waiting tool call can act on. The listener the flow holds is
   * released too: an abandoned card must not leave a loopback port bound for the
   * rest of its authorization window.
   */
  expireMcpSignInQuestion(pending: PendingQuestionInfo): void {
    if (this.host.pendingQuestions.get(pending.request.requestId) !== pending) return
    pending.timer = undefined
    for (const question of pending.request.questions) {
      const target = question.mcpSignIn
      if (!target) continue
      void this.host.mcpOAuth
        .cancel(target.utilityId)
        .catch((error: unknown) => Logger.dev('MCP sign-in cancel failed:', error))
    }
    pending.settleMcpSignIn?.({ status: 'declined' })
    this.host.units['questions'].finalizePendingQuestion(pending.request.requestId, 'timed_out')
  }
}
