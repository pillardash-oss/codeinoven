import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import type {
  AgentBankedResets,
  AgentEvent,
  AgentMessage,
  AgentProviderIssue,
  AgentRateLimitWindow,
  AgentUsageCredits,
  HarnessCommand,
  PermissionReply,
  PromptAttachment,
  ProviderCatalog,
  ProviderModel,
  ThreadSettings
} from '../../lib/types'
import { normalizeAgentQuestions, permissionPatterns } from '../../lib/agent-interactions'
import { classifyProviderIssue } from '../../lib/provider-issue'
import { resolveFastModelId } from '../../lib/fast-inference'
import { BaseUrlProviderService } from '../providers/base-url-provider-service'
import { Logger } from '../system/logger'
import {
  ASK_SECRET_TOOL_NAME,
  GATEWAY_TOOLS,
  UTILITY_SUGGEST_TOOL_NAME
} from '../../lib/gateway-tools'
import type { UtilityGatewayEndpoint } from '../../lib/gateway-timeout'
import { SecretVault } from '../storage/secret-vault'
import type { StorageEngine } from '../storage/storage-engine'
import { buildProcessEnvironment } from './cli-environment'
import { prependHistoryRecap } from './history-recap-prompt'
import { formatHistoryRecap } from '../chat/chat-engine/chat-engine-message-text'
import { attachmentReference } from './attachment-reference'
import type {
  GenerateTitleOptions,
  GradeTurnOptions,
  HarnessCapabilities,
  IdleNativeSessionReleaseResult,
  SendPromptOptions,
  SteerPromptOptions,
  UtilityRuntimeOverlay,
  UtilityRuntimePreparationRequest
} from './driver.interface'
import { InactiveQuestionTurnError, QuestionRequestGoneError } from './driver.interface'
import {
  PersistentCliDriver,
  type CliLineParseContext,
  type CliLineParseResult,
  type CliTurnCommand,
  type PersistentCliSession,
  type TitleModelCandidate
} from './persistent-cli-driver'
import { inlineSvgAttachments, isSvgAttachment } from './svg-attachment'
import { prepareHarnessInvocation, runHarnessCommand } from './harness-runtime'
import { fallbackCodexModels, mapCodexModel, THINKING_PRESETS } from './codex/codex-models'
import {
  CODEX_APP_SERVER_REQUEST_TIMEOUT_MS,
  CODEX_COMPACTION_TIMEOUT_MS,
  CODEX_USAGE_TIMEOUT_MS,
  type CodexAppServerHost,
  type CodexAppServerTurn,
  type CodexCompactionRun,
  type CodexContextUsageWaiter,
  type CodexServerRequest
} from './codex/codex-protocol'
import {
  CODEX_ASYNC_QUESTION_METHOD,
  CODEX_DEFAULT_QUESTION_CONFIG,
  CODEX_DYNAMIC_QUESTION_METHOD,
  CODEX_QUESTION_TOOL_NAME,
  codexApprovalPolicy,
  codexEffort,
  codexQuestionDecisionText,
  codexQuestionIds,
  codexQuestionTool,
  codexSandboxPolicy,
  isCodexAsyncQuestion,
  isCodexDynamicQuestion,
  isCodexDynamicQuestionItem,
  isCodexPermissionRequest,
  isCodexQuestionRequest,
  isUnsupportedReasoningSummary,
  normalizeAppServerItem,
  parseCodexConfigEdits,
  sandboxFor,
  tomlString,
  tomlStringArray,
  tomlStringMap,
  utilityKey
} from './codex/codex-tools'
import {
  codexRetryIssue,
  codexUsageLimitIssue,
  isCodexRetryRecoveryActivity
} from './codex/codex-errors'
import { mapCodexRateLimits, mapCodexUsage } from './codex/codex-usage'
import {
  appServerRequestId,
  notificationThreadId,
  numberValue,
  recordValue,
  stringValue
} from './codex/codex-values'
import {
  codexDeveloperInstructions,
  composePrompt,
  localAttachmentPath
} from './codex/codex-prompts'
import { namespacedMessage, parseCodexJsonLine, parseItem } from './codex/codex-stream-fold'

export { mapCodexRateLimits, mapCodexUsage }

/** Multiplexed bridge for one resident Codex app-server and many native threads. */
export class CodexDriver extends PersistentCliDriver {
  readonly id = 'codex'
  readonly name = 'Codex CLI'
  readonly capabilities: HarnessCapabilities = {
    runtimeTopology: { kind: 'shared_daemon', scope: 'application' },
    streaming: true,
    steering: true,
    nativeResume: true,
    messageHistory: 'mirrored',
    interactivePermissions: true,
    attachments: true,
    commands: true,
    providerCatalog: true,
    sessionStatus: true,
    contextUsage: true,
    compaction: true,
    subagents: true,
    nativeUtilities: ['web_search', 'web_fetch', 'computer_use']
  }
  private activeTurns = new Map<string, CodexAppServerTurn>()
  private utilityEndpoints = new Map<string, UtilityGatewayEndpoint>()
  private modelsWithoutReasoningSummaries = new Set<string>()
  private compactionsByThreadId = new Map<string, CodexCompactionRun>()
  private contextUsageByThreadId = new Map<string, CodexContextUsageWaiter>()
  /** Last session that bound each native codex thread, so auto-compaction
   *  item notifications that arrive outside any registered turn (between
   *  turns, at resume/turn-start) can still reach the owning session. */
  private threadSessionsByNativeId = new Map<string, { sessionId: string; projectPath: string }>()
  /** Resident app-server hosts keyed by project working directory, so one
   *  app-server never serves two working directories at once. A standalone chat
   *  works in its own `chats-cwd/<threadId>` directory, so chats never share a
   *  resident server; {@link stopResidentHostForPathIfIdle} stops an idle one. */
  private hostsByProjectPath = new Map<string, CodexAppServerHost>()
  private hostsStartingByProjectPath = new Map<string, Promise<CodexAppServerHost>>()
  private appServerHosts = new Set<CodexAppServerHost>()
  private authenticationRestartsByProjectPath = new Map<string, Promise<void>>()
  private serverRequests = new Map<string, CodexServerRequest>()

  protected async ensureCliReady(): Promise<void> {
    try {
      await runHarnessCommand('codex', ['--version'], {
        env: buildProcessEnvironment({ ...process.env, ...this.accountEnvironment }),
        timeoutMs: 10_000
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown error'
      throw new Error(`Codex CLI is unavailable: ${detail}`, { cause: error })
    }
  }

  constructor(
    storage: StorageEngine,
    private readonly baseUrlProviders?: BaseUrlProviderService,
    private readonly secretVault?: SecretVault,
    private readonly accountEnvironment: NodeJS.ProcessEnv = {}
  ) {
    super(storage)
  }

  async listProviders(projectPath: string): Promise<ProviderCatalog[]> {
    let builtInModels: ProviderModel[]
    try {
      const discovered = await this.discoverModels(projectPath)
      builtInModels = discovered.length > 0 ? discovered : fallbackCodexModels()
    } catch (error) {
      Logger.info('Codex model discovery fell back to the bundled catalog', {
        error: error instanceof Error ? error.message : String(error)
      })
      builtInModels = fallbackCodexModels()
    }
    const catalogs: ProviderCatalog[] = [
      {
        id: 'openai',
        name: 'OpenAI',
        harnessId: 'codex',
        models: builtInModels
      }
    ]
    if (!this.baseUrlProviders) return catalogs
    const customProviders = await this.baseUrlProviders.listEnabled(this.id)
    for (const custom of customProviders) {
      catalogs.push({
        id: custom.id,
        name: custom.name,
        harnessId: 'codex',
        models: custom.models.map((model) => ({
          id: `${custom.id}/${model.id}`,
          providerId: custom.id,
          name: model.name || model.id,
          reasoning: model.reasoning,
          thinkingPresets: model.reasoning ? THINKING_PRESETS : undefined,
          attachment: model.vision !== false,
          toolcall: true,
          ...(model.contextWindow ? { contextWindow: model.contextWindow } : {})
        }))
      })
    }
    return catalogs
  }

  override async listCommands(projectPath: string): Promise<HarnessCommand[]> {
    const commands: HarnessCommand[] = [
      {
        name: 'config',
        description: 'Set Codex preferences with key=value arguments'
      },
      {
        name: 'settings',
        description: 'Set Codex preferences with key=value arguments'
      }
    ]
    let temporaryHost: CodexAppServerHost | null = null
    try {
      const host =
        this.hostsByProjectPath.has(projectPath) || this.hostsStartingByProjectPath.has(projectPath)
          ? await this.ensureAppServerHost(projectPath)
          : (temporaryHost = await this.createAppServerHost(projectPath))
      const result = await this.appServerRequest(host, 'skills/list', {
        cwds: [projectPath],
        forceReload: true
      })
      const rows = Array.isArray(result['data']) ? result['data'] : []
      const projectSkills = rows
        .map(recordValue)
        .find((row) => stringValue(row?.['cwd']) === projectPath)
      const skills =
        projectSkills && Array.isArray(projectSkills['skills']) ? projectSkills['skills'] : []
      for (const value of skills) {
        const skill = recordValue(value)
        const name = stringValue(skill?.['name'])
        if (!name || skill?.['enabled'] === false) continue
        const interfaceInfo = recordValue(skill?.['interface'])
        commands.push({
          name,
          description:
            stringValue(interfaceInfo?.['shortDescription']) ??
            stringValue(skill?.['description']) ??
            'Invoke this Codex skill',
          source: 'skill'
        })
      }
    } catch (error) {
      Logger.info('Codex skill command discovery skipped', {
        error: error instanceof Error ? error.message : String(error)
      })
    } finally {
      if (temporaryHost) {
        this.stopAppServerHost(temporaryHost, 'Codex skill command discovery completed')
      }
    }
    return commands
  }

  override async runCommand(
    projectPath: string,
    sessionId: string,
    command: HarnessCommand,
    args: string,
    settings: ThreadSettings
  ): Promise<void> {
    if (command.source === 'skill') {
      const trimmedArgs = args.trim()
      await this.sendPrompt(projectPath, {
        sessionId,
        settings,
        text: `$${command.name}${trimmedArgs ? ` ${trimmedArgs}` : ''}`,
        attachments: []
      })
      return
    }
    if (command.name === 'config' || command.name === 'settings') {
      const edits = parseCodexConfigEdits(args, command.name)
      const host = await this.ensureAppServerHost(projectPath)
      await this.appServerRequest(host, 'config/batchWrite', { edits })
      return
    }
    throw new Error(`Command is not available in ${this.name}: ${command.name}`)
  }

  /** Luna is Codex's single cheap auxiliary candidate. */
  private async cheapestCandidate(_projectPath: string): Promise<TitleModelCandidate[]> {
    void _projectPath
    return [{ providerId: 'openai', modelId: 'gpt-5.6-luna' }]
  }

  async generateTitle(projectPath: string, options: GenerateTitleOptions): Promise<string | null> {
    return this.generateTitleWithCandidates(
      projectPath,
      options,
      options.candidates ?? (await this.cheapestCandidate(projectPath))
    )
  }

  async gradeTurn(projectPath: string, options: GradeTurnOptions): Promise<number | null> {
    return this.gradeTurnWithCandidates(
      projectPath,
      options,
      options.candidates ?? (await this.cheapestCandidate(projectPath))
    )
  }

  /** Cheapest candidates for any auxiliary one-shot run. */
  protected override async cheapCandidateModels(
    projectPath: string
  ): Promise<TitleModelCandidate[]> {
    return this.cheapestCandidate(projectPath)
  }

  async publishUtilityGatewayEndpoint(
    _projectPath: string,
    sessionId: string,
    endpoint: UtilityGatewayEndpoint | null
  ): Promise<void> {
    if (endpoint) this.utilityEndpoints.set(sessionId, endpoint)
    else this.utilityEndpoints.delete(sessionId)
  }

  /** Start a Codex turn through app-server so the same native turn can be steered. */
  override async sendPrompt(projectPath: string, options: SendPromptOptions): Promise<void> {
    const session = await this.requireSession(projectPath, options.sessionId)
    // A native turn can still be registered while the engine believes the
    // session is idle: a network failure tears down the visible turn, but the
    // `turn/completed` cleanup only arrives when the connection recovers (or
    // after the request timeout). Rejecting here poisons the thread with
    // "A turn is already active" on every retry, so a dispatch that lands on a
    // live native turn is delivered as a steer instead - the driver's turn
    // registry is authoritative, not the engine's session status.
    if (this.activeTurns.has(session.id)) {
      await this.steerPrompt(projectPath, options)
      return
    }

    if (this.utilityRuntime(session.id)) {
      throw new Error('Codex per-session launch overlays cannot bypass the shared app-server host')
    }
    const fastInference =
      options.settings.inferenceMode === 'fast' && options.settings.providerId === 'openai'
    const serviceTier =
      options.settings.providerId === 'openai' && options.settings.inferenceMode === 'ultrafast'
        ? 'ultrafast'
        : fastInference
          ? 'fast'
          : 'default'
    const host = await this.ensureAppServerHost(projectPath)
    const active: CodexAppServerTurn = {
      host,
      session,
      finished: false
    }
    this.activeTurns.set(session.id, active)
    this.setTurnProvenance(
      session.id,
      options.settings.providerId,
      resolveFastModelId(options.settings.modelId, fastInference ? 'fast' : 'normal'),
      options.settings.thinkingLevel
    )
    this.appendUserMessage(session, options)

    try {
      const dynamicTools = [
        codexQuestionTool((await this.storage.getConfig()).agentQuestionCap),
        ...(this.utilityEndpoints.has(session.id)
          ? GATEWAY_TOOLS.map(({ name, description, inputSchema }) => ({
              name,
              description,
              inputSchema
            }))
          : [])
      ]
      const developerInstructions = codexDeveloperInstructions(options.systemPrompt)
      const contextConfig =
        options.settings.contextWindow && options.settings.providerId === 'openai'
          ? {
              config: {
                model_context_window: options.settings.contextWindow,
                model_auto_compact_token_limit: Math.floor(options.settings.contextWindow * 0.9)
              }
            }
          : {}
      const startThread = (): Promise<Record<string, unknown>> =>
        this.appServerRequest(host, 'thread/start', {
          ...contextConfig,
          cwd: projectPath,
          dynamicTools,
          developerInstructions,
          model: options.settings.modelId,
          approvalPolicy: codexApprovalPolicy(
            options.readOnly === true,
            options.settings.permissionLevel
          ),
          ...(codexApprovalPolicy(options.readOnly === true, options.settings.permissionLevel) ===
          'on-request'
            ? { approvalsReviewer: 'user' }
            : {}),
          sandbox: sandboxFor(options.readOnly === true, options.settings.permissionLevel),
          serviceName: 'codeinoven'
        })
      const restoredHistory = (): string => {
        const currentMessageId = options.userMessageId ?? session.messages.at(-1)?.id
        return formatHistoryRecap(
          session.messages.filter((message) => message.id !== currentMessageId)
        )
      }
      let historyRecap = options.historyRecap
      let threadResult: Record<string, unknown>
      const previousNativeId = session.nativeSessionId
      if (previousNativeId) {
        try {
          threadResult = await this.appServerRequest(host, 'thread/resume', {
            threadId: previousNativeId,
            // The app keeps its own transcript; native turn projection is unused.
            excludeTurns: true,
            ...contextConfig,
            dynamicTools,
            developerInstructions
          })
        } catch (error) {
          // Recover only an explicitly missing rollout. Auth, transport and
          // projection errors must retain the binding and their original error.
          if (
            !(error instanceof Error) ||
            error.message.trim() !== `no rollout found for thread id ${previousNativeId}`
          ) {
            throw error
          }
          historyRecap ||= restoredHistory()
          delete session.nativeSessionId
          this.threadSessionsByNativeId.delete(previousNativeId)
          await this.persistSession(session)
          Logger.info('Codex native rollout is missing; restoring mirrored history', {
            sessionId: session.id,
            nativeThreadId: previousNativeId
          })
          threadResult = await startThread()
        }
      } else {
        historyRecap ||= restoredHistory()
        threadResult = await startThread()
      }
      const thread = recordValue(threadResult['thread'])
      const nativeThreadId = stringValue(thread?.['id']) ?? session.nativeSessionId
      if (!nativeThreadId) throw new Error('Codex app-server did not return a thread ID')
      active.nativeThreadId = nativeThreadId
      session.nativeSessionId = nativeThreadId
      this.threadSessionsByNativeId.set(nativeThreadId, { sessionId: session.id, projectPath })
      await this.persistSession(session)

      const turnParams: Record<string, unknown> = {
        threadId: nativeThreadId,
        clientUserMessageId: options.userMessageId,
        input: await this.codexInput(
          prependHistoryRecap(options.text, historyRecap),
          options.attachments,
          session.id
        ),
        cwd: projectPath,
        approvalPolicy: codexApprovalPolicy(
          options.readOnly === true,
          options.settings.permissionLevel
        ),
        ...(codexApprovalPolicy(options.readOnly === true, options.settings.permissionLevel) ===
        'on-request'
          ? { approvalsReviewer: 'user' }
          : {}),
        sandboxPolicy: codexSandboxPolicy(
          projectPath,
          options.readOnly === true,
          options.settings.permissionLevel
        ),
        model: options.settings.modelId,
        serviceTier,
        effort: codexEffort(options.settings.thinkingLevel),
        summary: this.modelsWithoutReasoningSummaries.has(options.settings.modelId)
          ? 'none'
          : 'auto',
        ...(options.structuredOutput ? { outputSchema: options.structuredOutput.schema } : {})
      }
      active.startParams = turnParams
      const turnResult = await this.appServerRequest(host, 'turn/start', turnParams)
      const turn = recordValue(turnResult['turn'])
      const turnId = stringValue(turn?.['id'])
      if (!turnId) throw new Error('Codex app-server did not return an active turn ID')
      active.turnId = turnId
    } catch (error) {
      await this.finishAppServerTurn(
        active,
        error instanceof Error ? error.message : 'Codex turn could not start'
      )
      throw error
    }
  }

  /** Append input to Codex's native in-flight turn without creating another turn. */
  async steerPrompt(projectPath: string, options: SteerPromptOptions): Promise<void> {
    const session = await this.requireSession(projectPath, options.sessionId)
    const active = this.activeTurns.get(session.id)
    if (!active?.nativeThreadId || !active.turnId) {
      throw new Error(`No active Codex turn is available to steer for session ${session.id}`)
    }
    this.appendUserMessage(session, options)
    await this.appServerRequest(active.host, 'turn/steer', {
      threadId: active.nativeThreadId,
      clientUserMessageId: options.userMessageId,
      input: await this.codexInput(options.text, options.attachments, session.id),
      expectedTurnId: active.turnId
    })
    await this.persistSession(session)
  }

  override async replyPermission(
    _projectPath: string,
    requestId: string,
    reply: PermissionReply,
    message?: string,
    _sessionId?: string
  ): Promise<void> {
    const request = this.serverRequests.get(requestId)
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
    this.writeServerResponse(request, result)
    this.serverRequests.delete(requestId)
  }

  override async replyToQuestion(
    _projectPath: string,
    sessionId: string,
    requestId: string,
    answers: string[][]
  ): Promise<void> {
    const request = this.serverRequests.get(requestId)
    if (
      !request ||
      (!isCodexQuestionRequest(request.method) &&
        !isCodexAsyncQuestion(request) &&
        !isCodexDynamicQuestion(request))
    ) {
      throw new QuestionRequestGoneError(sessionId, requestId, this.name)
    }
    if (!this.serverRequestTurnIsLive(request)) {
      this.serverRequests.delete(requestId)
      throw new InactiveQuestionTurnError(sessionId, requestId, this.name)
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
    this.writeServerResponse(request, { answers: mappedAnswers })
    this.serverRequests.delete(requestId)
  }

  override async rejectQuestion(
    _projectPath: string,
    sessionId: string,
    requestId: string
  ): Promise<void> {
    const request = this.serverRequests.get(requestId)
    if (
      !request ||
      (!isCodexQuestionRequest(request.method) &&
        !isCodexAsyncQuestion(request) &&
        !isCodexDynamicQuestion(request))
    ) {
      throw new QuestionRequestGoneError(sessionId, requestId, this.name)
    }
    if (!this.serverRequestTurnIsLive(request)) {
      this.serverRequests.delete(requestId)
      throw new InactiveQuestionTurnError(sessionId, requestId, this.name)
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
    this.writeServerResponse(request, { answers })
    this.serverRequests.delete(requestId)
  }

  /** Whether the app-server turn that owns a server request is still live.
   *  Replying to a request whose turn already ended writes into a closed
   *  conversation, so the caller reports the turn as inactive instead. */
  private serverRequestTurnIsLive(request: CodexServerRequest): boolean {
    const active = this.activeTurns.get(request.sessionId)
    return Boolean(
      active && !active.finished && !active.completionReceived && active.host === request.host
    )
  }

  private async completeDynamicQuestion(
    request: CodexServerRequest,
    answers?: string[][]
  ): Promise<void> {
    // A reply written after the owning turn ended reaches nothing: Codex has
    // already finished, so the answer would be silently dropped and the thread
    // would sit idle with an answered card. Report the turn as inactive so the
    // chat engine resumes the persisted session with the user's decision.
    if (!this.serverRequestTurnIsLive(request)) {
      this.serverRequests.delete(String(request.id))
      throw new InactiveQuestionTurnError(request.sessionId, String(request.id), this.name)
    }
    const questions = request.questions ?? normalizeAgentQuestions(request.params)
    const text = codexQuestionDecisionText(questions, answers)
    await this.relayQuestionDecision(request, text)
    this.writeServerResponse(request, {
      success: true,
      contentItems: [{ type: 'inputText', text }]
    })
    this.serverRequests.delete(String(request.id))
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
  private async relayQuestionDecision(request: CodexServerRequest, text: string): Promise<void> {
    const active = this.activeTurns.get(request.sessionId)
    if (
      !active?.nativeThreadId ||
      !active.turnId ||
      active.finished ||
      active.host !== request.host
    ) {
      return
    }
    try {
      await this.appServerRequest(active.host, 'turn/steer', {
        threadId: active.nativeThreadId,
        input: [{ type: 'text', text, text_elements: [] }],
        expectedTurnId: active.turnId
      })
    } catch (error) {
      if (active.finished || this.activeTurns.get(request.sessionId) !== active) return
      Logger.dev('Codex question decision could not be steered into the live turn:', error)
    }
  }

  private async continueAsyncQuestion(
    request: CodexServerRequest,
    answers?: string[][]
  ): Promise<void> {
    const active = this.activeTurns.get(request.sessionId)
    const requestId = String(request.id)
    if (
      !active?.nativeThreadId ||
      !active.turnId ||
      active.finished ||
      active.host !== request.host
    ) {
      this.serverRequests.delete(requestId)
      throw new InactiveQuestionTurnError(request.sessionId, requestId, this.name)
    }
    const questions = request.questions ?? normalizeAgentQuestions(request.params)
    const text = codexQuestionDecisionText(questions, answers)
    try {
      await this.appServerRequest(active.host, 'turn/steer', {
        threadId: active.nativeThreadId,
        input: [{ type: 'text', text, text_elements: [] }],
        expectedTurnId: active.turnId
      })
      this.serverRequests.delete(requestId)
    } catch (error) {
      if (active.finished || this.activeTurns.get(request.sessionId) !== active) {
        this.serverRequests.delete(requestId)
        throw new InactiveQuestionTurnError(request.sessionId, requestId, this.name)
      }
      throw error
    }
  }

  /** Whether the driver still has a registered live turn for this session.
   *  The engine's watchdog uses this to distinguish a session whose turn
   *  settled without finalization (stale working state) from one that is
   *  legitimately streaming a long turn. */
  hasActiveTurn(sessionId: string): boolean {
    const active = this.activeTurns.get(sessionId)
    return Boolean(active && !active.finished && !active.completionReceived)
  }

  /** Codex runs as a shared app-server daemon, so the base implementation's
   *  process-liveness check cannot tell one session's turn from another's:
   *  the host process is alive for every session while the daemon runs.
   *  Report per-turn registration instead so a silent session whose turn has
   *  already finished is probed as idle (letting the watchdog reconcile or
   *  abort it) while a genuinely active silent turn stays preserved. */
  override async isSessionBusy(_projectPath: string, sessionId: string): Promise<boolean> {
    return this.hasActiveTurn(sessionId)
  }

  override async abort(projectPath: string, sessionId: string): Promise<void> {
    await this.requireSession(projectPath, sessionId)
    const active = this.activeTurns.get(sessionId)
    if (!active?.nativeThreadId || !active.turnId) return
    try {
      await this.appServerRequest(active.host, 'turn/interrupt', {
        threadId: active.nativeThreadId,
        turnId: active.turnId
      })
      // A successful interrupt does not guarantee Codex's `turn/completed`
      // notification will arrive: the wedged connection that forced the abort
      // may stay silent indefinitely, leaving this registration as a zombie
      // that rejects every later dispatch with "A turn is already active".
      // Finish the turn locally; the notification path is idempotent.
      await this.finishAppServerTurn(active)
    } catch (error) {
      await this.finishAppServerTurn(
        active,
        error instanceof Error ? error.message : 'Codex turn could not be interrupted'
      )
      throw error
    }
  }

  /**
   * Codex's resident app-server keeps the OAuth credential it loaded at
   * startup. Re-authentication changes the credential on disk, but an existing
   * app-server keeps using the old one. Rebuild only this project's server so
   * the next retry resumes the same native thread with the new credential.
   */
  restartAfterAuthentication(projectPath: string): Promise<void> {
    const existing = this.authenticationRestartsByProjectPath.get(projectPath)
    if (existing) return existing

    const restart = this.restartAppServer(
      projectPath,
      'Codex app-server restarting after provider sign-in'
    ).finally(() => {
      if (this.authenticationRestartsByProjectPath.get(projectPath) === restart) {
        this.authenticationRestartsByProjectPath.delete(projectPath)
      }
    })
    this.authenticationRestartsByProjectPath.set(projectPath, restart)
    return restart
  }

  /**
   * Rebuild every resident app-server so the next turn spawns the Codex binary
   * currently on disk. A harness update replaces `codex` but not the app-server
   * already running from the old install, and that process is what every turn
   * in the project talks to. The native threads live in Codex's own store, so
   * the rebuilt server resumes them.
   */
  override async restartRuntime(): Promise<void> {
    for (const projectPath of [...this.hostsByProjectPath.keys()]) {
      await this.restartAppServer(
        projectPath,
        'Codex app-server restarted to pick up a harness update'
      )
    }
    super.restartRuntime()
  }

  override async deleteSession(projectPath: string, sessionId: string): Promise<void> {
    const active = this.activeTurns.get(sessionId)
    if (active) await this.finishAppServerTurn(active)
    await super.deleteSession(projectPath, sessionId)
    await this.storage.remove(`drivers/${this.id}/inputs/${sessionId}`)
    this.stopResidentHostForPathIfIdle(projectPath)
  }

  override releaseProjectResources(projectPath: string): void {
    super.releaseProjectResources(projectPath)
    this.stopResidentHostForPathIfIdle(projectPath)
  }

  /**
   * Hand an idle native thread to another CodeInOven process. Codex holds its
   * writer lock for the lifetime of the loaded app-server thread, so closing
   * only the project host can release it without deleting or forking history.
   */
  async releaseIdleSessionForTransfer(
    projectPath: string,
    sessionId: string
  ): Promise<IdleNativeSessionReleaseResult> {
    const session = await this.requireSession(projectPath, sessionId)
    const nativeThreadId = session.nativeSessionId
    if (!nativeThreadId) return { owner: false, released: false }

    const binding = this.threadSessionsByNativeId.get(nativeThreadId)
    const host = this.hostsByProjectPath.get(projectPath)
    if (
      !host ||
      !binding ||
      binding.sessionId !== sessionId ||
      binding.projectPath !== projectPath
    ) {
      return { owner: false, released: false }
    }

    if (this.activeTurns.has(sessionId)) {
      return {
        owner: true,
        released: false,
        reason: 'This Codex thread still has an active turn.'
      }
    }
    const hostBusy =
      [...this.activeTurns.values()].some((active) => active.host === host) ||
      [...this.compactionsByThreadId.values()].some((compaction) => compaction.host === host) ||
      [...this.contextUsageByThreadId.values()].some((waiter) => waiter.host === host) ||
      [...this.serverRequests.values()].some(
        (request) => request.host === host && request.sessionId !== sessionId
      ) ||
      host.pending.size > 0
    if (hostBusy) {
      return {
        owner: true,
        released: false,
        reason: 'Another Codex operation is still using this app-server.'
      }
    }

    if (this.hostsByProjectPath.get(projectPath) === host) {
      this.hostsByProjectPath.delete(projectPath)
    }
    const stopped = await this.stopAppServerHostAndWait(
      host,
      'Codex app-server handed an idle thread to another instance'
    )
    if (!stopped) {
      return {
        owner: true,
        released: false,
        reason: 'The Codex app-server did not exit, so its thread writer is still held.'
      }
    }
    for (const [threadId, sessionOwner] of this.threadSessionsByNativeId) {
      if (sessionOwner.projectPath === projectPath) this.threadSessionsByNativeId.delete(threadId)
    }
    return { owner: true, released: true }
  }

  override dispose(): void {
    for (const active of this.activeTurns.values()) {
      active.finished = true
    }
    this.activeTurns.clear()
    this.utilityEndpoints.clear()
    for (const compaction of this.compactionsByThreadId.values()) {
      clearTimeout(compaction.timer)
      compaction.reject(new Error('Codex driver disposed'))
    }
    this.compactionsByThreadId.clear()
    for (const waiter of this.contextUsageByThreadId.values()) {
      clearTimeout(waiter.timer)
      waiter.resolve(undefined)
    }
    this.contextUsageByThreadId.clear()
    for (const host of this.appServerHosts) {
      this.stopAppServerHost(host, 'Codex driver disposed')
    }
    this.appServerHosts.clear()
    this.hostsByProjectPath.clear()
    this.hostsStartingByProjectPath.clear()
    this.authenticationRestartsByProjectPath.clear()
    this.serverRequests.clear()
    super.dispose()
  }

  prepareForProcessCleanup(): void {
    for (const host of [...this.appServerHosts]) {
      this.stopAppServerHost(host, 'CodeInOven is shutting down')
    }
  }

  private async restartAppServer(projectPath: string, reason: string): Promise<void> {
    const starting = this.hostsStartingByProjectPath.get(projectPath)
    if (starting) await starting.catch(() => undefined)

    const host = this.hostsByProjectPath.get(projectPath)
    if (!host) return

    this.hostsByProjectPath.delete(projectPath)
    await this.failAppServerHost(host, reason)
    if (!host.child.killed) host.child.kill()
  }

  private stopAppServerHost(host: CodexAppServerHost, reason: string): void {
    if (host.stopped) return
    host.stopped = true
    this.appServerHosts.delete(host)
    for (const pending of host.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
    host.pending.clear()
    if (!host.child.killed) host.child.kill()
  }

  private async stopAppServerHostAndWait(
    host: CodexAppServerHost,
    reason: string
  ): Promise<boolean> {
    const exited = this.waitForAppServerExit(host.child)
    this.stopAppServerHost(host, reason)
    return exited
  }

  private waitForAppServerExit(
    child: CodexAppServerHost['child'],
    timeoutMs = 5_000
  ): Promise<boolean> {
    if (typeof child.exitCode === 'number' || typeof child.signalCode === 'string') {
      return Promise.resolve(true)
    }
    return new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (exited: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.removeListener('exit', onExit)
        resolve(exited)
      }
      const onExit = (): void => finish(true)
      const timer = setTimeout(() => finish(false), timeoutMs)
      timer.unref?.()
      child.once('exit', onExit)
      if (typeof child.exitCode === 'number' || typeof child.signalCode === 'string') {
        finish(true)
      }
    })
  }

  private stopResidentHostForPathIfIdle(projectPath: string): void {
    const host = this.hostsByProjectPath.get(projectPath)
    if (!host || this.hostsStartingByProjectPath.has(projectPath)) return
    const busy =
      [...this.activeTurns.values()].some((active) => active.host === host) ||
      [...this.compactionsByThreadId.values()].some((compaction) => compaction.host === host) ||
      [...this.contextUsageByThreadId.values()].some((waiter) => waiter.host === host) ||
      host.pending.size > 0
    if (busy) return
    this.hostsByProjectPath.delete(projectPath)
    this.stopAppServerHost(host, 'Codex app-server stopped after genuine inactivity')
  }

  private async createAppServerHost(projectPath: string): Promise<CodexAppServerHost> {
    const { env: providerEnv, args: providerArgs } = await this.customProviderOverlay()
    const prepared = await prepareHarnessInvocation(
      'codex',
      [...providerArgs, 'app-server', '-c', CODEX_DEFAULT_QUESTION_CONFIG, '--listen', 'stdio://'],
      {
        cwd: projectPath,
        env: {
          ...buildProcessEnvironment({ ...process.env, ...this.accountEnvironment }),
          ...providerEnv
        }
      }
    )
    const child = spawn(prepared.command, prepared.args, {
      ...(prepared.cwd ? { cwd: prepared.cwd } : {}),
      env: prepared.env,
      shell: prepared.shell,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const host: CodexAppServerHost = {
      child,
      nextRequestId: 0,
      stdoutBuffer: '',
      stderrBuffer: '',
      stopped: false,
      pending: new Map()
    }
    this.appServerHosts.add(host)
    this.bindAppServer(host)
    // The shared app-server is app-scoped: register it under APP_SCOPE (undefined
    // session) so thread-scoped process kills (thread deletion, SourcesPanel
    // "kill thread processes") never SIGTERM the universal session.
    this.observeHarnessProcess(undefined, child, 'codex app-server', projectPath)
    try {
      await this.appServerRequest(host, 'initialize', {
        clientInfo: { name: 'codeinoven', title: 'CodeInOven', version: '1' },
        capabilities: { experimentalApi: true }
      })
      this.appServerNotify(host, 'initialized')
      return host
    } catch (error) {
      this.stopAppServerHost(
        host,
        error instanceof Error ? error.message : 'Codex app-server initialization failed'
      )
      throw error
    }
  }

  private async ensureAppServerHost(projectPath: string): Promise<CodexAppServerHost> {
    const existing = this.hostsByProjectPath.get(projectPath)
    if (existing && !existing.stopped) {
      return existing
    }
    const starting = this.hostsStartingByProjectPath.get(projectPath)
    if (starting) return starting
    const promise = (async (): Promise<CodexAppServerHost> => {
      const host = await this.createAppServerHost(projectPath)
      this.hostsByProjectPath.set(projectPath, host)
      return host
    })()
    this.hostsStartingByProjectPath.set(projectPath, promise)
    try {
      return await promise
    } catch (error) {
      const host = this.hostsByProjectPath.get(projectPath)
      if (host && !host.child.killed) host.child.kill()
      this.hostsByProjectPath.delete(projectPath)
      throw error
    } finally {
      if (this.hostsStartingByProjectPath.get(projectPath) === promise) {
        this.hostsStartingByProjectPath.delete(projectPath)
      }
    }
  }

  private async discoverModels(projectPath: string): Promise<ProviderModel[]> {
    let temporaryHost: CodexAppServerHost | null = null
    try {
      const host =
        this.hostsByProjectPath.has(projectPath) || this.hostsStartingByProjectPath.has(projectPath)
          ? await this.ensureAppServerHost(projectPath)
          : (temporaryHost = await this.createAppServerHost(projectPath))
      const discovered: ProviderModel[] = []
      let cursor: string | undefined
      do {
        const result = await this.appServerRequest(host, 'model/list', {
          includeHidden: false,
          limit: 100,
          ...(cursor ? { cursor } : {})
        })
        const data = result['data']
        if (!Array.isArray(data)) {
          throw new Error('Codex model discovery returned an invalid response')
        }
        for (const value of data) {
          const model = mapCodexModel(value)
          if (model) discovered.push(model)
        }
        cursor = stringValue(result['nextCursor'])
      } while (cursor)
      return [...new Map(discovered.map((model) => [model.id, model])).values()]
    } finally {
      if (temporaryHost) {
        this.stopAppServerHost(temporaryHost, 'Codex model discovery completed')
      }
    }
  }

  private bindAppServer(host: CodexAppServerHost): void {
    host.child.stdout?.on('data', (chunk: Buffer) => {
      host.stdoutBuffer += chunk.toString()
      const lines = host.stdoutBuffer.split(/\r?\n/u)
      host.stdoutBuffer = lines.pop() ?? ''
      for (const line of lines) this.consumeAppServerLine(host, line)
    })
    host.child.stderr?.on('data', (chunk: Buffer) => {
      host.stderrBuffer = `${host.stderrBuffer}${chunk.toString()}`.slice(-4_000)
    })
    host.child.on('error', (error) => void this.failAppServerHost(host, error.message))
    host.child.on('exit', (code, signal) => {
      if (host.stopped) return
      const detail = host.stderrBuffer.trim()
      void this.failAppServerHost(
        host,
        `Codex app-server exited (${code ?? signal ?? 'unknown'})${detail ? `: ${detail}` : ''}`
      )
    })
  }

  private consumeAppServerLine(host: CodexAppServerHost, line: string): void {
    if (!line.trim()) return
    let payload: Record<string, unknown>
    try {
      payload = recordValue(JSON.parse(line) as unknown) ?? {}
    } catch {
      Logger.dev('Codex app-server emitted a non-JSON line')
      return
    }
    const responseId = appServerRequestId(payload['id'])
    const method = stringValue(payload['method'])
    if (typeof responseId === 'number' && !method) {
      const pending = host.pending.get(responseId)
      if (!pending) return
      host.pending.delete(responseId)
      clearTimeout(pending.timer)
      const error = recordValue(payload['error'])
      if (error) {
        pending.reject(
          new Error(stringValue(error['message']) ?? 'Codex app-server request failed')
        )
      } else {
        pending.resolve(recordValue(payload['result']) ?? {})
      }
      return
    }
    if (responseId !== undefined && method) {
      this.handleServerRequest(host, responseId, method, recordValue(payload['params']) ?? {})
      return
    }
    if (method) this.handleAppServerNotification(host, method, recordValue(payload['params']) ?? {})
  }

  private handleAppServerNotification(
    _host: CodexAppServerHost,
    method: string,
    params: Record<string, unknown>
  ): void {
    void _host
    if (method === 'serverRequest/resolved') {
      const requestId = appServerRequestId(params['requestId'] ?? params['request_id'])
      if (requestId === undefined) return
      const request = this.serverRequests.get(String(requestId))
      if (!request) return
      this.serverRequests.delete(String(requestId))
      if (isCodexQuestionRequest(request.method)) {
        this.emit({
          type: 'question.resolved',
          sessionId: request.sessionId,
          requestId: String(requestId),
          resolution: 'answered'
        })
      }
      return
    }
    const threadId = notificationThreadId(params)
    if (threadId && method === 'thread/tokenUsage/updated') {
      const waiter = this.contextUsageByThreadId.get(threadId)
      if (waiter) {
        clearTimeout(waiter.timer)
        this.contextUsageByThreadId.delete(threadId)
        waiter.resolve(mapCodexUsage(params['tokenUsage'] ?? params))
      }
    }
    if (threadId) {
      const compaction = this.compactionsByThreadId.get(threadId)
      if (compaction && (method === 'item/started' || method === 'item/completed')) {
        const item = recordValue(params['item'])
        if (stringValue(item?.['type']) === 'contextCompaction') {
          const summary = stringValue(item?.['summary']) ?? stringValue(item?.['text'])
          const part = summary ? { ...compaction.basePart, summary } : compaction.basePart
          this.applyEventToSession(compaction.session, {
            type: 'message.part.updated',
            sessionId: compaction.session.id,
            part
          })
          this.emit({
            type: 'message.part.updated',
            sessionId: compaction.session.id,
            part
          })
        }
        return
      }
      if (compaction && method === 'turn/completed') {
        const turn = recordValue(params['turn'])
        const status = stringValue(turn?.['status'])
        clearTimeout(compaction.timer)
        this.compactionsByThreadId.delete(threadId)
        if (status === 'failed' || status === 'interrupted') {
          const failure = stringValue(recordValue(turn?.['error'])?.['message'])
          compaction.reject(
            new Error(
              failure ? `Codex compaction failed: ${failure}` : `Codex compaction ${status}`
            )
          )
        } else {
          const completed: AgentEvent = {
            type: 'message.completed',
            sessionId: compaction.session.id,
            messageId: compaction.messageId,
            compaction: true
          }
          this.applyEventToSession(compaction.session, completed)
          this.emit(completed)
          this.emit({ type: 'session.idle', sessionId: compaction.session.id })
          void this.persistSession(compaction.session).then(compaction.resolve, compaction.reject)
        }
        return
      }
    }
    const active = this.activeTurnForNotification(params)
    if (!active) {
      this.reportBetweenTurnCompaction(method, params)
      return
    }
    if (active.waitingForRetry && isCodexRetryRecoveryActivity(method)) {
      active.waitingForRetry = false
      this.emit({
        type: 'session.status',
        sessionId: active.session.id,
        status: { state: 'working' }
      })
    }
    if (method === 'turn/started') {
      const turn = recordValue(params['turn'])
      active.turnId = stringValue(turn?.['id']) ?? active.turnId
      return
    }
    if (method === 'item/agentMessage/delta') {
      this.emitAppServerDelta(active, params, 'text')
      return
    }
    if (method === 'item/reasoning/textDelta') {
      this.emitAppServerDelta(active, params, 'reasoning')
      return
    }
    if (method === 'item/reasoning/summaryTextDelta') {
      // The summary is a separate channel from the reasoning body. Appending it
      // into `text` rendered the same sentences twice in the thinking block
      // (body plus "Thinking summary"), so it streams into `summary` instead.
      this.emitAppServerDelta(active, params, 'reasoning', 'summary')
      return
    }
    if (method === 'item/reasoning/summaryPartAdded') {
      this.emitReasoningSummarySeparator(active, params)
      return
    }
    if (method === 'item/started' || method === 'item/completed') {
      const item = normalizeAppServerItem(recordValue(params['item']))
      // app-server echoes the submitted top-level input as a userMessage item.
      // The app already owns a presentation-safe user bubble, so broadcasting
      // this transport echo would expose developer instructions in the trace.
      if (item && stringValue(item['type']) !== 'user_message') {
        if (this.captureAsyncQuestion(active, item)) return
        if (isCodexDynamicQuestionItem(item)) return
        this.applyCodexResult(
          active,
          parseItem(item, method === 'item/completed', active.session.id)
        )
      }
      return
    }
    if (method === 'turn/plan/updated') {
      const turnId = stringValue(params['turnId']) ?? active.turnId
      const plan = params['plan']
      if (turnId && Array.isArray(plan)) {
        this.applyCodexResult(
          active,
          parseItem(
            {
              id: `${turnId}:plan`,
              type: 'plan_update',
              plan,
              explanation: params['explanation'],
              output: params['explanation']
            },
            true,
            active.session.id
          )
        )
      }
      return
    }
    if (method === 'thread/tokenUsage/updated') {
      const usage = mapCodexUsage(params['tokenUsage'] ?? params)
      const message = [...active.session.messages]
        .reverse()
        .find((candidate) => candidate.role === 'assistant')
      if (usage && message) {
        if (usage.normalizedUsage) message.normalizedUsage = usage.normalizedUsage
        const event: AgentEvent = {
          type: 'usage.updated',
          sessionId: active.session.id,
          messageId: message.id,
          ...(usage.aggregateTokens ? { tokens: usage.aggregateTokens } : {}),
          ...(usage.normalizedUsage ? { normalizedUsage: usage.normalizedUsage } : {}),
          ...(usage.contextUsed === undefined ? {} : { contextUsed: usage.contextUsed }),
          ...(usage.contextWindow === undefined ? {} : { contextWindow: usage.contextWindow })
        }
        this.applyEventToSession(active.session, event)
        this.emit(event)
      }
      return
    }
    if (method === 'error') {
      const error = recordValue(params['error'])
      const message = stringValue(error?.['message']) ?? 'Codex turn failed'
      if (params['willRetry'] === true) {
        active.failure = undefined
        active.waitingForRetry = true
        this.emit({
          type: 'session.status',
          sessionId: active.session.id,
          status: { state: 'waiting', issue: codexRetryIssue(error, message) }
        })
      } else {
        active.waitingForRetry = false
        active.failure = message
        active.failureIssue = codexUsageLimitIssue(error, message)
      }
      return
    }
    if (method !== 'turn/completed') return
    const turn = recordValue(params['turn'])
    const status = stringValue(turn?.['status'])
    const error = recordValue(turn?.['error'])
    // A prior `error` notification (e.g. a usage-limit hit with
    // `willRetry: false`) already captured `active.failure`/`active.failureIssue`
    // before the turn tore down. The app-server can report that teardown as a
    // non-`'failed'` terminal status (e.g. `'interrupted'`)   falling through to
    // `undefined` here would silently drop the captured failure and let the
    // turn look like a clean success.
    const message =
      status === 'failed'
        ? (stringValue(error?.['message']) ?? active.failure ?? 'Codex turn failed')
        : active.failure
    const unsupportedSummary = [message, active.failure].some(
      (candidate) => candidate !== undefined && isUnsupportedReasoningSummary(candidate)
    )
    if (unsupportedSummary && !active.summaryFallbackAttempted) {
      void this.retryWithoutReasoningSummary(active)
      return
    }
    const issue =
      status === 'failed'
        ? (codexUsageLimitIssue(error, message ?? '') ?? active.failureIssue)
        : active.failureIssue
    // Mark the native turn terminal before the async telemetry refresh below.
    // A card answer arriving during that refresh must resume from persisted
    // history instead of being written into the completed turn.
    active.completionReceived = true
    void this.completeAppServerTurn(active, message, issue)
  }

  /** Promote Codex's asynchronous default-mode question item into CIO's
   *  question lifecycle and suppress its Markdown fallback from the transcript. */
  private captureAsyncQuestion(active: CodexAppServerTurn, item: Record<string, unknown>): boolean {
    if (stringValue(item['type']) !== 'agent_message' || !Array.isArray(item['questions'])) {
      return false
    }
    const itemId = stringValue(item['id'])
    if (!itemId) return false
    if (this.serverRequests.has(itemId)) return true
    const params = { questions: item['questions'] }
    const questions = normalizeAgentQuestions(params, stringValue(item['text']))
    this.serverRequests.set(itemId, {
      id: itemId,
      host: active.host,
      sessionId: active.session.id,
      method: CODEX_ASYNC_QUESTION_METHOD,
      params,
      questions
    })
    this.emit({
      type: 'question.asked',
      sessionId: active.session.id,
      requestId: itemId,
      questions
    })
    return true
  }

  private handleServerRequest(
    host: CodexAppServerHost,
    id: string | number,
    method: string,
    params: Record<string, unknown>
  ): void {
    const active = this.activeTurnForNotification(params)
    if (!active) {
      this.respondToUnsupportedAppServerRequest(host, id, method)
      return
    }
    if (method === 'item/tool/call') {
      if (
        active.host !== host ||
        params['threadId'] !== active.nativeThreadId ||
        params['turnId'] !== active.turnId
      ) {
        this.respondToUnsupportedAppServerRequest(host, id, method)
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
        this.serverRequests.set(String(id), request)
        this.emit({
          type: 'question.asked',
          sessionId: active.session.id,
          requestId: String(id),
          questions
        })
        return
      }
      void this.callUtilityTool(active, params).then((result) => {
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
      this.serverRequests.set(String(id), request)
      this.emit({
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
      this.serverRequests.set(String(id), request)
      this.emit({
        type: 'question.asked',
        sessionId: active.session.id,
        requestId: String(id),
        questions
      })
      return
    }
    this.respondToUnsupportedAppServerRequest(host, id, method)
  }

  private writeServerResponse(request: CodexServerRequest, result: Record<string, unknown>): void {
    request.host.child.stdin?.write(`${JSON.stringify({ id: request.id, result })}\n`)
  }

  /** Resolve credentials from the owning session on every structured tool call. */
  private async callUtilityTool(
    active: CodexAppServerTurn,
    params: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    try {
      const tool = GATEWAY_TOOLS.find(({ name }) => name === params['tool'])
      const endpoint = this.utilityEndpoints.get(active.session.id)
      if (!tool || !endpoint || active.finished) {
        throw new Error('The utility tool is not active for this turn')
      }
      const response = await fetch(`${endpoint.url}${tool.route}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${endpoint.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(recordValue(params['arguments']) ?? {}),
        // The secret and suggestion cards are human-paced, so those calls wait as
        // long as the app's own deadline   the endpoint carries it   while every
        // other tool stays bounded by the short gateway timeout.
        signal: AbortSignal.timeout(
          tool.name === ASK_SECRET_TOOL_NAME || tool.name === UTILITY_SUGGEST_TOOL_NAME
            ? endpoint.timeoutMs
            : 120_000
        )
      })
      const result: unknown = await response.json()
      const body = recordValue(result)
      if (!response.ok) {
        throw new Error(stringValue(body?.['error']) ?? 'Utility tool call failed')
      }
      const content = body?.['content']
      const contentItems = Array.isArray(content)
        ? content.map<Record<string, unknown>>((item: unknown) => {
            const entry = recordValue(item)
            if (entry?.['type'] === 'image' && typeof entry['data'] === 'string') {
              return {
                type: 'inputImage',
                imageUrl: `data:${stringValue(entry['mimeType']) ?? 'image/png'};base64,${entry['data']}`
              }
            }
            return { type: 'inputText', text: stringValue(entry?.['text']) ?? JSON.stringify(item) }
          })
        : [{ type: 'inputText', text: JSON.stringify(result) }]
      return { success: body?.['isError'] !== true, contentItems }
    } catch (error) {
      return {
        success: false,
        contentItems: [
          {
            type: 'inputText',
            text: error instanceof Error ? error.message : 'Utility tool call failed'
          }
        ]
      }
    }
  }

  private async retryWithoutReasoningSummary(active: CodexAppServerTurn): Promise<void> {
    const startParams = active.startParams
    if (!startParams) {
      await this.completeAppServerTurn(active, active.failure ?? 'Codex turn failed')
      return
    }
    active.summaryFallbackAttempted = true
    active.failure = undefined
    const model = stringValue(startParams['model'])
    if (model) this.modelsWithoutReasoningSummaries.add(model)
    const clientUserMessageId = stringValue(startParams['clientUserMessageId'])
    try {
      const result = await this.appServerRequest(active.host, 'turn/start', {
        ...startParams,
        ...(clientUserMessageId
          ? { clientUserMessageId: `${clientUserMessageId}:summary-fallback` }
          : {}),
        summary: 'none'
      })
      const turn = recordValue(result['turn'])
      const turnId = stringValue(turn?.['id'])
      if (!turnId) throw new Error('Codex app-server did not return an active fallback turn ID')
      active.turnId = turnId
    } catch (error) {
      await this.completeAppServerTurn(
        active,
        error instanceof Error ? error.message : 'Codex fallback turn could not start'
      )
    }
  }

  /**
   * Between-turn auto-compaction reporting.
   *
   * Codex emits `contextCompaction` item notifications outside any registered
   * turn (for example an automatic compaction running between turns or right
   * at resume/turn-start, before `turn/start` registers the turn). The
   * active-turn gate would drop those notifications, so this reconciliation
   * routes them to the session that last bound the native thread, producing
   * the same compaction message the in-turn parser produces.
   */
  private reportBetweenTurnCompaction(method: string, params: Record<string, unknown>): void {
    if (method !== 'item/started' && method !== 'item/completed') return
    const threadId = notificationThreadId(params)
    if (!threadId) return
    const mapping = this.threadSessionsByNativeId.get(threadId)
    if (!mapping) return
    const item = normalizeAppServerItem(recordValue(params['item']))
    if (!item || stringValue(item['type']) !== 'contextCompaction') return
    void this.requireSession(mapping.projectPath, mapping.sessionId)
      .then((session) => {
        const parsed = parseItem(item, method === 'item/completed', session.id)
        if (!parsed) return
        if (parsed.messages) this.mergeMessages(session, parsed.messages)
        for (const event of parsed.events ?? []) {
          this.applyEventToSession(session, event)
          this.emit(event)
        }
        session.updatedAt = Date.now()
        return this.persistSession(session)
      })
      .catch((error) => Logger.dev('Codex between-turn compaction report failed:', error))
  }

  private activeTurnForNotification(
    params: Record<string, unknown>
  ): CodexAppServerTurn | undefined {
    const turn = recordValue(params['turn'])
    const threadId =
      stringValue(params['threadId']) ??
      stringValue(params['thread_id']) ??
      stringValue(turn?.['threadId']) ??
      stringValue(turn?.['thread_id'])
    const turnId =
      stringValue(params['turnId']) ?? stringValue(params['turn_id']) ?? stringValue(turn?.['id'])
    if (turnId) {
      const byTurn = [...this.activeTurns.values()].find((active) => active.turnId === turnId)
      if (byTurn) return byTurn
    }
    if (threadId) {
      const byThread = [...this.activeTurns.values()].find(
        (active) => active.nativeThreadId === threadId
      )
      if (byThread) return byThread
    }
    if (this.activeTurns.size === 1) return this.activeTurns.values().next().value
    return undefined
  }

  private emitAppServerDelta(
    active: CodexAppServerTurn,
    params: Record<string, unknown>,
    kind: 'text' | 'reasoning',
    field: 'text' | 'summary' = 'text'
  ): void {
    const itemId = stringValue(params['itemId'])
    const delta = stringValue(params['delta'])
    if (!itemId || !delta) return
    const messageId = `${active.session.id}:${itemId}`
    const event: AgentEvent = {
      type: 'message.part.delta',
      sessionId: active.session.id,
      messageId,
      partId: `${messageId}:${kind}`,
      field,
      delta
    }
    this.applyEventToSession(active.session, event)
    this.emit(event)
  }

  /**
   * Separate the summary parts Codex streams for one reasoning item.
   *
   * Codex announces a new summary part with `item/reasoning/summaryPartAdded`
   * instead of delimiting its delta stream. Without a separator between parts
   * the streamed summary ran together (`**First****Second**`), so the live text
   * never matched the completed item's newline-joined summary. Emit the same
   * newline the snapshot uses, and only between parts: the first part opens the
   * summary and needs no leading break.
   */
  private emitReasoningSummarySeparator(
    active: CodexAppServerTurn,
    params: Record<string, unknown>
  ): void {
    const itemId = stringValue(params['itemId'])
    const summaryIndex = numberValue(params['summaryIndex'])
    if (!itemId || !summaryIndex) return
    const messageId = `${active.session.id}:${itemId}`
    const event: AgentEvent = {
      type: 'message.part.delta',
      sessionId: active.session.id,
      messageId,
      partId: `${messageId}:reasoning`,
      field: 'summary',
      delta: '\n'
    }
    this.applyEventToSession(active.session, event)
    this.emit(event)
  }

  private applyCodexResult(active: CodexAppServerTurn, result: CliLineParseResult | null): void {
    if (!result) return
    if (result.nativeSessionId) active.session.nativeSessionId = result.nativeSessionId
    if (result.messages) this.mergeMessages(active.session, result.messages)
    for (const event of result.events ?? []) {
      this.applyEventToSession(active.session, event)
      this.emit(event)
    }
    active.session.updatedAt = Date.now()
  }

  private appServerRequest(
    host: CodexAppServerHost,
    method: string,
    params?: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    if (host.stopped) return Promise.reject(new Error('Codex app-server is not running'))
    if (!host.child.stdin) return Promise.reject(new Error('Codex app-server stdin is closed'))
    const id = ++host.nextRequestId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        host.pending.delete(id)
        reject(new Error(`Codex app-server ${method} request timed out`))
      }, CODEX_APP_SERVER_REQUEST_TIMEOUT_MS)
      host.pending.set(id, { resolve, reject, timer })
      host.child.stdin?.write(`${JSON.stringify({ id, method, ...(params ? { params } : {}) })}\n`)
    })
  }

  private appServerNotify(host: CodexAppServerHost, method: string): void {
    host.child.stdin?.write(`${JSON.stringify({ method })}\n`)
  }

  private respondToUnsupportedAppServerRequest(
    host: CodexAppServerHost,
    id: string | number,
    method: string
  ): void {
    host.child.stdin?.write(
      `${JSON.stringify({
        id,
        error: {
          code: -32601,
          message: `CodeInOven does not support Codex server request ${method}`
        }
      })}\n`
    )
  }

  private async completeAppServerTurn(
    active: CodexAppServerTurn,
    error?: string,
    issue?: AgentProviderIssue
  ): Promise<void> {
    if (!error) {
      try {
        const result = await this.appServerRequest(active.host, 'account/rateLimits/read')
        const telemetry = mapCodexRateLimits(result)
        const finalMessage = [...active.session.messages]
          .reverse()
          .find((message) => message.role === 'assistant')
        if (
          (telemetry.rateLimits.length > 0 || telemetry.credits || telemetry.bankedResets) &&
          finalMessage
        ) {
          const event: AgentEvent = {
            type: 'usage.updated',
            sessionId: active.session.id,
            messageId: finalMessage.id,
            ...(telemetry.rateLimits.length > 0 ? { rateLimits: telemetry.rateLimits } : {}),
            ...(telemetry.credits ? { credits: telemetry.credits } : {}),
            ...(telemetry.bankedResets ? { bankedResets: telemetry.bankedResets } : {})
          }
          this.applyEventToSession(active.session, event)
          this.emit(event)
        }
      } catch (refreshError) {
        Logger.dev('Codex account rate-limit refresh unavailable:', refreshError)
      }
    }
    await this.finishAppServerTurn(active, error, issue)
  }

  private async finishAppServerTurn(
    active: CodexAppServerTurn,
    error?: string,
    issue?: AgentProviderIssue
  ): Promise<void> {
    if (active.finished) return
    active.finished = true
    if (this.activeTurns.get(active.session.id) === active) {
      this.activeTurns.delete(active.session.id)
    }
    try {
      await this.persistSession(active.session)
    } catch (persistError) {
      Logger.error('Codex app-server session persistence failed:', persistError)
      error ??= 'Codex session could not be persisted'
    }
    if (error) {
      this.emit({
        type: 'session.error',
        sessionId: active.session.id,
        error,
        ...(issue ? { issue } : {})
      })
    }
    this.emit({ type: 'session.idle', sessionId: active.session.id })
  }

  /** A graceful harness failure for a dead Codex app-server: the user-facing
   *  message is a retryable harness error, and the raw detail stays scoped to
   *  the raw-error modal instead of splashing on the status card. */
  private gracefulAppServerIssue(error: string): AgentProviderIssue {
    return {
      kind: classifyProviderIssue(error),
      message:
        'The Codex app-server stopped unexpectedly. Retry the message to continue your work.',
      rawError: error,
      harnessId: this.id,
      retryable: true
    }
  }

  private async failAppServerHost(host: CodexAppServerHost, error: string): Promise<void> {
    if (host.stopped) return
    host.stopped = true
    this.appServerHosts.delete(host)
    for (const [projectPath, candidate] of this.hostsByProjectPath) {
      if (candidate !== host) continue
      this.hostsByProjectPath.delete(projectPath)
      break
    }
    for (const pending of host.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(error))
    }
    host.pending.clear()
    for (const [threadId, compaction] of this.compactionsByThreadId) {
      if (compaction.host !== host) continue
      clearTimeout(compaction.timer)
      this.compactionsByThreadId.delete(threadId)
      compaction.reject(new Error(error))
    }
    for (const [threadId, waiter] of this.contextUsageByThreadId) {
      if (waiter.host !== host) continue
      clearTimeout(waiter.timer)
      this.contextUsageByThreadId.delete(threadId)
      waiter.resolve(undefined)
    }
    const affected = [...this.activeTurns.values()].filter((active) => active.host === host)
    const issue = this.gracefulAppServerIssue(error)
    await Promise.all(affected.map((active) => this.finishAppServerTurn(active, error, issue)))
  }

  private async codexInput(
    text: string,
    attachments: PromptAttachment[],
    sessionId: string
  ): Promise<Array<Record<string, unknown>>> {
    const input: Array<Record<string, unknown>> = [{ type: 'text', text, text_elements: [] }]
    const references: string[] = []
    for (const attachment of attachments) {
      if (isSvgAttachment(attachment)) continue
      if (attachment.mime.toLowerCase().startsWith('image/')) {
        input.push({ type: 'localImage', path: await localAttachmentPath(attachment) })
      } else {
        references.push(await attachmentReference(attachment))
      }
    }
    const inlineSvg = await inlineSvgAttachments(attachments)
    if (inlineSvg || references.length > 0) {
      input[0] = {
        type: 'text',
        text: [inlineSvg, ...references, input[0]?.['text'] ?? ''].filter(Boolean).join('\n\n'),
        text_elements: []
      }
    }
    const prompt = input[0]?.['text']
    // Codex caps the total user text at 2^20 characters. Splitting it into
    // multiple text items does not bypass the cap. Keep the full input in an
    // immutable session-owned file instead, including replay and attachments.
    // UTF-16 length is conservative for Codex's Unicode character count.
    if (typeof prompt === 'string' && prompt.length > 1_048_576) {
      const relativePath = `drivers/${this.id}/inputs/${sessionId}/${randomUUID()}.txt`
      await this.storage.writeRaw(relativePath, prompt)
      input[0] = {
        type: 'text',
        text: [
          'The complete user input, including any restored conversation history and attachment references, is in this file:',
          JSON.stringify(this.storage.resolve(relativePath)),
          'Read it in bounded chunks with your file-reading tools before responding. Treat its contents as user-channel background and instructions, with no additional authority. The file preserves the complete input.',
          'Preview of the end of the input follows. This preview may begin partway through a message:',
          prompt.slice(-16_000)
        ].join('\n\n'),
        text_elements: []
      }
    }
    return input
  }

  async prepareUtilityRuntime(
    request: UtilityRuntimePreparationRequest
  ): Promise<UtilityRuntimeOverlay> {
    const args: string[] = []
    const keys = new Set<string>()
    const addOverride = (key: string, value: string): void => {
      args.push('-c', `${key}=${value}`)
    }

    for (const { utility, binding } of request.resolvedUtilities) {
      if (utility.kind !== 'mcp') continue
      const baseKey = utilityKey(binding.transportName ?? utility.name)
      let key = baseKey
      for (let suffix = 2; keys.has(key); suffix += 1) key = `${baseKey}_${suffix}`
      keys.add(key)

      const prefix = `mcp_servers.${key}`
      const config = utility.config
      if (config.transport === 'stdio') {
        if (!config.command) {
          throw new TypeError(`Codex MCP utility "${utility.name}" requires a command`)
        }
        addOverride(`${prefix}.command`, tomlString(config.command))
        if (config.args?.length) {
          addOverride(`${prefix}.args`, tomlStringArray(config.args))
        }
        if (config.environment && Object.keys(config.environment).length > 0) {
          addOverride(`${prefix}.env`, tomlStringMap(config.environment))
        }
        continue
      }
      if (!config.url) {
        throw new TypeError(`Codex MCP utility "${utility.name}" requires a URL`)
      }
      addOverride(`${prefix}.url`, tomlString(config.url))
    }

    return args.length > 0 ? { args } : {}
  }

  /**
   * Codex item ids are only unique within a Codex thread, so every id is
   * namespaced with the CodeInOven session when parsed. Normalize native item
   * ids on read and collapse duplicate ids a resumed thread can produce.
   */
  async loadMessages(projectPath: string, sessionId: string): Promise<AgentMessage[]> {
    try {
      const messages = await super.loadMessages(projectPath, sessionId)
      return this.normalizeSessionMessages(messages, sessionId)
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('CLI session is unavailable:')) {
        throw error
      }
      return this.loadNativeThreadMessages(projectPath, sessionId)
    }
  }

  async loadMessagesSince(
    projectPath: string,
    sessionId: string,
    messageId: string
  ): Promise<AgentMessage[]> {
    try {
      const messages = await super.loadMessagesSince(projectPath, sessionId, messageId)
      return this.normalizeSessionMessages(messages, sessionId)
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('CLI session is unavailable:')) {
        throw error
      }
      const messages = await this.loadNativeThreadMessages(projectPath, sessionId)
      const startIndex = messages.findLastIndex((message) => message.id === messageId)
      return startIndex >= 0 ? messages.slice(startIndex) : messages
    }
  }

  private async loadNativeThreadMessages(
    projectPath: string,
    nativeThreadId: string
  ): Promise<AgentMessage[]> {
    const host = await this.ensureAppServerHost(projectPath)
    const result = await this.appServerRequest(host, 'thread/read', {
      threadId: nativeThreadId,
      includeTurns: true
    })
    const thread = recordValue(result['thread']) ?? result
    const turns = Array.isArray(thread['turns']) ? thread['turns'] : []
    const messages: AgentMessage[] = []
    for (const turnValue of turns) {
      const turn = recordValue(turnValue)
      const items = turn && Array.isArray(turn['items']) ? turn['items'] : []
      for (const itemValue of items) {
        const item = normalizeAppServerItem(recordValue(itemValue))
        if (!item) continue
        const parsed = parseItem(item, true, nativeThreadId)
        if (parsed?.messages) messages.push(...parsed.messages)
      }
    }
    return this.normalizeSessionMessages(messages, nativeThreadId).map((message) => ({
      ...message,
      origin: 'subagent',
      visibility: 'subagent_trace'
    }))
  }

  private normalizeSessionMessages(messages: AgentMessage[], sessionId: string): AgentMessage[] {
    const byId = new Map<string, AgentMessage>()
    for (const message of messages) {
      const renamed = namespacedMessage(message, sessionId)
      byId.set(renamed.id, renamed)
    }
    return [...byId.values()].sort((left, right) => left.createdAt - right.createdAt)
  }

  /** Fast inference enables Codex's `service_tier = "fast"` mode via config override. */
  protected async buildTurnCommand(
    _projectPath: string,
    session: PersistentCliSession,
    options: Parameters<PersistentCliDriver['sendPrompt']>[1]
  ): Promise<CliTurnCommand> {
    void _projectPath
    const nativeSessionId = session.nativeSessionId
    const fullAccess =
      options.settings.permissionLevel === 'full_access' && options.readOnly !== true
    const args = fullAccess ? ['--dangerously-bypass-approvals-and-sandbox', 'exec'] : ['exec']
    if (nativeSessionId) args.push('resume', nativeSessionId)
    const sandbox = sandboxFor(options.readOnly === true, options.settings.permissionLevel)
    args.push('--json')
    if (nativeSessionId) args.push('-c', `sandbox_mode=${tomlString(sandbox)}`)
    else args.push('--sandbox', sandbox)

    if (options.settings.modelId) args.push('--model', options.settings.modelId)
    const fastInference =
      options.settings.inferenceMode === 'fast' && options.settings.providerId === 'openai'
    const serviceTier =
      options.settings.providerId === 'openai' && options.settings.inferenceMode === 'ultrafast'
        ? 'ultrafast'
        : fastInference
          ? 'fast'
          : 'default'
    args.push(
      '-c',
      `service_tier=${serviceTier}`,
      '-c',
      `features.fast_mode=${serviceTier !== 'default'}`
    )
    if (options.settings.contextWindow && options.settings.providerId === 'openai') {
      args.push(
        '-c',
        `model_context_window=${options.settings.contextWindow}`,
        '-c',
        `model_auto_compact_token_limit=${Math.floor(options.settings.contextWindow * 0.9)}`
      )
    }
    const { env, args: providerArgs } = await this.customProviderOverlay()
    args.push(...providerArgs)
    const inlineSvg = await inlineSvgAttachments(options.attachments)
    const attachmentPrompts: string[] = []
    for (const attachment of options.attachments) {
      if (isSvgAttachment(attachment)) continue
      if (attachment.mime.toLowerCase().startsWith('image/')) {
        args.push('--image', await localAttachmentPath(attachment))
      } else {
        attachmentPrompts.push(await attachmentReference(attachment))
      }
    }
    const promptBody = [
      inlineSvg,
      ...attachmentPrompts,
      composePrompt(options.systemPrompt, prependHistoryRecap(options.text, options.historyRecap))
    ]
      .filter(Boolean)
      .join('\n\n')
    args.push(promptBody)
    return {
      command: 'codex',
      args,
      env: {
        ...buildProcessEnvironment({ ...process.env, ...this.accountEnvironment }),
        ...env
      },
      provenanceModelId: resolveFastModelId(
        options.settings.modelId,
        fastInference ? 'fast' : 'normal'
      )
    }
  }

  async compactSession(
    projectPath: string,
    sessionId: string,
    _settings: ThreadSettings
  ): Promise<void> {
    void _settings
    const nativeThreadId = await this.nativeSessionId(projectPath, sessionId)
    const session = await this.requireSession(projectPath, sessionId)
    const messageId = `${sessionId}:compaction:${Date.now()}`
    const partId = `${messageId}:compaction`
    const basePart = {
      type: 'compaction' as const,
      id: partId,
      messageID: messageId,
      auto: false
    }
    session.messages.push({
      id: messageId,
      role: 'assistant',
      parts: [basePart],
      createdAt: Date.now(),
      harnessId: this.id
    })

    this.emit({ type: 'session.status', sessionId, status: { state: 'working' } })
    this.applyEventToSession(session, { type: 'message.part.updated', sessionId, part: basePart })
    this.emit({ type: 'message.part.updated', sessionId, part: basePart })

    const host = await this.ensureAppServerHost(projectPath)
    // `thread/compact/start` only accepts threads the app-server has loaded.
    // Loading (resuming) first is a no-op when the thread is already loaded, and
    // it turns the "thread not found" rejection into a real compaction run.
    await this.appServerRequest(host, 'thread/resume', {
      threadId: nativeThreadId,
      excludeTurns: true,
      developerInstructions: null
    })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.compactionsByThreadId.delete(nativeThreadId)
        reject(new Error('Codex compaction timed out'))
      }, CODEX_COMPACTION_TIMEOUT_MS)
      this.compactionsByThreadId.set(nativeThreadId, {
        host,
        session,
        messageId,
        basePart,
        resolve,
        reject,
        timer
      })
      void this.appServerRequest(host, 'thread/compact/start', { threadId: nativeThreadId }).catch(
        (error: unknown) => {
          clearTimeout(timer)
          this.compactionsByThreadId.delete(nativeThreadId)
          reject(error instanceof Error ? error : new Error('Codex compaction failed'))
        }
      )
    }).catch((error) => {
      const failed: AgentEvent = {
        type: 'message.completed',
        sessionId,
        messageId,
        error: error instanceof Error ? error.message : 'Codex compaction failed',
        compaction: true
      }
      this.applyEventToSession(session, failed)
      this.emit(failed)
      this.emit({ type: 'session.idle', sessionId })
      throw error
    })
  }

  /**
   * Inject every enabled custom base-URL provider as a Codex `model_providers.<id>`
   * override plus its vaulted API key env var. Models are selected as `<id>/<model>`.
   */
  private async customProviderOverlay(): Promise<{ env: Record<string, string>; args: string[] }> {
    const env: Record<string, string> = {}
    const args: string[] = []
    if (!this.baseUrlProviders || !this.secretVault) return { env, args }
    const customProviders = await this.baseUrlProviders.listEnabled(this.id)
    for (const custom of customProviders) {
      const wireApi = custom.npm === '@ai-sdk/openai' ? 'responses' : 'chat'
      args.push('-c', `model_providers.${custom.id}.name=${tomlString(custom.name)}`)
      args.push('-c', `model_providers.${custom.id}.base_url=${tomlString(custom.baseURL)}`)
      args.push('-c', `model_providers.${custom.id}.wire_api=${tomlString(wireApi)}`)
      if (custom.apiKeyRef && custom.apiKeyEnvVar) {
        const apiKey = await this.secretVault.resolve(custom.apiKeyRef)
        env[custom.apiKeyEnvVar] = apiKey
        args.push('-c', `model_providers.${custom.id}.env_key=${tomlString(custom.apiKeyEnvVar)}`)
      }
      if (custom.headers && Object.keys(custom.headers).length > 0) {
        args.push(
          '-c',
          `model_providers.${custom.id}.http_headers=${tomlStringMap(custom.headers)}`
        )
      }
    }
    return { env, args }
  }

  /** Refresh account quota data through Codex's supported app-server surface. */
  private async refreshRateLimits(
    projectPath: string,
    session: PersistentCliSession,
    messageId: string
  ): Promise<void> {
    const host = await this.ensureAppServerHost(projectPath)
    const telemetry = mapCodexRateLimits(
      await this.appServerRequest(host, 'account/rateLimits/read')
    )

    if (telemetry.rateLimits.length === 0 && !telemetry.credits && !telemetry.bankedResets) return
    const event: AgentEvent = {
      type: 'usage.updated',
      sessionId: session.id,
      messageId,
      ...(telemetry.rateLimits.length > 0 ? { rateLimits: telemetry.rateLimits } : {}),
      ...(telemetry.credits ? { credits: telemetry.credits } : {}),
      ...(telemetry.bankedResets ? { bankedResets: telemetry.bankedResets } : {})
    }
    this.applyEventToSession(session, event)
    this.emit(event)
    await this.persistSession(session)
  }

  /**
   * Fetch current quota telemetry through the resident app-server, including
   * for old threads whose turns predate quota capture.
   */
  async readAccountUsage(projectPath: string): Promise<{
    rateLimits: AgentRateLimitWindow[]
    credits?: AgentUsageCredits
    bankedResets?: AgentBankedResets
    reauthenticationRequired?: boolean
  } | null> {
    let temporaryHost: CodexAppServerHost | null = null
    try {
      const host =
        this.hostsByProjectPath.has(projectPath) || this.hostsStartingByProjectPath.has(projectPath)
          ? await this.ensureAppServerHost(projectPath)
          : (temporaryHost = await this.createAppServerHost(projectPath))
      const telemetry = mapCodexRateLimits(
        await this.appServerRequest(host, 'account/rateLimits/read')
      )
      if (telemetry.rateLimits.length === 0 && !telemetry.credits && !telemetry.bankedResets) {
        return null
      }
      return telemetry
    } catch (error) {
      Logger.dev('Codex on-demand account usage refresh unavailable:', error)
      if (
        error instanceof Error &&
        /401 Unauthorized[\s\S]*token_expired|token_expired[\s\S]*401 Unauthorized/iu.test(
          error.message
        )
      ) {
        return { rateLimits: [], reauthenticationRequired: true }
      }
      return null
    } finally {
      if (temporaryHost) {
        this.stopAppServerHost(temporaryHost, 'Codex account usage probe completed')
      }
    }
  }

  /**
   * Redeem one banked rate-limit reset credit. Destructive and irreversible:
   * it immediately resets the account's active 5-hour and weekly usage
   * windows and consumes one banked credit. The caller is responsible for
   * confirming with the user before invoking this.
   */
  async activateBankedReset(projectPath: string): Promise<{
    rateLimits: AgentRateLimitWindow[]
    credits?: AgentUsageCredits
    bankedResets?: AgentBankedResets
  } | null> {
    let temporaryHost: CodexAppServerHost | null = null
    try {
      const host =
        this.hostsByProjectPath.has(projectPath) || this.hostsStartingByProjectPath.has(projectPath)
          ? await this.ensureAppServerHost(projectPath)
          : (temporaryHost = await this.createAppServerHost(projectPath))
      const usage = mapCodexRateLimits(await this.appServerRequest(host, 'account/rateLimits/read'))
      const now = Date.now()
      let selectedCredit: NonNullable<AgentBankedResets['credits']>[number] | undefined
      for (const credit of usage.bankedResets?.credits ?? []) {
        if (typeof credit.expiresAt === 'number' && credit.expiresAt <= now) continue
        if (
          !selectedCredit ||
          (credit.expiresAt ?? Infinity) < (selectedCredit.expiresAt ?? Infinity)
        ) {
          selectedCredit = credit
        }
      }
      // Prefer the earliest known expiry. Count-only responses from older
      // app-server versions still use the provider's default selection.
      await this.appServerRequest(host, 'account/rateLimitResetCredit/consume', {
        idempotencyKey: randomUUID(),
        ...(selectedCredit ? { creditId: selectedCredit.id } : {})
      })
      return mapCodexRateLimits(await this.appServerRequest(host, 'account/rateLimits/read'))
    } finally {
      if (temporaryHost) {
        this.stopAppServerHost(temporaryHost, 'Codex banked reset activation completed')
      }
    }
  }

  /** Read persisted thread usage that `codex exec --json` does not stream. */
  private async refreshContextUsage(
    projectPath: string,
    session: PersistentCliSession,
    messageId: string,
    nativeThreadId: string
  ): Promise<void> {
    const host = await this.ensureAppServerHost(projectPath)
    const usagePromise = new Promise<ReturnType<typeof mapCodexUsage>>((resolve) => {
      const timer = setTimeout(() => {
        this.contextUsageByThreadId.delete(nativeThreadId)
        resolve(undefined)
      }, CODEX_USAGE_TIMEOUT_MS)
      this.contextUsageByThreadId.set(nativeThreadId, { host, resolve, timer })
    })
    try {
      await this.appServerRequest(host, 'thread/resume', {
        threadId: nativeThreadId,
        excludeTurns: true
      })
    } catch (error) {
      const waiter = this.contextUsageByThreadId.get(nativeThreadId)
      if (waiter) clearTimeout(waiter.timer)
      this.contextUsageByThreadId.delete(nativeThreadId)
      throw error
    }
    const usage = await usagePromise

    if (!usage) return
    const event: AgentEvent = {
      type: 'usage.updated',
      sessionId: session.id,
      messageId,
      ...(usage.aggregateTokens ? { tokens: usage.aggregateTokens } : {}),
      ...(usage.normalizedUsage ? { normalizedUsage: usage.normalizedUsage } : {}),
      ...(usage.contextUsed === undefined ? {} : { contextUsed: usage.contextUsed }),
      ...(usage.contextWindow === undefined ? {} : { contextWindow: usage.contextWindow })
    }
    if (usage.normalizedUsage) {
      const target = session.messages.find((candidate) => candidate.id === messageId)
      if (target) target.normalizedUsage = usage.normalizedUsage
    }
    this.applyEventToSession(session, event)
    this.emit(event)
    await this.persistSession(session)
  }

  protected parseJsonLine(value: unknown, context: CliLineParseContext): CliLineParseResult | null {
    return parseCodexJsonLine(value, context, {
      refreshContextUsage: (projectPath, session, messageId, nativeThreadId) =>
        this.refreshContextUsage(projectPath, session, messageId, nativeThreadId),
      refreshRateLimits: (projectPath, session, messageId) =>
        this.refreshRateLimits(projectPath, session, messageId)
    })
  }
}
