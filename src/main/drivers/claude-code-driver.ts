import { execFile, spawn, type ChildProcess } from 'child_process'
import type {
  AgentRateLimitWindow,
  HarnessCommand,
  ProviderCatalog,
  PermissionReply,
  SessionAgentEvent,
  ThreadSettings
} from '../../lib/types'
import { fastSelectionModelId, resolveFastModelId } from '../../lib/fast-inference'
import type { StorageEngine } from '../storage/storage-engine'
import { BaseUrlProviderService } from '../providers/base-url-provider-service'
import { CLAUDE_CREDENTIAL_LOCK_NAME, CrossProcessMutex } from '../system/cross-process-mutex'
import { Logger } from '../system/logger'
import { SecretVault } from '../storage/secret-vault'
import { prepareHarnessInvocation, runHarnessCommand } from './harness-runtime'
import type {
  CheapModelRequest,
  CheapModelResult,
  GenerateTitleOptions,
  GradeTurnOptions,
  HarnessAuthStatus,
  HarnessCapabilities,
  SendPromptOptions,
  SteerPromptOptions,
  UtilityRuntimeOverlay,
  UtilityRuntimePreparationRequest
} from './driver.interface'
import { InactiveQuestionTurnError, QuestionRequestGoneError } from './driver.interface'
import type {
  CliLineParseContext,
  CliLineParseResult,
  CliTurnCommand,
  PersistentCliSession,
  TitleModelCandidate
} from './persistent-cli-driver'
import { PersistentCliDriver } from './persistent-cli-driver'
import {
  AUTH_CONFIRM_POLL_MS,
  AUTH_CONFIRM_TIMEOUT_MS,
  ONE_SHOT_SPAWN_LIMIT,
  OneShotSpawnGate,
  PRE_FLIGHT_AUTH_PROBE_TTL_MS,
  PRE_FLIGHT_AUTH_PROBE_TIMEOUT_MS,
  buildClaudeEnvironment,
  claudeToolName
} from './claude-code/claude-environment'
import {
  CLAUDE_COMMANDS_REQUIRING_ARGUMENTS,
  CLAUDE_NON_INTERACTIVE_COMMANDS,
  claudeEffort,
  utilityKey
} from './claude-code/claude-commands'
import {
  CLAUDE_ASYNC_AGENT_CLOSE_GRACE_MS,
  CLAUDE_ASYNC_AGENT_MAX_HOLD_MS,
  sameClaudeQuestions
} from './claude-code/claude-session-state'
import type {
  ClaudeAuthenticationReadiness,
  ClaudePermissionRequest,
  ClaudeQuestionRequest,
  ClaudeUsageProbe
} from './claude-code/claude-session-state'
import {
  THINKING_PRESETS,
  claudeAuthenticationResult,
  discoverClaudeModels,
  fallbackClaudeModel
} from './claude-code/claude-models'
import { CLAUDE_USAGE_TIMEOUT_MS, rateLimitWindows } from './claude-code/claude-usage'
import type { ClaudeAccountUsage } from './claude-code/claude-usage'
import { claudeStreamInput } from './claude-code/claude-attachments'
import { activeClaudeSubagentParts, latestAssistant } from './claude-code/claude-parts'
import { mapClaudeCodeRecord } from './claude-code/claude-stream-fold'
import { numberProperty, record, string } from './claude-code/claude-values'

export { mapClaudeCodeRecord }

export class ClaudeCodeDriver extends PersistentCliDriver {
  readonly id = 'claude-code'
  readonly name = 'Claude Code'
  readonly capabilities: HarnessCapabilities = {
    runtimeTopology: { kind: 'turn_process', scope: 'session' },
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
    structuredOutput: true,
    nativeUtilities: ['web_search', 'web_fetch']
  }
  private readonly pendingRateLimits = new Map<string, AgentRateLimitWindow[]>()
  private readonly activeUsageProbes = new Map<string, ClaudeUsageProbe>()
  private readonly authenticationReadiness = new Map<string, ClaudeAuthenticationReadiness>()
  /** Cached `claude auth status` verdict per project, so a fresh thread never
   *  re-spawns the CLI for auth on every message. */
  private readonly authProbeCache = new Map<string, { authenticated: boolean; at: number }>()
  /** Bounds concurrent one-shot claude spawns to keep the fd table stable. */
  private readonly oneShotSpawnGate = new OneShotSpawnGate(ONE_SHOT_SPAWN_LIMIT)
  /**
   * Cross-process credential-refresh mutex. Multiple app instances each hold
   * their own in-memory auth slot, so they cannot serialize each other's claude
   * spawns; this shared atomic lock closes that gap for every CodeInOven instance
   * using the same config root.
   */
  private readonly crossProcessAuthLock = new CrossProcessMutex(CLAUDE_CREDENTIAL_LOCK_NAME)
  /** Sessions whose current process has proved authentication. */
  private readonly authenticatedSessions = new Set<string>()
  private readonly pendingClaudeQuestions = new Map<string, ClaudeQuestionRequest>()
  private readonly pendingClaudePermissions = new Map<string, ClaudePermissionRequest>()
  /** Scheduled stdin closes for turn processes still running background agents. */
  private readonly asyncAgentCloseTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Absolute stdin-close deadlines, immune to stdout-driven grace resets. */
  private readonly asyncAgentHoldDeadlines = new Map<string, ReturnType<typeof setTimeout>>()
  /** Held while a first-party session spawn may be refreshing the credential. */
  private authSlotHeld = false
  /** Resolved when the current credential-refresh window closes. */
  private authSlot: Promise<void> = Promise.resolve()
  private usageProbeSequence = 0

  constructor(
    storage: StorageEngine,
    private readonly baseUrlProviders?: BaseUrlProviderService,
    private readonly secretVault?: SecretVault,
    private readonly accountEnvironment: NodeJS.ProcessEnv = {}
  ) {
    super(storage)
  }

  async listProviders(projectPath: string): Promise<ProviderCatalog[]> {
    let anthropicCatalog: ProviderCatalog
    try {
      const models = await this.runAuthSerialized(() =>
        discoverClaudeModels(projectPath, this.accountEnvironment)
      )
      if (models.length === 0) throw new Error('Claude Code returned no account-selectable models')
      anthropicCatalog = {
        id: 'anthropic',
        name: 'Anthropic',
        harnessId: 'claude-code',
        models
      }
    } catch (error) {
      Logger.info('Claude Code model discovery fell back to the account default', {
        error: error instanceof Error ? error.message : String(error)
      })
      anthropicCatalog = {
        id: 'anthropic',
        name: 'Anthropic',
        harnessId: 'claude-code',
        models: [fallbackClaudeModel()],
        catalogStatus: 'unavailable',
        catalogMessage: 'Claude Code could not report account-selectable models; using Default.'
      }
    }
    if (!this.baseUrlProviders) return [anthropicCatalog]
    const customProviders = await this.baseUrlProviders.listEnabled(this.id)
    if (customProviders.length === 0) return [anthropicCatalog]
    return [
      anthropicCatalog,
      ...customProviders.map((custom) => ({
        id: custom.id,
        name: custom.name,
        harnessId: 'claude-code',
        models: custom.models.map((model) => ({
          id: model.id,
          providerId: custom.id,
          name: model.name || model.id,
          reasoning: model.reasoning,
          thinkingPresets: model.reasoning
            ? (model.thinkingPresets ?? THINKING_PRESETS)
            : undefined,
          attachment: model.vision !== false,
          toolcall: true,
          ...(model.contextWindow ? { contextWindow: model.contextWindow } : {})
        }))
      }))
    ]
  }

  override async listCommands(): Promise<HarnessCommand[]> {
    return CLAUDE_NON_INTERACTIVE_COMMANDS.map((command) => ({ ...command }))
  }

  override async runCommand(
    projectPath: string,
    sessionId: string,
    command: HarnessCommand,
    args: string,
    settings: ThreadSettings
  ): Promise<void> {
    const trimmedArgs = args.trim()
    if (command.source !== 'skill' && CLAUDE_COMMANDS_REQUIRING_ARGUMENTS.has(command.name)) {
      if (!trimmedArgs) {
        throw new Error(`/${command.name} requires arguments in ${this.name}`)
      }
    }
    const text = `/${command.name}${trimmedArgs ? ` ${trimmedArgs}` : ''}`
    await this.sendPrompt(projectPath, {
      sessionId,
      settings,
      text,
      attachments: []
    })
  }

  /**
   * Compact the thread by resuming Claude's native session with the `/compact`
   * slash command in a one-shot print process. Claude writes its own
   * `compact_boundary` record into the resumed session and emits it on the
   * stream, which the record parser mirrors as a compaction checkpoint; the
   * normal turn machinery then reports idle. Throws when the session has no
   * native id yet (nothing to resume) or Claude reports "no messages".
   */
  async compactSession(
    projectPath: string,
    sessionId: string,
    settings: ThreadSettings
  ): Promise<void> {
    const session = await this.requireSession(projectPath, sessionId)
    if (!session.nativeSessionId) {
      throw new Error('No Claude Code session is available to compact yet')
    }
    this.emit({ type: 'session.status', sessionId, status: { state: 'working' } })
    try {
      await this.sendPrompt(projectPath, {
        sessionId,
        settings,
        text: '/compact',
        attachments: []
      })
    } catch (error) {
      this.emit({ type: 'session.idle', sessionId })
      throw error
    }
  }

  /** Haiku is Claude Code's single cheap auxiliary candidate. */
  private async cheapAnthropicCandidates(_projectPath: string): Promise<TitleModelCandidate[]> {
    void _projectPath
    // The stable alias is attempted directly. The shared one-shot runner adds
    // the conversation model as the only fallback on timeout or failure.
    return [{ providerId: 'anthropic', modelId: 'haiku' }]
  }

  async generateTitle(projectPath: string, options: GenerateTitleOptions): Promise<string | null> {
    if (!(await this.auxiliaryTransportReady(options))) return null
    return this.generateTitleWithCandidates(
      projectPath,
      options,
      await this.cheapAnthropicCandidates(projectPath)
    )
  }

  async gradeTurn(projectPath: string, options: GradeTurnOptions): Promise<number | null> {
    if (!(await this.auxiliaryTransportReady(options))) return null
    return this.gradeTurnWithCandidates(
      projectPath,
      options,
      await this.cheapAnthropicCandidates(projectPath)
    )
  }

  async provideCheapModel(
    projectPath: string,
    request: CheapModelRequest
  ): Promise<CheapModelResult> {
    if (!(await this.auxiliaryTransportReady(request))) {
      return { text: null, attempts: [] }
    }
    return super.provideCheapModel(projectPath, request)
  }

  /** Cheapest first-party candidates for any auxiliary one-shot run. */
  protected override async cheapCandidateModels(
    projectPath: string
  ): Promise<TitleModelCandidate[]> {
    return this.cheapAnthropicCandidates(projectPath)
  }

  /**
   * Authentication/transport gate shared by auxiliary one-shot runs. Non-Anthropic
   * providers always pass; first-party runs require the parent session's
   * authenticated transport.
   */
  private async auxiliaryTransportReady(
    options: GenerateTitleOptions | GradeTurnOptions | CheapModelRequest
  ): Promise<boolean> {
    const firstParty = !options.settings.providerId || options.settings.providerId === 'anthropic'
    if (
      !firstParty ||
      !options.parentSessionId ||
      (await this.waitForParentAuthentication(options.parentSessionId))
    ) {
      return true
    }
    // Silent nulls here made auxiliary runs (titles, grading) undiagnosable.
    Logger.dev('Claude Code auxiliary transport gate: parent session not authenticated')
    return false
  }

  /** Append user input to Claude's realtime stream while its turn is active. */
  async steerPrompt(projectPath: string, options: SteerPromptOptions): Promise<void> {
    const session = await this.requireSession(projectPath, options.sessionId)
    this.writeActiveInput(
      session.id,
      await claudeStreamInput(options.text, options.attachments, 'now')
    )
    this.appendUserMessage(session, options)
    await this.persistSession(session)
  }

  override async replyPermission(
    _projectPath: string,
    requestId: string,
    reply: PermissionReply,
    message?: string,
    sessionId?: string
  ): Promise<void> {
    const pending = this.pendingClaudePermissions.get(requestId)
    const targetSessionId = sessionId ?? pending?.sessionId
    if (!targetSessionId || !pending)
      throw new Error(`Claude permission request is no longer pending: ${requestId}`)
    const response = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: {
          behavior: reply === 'reject' ? 'deny' : 'allow',
          ...(reply === 'reject' ? {} : { updatedInput: pending.input }),
          ...(message ? { message } : {})
        }
      }
    }
    this.writeActiveInput(targetSessionId, `${JSON.stringify(response)}\n`)
    this.pendingClaudePermissions.delete(requestId)
  }

  override async replyToQuestion(
    _projectPath: string,
    sessionId: string,
    requestId: string,
    answers: string[][]
  ): Promise<void> {
    const request = this.pendingClaudeQuestions.get(requestId)
    if (!request || request.sessionId !== sessionId) {
      throw new QuestionRequestGoneError(sessionId, requestId, this.name)
    }
    const answersByPrompt = Object.fromEntries(
      request.questions.map((question, index) => [
        question.prompt,
        (answers[index] ?? []).join(', ')
      ])
    )
    this.writeQuestionResponse(sessionId, requestId, () => {
      if (request.transport === 'control') {
        this.writeActiveInput(
          request.sessionId,
          `${JSON.stringify({
            type: 'control_response',
            response: {
              subtype: 'success',
              request_id: request.controlRequestId,
              response: {
                behavior: 'allow',
                updatedInput: { ...request.input, answers: answersByPrompt }
              }
            }
          })}\n`
        )
      } else {
        this.writeClaudeToolResult(
          request.sessionId,
          request.callId,
          JSON.stringify({ answers: answersByPrompt })
        )
      }
    })
    this.pendingClaudeQuestions.delete(requestId)
  }

  override async rejectQuestion(
    _projectPath: string,
    sessionId: string,
    requestId: string
  ): Promise<void> {
    const request = this.pendingClaudeQuestions.get(requestId)
    if (!request || request.sessionId !== sessionId) {
      throw new QuestionRequestGoneError(sessionId, requestId, this.name)
    }
    this.writeQuestionResponse(sessionId, requestId, () => {
      if (request.transport === 'control') {
        this.writeActiveInput(
          request.sessionId,
          `${JSON.stringify({
            type: 'control_response',
            response: {
              subtype: 'success',
              request_id: request.controlRequestId,
              response: { behavior: 'deny', message: 'The user dismissed this question.' }
            }
          })}\n`
        )
      } else {
        this.writeClaudeToolResult(
          request.sessionId,
          request.callId,
          'The user dismissed this question.',
          true
        )
      }
    })
    this.pendingClaudeQuestions.delete(requestId)
  }

  private writeQuestionResponse(sessionId: string, requestId: string, write: () => void): void {
    if (!this.activeSessionIds().includes(sessionId)) {
      this.pendingClaudeQuestions.delete(requestId)
      throw new InactiveQuestionTurnError(sessionId, requestId, this.name)
    }
    try {
      write()
    } catch (error) {
      if (this.activeSessionIds().includes(sessionId)) throw error
      this.pendingClaudeQuestions.delete(requestId)
      throw new InactiveQuestionTurnError(sessionId, requestId, this.name)
    }
  }

  private writeClaudeToolResult(
    sessionId: string,
    callId: string,
    content: string,
    isError = false
  ): void {
    const message = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: callId,
            content,
            ...(isError ? { is_error: true } : {})
          }
        ]
      },
      parent_tool_use_id: null
    }
    this.writeActiveInput(sessionId, `${JSON.stringify(message)}\n`)
  }

  /** A result record must not close stdin while Claude still awaits host input. */
  private hasPendingInteraction(sessionId: string): boolean {
    return (
      [...this.pendingClaudeQuestions.values()].some(
        (request) => request.sessionId === sessionId
      ) ||
      [...this.pendingClaudePermissions.values()].some((request) => request.sessionId === sessionId)
    )
  }

  protected override normalizeInteractionEvents(
    sessionId: string,
    events: SessionAgentEvent[]
  ): SessionAgentEvent[] {
    const normalized = super.normalizeInteractionEvents(sessionId, events).map((event) => {
      if (event.type !== 'question.asked' || event.metadata?.['transport'] !== 'control') {
        return event
      }
      const fallback = [...this.pendingClaudeQuestions.entries()].find(
        ([, request]) =>
          request.sessionId === sessionId &&
          request.transport === 'tool_result' &&
          sameClaudeQuestions(request.questions, event.questions)
      )
      return fallback ? { ...event, requestId: fallback[0] } : event
    })
    for (const event of normalized) {
      if (event.type === 'permission.asked' && event.permission.id) {
        const input = record(event.permission.metadata['input']) ?? {}
        this.pendingClaudePermissions.set(event.permission.id, { sessionId, input })
      }
      if (event.type === 'question.asked') {
        const input = record(event.metadata?.['input'])
        if (event.metadata?.['transport'] === 'control' && input) {
          this.pendingClaudeQuestions.set(event.requestId, {
            sessionId,
            questions: event.questions,
            transport: 'control',
            input,
            controlRequestId: string(event.metadata['controlRequestId']) ?? event.requestId
          })
        } else if (event.tool) {
          this.pendingClaudeQuestions.set(event.requestId, {
            sessionId,
            questions: event.questions,
            transport: 'tool_result',
            callId: event.tool.callID
          })
        }
      }
    }
    return normalized
  }

  async prepareUtilityRuntime(
    request: UtilityRuntimePreparationRequest
  ): Promise<UtilityRuntimeOverlay> {
    const mcpServers: Record<string, Record<string, unknown>> = {}
    const keys = new Set<string>()
    for (const { utility, binding } of request.resolvedUtilities) {
      if (utility.kind !== 'mcp') continue
      const baseKey = utilityKey(binding.transportName ?? utility.name)
      let key = baseKey
      for (let suffix = 2; keys.has(key); suffix += 1) key = `${baseKey}-${suffix}`
      keys.add(key)

      const config = utility.config
      if (config.transport === 'stdio') {
        if (!config.command) {
          throw new TypeError(`Claude MCP utility "${utility.name}" requires a command`)
        }
        mcpServers[key] = {
          type: 'stdio',
          command: config.command,
          args: [...(config.args ?? [])],
          env: { ...(config.environment ?? {}) }
        }
        continue
      }
      if (!config.url) {
        throw new TypeError(`Claude MCP utility "${utility.name}" requires a URL`)
      }
      mcpServers[key] = {
        type: config.transport,
        url: config.url
      }
    }

    if (Object.keys(mcpServers).length === 0) return {}
    return {
      args: ['--mcp-config', '{{config:claude-mcp}}', '--strict-mcp-config'],
      configFiles: [
        {
          id: 'claude-mcp',
          relativePath: 'claude/mcp.json',
          content: JSON.stringify({ mcpServers }, null, 2)
        }
      ]
    }
  }

  protected async ensureCliReady(projectPath: string): Promise<void> {
    const release = await this.oneShotSpawnGate.acquire()
    try {
      await runHarnessCommand('claude', ['--version'], {
        cwd: projectPath,
        env: buildClaudeEnvironment(this.accountEnvironment),
        timeoutMs: 10_000
      })
    } finally {
      release()
    }
  }

  /** Claude Code accepts ephemeral settings JSON, avoiding global or project config writes. */
  protected async buildTurnCommand(
    _projectPath: string,
    session: PersistentCliSession,
    options: SendPromptOptions
  ): Promise<CliTurnCommand> {
    // A new turn spawns a fresh CLI process; any stdin-close grace timer left
    // by the previous turn belongs to a process this turn just replaced.
    this.cancelAsyncAgentInputClose(session.id)
    // Pre-flight auth gate at message-send time (buildTurnCommand runs per turn,
    // never on thread open). For first-party Anthropic turns, probe the CLI's
    // stored credential so the CLI's own silent OAuth refresh is triggered up
    // front; if it genuinely cannot authenticate, fail with a clean early
    // authentication issue instead of a confusing mid-turn authentication_failed.
    const firstParty = !options.settings.providerId || options.settings.providerId === 'anthropic'
    if (firstParty && !this.isTitleSession(session.id)) {
      const releaseSpawn = await this.oneShotSpawnGate.acquire()
      try {
        const authenticated = await this.probeFirstPartyAuthentication(_projectPath)
        if (!authenticated) {
          throw new Error('Claude Code sign-in required. Sign in, then retry this message.')
        }
      } finally {
        releaseSpawn()
      }
    }
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--permission-prompt-tool',
      'stdio',
      '--verbose',
      '--include-partial-messages',
      '--forward-subagent-text',
      '--thinking-display',
      'summarized'
    ]
    if (session.nativeSessionId) args.push('--resume', session.nativeSessionId)
    const fastInference =
      options.settings.inferenceMode === 'fast' && options.settings.providerId === 'anthropic'
    const modelId = fastInference
      ? fastSelectionModelId(options.settings.harnessId, options.settings.modelId)
      : options.settings.modelId
    if (modelId) args.push('--model', modelId)
    args.push('--effort', claudeEffort(options.settings.thinkingLevel))
    args.push(
      '--settings',
      JSON.stringify({ showThinkingSummaries: true, ...(fastInference ? { fastMode: true } : {}) })
    )
    if (options.systemPrompt) args.push('--append-system-prompt', options.systemPrompt)
    if (options.allowedTools !== undefined)
      args.push('--tools', options.allowedTools.map(claudeToolName).join(','))
    else if (options.readOnly) args.push('--tools', 'Read,Glob,Grep,WebFetch,WebSearch')
    if (options.structuredOutput)
      args.push('--json-schema', JSON.stringify(options.structuredOutput.schema))
    if (options.settings.permissionLevel === 'full_access')
      args.push('--permission-mode', 'bypassPermissions')
    else args.push('--permission-mode', 'manual')
    const env = await this.customProviderEnv(options.settings.providerId)
    const input = await claudeStreamInput(options.text, options.attachments)
    const trackAuthentication =
      !this.isTitleSession(session.id) &&
      (!options.settings.providerId || options.settings.providerId === 'anthropic')
    if (trackAuthentication) this.beginAuthenticationReadiness(session.id)
    return {
      command: 'claude',
      args,
      input,
      keepInputOpen: true,
      env,
      provenanceModelId: resolveFastModelId(modelId, fastInference ? 'fast' : 'normal'),
      ...(trackAuthentication
        ? {
            onJsonRecord: (value: unknown) => {
              const result = claudeAuthenticationResult(value)
              if (result !== undefined) this.settleAuthenticationReadiness(session.id, result)
            },
            onProcessExit: () => this.settleAuthenticationReadiness(session.id, false)
          }
        : {})
    }
  }

  /**
   * Close a background-agent turn process's stdin after a silence window so
   * the CLI can exit if the agents never deliver further work. Any stdout
   * record pushes both the inactivity grace and the hold deadline back out  
   * a sub-agent that is genuinely streaming keeps its process alive
   * indefinitely; only true silence (a wedged or dead wait) reaches the cap.
   */
  private scheduleAsyncAgentInputClose(sessionId: string): void {
    this.cancelAsyncAgentInputClose(sessionId)
    const timer = setTimeout(() => {
      this.asyncAgentCloseTimers.delete(sessionId)
      if (!this.activeSessionIds().includes(sessionId)) return
      this.closeActiveInput(sessionId)
    }, CLAUDE_ASYNC_AGENT_CLOSE_GRACE_MS)
    timer.unref?.()
    this.asyncAgentCloseTimers.set(sessionId, timer)
    const deadline = setTimeout(() => {
      this.asyncAgentHoldDeadlines.delete(sessionId)
      if (!this.activeSessionIds().includes(sessionId)) return
      this.closeActiveInput(sessionId)
    }, CLAUDE_ASYNC_AGENT_MAX_HOLD_MS)
    deadline.unref?.()
    this.asyncAgentHoldDeadlines.set(sessionId, deadline)
  }

  private cancelAsyncAgentInputClose(sessionId: string): void {
    const timer = this.asyncAgentCloseTimers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      this.asyncAgentCloseTimers.delete(sessionId)
    }
    const deadline = this.asyncAgentHoldDeadlines.get(sessionId)
    if (deadline) {
      clearTimeout(deadline)
      this.asyncAgentHoldDeadlines.delete(sessionId)
    }
  }

  private beginAuthenticationReadiness(sessionId: string): void {
    let resolveReadiness: (authenticated: boolean) => void = () => undefined
    const promise = new Promise<boolean>((resolve) => {
      resolveReadiness = resolve
    })
    this.authenticationReadiness.set(sessionId, {
      promise,
      resolve: resolveReadiness,
      settled: false
    })
  }

  private settleAuthenticationReadiness(sessionId: string, authenticated: boolean): void {
    const readiness = this.authenticationReadiness.get(sessionId)
    if (!readiness || readiness.settled) return
    readiness.settled = true
    readiness.resolve(authenticated)
  }

  private async waitForParentAuthentication(sessionId: string): Promise<boolean> {
    const readiness = this.authenticationReadiness.get(sessionId)
    if (!readiness) return false
    const authenticated = await readiness.promise
    if (this.authenticationReadiness.get(sessionId) === readiness) {
      this.authenticationReadiness.delete(sessionId)
    }
    return authenticated
  }

  /**
   * Serialize the credential-refresh window for first-party session spawns.
   * Claude Code's macOS keychain OAuth store races when two processes refresh
   * a single-use token concurrently and the loser wipes the shared credential
   * (anthropics/claude-code#76905), forcing repeated re-logins. Every first-party
   * process passes through the startup gate because a prior authentication does
   * not reveal the access token's remaining lifetime. Custom base-URL providers
   * never share the Anthropic OAuth credential, so they bypass the gate entirely.
   */
  override async sendPrompt(projectPath: string, opts: SendPromptOptions): Promise<void> {
    const firstParty = !opts.settings.providerId || opts.settings.providerId === 'anthropic'
    if (!firstParty) {
      await super.sendPrompt(projectPath, opts)
      return
    }
    const release = await this.acquireAuthSlot()
    this.authenticatedSessions.delete(opts.sessionId)
    try {
      await super.sendPrompt(projectPath, opts)
      await this.waitForAuthConfirmation(opts.sessionId)
    } finally {
      release()
    }
  }

  /**
   * Claim the credential-refresh window, waiting for any in-flight window to
   * close first. The window covers the CLI's silent OAuth refresh at process
   * startup   only one first-party spawn may be inside it at a time.
   */
  private async acquireAuthSlot(): Promise<() => void> {
    for (;;) {
      if (this.authSlotHeld) {
        await this.authSlot
        continue
      }
      this.authSlotHeld = true
      break
    }
    let release: (() => void) | undefined
    this.authSlot = new Promise<void>((resolve) => (release = resolve))
    const releaseCrossProcess = await this.crossProcessAuthLock.acquire()
    return () => {
      releaseCrossProcess()
      release?.()
      this.authSlotHeld = false
    }
  }

  /**
   * Run an auth-touching CLI operation under the credential-refresh gate. A
   * successful process start proves only that the access token works at that
   * instant; it does not reveal when the token expires. Every new process must
   * therefore pass through this short startup gate. The one-shot spawn gate
   * then bounds concurrent short-lived claude spawns (auth probe, usage refresh,
   * model discovery) so they cannot exhaust the process file-descriptor table
   * and fail later spawns with `EBADF`.
   *
   * Lock ordering: the auth slot is always acquired before the spawn gate
   * (sendPrompt → buildTurnCommand probe follows the same order), so no path
   * ever holds the gate while waiting for the auth slot.
   */
  private async runAuthSerialized<T>(operation: () => Promise<T>): Promise<T> {
    const releaseAuth = await this.acquireAuthSlot()
    try {
      const releaseSpawn = await this.oneShotSpawnGate.acquire()
      try {
        return await operation()
      } finally {
        releaseSpawn()
      }
    } finally {
      releaseAuth()
    }
  }

  /**
   * Hold the credential-refresh window until the guarded session proves
   * authentication, exits, or the bound expires   the window in which the CLI
   * may refresh the shared keychain credential. Resolving early on
   * authentication lets the next concurrent spawn proceed without a refresh.
   */
  private async waitForAuthConfirmation(sessionId: string): Promise<void> {
    const deadline = Date.now() + AUTH_CONFIRM_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (this.authenticatedSessions.has(sessionId)) return
      if (!this.activeSessionIds().includes(sessionId)) return
      await new Promise<void>((resolve) => setTimeout(resolve, AUTH_CONFIRM_POLL_MS))
    }
  }

  /**
   * Pre-flight probe of the first-party Anthropic credential. Shells
   * `claude auth status --json` and trusts its `loggedIn` verdict, letting the
   * CLI's own silent OAuth refresh run before a turn is dispatched. The result
   * is cached per project for a short window so a session's consecutive
   * messages do not each re-spawn the CLI. On any probe failure (CLI missing,
   * timeout, unparseable output) we assume authenticated so the turn still has
   * a chance to report the real error mid-stream rather than being silently
   * blocked by an unreliable pre-check.
   */
  private async probeFirstPartyAuthentication(projectPath: string): Promise<boolean> {
    const now = Date.now()
    const cached = this.authProbeCache.get(projectPath)
    if (cached && now - cached.at < PRE_FLIGHT_AUTH_PROBE_TTL_MS) return cached.authenticated
    let authenticated: boolean
    if (process.platform !== 'win32') {
      authenticated = await new Promise<boolean>((resolve) => {
        try {
          execFile(
            'claude',
            ['auth', 'status', '--json'],
            {
              cwd: projectPath,
              env: buildClaudeEnvironment(this.accountEnvironment),
              timeout: PRE_FLIGHT_AUTH_PROBE_TIMEOUT_MS,
              maxBuffer: 1024 * 1024
            },
            (error, stdout) => {
              if (error) {
                resolve(true)
                return
              }
              try {
                const parsed = JSON.parse(stdout) as { loggedIn?: unknown }
                resolve(parsed['loggedIn'] === true)
              } catch {
                resolve(true)
              }
            }
          )
        } catch {
          resolve(true)
        }
      })
    } else {
      try {
        const { stdout } = await runHarnessCommand('claude', ['auth', 'status', '--json'], {
          cwd: projectPath,
          env: buildClaudeEnvironment(this.accountEnvironment),
          timeoutMs: PRE_FLIGHT_AUTH_PROBE_TIMEOUT_MS,
          maxOutputBytes: 1024 * 1024
        })
        const parsed = JSON.parse(stdout) as { loggedIn?: unknown }
        authenticated = parsed['loggedIn'] === true
      } catch {
        // Fail open so the turn still has a chance to report the real error.
        authenticated = true
      }
    }
    this.authProbeCache.delete(projectPath)
    if (authenticated) this.authProbeCache.set(projectPath, { authenticated, at: now })
    return authenticated
  }

  /**
   * Current authentication state of the shared first-party credential, probed
   * through the credential-refresh gate so a thread-open check can never race
   * a concurrent refresh (anthropics/claude-code#76905). Probe failures are
   * reported as authenticated so real errors still surface at message time.
   */
  async getAuthStatus(projectPath: string): Promise<HarnessAuthStatus> {
    const authenticated = await this.runAuthSerialized(() =>
      this.probeFirstPartyAuthentication(projectPath)
    )
    if (!authenticated) {
      return {
        state: 'unauthenticated',
        accounts: [],
        detail: 'Claude Code could not authenticate with the stored credential.'
      }
    }
    return {
      state: 'authenticated',
      accounts: [
        {
          id: 'anthropic',
          providerId: 'anthropic',
          label: 'Anthropic',
          method: 'oauth',
          active: true
        }
      ]
    }
  }

  /**
   * Route a custom base-URL provider into Claude Code's env when the selected
   * provider is one of our custom endpoints. Claude Code supports a single
   * active endpoint per process, so only the selected provider is applied.
   */
  private async customProviderEnv(providerId: string): Promise<NodeJS.ProcessEnv> {
    const env = buildClaudeEnvironment(this.accountEnvironment)
    if (!this.baseUrlProviders || !this.secretVault || !providerId) return env
    const provider = await this.baseUrlProviders.getProvider(this.id, providerId)
    if (!provider || provider.harnessId !== this.id || !provider.enabled) return env
    env['ANTHROPIC_BASE_URL'] = provider.baseURL
    if (provider.apiKeyRef) {
      const apiKey = await this.secretVault.resolve(provider.apiKeyRef)
      if (apiKey) env['ANTHROPIC_AUTH_TOKEN'] = apiKey
    }
    return env
  }

  private readUsageFromActiveSession(sessionId: string): Promise<Record<string, unknown> | null> {
    const existing = this.activeUsageProbes.get(sessionId)
    if (existing) return existing.promise

    const sequence = ++this.usageProbeSequence
    const usageRequestId = `codeinoven-usage-${sequence}`
    const contextRequestId = `codeinoven-context-${sequence}`
    let resolveProbe: (value: Record<string, unknown> | null) => void = () => undefined
    const promise = new Promise<Record<string, unknown> | null>((resolve) => {
      resolveProbe = resolve
    })
    const probe: ClaudeUsageProbe = {
      usageRequestId,
      contextRequestId,
      rateLimitsPayload: null,
      rateLimitsResponded: false,
      contextPayload: null,
      contextResponded: false,
      timer: setTimeout(
        () => this.finishActiveUsageProbe(sessionId, null),
        CLAUDE_USAGE_TIMEOUT_MS
      ),
      promise,
      resolve: resolveProbe
    }
    this.activeUsageProbes.set(sessionId, probe)
    try {
      this.writeActiveInput(
        sessionId,
        `${JSON.stringify({
          type: 'control_request',
          request_id: usageRequestId,
          request: { subtype: 'get_usage' }
        })}\n`
      )
      this.writeActiveInput(
        sessionId,
        `${JSON.stringify({
          type: 'control_request',
          request_id: contextRequestId,
          request: { subtype: 'get_context_usage' }
        })}\n`
      )
    } catch {
      this.finishActiveUsageProbe(sessionId, null)
    }
    return promise
  }

  private finishActiveUsageProbe(sessionId: string, value: Record<string, unknown> | null): void {
    const probe = this.activeUsageProbes.get(sessionId)
    if (!probe) return
    this.activeUsageProbes.delete(sessionId)
    clearTimeout(probe.timer)
    probe.resolve(value)
  }

  private captureActiveUsageResponse(
    sessionId: string,
    entry: Record<string, unknown> | null
  ): void {
    const probe = this.activeUsageProbes.get(sessionId)
    if (!probe || entry?.['type'] !== 'control_response') return
    const response = record(entry['response'])
    const inner = record(response?.['response'])
    const requestId = string(response?.['request_id'])
    if (requestId === probe.usageRequestId) {
      probe.rateLimitsResponded = true
      const rateLimits = record(inner?.['rate_limits'])
      probe.rateLimitsPayload =
        inner?.['rate_limits_available'] === true && rateLimits ? inner : null
    } else if (requestId === probe.contextRequestId) {
      probe.contextResponded = true
      probe.contextPayload = inner
    } else {
      return
    }

    if (probe.rateLimitsResponded && probe.rateLimitsPayload === null) {
      this.finishActiveUsageProbe(sessionId, {
        rateLimits: null,
        context: probe.contextPayload
      })
    } else if (probe.rateLimitsResponded && probe.contextResponded) {
      this.finishActiveUsageProbe(sessionId, {
        rateLimits: probe.rateLimitsPayload,
        context: probe.contextPayload
      })
    }
  }

  private mapAccountUsage(telemetry: Record<string, unknown> | null): ClaudeAccountUsage | null {
    if (!telemetry) return null
    const usage = record(telemetry['rateLimits'])
    const context = record(telemetry['context'])
    const rateLimits = usage ? rateLimitWindows(usage['rate_limits']) : []
    if (rateLimits.length === 0 && !context) return null
    const contextWindow =
      context === null ? undefined : numberProperty(context, 'maxTokens', 'max_tokens')
    const contextUsed =
      context === null ? undefined : numberProperty(context, 'totalTokens', 'total_tokens')
    return {
      rateLimits,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(contextUsed === undefined ? {} : { contextUsed })
    }
  }

  /**
   * Fetch the account's current plan rate-limit windows and live context-window
   * usage on demand via the `get_usage` + `get_context_usage` control requests.
   * These run WITHOUT a model turn (`total_api_duration_ms` stays 0), so the
   * battery can show live quota and the context percent for old threads whose
   * turns predate capture. Returns null when the session has no plan limits
   * (API key, Bedrock, Vertex) or on any failure.
   */
  async readAccountUsage(projectPath: string): Promise<ClaudeAccountUsage | null> {
    const activeSessionId = this.activeSessionIds()[0]
    if (activeSessionId) {
      return this.mapAccountUsage(await this.readUsageFromActiveSession(activeSessionId))
    }
    try {
      const prepared = await prepareHarnessInvocation(
        'claude',
        ['--print', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose'],
        { cwd: projectPath, env: buildClaudeEnvironment(this.accountEnvironment) }
      )
      const telemetry = await this.runAuthSerialized(
        () =>
          new Promise<Record<string, unknown> | null>((resolve) => {
            let child: ChildProcess
            try {
              child = spawn(prepared.command, prepared.args, {
                ...(prepared.cwd ? { cwd: prepared.cwd } : {}),
                env: prepared.env,
                shell: prepared.shell,
                // Usage telemetry is a side channel; do not leave a piped
                // stderr buffer undrained while the probe waits for JSON.
                stdio: ['pipe', 'pipe', 'ignore']
              })
            } catch {
              // Spawn itself threw synchronously (e.g. EBADF when the process is
              // low on file descriptors). Report no usage rather than rejecting.
              resolve(null)
              return
            }
            let buffer = ''
            let settled = false
            const timer = setTimeout(() => finish(null), CLAUDE_USAGE_TIMEOUT_MS)
            const finish = (value: Record<string, unknown> | null): void => {
              if (settled) return
              settled = true
              clearTimeout(timer)
              if (!child.killed) child.kill()
              resolve(value)
            }
            let rateLimitsPayload: Record<string, unknown> | null = null
            let rateLimitsResponded = false
            let contextPayload: Record<string, unknown> | null = null
            let contextResponded = false
            const attemptFinish = (): void => {
              if (settled) return
              // If the session has no plan rate limits, stop waiting for context and
              // report nothing. Otherwise wait for both responses so quota and
              // context are reported together; the timeout covers a missing response.
              if (rateLimitsResponded && rateLimitsPayload === null) {
                finish({ rateLimits: null, context: contextPayload })
                return
              }
              if (rateLimitsResponded && contextResponded) {
                finish({ rateLimits: rateLimitsPayload, context: contextPayload })
              }
            }
            const consume = (line: string): void => {
              if (!line.trim()) return
              const payload = record(JSON.parse(line) as unknown)
              if (!payload) return
              if (payload['type'] !== 'control_response') return
              const response = record(payload['response'])
              const inner = record(response?.['response'])
              const requestId = string(response?.['request_id'])
              if (requestId === 'usage') {
                rateLimitsResponded = true
                const rateLimits = record(inner?.['rate_limits'])
                rateLimitsPayload =
                  inner?.['rate_limits_available'] === true && rateLimits ? inner : null
              } else if (requestId === 'context') {
                contextResponded = true
                contextPayload = inner
              }
              attemptFinish()
            }
            child.stdout?.on('data', (chunk: Buffer) => {
              buffer += chunk.toString()
              const lines = buffer.split(/\r?\n/u)
              buffer = lines.pop() ?? ''
              for (const line of lines) {
                try {
                  consume(line)
                } catch {
                  // Ignore malformed side-channel output.
                }
              }
            })
            child.on('error', () => finish(null))
            child.on('exit', () => {
              if (!settled) finish(null)
            })
            // Send both control requests immediately; `--print` waits on stdin.
            child.stdin?.write(
              `${JSON.stringify({
                type: 'control_request',
                request_id: 'usage',
                request: { subtype: 'get_usage' }
              })}\n`
            )
            child.stdin?.write(
              `${JSON.stringify({
                type: 'control_request',
                request_id: 'context',
                request: { subtype: 'get_context_usage' }
              })}\n`
            )
          })
      )
      return this.mapAccountUsage(telemetry)
    } catch (error) {
      Logger.dev('Claude on-demand account usage refresh unavailable:', error)
      return null
    }
  }

  override dispose(): void {
    this.authProbeCache.clear()
    this.authenticatedSessions.clear()
    for (const timer of [
      ...this.asyncAgentCloseTimers.values(),
      ...this.asyncAgentHoldDeadlines.values()
    ]) {
      clearTimeout(timer)
    }
    this.asyncAgentCloseTimers.clear()
    this.asyncAgentHoldDeadlines.clear()
    for (const sessionId of this.activeUsageProbes.keys()) {
      this.finishActiveUsageProbe(sessionId, null)
    }
    for (const [sessionId, readiness] of this.authenticationReadiness) {
      if (!readiness.settled) readiness.resolve(false)
      this.authenticationReadiness.delete(sessionId)
    }
    this.pendingClaudeQuestions.clear()
    this.pendingClaudePermissions.clear()
    super.dispose()
  }

  protected parseJsonLine(value: unknown, context: CliLineParseContext): CliLineParseResult | null {
    const entry = record(value)
    if (claudeAuthenticationResult(entry) === true) {
      this.authenticatedSessions.add(context.sessionId)
    }
    this.captureActiveUsageResponse(context.sessionId, entry)
    const type = string(entry?.['type'])
    if (type === 'rate_limit_event' && !latestAssistant(context)) {
      const limits = rateLimitWindows(entry?.['rate_limit_info'] ?? entry?.['rateLimitInfo'])
      if (limits.length > 0) this.pendingRateLimits.set(context.sessionId, limits)
    }

    const result = mapClaudeCodeRecord(value, context)
    // Background-agent bookkeeping: any stdout record proves the turn process
    // is still doing work, so the scheduled stdin close (armed at result time
    // while background agents run) must be pushed back out   both the
    // inactivity grace and the silence cap reset on live activity. A result
    // record re-arms them itself below when background agents remain.
    if (type !== 'result') {
      if (this.asyncAgentHoldDeadlines.has(context.sessionId)) {
        this.scheduleAsyncAgentInputClose(context.sessionId)
      } else {
        this.cancelAsyncAgentInputClose(context.sessionId)
      }
    }
    if (type === 'result') {
      this.finishActiveUsageProbe(context.sessionId, null)
      const backgroundAgents = activeClaudeSubagentParts(context, true).length > 0
      if (backgroundAgents) {
        // Background agents keep the CLI process alive after the result: it
        // will inject their task-notifications as new prompts in this same
        // process. Ending stdin here would break every later can_use_tool
        // control response (AskUserQuestion, permission prompts) with
        // "AbortError: Stream closed". Keep stdin open and arm a grace close
        // instead; fresh stdout records keep cancelling it.
        this.scheduleAsyncAgentInputClose(context.sessionId)
      } else if (!this.hasPendingInteraction(context.sessionId)) {
        this.closeActiveInput(context.sessionId)
      }
    }
    if (!result) return null
    const assistant = result.messages?.find((message) => message.role === 'assistant')
    const pending = this.pendingRateLimits.get(context.sessionId)
    if (assistant && pending?.length) {
      assistant.rateLimits = pending
      result.events = [
        ...(result.events ?? []),
        {
          type: 'usage.updated',
          sessionId: context.sessionId,
          messageId: assistant.id,
          rateLimits: pending
        }
      ]
      this.pendingRateLimits.delete(context.sessionId)
    } else if (type === 'result') {
      this.pendingRateLimits.delete(context.sessionId)
    }
    return result
  }
}
