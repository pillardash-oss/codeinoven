import { normalizeAgentQuestions, permissionPatterns } from '../../../lib/agent-interactions'
import { Logger } from '../../system/logger'
import { ASK_SECRET_TOOL_NAME, UTILITY_SUGGEST_TOOL_NAME } from '../../../lib/gateway-tools'
import { InactiveQuestionTurnError, QuestionRequestGoneError } from '../driver.interface'
import {
  type CodexAppServerHost,
  type CodexAppServerTurn,
  type CodexServerRequest
} from '../codex/codex-protocol'
import {
  CODEX_ASYNC_QUESTION_METHOD,
  CODEX_DYNAMIC_QUESTION_METHOD,
  CODEX_QUESTION_TOOL_NAME,
  codexQuestionDecisionText,
  codexQuestionIds,
  isCodexAsyncQuestion,
  isCodexDynamicQuestion,
  isCodexPermissionRequest,
  isCodexQuestionRequest
} from '../codex/codex-tools'
import { recordValue, stringValue } from '../codex/codex-values'
import type { CodexDriver } from '../codex-driver'

/** CodexDriver questions: one concern, moved verbatim from the composition root. */
export class CodexDriverQuestions {
  constructor(
    private readonly host: CodexDriver,
    private readonly base: CodexDriver['base']
  ) {}

  async replyToQuestion(
    _projectPath: string,
    sessionId: string,
    requestId: string,
    answers: string[][]
  ): Promise<void> {
    const request = this.host.serverRequests.get(requestId)
    if (
      !request ||
      (!isCodexQuestionRequest(request.method) &&
        !isCodexAsyncQuestion(request) &&
        !isCodexDynamicQuestion(request))
    ) {
      throw new QuestionRequestGoneError(sessionId, requestId, this.host.base.name)
    }
    if (!this.serverRequestTurnIsLive(request)) {
      this.host.serverRequests.delete(requestId)
      throw new InactiveQuestionTurnError(sessionId, requestId, this.host.base.name)
    }
    if (isCodexDynamicQuestion(request)) {
      await this.completeDynamicQuestion(request, answers)
      return
    }
    if (isCodexAsyncQuestion(request)) {
      await this.continueAsyncQuestion(request, answers)
      return
    }
    const questionIds = codexQuestionIds(request.params)
    const mappedAnswers: Record<string, { answers: string[] }> = {}
    questionIds.forEach((id, index) => {
      mappedAnswers[id] = { answers: answers[index] ?? [] }
    })
    // A native question request can also be auto-resolved by Codex while the
    // turn keeps running, which drops the result we write here. The turn input
    // carries the same decision, so the answer survives either way.
    await this.relayQuestionDecision(
      request,
      codexQuestionDecisionText(
        request.questions ?? normalizeAgentQuestions(request.params),
        answers
      )
    )
    this.host.units['protocol'].writeServerResponse(request, { answers: mappedAnswers })
    this.host.serverRequests.delete(requestId)
  }

  async rejectQuestion(_projectPath: string, sessionId: string, requestId: string): Promise<void> {
    const request = this.host.serverRequests.get(requestId)
    if (
      !request ||
      (!isCodexQuestionRequest(request.method) &&
        !isCodexAsyncQuestion(request) &&
        !isCodexDynamicQuestion(request))
    ) {
      throw new QuestionRequestGoneError(sessionId, requestId, this.host.base.name)
    }
    if (!this.serverRequestTurnIsLive(request)) {
      this.host.serverRequests.delete(requestId)
      throw new InactiveQuestionTurnError(sessionId, requestId, this.host.base.name)
    }
    if (isCodexDynamicQuestion(request)) {
      await this.completeDynamicQuestion(request)
      return
    }
    if (isCodexAsyncQuestion(request)) {
      await this.continueAsyncQuestion(request)
      return
    }
    const answers: Record<string, { answers: string[] }> = {}
    for (const id of codexQuestionIds(request.params)) answers[id] = { answers: [] }
    await this.relayQuestionDecision(
      request,
      codexQuestionDecisionText(
        request.questions ?? normalizeAgentQuestions(request.params),
        undefined
      )
    )
    this.host.units['protocol'].writeServerResponse(request, { answers })
    this.host.serverRequests.delete(requestId)
  }

  /** Whether the app-server turn that owns a server request is still live.
   *  Replying to a request whose turn already ended writes into a closed
   *  conversation, so the caller reports the turn as inactive instead. */
  serverRequestTurnIsLive(request: CodexServerRequest): boolean {
    const active = this.host.activeTurns.get(request.sessionId)
    return Boolean(
      active && !active.finished && !active.completionReceived && active.host === request.host
    )
  }

  async completeDynamicQuestion(request: CodexServerRequest, answers?: string[][]): Promise<void> {
    // A reply written after the owning turn ended reaches nothing: Codex has
    // already finished, so the answer would be silently dropped and the thread
    // would sit idle with an answered card. Report the turn as inactive so the
    // chat engine resumes the persisted session with the user's decision.
    if (!this.serverRequestTurnIsLive(request)) {
      this.host.serverRequests.delete(String(request.id))
      throw new InactiveQuestionTurnError(
        request.sessionId,
        String(request.id),
        this.host.base.name
      )
    }
    const questions = request.questions ?? normalizeAgentQuestions(request.params)
    const text = codexQuestionDecisionText(questions, answers)
    await this.relayQuestionDecision(request, text)
    this.host.units['protocol'].writeServerResponse(request, {
      success: true,
      contentItems: [{ type: 'inputText', text }]
    })
    this.host.serverRequests.delete(String(request.id))
  }

  /**
   * Write the user's decision onto the turn's own input channel.
   *
   * Codex parks a long-running `exec` script after about half a minute and
   * hands the model a "Script running with cell ID ..." placeholder. When the
   * user answers while that cell is parked, the app-server accepts the tool
   * result, but the model can end its turn before the parked cell is collected,
   * so the value never reaches the conversation: the card looks answered, the
   * thread goes idle, and the next turn repeats the same question. Steering the
   * live turn writes the decision as ordinary user input, which the model
   * consumes on its next step. A turn that refuses input falls back to the
   * result it is still blocked on, and a turn that already ended is reported as
   * inactive by the caller so the chat engine resumes with the decision.
   */
  async relayQuestionDecision(request: CodexServerRequest, text: string): Promise<void> {
    const active = this.host.activeTurns.get(request.sessionId)
    if (
      !active?.nativeThreadId ||
      !active.turnId ||
      active.finished ||
      active.host !== request.host
    ) {
      return
    }
    try {
      await this.host.units['runtime'].appServerRequest(active.host, 'turn/steer', {
        threadId: active.nativeThreadId,
        input: [{ type: 'text', text, text_elements: [] }],
        expectedTurnId: active.turnId
      })
    } catch (error) {
      if (active.finished || this.host.activeTurns.get(request.sessionId) !== active) return
      Logger.dev('Codex question decision could not be steered into the live turn:', error)
    }
  }

  async continueAsyncQuestion(request: CodexServerRequest, answers?: string[][]): Promise<void> {
    const active = this.host.activeTurns.get(request.sessionId)
    const requestId = String(request.id)
    if (
      !active?.nativeThreadId ||
      !active.turnId ||
      active.finished ||
      active.host !== request.host
    ) {
      this.host.serverRequests.delete(requestId)
      throw new InactiveQuestionTurnError(request.sessionId, requestId, this.host.base.name)
    }
    const questions = request.questions ?? normalizeAgentQuestions(request.params)
    const text = codexQuestionDecisionText(questions, answers)
    try {
      await this.host.units['runtime'].appServerRequest(active.host, 'turn/steer', {
        threadId: active.nativeThreadId,
        input: [{ type: 'text', text, text_elements: [] }],
        expectedTurnId: active.turnId
      })
      this.host.serverRequests.delete(requestId)
    } catch (error) {
      if (active.finished || this.host.activeTurns.get(request.sessionId) !== active) {
        this.host.serverRequests.delete(requestId)
        throw new InactiveQuestionTurnError(request.sessionId, requestId, this.host.base.name)
      }
      throw error
    }
  }

  /** Promote Codex's asynchronous default-mode question item into CIO's
   *  question lifecycle and suppress its Markdown fallback from the transcript. */
  captureAsyncQuestion(active: CodexAppServerTurn, item: Record<string, unknown>): boolean {
    if (stringValue(item['type']) !== 'agent_message' || !Array.isArray(item['questions'])) {
      return false
    }
    const itemId = stringValue(item['id'])
    if (!itemId) return false
    if (this.host.serverRequests.has(itemId)) return true
    const params = { questions: item['questions'] }
    const questions = normalizeAgentQuestions(params, stringValue(item['text']))
    this.host.serverRequests.set(itemId, {
      id: itemId,
      host: active.host,
      sessionId: active.session.id,
      method: CODEX_ASYNC_QUESTION_METHOD,
      params,
      questions
    })
    this.host.base.emit({
      type: 'question.asked',
      sessionId: active.session.id,
      requestId: itemId,
      questions
    })
    return true
  }

  handleServerRequest(
    host: CodexAppServerHost,
    id: string | number,
    method: string,
    params: Record<string, unknown>
  ): void {
    const active = this.host.units['turns'].activeTurnForNotification(params)
    if (!active) {
      this.host.units['runtime'].respondToUnsupportedAppServerRequest(host, id, method)
      return
    }
    if (method === 'item/tool/call') {
      if (
        active.host !== host ||
        params['threadId'] !== active.nativeThreadId ||
        params['turnId'] !== active.turnId
      ) {
        this.host.units['runtime'].respondToUnsupportedAppServerRequest(host, id, method)
        return
      }
      if (params['tool'] === CODEX_QUESTION_TOOL_NAME) {
        const questionParams = recordValue(params['arguments']) ?? {}
        const questions = normalizeAgentQuestions(questionParams)
        const request: CodexServerRequest = {
          id,
          host,
          sessionId: active.session.id,
          method: CODEX_DYNAMIC_QUESTION_METHOD,
          params: questionParams,
          questions
        }
        this.host.serverRequests.set(String(id), request)
        this.host.base.emit({
          type: 'question.asked',
          sessionId: active.session.id,
          requestId: String(id),
          questions
        })
        return
      }
      void this.host.units['tools'].callUtilityTool(active, params).then((result) => {
        if (
          (params['tool'] === ASK_SECRET_TOOL_NAME ||
            params['tool'] === UTILITY_SUGGEST_TOOL_NAME) &&
          (active.finished || active.completionReceived)
        ) {
          return
        }
        host.child.stdin?.write(`${JSON.stringify({ id, result })}\n`)
      })
      return
    }
    if (isCodexPermissionRequest(method)) {
      const request: CodexServerRequest = {
        id,
        host,
        sessionId: active.session.id,
        method,
        params
      }
      this.host.serverRequests.set(String(id), request)
      this.host.base.emit({
        type: 'permission.asked',
        sessionId: active.session.id,
        permission: {
          id: String(id),
          sessionId: active.session.id,
          permission:
            method === 'item/fileChange/requestApproval'
              ? 'edit'
              : method === 'item/commandExecution/requestApproval'
                ? 'command'
                : 'permissions',
          patterns: permissionPatterns(params),
          metadata: { method, ...params }
        }
      })
      return
    }
    if (isCodexQuestionRequest(method)) {
      const questions = normalizeAgentQuestions(
        params,
        stringValue(params['message']) ?? stringValue(params['prompt'])
      )
      const request: CodexServerRequest = {
        id,
        host,
        sessionId: active.session.id,
        method,
        params,
        questions
      }
      this.host.serverRequests.set(String(id), request)
      this.host.base.emit({
        type: 'question.asked',
        sessionId: active.session.id,
        requestId: String(id),
        questions
      })
      return
    }
    this.host.units['runtime'].respondToUnsupportedAppServerRequest(host, id, method)
  }
}
