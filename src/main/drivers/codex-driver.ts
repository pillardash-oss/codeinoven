import { createWorkQueue } from '../../lib/bounded-work'
import { type ChildProcess } from 'child_process'
import {
  type AgentBankedResets,
  type AgentEvent,
  type AgentMessage,
  type AgentRateLimitWindow,
  type AgentUsageCredits,
  type HarnessCommand,
  type PermissionReply,
  type ProviderCatalog,
  type ProviderModel,
  type ThinkingLevel,
  type ThreadSettings,
  type UtilityKind
} from '../../lib/types'
import { resolveFastModelId } from '../../lib/fast-inference'
import { COMPACT_LINE_SHARE } from '../../lib/prompt-budget'
import { BaseUrlProviderService } from '../providers/base-url-provider-service'
import { type UtilityGatewayEndpoint } from '../../lib/gateway-timeout'
import { SecretVault } from '../storage/secret-vault'
import { type StorageEngine } from '../storage/storage-engine'
import { buildProcessEnvironmentAsync } from './cli-environment'
import { prependHistoryRecap } from './history-recap-prompt'
import { attachmentReference } from './attachment-reference'
import {
  type GenerateTitleOptions,
  type GradeTurnOptions,
  type HarnessCapabilities,
  type IdleNativeSessionHandOffProbe,
  type IdleNativeSessionReleaseResult,
  type SendPromptOptions,
  type SteerPromptOptions,
  type UtilityRuntimeOverlay,
  type UtilityRuntimePreparationRequest
} from './driver.interface'
import {
  PersistentCliDriver,
  type CliLineParseContext,
  type CliLineParseResult,
  type CliTurnCommand,
  type PersistentCliSession,
  type TitleModelCandidate
} from './persistent-cli-driver'
import { inlineSvgAttachments, isSvgAttachment } from './svg-attachment'
import { runHarnessCommand } from './harness-runtime'
import { type CodexWindowCatalog } from './codex/codex-catalog'
import {
  type CodexAppServerHost,
  type CodexAppServerTurn,
  type CodexCompactionRun,
  type CodexContextUsageWaiter,
  type CodexServerRequest
} from './codex/codex-protocol'
import { sandboxFor, tomlString } from './codex/codex-tools'
import { type CodexComputerUseReadiness } from './codex/codex-computer-use'
import { mapCodexRateLimits, mapCodexUsage } from './codex/codex-usage'
import { codexAuxiliaryConfig, composePrompt, localAttachmentPath } from './codex/codex-prompts'
import { parseCodexJsonLine } from './codex/codex-stream-fold'
import { buildCodexDriverUnits } from './codex-driver/codex-driver-units'

export { mapCodexRateLimits, mapCodexUsage }

/**
 * How long CodeInOven waits after an unexpected Codex app-server exit before the
 * scheduled auto-resume dispatches the continuation. The wait only has to cover
 * dropping the dead host; the replacement app-server is spawned by the resumed
 * turn itself, and the retry scheduler adds its own fire grace on top. */
// Account drivers share a startup slot so initialization is not competing with
// other cold Codex processes on memory-constrained machines.
export const codexStartupQueue = createWorkQueue(1)
export const CODEX_APP_SERVER_RESTART_DELAY_MS = 5_000
/**
 * Consecutive unexpected app-server exits CodeInOven auto-recovers for one
 * session before it stops resuming and reports the terminal failure. A harness
 * that cannot stay up must surface for manual recovery instead of retry-looping.
 */
export const CODEX_APP_SERVER_RECOVERY_LIMIT = 3
/** How long Codex's own context-window catalog is reused before it is read
 *  again. Codex updates that catalog with its own releases, not per turn. */
export const CODEX_WINDOW_CATALOG_TTL_MS = 5 * 60 * 1000

/** Multiplexed bridge for one resident Codex app-server and many native threads. */
export class CodexDriver extends PersistentCliDriver {
  /**
   * The base-class surface the concern units reach. A protected member of the
   * parent class is not visible from another class, so every one a unit uses is
   * exposed here once, and a call still lands on this driver's own override.
   */
  readonly base = this.buildBaseHost()
  /**
   * One owner per concern. Each unit holds this engine and nothing else, so they
   * are safe to build first: none of them reads a field at construction.
   */
  readonly units = buildCodexDriverUnits(this)
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
    // The app-server does not guarantee desktop tools for every model/session.
    // Keep the app-managed computer-use fallback available.
    nativeUtilities: ['web_search', 'web_fetch']
  }
  /** How old a computer-use answer may be before it is re-measured. The refresh
   *  runs in the background, so a turn never waits for it. */
  static readonly COMPUTER_USE_STALE_MS = 60_000
  public computerUseLogged?: boolean
  public activeTurns = new Map<string, CodexAppServerTurn>()
  public utilityEndpoints = new Map<string, UtilityGatewayEndpoint>()
  public modelsWithoutReasoningSummaries = new Set<string>()
  public compactionsByThreadId = new Map<string, CodexCompactionRun>()
  public contextUsageByThreadId = new Map<string, CodexContextUsageWaiter>()
  /** Last session that bound each native codex thread, so auto-compaction
   *  item notifications that arrive outside any registered turn (between
   *  turns, at resume/turn-start) can still reach the owning session. */
  public threadSessionsByNativeId = new Map<string, { sessionId: string; projectPath: string }>()
  /** Resident app-server hosts keyed by project working directory, so one
   *  app-server never serves two working directories at once. A standalone chat
   *  works in its own `chats-cwd/<threadId>` directory, so chats never share a
   *  resident server; {@link stopResidentHostForPathIfIdle} stops an idle one. */
  public hostsByProjectPath = new Map<string, CodexAppServerHost>()
  public hostsStartingByProjectPath = new Map<string, Promise<CodexAppServerHost>>()
  public appServerHosts = new Set<CodexAppServerHost>()
  appServerGeneration = 0
  public authenticationRestartsByProjectPath = new Map<string, Promise<void>>()
  public serverRequests = new Map<string, CodexServerRequest>()
  /** Codex's own context windows, cached per Codex home. The CLI's catalog
   *  changes only when Codex itself updates it, so a short TTL keeps repeated
   *  catalog refreshes from re-running the dump for every project. */
  public codexWindowsByHome = new Map<string, { catalog: CodexWindowCatalog; readAt: number }>()
  public codexWindowReads = new Map<string, Promise<CodexWindowCatalog>>()

  /** Consecutive automatic recoveries already attempted for a session after the
   *  shared app-server died under it, cleared the moment one of its turns
   *  completes. Bounds the auto-resume of a harness that cannot stay up, so a
   *  broken installation surfaces a terminal failure instead of retry-looping. */
  public appServerRecoveriesBySessionId = new Map<string, number>()

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
    // Measure the device once, off the turn path: the answer decides whether the
    // app-owned CUA driver has to stand in for Codex's own computer use, and
    // starting a turn is the wrong moment to launch Codex a second time.
    void this.refreshComputerUse(this.codexHomeKey()).catch(() => undefined)
  }

  constructor(
    storage: StorageEngine,
    public readonly baseUrlProviders?: BaseUrlProviderService,
    public readonly secretVault?: SecretVault,
    public readonly accountEnvironment: NodeJS.ProcessEnv = {}
  ) {
    super(storage)
  }
  async listProviders(projectPath: string): Promise<ProviderCatalog[]> {
    return this.units['catalog'].listProviders(projectPath)
  }
  async modelContext(
    projectPath: string,
    modelId: string
  ): Promise<Pick<ProviderModel, 'contextWindow' | 'contextWindows'> | null> {
    return this.units['prompting'].modelContext(projectPath, modelId)
  }
  override async listCommands(projectPath: string): Promise<HarnessCommand[]> {
    return this.units['capabilities'].listCommands(projectPath)
  }
  override async runCommand(
    projectPath: string,
    sessionId: string,
    command: HarnessCommand,
    args: string,
    settings: ThreadSettings
  ): Promise<void> {
    return this.units['capabilities'].runCommand(projectPath, sessionId, command, args, settings)
  }
  async generateTitle(projectPath: string, options: GenerateTitleOptions): Promise<string | null> {
    return this.units['usage'].generateTitle(projectPath, options)
  }
  async gradeTurn(projectPath: string, options: GradeTurnOptions): Promise<number | null> {
    return this.units['turns'].gradeTurn(projectPath, options)
  }
  async publishUtilityGatewayEndpoint(
    _projectPath: string,
    sessionId: string,
    endpoint: UtilityGatewayEndpoint | null
  ): Promise<void> {
    return this.units['tools'].publishUtilityGatewayEndpoint(_projectPath, sessionId, endpoint)
  }
  async resolveNativeUtilities(projectPath: string): Promise<UtilityKind[]> {
    return this.units['driver'].resolveNativeUtilities(projectPath)
  }
  refreshComputerUse(key: string): Promise<CodexComputerUseReadiness> {
    return this.units['panels'].refreshComputerUse(key)
  }
  async computerUseConfigArgs(): Promise<string[]> {
    return this.units['panels'].computerUseConfigArgs()
  }
  override async sendPrompt(projectPath: string, options: SendPromptOptions): Promise<void> {
    return this.units['prompting'].sendPrompt(projectPath, options)
  }
  async steerPrompt(projectPath: string, options: SteerPromptOptions): Promise<void> {
    return this.units['prompting'].steerPrompt(projectPath, options)
  }
  override async replyPermission(
    _projectPath: string,
    requestId: string,
    reply: PermissionReply,
    message?: string,
    _sessionId?: string
  ): Promise<void> {
    return this.units['approvals'].replyPermission(
      _projectPath,
      requestId,
      reply,
      message,
      _sessionId
    )
  }
  override async replyToQuestion(
    _projectPath: string,
    sessionId: string,
    requestId: string,
    answers: string[][]
  ): Promise<void> {
    return this.units['questions'].replyToQuestion(_projectPath, sessionId, requestId, answers)
  }
  override async rejectQuestion(
    _projectPath: string,
    sessionId: string,
    requestId: string
  ): Promise<void> {
    return this.units['questions'].rejectQuestion(_projectPath, sessionId, requestId)
  }
  hasActiveTurn(sessionId: string): boolean {
    return this.units['turns'].hasActiveTurn(sessionId)
  }
  override async isSessionBusy(_projectPath: string, sessionId: string): Promise<boolean> {
    return this.units['sessions'].isSessionBusy(_projectPath, sessionId)
  }
  override async abort(projectPath: string, sessionId: string): Promise<void> {
    return this.units['turns'].abort(projectPath, sessionId)
  }
  restartAfterAuthentication(projectPath: string): Promise<void> {
    return this.units['runtime'].restartAfterAuthentication(projectPath)
  }
  override async restartRuntime(): Promise<void> {
    return this.units['runtime'].restartRuntime()
  }
  override async deleteSession(projectPath: string, sessionId: string): Promise<void> {
    return this.units['sessions'].deleteSession(projectPath, sessionId)
  }
  override releaseProjectResources(projectPath: string): void {
    return this.units['driver'].releaseProjectResources(projectPath)
  }
  hasSessionWriter(projectPath: string, sessionId: string): boolean {
    return this.units['sessions'].hasSessionWriter(projectPath, sessionId)
  }
  async releaseIdleSessionForTransfer(
    projectPath: string,
    sessionId: string
  ): Promise<IdleNativeSessionReleaseResult> {
    return this.units['sessions'].releaseIdleSessionForTransfer(projectPath, sessionId)
  }
  async canHandOffIdleSession(
    projectPath: string,
    sessionId: string
  ): Promise<IdleNativeSessionHandOffProbe> {
    return this.units['sessions'].canHandOffIdleSession(projectPath, sessionId)
  }
  override dispose(): void {
    return this.units['runtime'].dispose()
  }
  prepareForProcessCleanup(): void {
    return this.units['runtime'].prepareForProcessCleanup()
  }
  codexHomeKey(): string {
    return this.units['driver'].codexHomeKey()
  }
  codexContextWindowOverride(settings: ThreadSettings): number | undefined {
    return this.units['prompting'].codexContextWindowOverride(settings)
  }
  async prepareUtilityRuntime(
    request: UtilityRuntimePreparationRequest
  ): Promise<UtilityRuntimeOverlay> {
    return this.units['tools'].prepareUtilityRuntime(request)
  }
  async loadMessages(projectPath: string, sessionId: string): Promise<AgentMessage[]> {
    return this.units['messages'].loadMessages(projectPath, sessionId)
  }
  async loadMessagesSince(
    projectPath: string,
    sessionId: string,
    messageId: string
  ): Promise<AgentMessage[]> {
    return this.units['messages'].loadMessagesSince(projectPath, sessionId, messageId)
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
    args.push(...(await this.computerUseConfigArgs()))
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
    return this.units['sessions'].compactSession(projectPath, sessionId, _settings)
  }
  async customProviderOverlay(): Promise<{ env: Record<string, string>; args: string[] }> {
    return this.units['catalog'].customProviderOverlay()
  }
  async refreshRateLimits(
    projectPath: string,
    session: PersistentCliSession,
    messageId: string
  ): Promise<void> {
    return this.units['usage'].refreshRateLimits(projectPath, session, messageId)
  }
  async readAccountUsage(projectPath: string): Promise<{
    rateLimits: AgentRateLimitWindow[]
    credits?: AgentUsageCredits
    bankedResets?: AgentBankedResets
    reauthenticationRequired?: boolean
  } | null> {
    return this.units['usage'].readAccountUsage(projectPath)
  }
  async activateBankedReset(projectPath: string): Promise<{
    rateLimits: AgentRateLimitWindow[]
    credits?: AgentUsageCredits
    bankedResets?: AgentBankedResets
  } | null> {
    return this.units['usage'].activateBankedReset(projectPath)
  }
  async refreshContextUsage(
    projectPath: string,
    session: PersistentCliSession,
    messageId: string,
    nativeThreadId: string
  ): Promise<void> {
    return this.units['prompting'].refreshContextUsage(
      projectPath,
      session,
      messageId,
      nativeThreadId
    )
  }

  protected parseJsonLine(value: unknown, context: CliLineParseContext): CliLineParseResult | null {
    return parseCodexJsonLine(value, context, {
      refreshContextUsage: (projectPath, session, messageId, nativeThreadId) =>
        this.refreshContextUsage(projectPath, session, messageId, nativeThreadId),
      refreshRateLimits: (projectPath, session, messageId) =>
        this.refreshRateLimits(projectPath, session, messageId)
    })
  }

  private buildBaseHost() {
    // The host is a plain object literal: its getters/setters run with the
    // literal as `this`, so every member reaches the driver through this alias.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const driver = this
    return {
      appendUserMessage: (
        session: PersistentCliSession,
        opts: Pick<SendPromptOptions, 'text' | 'attachments' | 'userMessageId'>
      ) => driver.appendUserMessage(session, opts),
      applyEventToSession: (session: PersistentCliSession, event: AgentEvent) =>
        driver.applyEventToSession(session, event),
      get capabilities() {
        return driver.capabilities
      },
      emit: (event: AgentEvent) => driver.emit(event),
      generateTitleWithCandidates: (
        projectPath: string,
        options: GenerateTitleOptions,
        candidates: TitleModelCandidate[]
      ) => driver.generateTitleWithCandidates(projectPath, options, candidates),
      gradeTurnWithCandidates: (
        projectPath: string,
        options: GradeTurnOptions,
        candidates: TitleModelCandidate[]
      ) => driver.gradeTurnWithCandidates(projectPath, options, candidates),
      get id() {
        return driver.id
      },
      mergeMessages: (session: PersistentCliSession, messages: AgentMessage[]) =>
        driver.mergeMessages(session, messages),
      get name() {
        return driver.name
      },
      nativeSessionId: (projectPath: string, sessionId: string) =>
        driver.nativeSessionId(projectPath, sessionId),
      observeHarnessProcess: (
        sessionId: string | undefined,
        child: ChildProcess,
        command: string,
        cwd: string
      ) => driver.observeHarnessProcess(sessionId, child, command, cwd),
      persistSession: (session: PersistentCliSession) => driver.persistSession(session),
      requireSession: (projectPath: string, sessionId: string) =>
        driver.requireSession(projectPath, sessionId),
      sendPrompt: (projectPath: string, opts: SendPromptOptions) =>
        driver.sendPrompt(projectPath, opts),
      get sessionCache() {
        return driver.sessionCache
      },
      set sessionCache(value: typeof driver.sessionCache) {
        driver.sessionCache = value
      },
      setTurnProvenance: (
        sessionId: string,
        providerId?: string,
        modelId?: string,
        thinkingLevel?: ThinkingLevel
      ) => driver.setTurnProvenance(sessionId, providerId, modelId, thinkingLevel),
      steerPrompt: (projectPath: string, options: SteerPromptOptions) =>
        driver.steerPrompt(projectPath, options),
      get storage() {
        return driver.storage
      },
      superDeleteSession: (projectPath: string, sessionId: string) =>
        super.deleteSession(projectPath, sessionId),
      superDispose: () => super.dispose(),
      superLoadMessages: (projectPath: string, sessionId: string) =>
        super.loadMessages(projectPath, sessionId),
      superLoadMessagesSince: (projectPath: string, sessionId: string, messageId: string) =>
        super.loadMessagesSince(projectPath, sessionId, messageId),
      superReleaseProjectResources: (projectPath: string) =>
        super.releaseProjectResources(projectPath),
      superRestartRuntime: () => super.restartRuntime(),
      utilityRuntime: (sessionId: string) => driver.utilityRuntime(sessionId)
    }
  }
}
