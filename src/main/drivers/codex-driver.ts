import { createWorkQueue } from '../../lib/bounded-work'
import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import type {
  AgentBankedResets,
  AgentEvent,
  AgentMessage,
  AgentTokenUsage,
  AgentProviderIssue,
  AgentRateLimitWindow,
  AgentUsageCredits,
  HarnessCommand,
  PermissionReply,
  PromptAttachment,
  ProviderCatalog,
  ProviderModel,
  ThreadSettings,
  UtilityKind
} from '../../lib/types'
import { normalizeAgentQuestions, permissionPatterns } from '../../lib/agent-interactions'
import { classifyProviderIssue } from '../../lib/provider-issue'
import { resolveFastModelId } from '../../lib/fast-inference'
import { COMPACT_LINE_SHARE } from '../../lib/prompt-budget'
import { BaseUrlProviderService } from '../providers/base-url-provider-service'
import { Logger } from '../system/logger'
import {
  ASK_SECRET_TOOL_NAME,
  GATEWAY_TOOLS,
  gatewayToolForModel,
  UTILITY_SUGGEST_TOOL_NAME
} from '../../lib/gateway-tools'
import type { UtilityGatewayEndpoint } from '../../lib/gateway-timeout'
import { SecretVault } from '../storage/secret-vault'
import type { StorageEngine } from '../storage/storage-engine'
import { buildProcessEnvironmentAsync } from './cli-environment'
import { prependHistoryRecap } from './history-recap-prompt'
import { formatHistoryRecap } from '../chat/chat-engine/chat-engine-message-text'
import { attachmentReference } from './attachment-reference'
import type {
  GenerateTitleOptions,
  GradeTurnOptions,
  HarnessCapabilities,
  IdleNativeSessionHandOffProbe,
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
  type CodexWindowCatalog,
  codexContextWindowOptions,
  emptyCodexWindowCatalog,
  parseCodexWindowCatalog
} from './codex/codex-catalog'
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
  CODEX_COMPUTER_USE_UNAVAILABLE,
  probeCodexComputerUse,
  type CodexComputerUseReadiness
} from './codex/codex-computer-use'
import {
  codexRetryIssue,
  codexUsageLimitIssue,
  isCodexRetryRecoveryActivity
} from './codex/codex-errors'
import { mapCodexRateLimits, mapCodexUsage, mapCodexTotalUsage } from './codex/codex-usage'
import {
  appServerRequestId,
  notificationThreadId,
  numberValue,
  recordValue,
  stringValue
} from './codex/codex-values'
import {
  codexDeveloperInstructions,
  codexAuxiliaryConfig,
  composePrompt,
  localAttachmentPath
} from './codex/codex-prompts'
import { namespacedMessage, parseCodexJsonLine, parseItem } from './codex/codex-stream-fold'

export { mapCodexRateLimits, mapCodexUsage }

/**
 * How long CodeInOven waits after an unexpected Codex app-server exit before the
 * scheduled auto-resume dispatches the continuation. The wait only has to cover
 * dropping the dead host; the replacement app-server is spawned by the resumed
 * turn itself, and the retry scheduler adds its own fire grace on top. */
// Account drivers share a startup slot so initialization is not competing with
// other cold Codex processes on memory-constrained machines.
const codexStartupQueue = createWorkQueue(1)
const CODEX_APP_SERVER_RESTART_DELAY_MS = 5_000
/**
 * Consecutive unexpected app-server exits CodeInOven auto-recovers for one
 * session before it stops resuming and reports the terminal failure. A harness
 * that cannot stay up must surface for manual recovery instead of retry-looping.
 */
const CODEX_APP_SERVER_RECOVERY_LIMIT = 3
/** How long Codex's own context-window catalog is reused before it is read
 *  again. Codex updates that catalog with its own releases, not per turn. */
const CODEX_WINDOW_CATALOG_TTL_MS = 5 * 60 * 1000

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
    // Computer use is declared here as the intent, not as a fact: Codex ships it
    // as an installed MCP server, so `resolveNativeUtilities` decides per turn
    // whether this machine actually has it. `web_search` and `web_fetch` are the
    // harness's own and are answered as declared.
    nativeUtilities: ['web_search', 'web_fetch', 'computer_use']
  }
  /** How long a computer-use answer is reused. One turn start asks for it from
   *  several places (host launch, gateway, behavior prompt), and the answer is a
   *  device fact that cannot change between them. */
  private static readonly COMPUTER_USE_TTL_MS = 15_000
  private computerUseReadiness?: { home: string; readAt: number; value: CodexComputerUseReadiness }
  private computerUseProbe?: { home: string; promise: Promise<CodexComputerUseReadiness> }
  private computerUseLogged?: boolean
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
  private appServerGeneration = 0
  private authenticationRestartsByProjectPath = new Map<string, Promise<void>>()
  private serverRequests = new Map<string, CodexServerRequest>()
  /** Codex's own context windows, cached per Codex home. The CLI's catalog
   *  changes only when Codex itself updates it, so a short TTL keeps repeated
   *  catalog refreshes from re-running the dump for every project. */
  private codexWindowsByHome = new Map<string, { catalog: CodexWindowCatalog; readAt: number }>()
  private codexWindowReads = new Map<string, Promise<CodexWindowCatalog>>()

  /** Consecutive automatic recoveries already attempted for a session after the
   *  shared app-server died under it, cleared the moment one of its turns
   *  completes. Bounds the auto-resume of a harness that cannot stay up, so a
   *  broken installation surfaces a terminal failure instead of retry-looping. */
  private appServerRecoveriesBySessionId = new Map<string, number>()

  protected async ensureCliReady(): Promise<void> {
    try {
      await runHarnessCommand('codex', ['--version'], {
        env: await buildProcessEnvironmentAsync({ ...process.env, ...this.accountEnvironment }),
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
    // Codex states its own context windows in its model catalog, so the picker
    // offers exactly what Codex accepts and starts at what Codex uses.
    const windows = await this.codexWindowCatalog(projectPath)
    let builtInModels: ProviderModel[]
    try {
      const discovered = await this.discoverModels(projectPath)
      builtInModels = discovered.length > 0 ? discovered : fallbackCodexModels(windows)
    } catch (error) {
      Logger.info('Codex model discovery fell back to the bundled catalog', {
        error: error instanceof Error ? error.message : String(error)
      })
      builtInModels = fallbackCodexModels(windows)
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

  async modelContext(
    projectPath: string,
    modelId: string
  ): Promise<Pick<ProviderModel, 'contextWindow' | 'contextWindows'> | null> {
    const windows = await this.codexWindowCatalog(projectPath, true)
    const window = windows.get(modelId)
    return window
      ? { contextWindow: window.defaultWindow, contextWindows: codexContextWindowOptions(window) }
      : null
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

  /**
   * The native utilities this machine really supplies.
   *
   * Codex's computer use is an MCP server its desktop app installs into the Codex
   * home, and it is absent from an app-managed home and often disabled in the
   * device one. Claiming it unconditionally made the utility registry suppress the
   * app-owned CUA driver for every Codex turn, so a thread had neither: the claim
   * now follows the device.
   */
  async resolveNativeUtilities(projectPath: string): Promise<UtilityKind[]> {
    const declared = this.capabilities.nativeUtilities ?? []
    if (!declared.includes('computer_use')) return declared
    const readiness = await this.codexComputerUse(projectPath)
    return readiness.available ? declared : declared.filter((kind) => kind !== 'computer_use')
  }

  /**
   * Codex's own computer-use availability, probed once per turn and shared by
   * every consumer of it. Concurrent callers share one probe instead of launching
   * Codex once per caller.
   */
  private async codexComputerUse(projectPath: string): Promise<CodexComputerUseReadiness> {
    const home = this.codexHomeKey()
    const cached = this.computerUseReadiness
    if (
      cached &&
      cached.home === home &&
      Date.now() - cached.readAt < CodexDriver.COMPUTER_USE_TTL_MS
    ) {
      return cached.value
    }
    const running = this.computerUseProbe
    if (running && running.home === home) return running.promise
    const promise = probeCodexComputerUse({
      cwd: projectPath,
      env: { ...process.env, ...this.accountEnvironment }
    })
      .catch((error: unknown) => {
        // A probe that fails is a device we could not read, never a capability we
        // may claim: the app-owned CUA driver stays reachable in that case.
        Logger.dev('Codex computer-use probe failed:', error)
        return CODEX_COMPUTER_USE_UNAVAILABLE
      })
      .then((value) => {
        this.computerUseReadiness = { home, readAt: Date.now(), value }
        if (this.computerUseProbe?.promise === promise) this.computerUseProbe = undefined
        if (this.computerUseLogged !== value.available) {
          this.computerUseLogged = value.available
          Logger.info(
            `Codex computer use ${value.available ? 'enabled' : 'unavailable'}: ${value.reason}`
          )
        }
        return value
      })
    this.computerUseProbe = { home, promise }
    return promise
  }

  /** `-c` pairs that turn Codex's own computer use on for one launch. */
  private async computerUseConfigArgs(projectPath: string): Promise<string[]> {
    const readiness = await this.codexComputerUse(projectPath)
    return readiness.configOverrides.flatMap((override) => ['-c', override])
  }

  /** Start a Codex turn through app-server so the same native turn can be steered. */
  override async sendPrompt(projectPath: string, options: SendPromptOptions): Promise<void> {
    // A sibling can have rebound this app session since our last turn.
    if (!this.activeTurns.has(options.sessionId)) this.sessionCache.delete(options.sessionId)
    const session = await this.requireSession(projectPath, options.sessionId)
    // A native turn can still be registered while the engine believes the
    // session is idle: a network failure tears down the visible turn, but the
    // `turn/completed` cleanup only arrives when the connection recovers (or
    // after the request timeout). Rejecting here poisons the thread with
    // "A turn is already active" on every retry, so a dispatch that lands on a
    // live native turn is delivered as a steer instead - the driver's turn
    // registry is authoritative, not the engine's session status.
    const previousTurn = this.activeTurns.get(session.id)
    if (previousTurn?.completionReceived) {
      // Let the old turn finish emitting idle before a new turn can start.
      await previousTurn.completion
    }
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
    active.messageOffset = session.messages.length

    try {
      const dynamicTools = options.minimalContext
        ? []
        : [
            codexQuestionTool((await this.storage.getConfig()).agentQuestionCap),
            ...(this.utilityEndpoints.has(session.id)
              ? GATEWAY_TOOLS.filter(({ name }) => {
                  const granted = this.utilityEndpoints.get(session.id)?.toolNames
                  return granted === undefined || granted.includes(name)
                })
                  .map(gatewayToolForModel)
                  .map(({ name, description, inputSchema }) => ({
                    name,
                    description,
                    inputSchema
                  }))
              : [])
          ]
      const developerInstructions = options.minimalContext
        ? 'Return only the requested auxiliary answer.'
        : codexDeveloperInstructions(options.systemPrompt)
      const contextWindow = this.codexContextWindowOverride(options.settings)
      const contextConfig = {
        config: {
          tool_output_token_limit: 3_000,
          ...(options.minimalContext ? await codexAuxiliaryConfig(projectPath) : {}),
          ...(contextWindow === undefined
            ? {}
            : {
                model_context_window: contextWindow,
                model_auto_compact_token_limit: Math.floor(contextWindow * COMPACT_LINE_SHARE)
              })
        }
      }
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
          session.messages.filter((message) => message.id !== currentMessageId),
          // Apply the transport cap below, keeping the recent end of history,
          // so the formatter is given no budget of its own here: the cap that
          // follows is the one that trims the oldest end when it must.
          { maxInputTokens: Number.MAX_SAFE_INTEGER }
        )
      }
      let historyRecap = options.historyRecap
      let threadResult: Record<string, unknown>
      const previousNativeId = session.nativeSessionId
      const transferPath = `drivers/${this.id}/transfers/${session.id}.json`
      const transfer = await this.storage.read<{ nativeThreadId: string; projectPath: string }>(
        transferPath
      )
      const forkForTransfer =
        transfer?.projectPath === projectPath && previousNativeId === transfer.nativeThreadId
      if (forkForTransfer) {
        threadResult = await this.appServerRequest(host, 'thread/fork', {
          ...contextConfig,
          threadId: transfer.nativeThreadId,
          excludeTurns: true,
          cwd: projectPath,
          dynamicTools,
          developerInstructions
        })
      } else if (previousNativeId) {
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
      if (forkForTransfer && nativeThreadId === transfer.nativeThreadId) {
        throw new Error('Codex app-server did not return a new thread ID for the transfer')
      }
      active.nativeThreadId = nativeThreadId
      if (!previousNativeId || nativeThreadId !== previousNativeId) {
        session.codexUsageCheckpoint = {
          nativeThreadId,
          tokens:
            forkForTransfer && session.codexUsageCheckpoint
              ? session.codexUsageCheckpoint.tokens
              : { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        }
      }
      session.nativeSessionId = nativeThreadId
      this.threadSessionsByNativeId.set(nativeThreadId, { sessionId: session.id, projectPath })
      await this.persistSession(session)
      if (transfer?.projectPath === projectPath) await this.storage.remove(transferPath)

      const turnParams: Record<string, unknown> = {
        threadId: nativeThreadId,
        clientUserMessageId: options.userMessageId,
        input: await this.codexInput(options.text, options.attachments, session.id, historyRecap),
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
    if (!active?.nativeThreadId || !active.turnId || active.completionReceived || active.finished) {
      throw new Error(`No active Codex turn is available to steer for session ${session.id}`)
    }
    const input = await this.codexInput(options.text, options.attachments, session.id)
    if (
      this.activeTurns.get(session.id) !== active ||
      active.completionReceived ||
      active.finished
    ) {
      throw new Error(`Codex turn finished before steering session ${session.id}`)
    }
    await this.appServerRequest(active.host, 'turn/steer', {
      threadId: active.nativeThreadId,
      clientUserMessageId: options.userMessageId,
      input,
      expectedTurnId: active.turnId
    })
    this.appendUserMessage(session, options)
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
    await this.storage.remove(`drivers/${this.id}/transfers/${sessionId}.json`)
    this.stopResidentHostForPathIfIdle(projectPath)
  }

  override releaseProjectResources(projectPath: string): void {
    super.releaseProjectResources(projectPath)
    this.stopResidentHostForPathIfIdle(projectPath)
  }

  /** Check the resident writer without starting a host or loading history. */
  hasSessionWriter(projectPath: string, sessionId: string): boolean {
    if (!this.hostsByProjectPath.has(projectPath)) return false
    for (const binding of this.threadSessionsByNativeId.values()) {
      if (binding.sessionId === sessionId && binding.projectPath === projectPath) return true
    }
    return false
  }

  /**
   * Transfer a settled app session. An idle host exits to release the exact
   * native writer. A busy host stays alive for unrelated turns; the receiving
   * instance forks the settled history under a new native ID on its own host.
   */
  async releaseIdleSessionForTransfer(
    projectPath: string,
    sessionId: string
  ): Promise<IdleNativeSessionReleaseResult> {
    // A session record this process cannot read names no native thread, so there
    // is no writer here for a hand-off to release. Answering with a thrown error
    // would instead fail the peer's ordinary prompt with a transfer message it
    // cannot act on: this method's contract is a result, never an exception.
    let nativeThreadId: string | null
    try {
      nativeThreadId = (await this.requireSession(projectPath, sessionId)).nativeSessionId ?? null
    } catch (error) {
      Logger.dev('Codex idle writer release could not read the session:', error)
      return { owner: false, released: false }
    }
    const host = this.writerHostFor(projectPath, sessionId, nativeThreadId)
    if (!host || !nativeThreadId) return { owner: false, released: false }

    const sessionBlocker = this.sessionTransferBlocker(sessionId, nativeThreadId)
    if (sessionBlocker) return { owner: true, released: false, reason: sessionBlocker }
    const blocker = this.handOffBlockerFor(host, sessionId)
    if (blocker) {
      // Keep unrelated turns on their shared server. The adopter forks this
      // settled native history on its own host and retains the app session ID.
      await this.storage.write(`drivers/${this.id}/transfers/${sessionId}.json`, {
        nativeThreadId,
        projectPath
      })
      this.threadSessionsByNativeId.delete(nativeThreadId)
      this.sessionCache.delete(sessionId)
      void this.appServerRequest(host, 'thread/unsubscribe', { threadId: nativeThreadId }).catch(
        (error: unknown) => Logger.dev('Codex transferred thread unsubscribe unavailable:', error)
      )
      return { owner: true, released: true }
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

  /**
   * Whether this thread's writer could be released once its own turn stops,
   * judged without stopping anything.
   *
   * Unrelated host activity can use the history-fork path. Only operations on
   * this session block the transfer, and its own turn will be stopped by the
   * caller after this probe.
   */
  async canHandOffIdleSession(
    projectPath: string,
    sessionId: string
  ): Promise<IdleNativeSessionHandOffProbe> {
    let nativeThreadId: string | null
    try {
      nativeThreadId = (await this.requireSession(projectPath, sessionId)).nativeSessionId ?? null
    } catch (error) {
      // A session this process cannot even read is one it cannot hand over.
      Logger.dev('Codex hand-off probe could not read the session:', error)
      return { blocked: true, reason: 'This Codex session is no longer available to hand over.' }
    }
    const host = this.writerHostFor(projectPath, sessionId, nativeThreadId)
    // No writer here means this process is not the one holding the thread, so a
    // hand-off has nothing to wait on.
    if (!host) return { blocked: false }
    const blocker = this.sessionTransferBlocker(sessionId, nativeThreadId, true)
    return blocker ? { blocked: true, reason: blocker } : { blocked: false }
  }

  private sessionTransferBlocker(
    sessionId: string,
    nativeThreadId: string | null,
    ignoreOwnTurn = false
  ): string | null {
    if (!ignoreOwnTurn && this.activeTurns.has(sessionId)) {
      return `Codex session ${sessionId} still has an active turn.`
    }
    if (nativeThreadId && this.compactionsByThreadId.has(nativeThreadId)) {
      return `Codex session ${sessionId} is still compacting its history.`
    }
    if (nativeThreadId && this.contextUsageByThreadId.has(nativeThreadId)) {
      return `Codex session ${sessionId} is still refreshing context usage.`
    }
    return null
  }

  /**
   * The resident host whose native writer this session's thread lives in, or
   * null when this process holds no writer for it.
   */
  private writerHostFor(
    projectPath: string,
    sessionId: string,
    nativeThreadId: string | null
  ): CodexAppServerHost | null {
    if (!nativeThreadId) return null
    const binding = this.threadSessionsByNativeId.get(nativeThreadId)
    const host = this.hostsByProjectPath.get(projectPath)
    if (
      !host ||
      !binding ||
      binding.sessionId !== sessionId ||
      binding.projectPath !== projectPath
    ) {
      return null
    }
    return host
  }

  /**
   * Why the host cannot be stopped for a hand-off right now, or null when it can.
   *
   * `ignoreOwnTurn` covers a transfer's pre-flight: the thread being handed over
   * is still running its turn at that moment, and the transfer stops it before
   * it releases the writer.
   */
  private handOffBlockerFor(
    host: CodexAppServerHost,
    sessionId: string,
    options: { ignoreOwnTurn?: boolean } = {}
  ): string | null {
    if (!options.ignoreOwnTurn && this.activeTurns.has(sessionId)) {
      return `Codex session ${sessionId} still has an active turn on the app-server.`
    }
    const blockers = new Set<string>()
    for (const [turnSessionId, active] of this.activeTurns) {
      if (active.host !== host || turnSessionId === sessionId) continue
      blockers.add(`active turn for session ${turnSessionId}`)
    }
    for (const [threadId, compaction] of this.compactionsByThreadId) {
      if (compaction.host === host) blockers.add(`compaction for native thread ${threadId}`)
    }
    for (const [threadId, waiter] of this.contextUsageByThreadId) {
      if (waiter.host === host) blockers.add(`context-usage request for native thread ${threadId}`)
    }
    for (const request of this.serverRequests.values()) {
      if (request.host === host && request.sessionId !== sessionId) {
        blockers.add(`${request.method} server request for session ${request.sessionId}`)
      }
    }
    for (const pending of host.pending.values()) blockers.add(`pending ${pending.method} request`)
    if (blockers.size === 0) return null
    return `This Codex thread cannot move yet; its app-server is still handling ${[...blockers].join('; ')}.`
  }

  override dispose(): void {
    this.appServerGeneration += 1
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
    this.appServerRecoveriesBySessionId.clear()
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
    // Decided before the host starts: an app-server is shared for the life of a
    // project, so computer use has to be on the one launch that serves its turns.
    const computerUseArgs = await this.computerUseConfigArgs(projectPath)
    const prepared = await prepareHarnessInvocation(
      'codex',
      [
        ...providerArgs,
        'app-server',
        '-c',
        CODEX_DEFAULT_QUESTION_CONFIG,
        ...computerUseArgs,
        '--listen',
        'stdio://'
      ],
      {
        cwd: projectPath,
        env: {
          ...(await buildProcessEnvironmentAsync({ ...process.env, ...this.accountEnvironment })),
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
    const generation = this.appServerGeneration
    const promise = (async (): Promise<CodexAppServerHost> => {
      const host = await codexStartupQueue(async () => {
        if (generation !== this.appServerGeneration) throw new Error('Codex driver disposed')
        const created = await this.createAppServerHost(projectPath)
        if (generation !== this.appServerGeneration) {
          this.stopAppServerHost(created, 'Codex driver disposed')
          throw new Error('Codex driver disposed')
        }
        return created
      })
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

  private codexHomeKey(): string {
    return this.accountEnvironment['CODEX_HOME']?.trim() || 'default'
  }

  /**
   * The context window this turn actually sends to Codex. Codex's own catalog
   * decides which windows a model runs with, so a stored window the model no
   * longer offers is dropped and the turn keeps Codex's default, exactly as the
   * picker shows it. A catalog that has not been read leaves the stored pick
   * untouched instead of silently discarding the user's choice.
   */
  private codexContextWindowOverride(settings: ThreadSettings): number | undefined {
    const requested = settings.contextWindow
    if (requested === undefined || settings.providerId !== 'openai') return undefined
    const cached = this.codexWindowsByHome.get(this.codexHomeKey())
    if (!cached) return requested
    const offered = codexContextWindowOptions(cached.catalog.get(settings.modelId))
    return offered.length === 0 || offered.includes(requested) ? requested : undefined
  }

  /**
   * Codex's own context windows for every model it lists, read through
   * `codex debug models`, the CLI's supported dump of the catalog it actually
   * runs with. A failed read yields an empty catalog rather than a guessed
   * figure: a model with no stated window shows no window options at all.
   */
  private async codexWindowCatalog(
    projectPath: string,
    force = false
  ): Promise<CodexWindowCatalog> {
    const home = this.codexHomeKey()
    const cached = this.codexWindowsByHome.get(home)
    if (!force && cached && Date.now() - cached.readAt < CODEX_WINDOW_CATALOG_TTL_MS)
      return cached.catalog
    const pending = this.codexWindowReads.get(home)
    if (pending) return pending
    const read = this.readCodexWindowCatalog(projectPath)
      .then((catalog) => {
        this.codexWindowsByHome.set(home, { catalog, readAt: Date.now() })
        return catalog
      })
      .catch((error: unknown) => {
        // A transient failure must not cache an empty catalog: the next
        // discovery reads Codex again instead of showing no windows for minutes.
        Logger.info('Codex context window catalog unavailable', {
          error: error instanceof Error ? error.message : String(error)
        })
        return emptyCodexWindowCatalog()
      })
      .finally(() => {
        this.codexWindowReads.delete(home)
      })
    this.codexWindowReads.set(home, read)
    return read
  }

  private async readCodexWindowCatalog(projectPath: string): Promise<CodexWindowCatalog> {
    const result = await runHarnessCommand('codex', ['debug', 'models'], {
      cwd: projectPath,
      env: await buildProcessEnvironmentAsync({ ...process.env, ...this.accountEnvironment }),
      timeoutMs: 20_000,
      // The catalog embeds each model's prompt templates, so it is far larger
      // than any other harness command output.
      maxOutputBytes: 8 * 1024 * 1024
    })
    return parseCodexWindowCatalog(JSON.parse(result.stdout))
  }

  private async discoverModels(projectPath: string): Promise<ProviderModel[]> {
    let temporaryHost: CodexAppServerHost | null = null
    try {
      const windows = await this.codexWindowCatalog(projectPath)
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
          const model = mapCodexModel(value, windows)
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
    host.child.on('error', (error) => void this.failAppServerHost(host, error.message, true))
    host.child.on('exit', (code, signal) => {
      if (host.stopped) return
      const detail = host.stderrBuffer.trim()
      void this.failAppServerHost(
        host,
        `Codex app-server exited (${code ?? signal ?? 'unknown'})${detail ? `: ${detail}` : ''}`,
        true
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
      let usage = mapCodexUsage(params['tokenUsage'] ?? params)
      const message = active.session.messages
        .slice(active.messageOffset ?? 0)
        .findLast((candidate) => candidate.role === 'assistant')
      if (usage && !message) {
        // Wait for this turn's first response instead of rewriting the previous
        // turn's final response. Cumulative counters recover coalesced updates.
        active.pendingUsage = params
        return
      }
      if (usage && message) {
        const total = mapCodexTotalUsage(params['tokenUsage'] ?? params)
        const checkpoint = active.session.codexUsageCheckpoint
        if (total && active.nativeThreadId) {
          const previous =
            checkpoint?.nativeThreadId === active.nativeThreadId ? checkpoint.tokens : undefined
          // A legacy resumed session has no checkpoint. Its first last-request
          // snapshot is all that can be attributed honestly; retain the total
          // from then on rather than charging old session history to this turn.
          if (previous && total.total >= previous.total) {
            const tokens = { ...total }
            for (const key of Object.keys(tokens) as Array<keyof AgentTokenUsage>) {
              tokens[key] = (message.tokens?.[key] ?? 0) + Math.max(0, total[key] - previous[key])
            }
            const mapped = mapCodexUsage({ ...tokens, totalTokens: tokens.total })
            if (mapped) {
              usage = {
                ...usage,
                aggregateTokens: mapped.aggregateTokens,
                normalizedUsage: mapped.normalizedUsage
                  ? {
                      ...mapped.normalizedUsage,
                      cachedInput:
                        usage.normalizedUsage?.cachedInput === null
                          ? null
                          : mapped.normalizedUsage.cachedInput,
                      cacheWrite:
                        usage.normalizedUsage?.cacheWrite === null
                          ? null
                          : mapped.normalizedUsage.cacheWrite,
                      reasoning:
                        usage.normalizedUsage?.reasoning === null
                          ? null
                          : mapped.normalizedUsage.reasoning,
                      rawProviderUsage: {
                        providerSnapshot: recordValue(params['tokenUsage'] ?? params) ?? {},
                        cumulative: total,
                        previousCumulative: previous
                      }
                    }
                  : undefined
              }
            }
          }
          active.session.codexUsageCheckpoint = {
            nativeThreadId: active.nativeThreadId,
            tokens: total
          }
        }
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
        const retryIssue = codexRetryIssue(error, message)
        // Codex's reconnecting loop cannot satisfy an expired credential: it
        // re-fails the same 401 until it gives up, which used to leave the
        // thread parked on a connection-wait card whose only actions were
        // Retry and Stop, with no way to sign in again. Report the terminal
        // sign-in verdict now, and keep it so the turn's teardown carries it.
        if (retryIssue.kind === 'authentication') {
          active.waitingForRetry = false
          active.failure = retryIssue.message
          active.failureIssue = retryIssue
          this.emit({
            type: 'session.status',
            sessionId: active.session.id,
            status: { state: 'error', issue: retryIssue }
          })
          return
        }
        active.failure = undefined
        active.waitingForRetry = true
        this.emit({
          type: 'session.status',
          sessionId: active.session.id,
          status: { state: 'waiting', issue: retryIssue }
        })
      } else {
        active.waitingForRetry = false
        active.failure = message
        active.failureIssue = codexUsageLimitIssue(error, message) ?? active.failureIssue
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
    active.completion = this.completeAppServerTurn(active, message, issue)
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
      if (
        !tool ||
        !endpoint ||
        active.finished ||
        (endpoint.toolNames !== undefined && !endpoint.toolNames.includes(tool.name))
      ) {
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
      // A transferred thread can still emit late events on the source host.
      return undefined
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
    if (active.pendingUsage && result.messages?.some((message) => message.role === 'assistant')) {
      const pendingUsage = active.pendingUsage
      delete active.pendingUsage
      this.handleAppServerNotification(active.host, 'thread/tokenUsage/updated', pendingUsage)
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
      host.pending.set(id, { method, resolve, reject, timer })
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
    if (!error) this.appServerRecoveriesBySessionId.delete(active.session.id)
    if (active.finished) return
    if (active.pendingUsage) {
      // A cancelled or failed request can report usage without ever emitting
      // content. Keep an accounting-only response rather than losing its spend.
      this.applyCodexResult(active, {
        messages: [
          {
            id: `${active.session.id}:${active.turnId ?? 'turn'}:usage`,
            role: 'assistant',
            visibility: 'working_trace',
            parts: [],
            createdAt: Date.now(),
            completedAt: Date.now(),
            ...(error ? { error } : {})
          }
        ]
      })
    }
    const finalUsageMessage = active.session.messages
      .slice(active.messageOffset ?? 0)
      .findLast((message) => message.role === 'assistant')
    if (finalUsageMessage) {
      let sessionCost = 0
      let priced = false
      let complete = true
      for (const message of active.session.messages) {
        if (
          message.role !== 'assistant' ||
          message.providerId !== finalUsageMessage.providerId ||
          message.harnessId !== this.id
        )
          continue
        if (typeof message.cost === 'number') {
          sessionCost += message.cost
          priced = true
        } else if (message.tokens || message.normalizedUsage) complete = false
      }
      if (priced && complete) {
        const costEvent: AgentEvent = {
          type: 'usage.updated',
          sessionId: active.session.id,
          messageId: finalUsageMessage.id,
          cost: sessionCost
        }
        this.applyEventToSession(active.session, costEvent)
        this.emit(costEvent)
      }
    }
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

  /**
   * The issue for a dead Codex app-server. The app-server is a shared, app-scoped
   * process, so its exit is a harness/transport interruption rather than a
   * provider verdict on the work itself: the native thread survives on disk and
   * a freshly spawned app-server resumes it.
   *
   * While the session still has recovery budget the issue is a retryable
   * `provider_unavailable` wait carrying a concrete `retryAt`, which is what
   * makes `ChatEngine.enterRetryWait` persist the thread as paused and the retry
   * scheduler resume it automatically. Without that deadline the failure is
   * classified `unknown` by {@link classifyProviderIssue} and is never admitted
   * for automatic resume, so the turn was thrown away and the user had to retype
   * it (observed on thread cf987dbf: five lost turns, three inside 15 minutes).
   *
   * Once the budget is spent the issue keeps its classified kind and no deadline,
   * which renders the terminal failure for manual recovery instead of looping.
   */
  private gracefulAppServerIssue(error: string, sessionId: string): AgentProviderIssue {
    const attempted = this.appServerRecoveriesBySessionId.get(sessionId) ?? 0
    if (attempted >= CODEX_APP_SERVER_RECOVERY_LIMIT) {
      return {
        kind: classifyProviderIssue(error),
        message:
          attempted === CODEX_APP_SERVER_RECOVERY_LIMIT
            ? 'The Codex app-server keeps stopping unexpectedly. CodeInOven stopped retrying this turn automatically; retry the message to continue your work.'
            : 'The Codex app-server stopped unexpectedly. Retry the message to continue your work.',
        rawError: error,
        harnessId: this.id,
        retryable: true,
        ...(attempted === CODEX_APP_SERVER_RECOVERY_LIMIT ? { attempt: attempted } : {})
      }
    }
    this.appServerRecoveriesBySessionId.set(sessionId, attempted + 1)
    return {
      kind: 'provider_unavailable',
      message:
        'The Codex app-server stopped unexpectedly. CodeInOven is restarting it and will resume this turn.',
      rawError: error,
      harnessId: this.id,
      retryable: true,
      retryAt: Date.now() + CODEX_APP_SERVER_RESTART_DELAY_MS
    }
  }

  private async failAppServerHost(
    host: CodexAppServerHost,
    error: string,
    recoverable = false
  ): Promise<void> {
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
    await Promise.all(
      affected.map((active) =>
        // The recovery budget is per session, so each affected turn gets its own
        // issue; a deliberate restart keeps its own terminal reason.
        this.finishAppServerTurn(
          active,
          error,
          recoverable
            ? this.gracefulAppServerIssue(error, active.session.id)
            : this.deliberateAppServerIssue(error)
        )
      )
    )
  }

  /** The issue for an app-server the app itself is replacing (harness update,
   *  provider sign-in): an intentional stop, so it is never auto-resumed. */
  private deliberateAppServerIssue(error: string): AgentProviderIssue {
    return {
      kind: classifyProviderIssue(error),
      message: 'The Codex app-server was restarted. Retry the message to continue your work.',
      rawError: error,
      harnessId: this.id,
      retryable: true
    }
  }

  private async codexInput(
    text: string,
    attachments: PromptAttachment[],
    sessionId: string,
    historyRecap?: string
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
    const currentInput = input[0]?.['text']
    if (typeof currentInput === 'string' && historyRecap?.trim()) {
      const combined = prependHistoryRecap(currentInput, historyRecap)
      input[0] = { type: 'text', text: combined, text_elements: [] }
      if (combined.length > 1_048_576 && currentInput.length < 1_048_576 - 4_096) {
        const relativePath = `drivers/${this.id}/inputs/${sessionId}/${randomUUID()}.txt`
        await this.storage.writeRaw(relativePath, historyRecap)
        const prefix = [
          'Restored conversation history follows as background only. Earlier requests may already be completed. Respond to the current user request after the end of history.',
          `Older history was omitted to fit the input limit. The complete history is available at ${JSON.stringify(this.storage.resolve(relativePath))}. Consult it only if needed for the current request.`,
          'Recent history excerpt, which may start partway through an earlier message:'
        ].join('\n\n')
        const trailer = 'End of restored history. Current user request follows:'
        const historyBudget = Math.max(
          0,
          1_048_576 - prefix.length - trailer.length - currentInput.length - 6
        )
        input[0] = {
          type: 'text',
          text: [
            prefix,
            historyBudget > 0 ? historyRecap.slice(-historyBudget) : '',
            trailer,
            currentInput
          ].join('\n\n'),
          text_elements: []
        }
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
    projectPath: string,
    session: PersistentCliSession,
    options: Parameters<PersistentCliDriver['sendPrompt']>[1]
  ): Promise<CliTurnCommand> {
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
    const contextWindow = this.codexContextWindowOverride(options.settings)
    if (contextWindow !== undefined) {
      args.push(
        '-c',
        `model_context_window=${contextWindow}`,
        '-c',
        `model_auto_compact_token_limit=${Math.floor(contextWindow * COMPACT_LINE_SHARE)}`
      )
    }
    const { env, args: providerArgs } = await this.customProviderOverlay()
    args.push(...providerArgs)
    // A one-shot turn never shares the resident host, so it carries the same
    // computer-use config the host launch decides.
    args.push(...(await this.computerUseConfigArgs(projectPath)))
    args.push('-c', 'tool_output_token_limit=3000')
    if (options.minimalContext) {
      const config = await codexAuxiliaryConfig(projectPath)
      for (const [key, value] of Object.entries(config))
        args.push('-c', `${key}=${JSON.stringify(value)}`)
    }
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
        ...(await buildProcessEnvironmentAsync({ ...process.env, ...this.accountEnvironment })),
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
