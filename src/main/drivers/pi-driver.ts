import { join } from 'path'
import type {
  AgentEvent,
  AgentMessage,
  AgentRateLimitWindow,
  AgentUsageCredits,
  ProviderCatalog
} from '../../lib/types'
import type { UtilityGatewayEndpoint } from '../../lib/gateway-timeout'
import { buildProcessEnvironmentAsync } from './cli-environment'
import { PiAuthConfigService, piAuthFileIo } from '../providers/pi-auth-config'
import type { BaseUrlProviderService } from '../providers/base-url-provider-service'
import type { SecretVault } from '../storage/secret-vault'
import type { StorageEngine } from '../storage/storage-engine'
import { Logger } from '../system/logger'
import { DevStepClock } from '../system/dev-timing'
import type {
  CompactionFallbackContext,
  GenerateTitleOptions,
  HarnessCapabilities,
  SendPromptOptions,
  SteerPromptOptions
} from './driver.interface'
import type { HarnessCommand, PermissionReply, ThreadSettings } from '../../lib/types'
import {
  PersistentCliDriver,
  type CliLineParseContext,
  type CliLineParseResult,
  type CliTurnCommand,
  type PersistentCliSession,
  type TitleModelCandidate
} from './persistent-cli-driver'
import { PiRpcClient, type PiRpcImage } from './pi-rpc-client'
import { runHarnessCommand } from './harness-runtime'

import { record, withTimeout } from './pi/pi-values'
import { composePiAttachments } from './pi/pi-prompt-assembly'
import { PiModelCatalog } from './pi/pi-driver-models'
import { PiSubagentStreams } from './pi/pi-driver-subagents'
import { PiUiRequestBoard } from './pi/pi-driver-ui-requests'
import { PiUsageTracker } from './pi/pi-driver-usage'
import { PiNativeSessions } from './pi/pi-driver-native-session'
import { PiCioRuntimeFiles } from './pi/pi-driver-cio-files'
import { PiRpcSessions } from './pi/pi-driver-rpc'
import { PiTurnLifecycle } from './pi/pi-driver-turns'

export { isContinuableFinishReasonError, isOversizedRequestError } from './pi/pi-errors'
export { mapPiRateLimitHeaders } from './pi/pi-usage'
export { mapPiRecord } from './pi/pi-stream-fold'
export type { PiStreamContext } from './pi/pi-stream-types'

/**
 * How long a stopped session may keep streaming before the driver kills its pi
 * process. A stop must be authoritative: pi's abort RPC is the graceful path,
 * but a run that ignores it (or a wedged process) would otherwise keep working
 *   with its nested worker sessions   after the user pressed stop.
 */
const PI_ABORT_ENFORCE_MS = 3_000
const PI_ABORT_ENFORCE_INTERVAL_MS = 500
/** Bound on the post-abort `get_state` probe so a busy process cannot stall the
 *  stop behind the RPC client's full request timeout. */
const PI_ABORT_PROBE_TIMEOUT_MS = 1_500
/**
 * How long the `abort` RPC itself may take before the process is terminated.
 *
 * Pi answers an abort as soon as its run unwinds, so a missing answer means the
 * run cannot unwind (a dialog it is parked on that nothing will ever answer) or
 * the transport is wedged. Waiting for the RPC client's own request timeout
 * instead kept the caller (the permission card the user just rejected, the
 * thread status behind it) frozen for a full two minutes.
 */
const PI_ABORT_RPC_TIMEOUT_MS = 5_000

/** Pi thinking levels accepted by `set_thinking_level`. */
const PI_THINKING_LEVELS: Record<string, string> = {
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'xhigh',
  ultra: 'xhigh'
}

function piThinkingLevel(value: string): 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' {
  const resolved = PI_THINKING_LEVELS[value]
  if (
    resolved === 'minimal' ||
    resolved === 'low' ||
    resolved === 'medium' ||
    resolved === 'high' ||
    resolved === 'xhigh'
  ) {
    return resolved
  }
  return 'medium'
}

/** pi rejects `set_model` for models outside its availability snapshot; the
 *  only recovery is a fresh process with a regenerated providers extension. */
function isPiModelNotFoundError(error: unknown): boolean {
  return error instanceof Error && /^Model not found: /u.test(error.message)
}

/**
 * Whether a rejected `prompt` is pi refusing the input rather than failing to
 * take it: its streaming guard (`agent-session.js`), or the manual-compaction
 * guard that runs before it. Only a refusal means "this session is alive and the
 * message needs another channel"; every other failure of a `prompt` is a real
 * delivery error and must keep its own outcome.
 */
function isPiInputRefusal(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return (
    error.message.includes('Agent is already processing') ||
    error.message.includes('Cannot submit a prompt while compaction is in progress')
  )
}

/**
 * Driver for Pi's headless agent. Unlike the former in-process SDK path, this
 * shells out to the `pi` CLI the user installs on PATH (like Claude Code), so
 * the heavy Pi runtime is never bundled. It drives `pi --mode rpc` over stdio
 * and keeps one persistent Pi process per active CodeInOven session.
 */
export class PiDriver extends PersistentCliDriver {
  readonly id = 'pi'
  readonly name = 'Pi'
  // The recap rides the core-tools context hook for the turn it belongs to and
  // is never written into pi's own transcript (see publishCioHistoryRecap), so
  // the engine replays a parked branch's delta on every turn instead of once.
  readonly retainsRecapInTranscript = false
  readonly capabilities: HarnessCapabilities = {
    runtimeTopology: { kind: 'shared_daemon', scope: 'application', sessionWorkers: true },
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
    scheduledRetry: true,
    // The core-tools extension reconciles the task list on `agent_settled`
    // (src/main/drivers/pi/tools/core-tools-events.ts), so the chat engine's
    // generic guard must not nudge the same turn again. The driver reads the
    // answer that nudge must not replace back out of the record stream, so the
    // engine can keep it as the turn's answer.
    handlesTaskReconcile: true,
    reportsTaskReconcileAnswer: true,
    nativeUtilities: []
  }

  /** The extracted units that own this driver's concerns. */
  private readonly turns: PiTurnLifecycle
  private readonly rpcSessions: PiRpcSessions
  private readonly modelCatalog: PiModelCatalog
  private readonly subagentStreams: PiSubagentStreams
  private readonly uiRequests: PiUiRequestBoard
  private readonly usage: PiUsageTracker
  private readonly nativeSessions: PiNativeSessions
  private readonly cioFiles: PiCioRuntimeFiles
  /** This driver's Pi agent directory when it serves a managed account
   *  container; undefined for the harness-global account. Every catalog input
   *  (credentials, native provider config) lives inside that directory, so the
   *  driver must never read the other account's files. */
  private readonly agentDirectory: string | undefined
  /** Read view of THIS account's credential store (`auth.json`). The default
   *  account keeps the WSL-aware transport; a container path is a plain local
   *  file, exactly as the connect flow writes it. */
  private readonly authConfig: PiAuthConfigService

  constructor(
    storage: StorageEngine,
    private readonly baseUrlProviders?: BaseUrlProviderService,
    private readonly secretVault?: SecretVault,
    private readonly accountEnvironment: NodeJS.ProcessEnv = {}
  ) {
    super(storage)
    this.agentDirectory = accountEnvironment['PI_CODING_AGENT_DIR']?.trim() || undefined
    this.authConfig = this.agentDirectory
      ? new PiAuthConfigService(join(this.agentDirectory, 'auth.json'))
      : new PiAuthConfigService(undefined, piAuthFileIo)
    this.turns = new PiTurnLifecycle({
      agentDirectory: this.agentDirectory,
      requireSession: (projectPath, sessionId) => this.requireSession(projectPath, sessionId),
      persistSession: (session) => this.persistSession(session),
      mergeMessages: (session, messages) => this.mergeMessages(session, messages),
      applySessionEvent: (session, event) => this.applyEventToSession(session, event),
      emitEvent: (event) => this.emit(event),
      client: (sessionId) => this.rpcSessions.client(sessionId),
      projectOf: (sessionId) => this.rpcSessions.projectOf(sessionId),
      ensureClient: (projectPath, sessionId) =>
        this.rpcSessions.ensureClient(projectPath, sessionId),
      settledClient: (sessionId) => this.rpcSessions.settledClient(sessionId),
      disposeClient: (sessionId) => this.rpcSessions.disposeClient(sessionId),
      touchActivity: (sessionId) => this.rpcSessions.touchSessionActivity(sessionId),
      refreshSessionUsage: (session) => this.usage.refreshSessionUsage(session),
      scheduleLiveUsageRefresh: (session) => this.usage.scheduleLiveUsageRefresh(session),
      publishOversizedRecovery: (sessionId, armed) =>
        this.cioFiles.publishOversizedRecovery(sessionId, armed),
      normalizeInteractionEvents: (sessionId, events) =>
        this.normalizeInteractionEvents(sessionId, events),
      clearUsageThrottle: (sessionId) => this.usage.endTurn(sessionId),
      markCompactionReady: (sessionId) => this.rpcSessions.markCompactionReady(sessionId),
      handleUsageStatus: (record, sessionId) => this.usage.handleUsageStatus(record, sessionId),
      handleSubagentStreamStatus: (record, sessionId) =>
        this.subagentStreams.handleSubagentStreamStatus(record, sessionId)
    })
    this.rpcSessions = new PiRpcSessions({
      id: this.id,
      accountEnvironment,
      requireSession: (projectPath, sessionId) => this.requireSession(projectPath, sessionId),
      isTitleSession: (sessionId) => this.isTitleSession(sessionId),
      utilityRuntime: (sessionId) => this.utilityRuntime(sessionId),
      resolveRuntimePlaceholders: (value, runtime) =>
        this.resolveRuntimePlaceholders(value, runtime),
      workspaceTemporaryEnvironment: (projectPath) =>
        this.modelCatalog.workspaceTemporaryEnvironment(projectPath),
      observeHarnessProcess: (sessionId, child, command, projectPath) =>
        this.observeHarnessProcess(sessionId, child, command, projectPath),
      materializeCoreToolsExtension: (sessionId, bundledRuntime) =>
        this.cioFiles.materializeCoreToolsExtension(sessionId, bundledRuntime),
      materializeProvidersExtension: (sessionId) =>
        this.modelCatalog.materializeProvidersExtension(sessionId),
      providerExtensionEnv: (sessionId) => this.cioFiles.providerExtensionEnv(sessionId),
      forgetCioSession: (sessionId) => this.cioFiles.forgetSession(sessionId),
      resumeNativeSession: (projectPath, sessionId, client) =>
        this.nativeSessions.resumeNativePiSession(projectPath, sessionId, client),
      syncNativeSessionId: (projectPath, sessionId) =>
        this.nativeSessions.syncNativeSessionId(projectPath, sessionId),
      initializeTurnState: (sessionId, messages) =>
        this.turns.initializeTurnState(sessionId, messages),
      hasActiveTurn: (sessionId) => this.hasActiveTurn(sessionId),
      endActiveTurn: (sessionId) => this.turns.removeActiveTurn(sessionId),
      clearPageCompaction: (sessionId) => this.turns.clearPageCompaction(sessionId),
      resetSubagentWatch: (sessionId) => this.subagentStreams.resetWatch(sessionId),
      publishWatchLists: () => this.subagentStreams.publishWatchLists(),
      failChildStreams: (sessionId) => this.subagentStreams.settleChildStreams(sessionId, 'error'),
      hasLiveChildSession: (sessionId) => this.subagentStreams.hasLiveChildSession(sessionId),
      hasPendingUiRequest: (sessionId) => this.uiRequests.hasPendingUiRequest(sessionId),
      forgetUsage: (sessionId) => this.usage.forgetSession(sessionId),
      finishTurn: (session) => this.turns.finishTurn(session),
      handleRpcEvent: (record, sessionId, projectPath) =>
        this.turns.handleRpcEvent(record, sessionId, projectPath),
      handleUiRequest: (record, sessionId) => this.uiRequests.handleUiRequest(record, sessionId),
      handleExtensionStatus: (record, sessionId) =>
        this.turns.handleExtensionStatus(record, sessionId)
    })
    this.modelCatalog = new PiModelCatalog({
      id: this.id,
      agentDirectory: this.agentDirectory,
      accountEnvironment,
      baseUrlProviders,
      secretVault,
      storage,
      authConfig: this.authConfig,
      lastSessionProject: () => this.rpcSessions.lastSessionProject(),
      setProvidersExtensionEnv: (sessionId, env) =>
        this.cioFiles.setProviderExtensionEnv(sessionId, env)
    })
    this.subagentStreams = new PiSubagentStreams({
      id: this.id,
      storage,
      emitEvent: (event) => this.emit(event),
      cachedSession: (sessionId) => this.sessionCache.get(sessionId),
      hasActiveTurn: (sessionId) => this.hasActiveTurn(sessionId),
      applySessionEvent: (session, event) => this.applyEventToSession(session, event),
      applyMessagesEvent: (messages, event) => this.applyEventToMessages(messages, event)
    })
    this.uiRequests = new PiUiRequestBoard({
      name: this.name,
      rpcClient: (sessionId) => this.rpcSessions.client(sessionId),
      emitEvent: (event) => this.emit(event)
    })
    this.usage = new PiUsageTracker({
      storage,
      accountEnvironment,
      rpcClient: (sessionId) => this.rpcSessions.client(sessionId),
      projectSessionId: (projectPath) =>
        [...this.rpcSessions.projectEntries()].find(
          ([, clientProject]) => clientProject === projectPath
        )?.[0],
      hasActiveTurn: (sessionId) => this.hasActiveTurn(sessionId),
      applySessionEvent: (session, event) => this.applyEventToSession(session, event),
      emitEvent: (event) => this.emit(event)
    })
    this.nativeSessions = new PiNativeSessions({
      agentDirectory: this.agentDirectory,
      storage,
      hasClient: (sessionId) => this.rpcSessions.hasClient(sessionId),
      rpcClient: (sessionId) => this.rpcSessions.client(sessionId),
      session: (projectPath, sessionId) => this.requireSession(projectPath, sessionId),
      persistSession: (session) => this.persistSession(session),
      sessionRecordPath: (sessionId) => this.sessionPath(sessionId),
      loadMirroredMessages: (projectPath, sessionId) =>
        this.loadMirroredMessages(projectPath, sessionId),
      findLatestThreadSession: (projectPath, threadId) =>
        this.findLatestThreadSession(projectPath, threadId),
      markNativeSessionResumed: (sessionId) => this.rpcSessions.markNativeSessionResumed(sessionId),
      childSnapshot: (sessionId) => this.subagentStreams.snapshot(sessionId),
      watchChildSession: (sessionId) => this.subagentStreams.watchSubagentSession(sessionId)
    })
    this.cioFiles = new PiCioRuntimeFiles({
      storage,
      isTitleSession: (sessionId) => this.isTitleSession(sessionId),
      registerWatchPath: (sessionId, watchFlagPath) =>
        this.subagentStreams.registerSession(sessionId, watchFlagPath)
    })
  }

  /**
   * Publish the turn-scoped gateway endpoint for the app-owned utility gateway
   * extension. Pi sessions are persistent RPC processes whose extensions load
   * at spawn, so the per-turn URL+token reach the extension through a
   * session-keyed handoff file the driver rewrites per turn; clearing it on
   * turn end makes stale tokens unusable.
   */
  async publishUtilityGatewayEndpoint(
    _projectPath: string,
    sessionId: string,
    endpoint: UtilityGatewayEndpoint | null
  ): Promise<void> {
    void _projectPath
    return this.cioFiles.publishUtilityGatewayEndpoint(sessionId, endpoint)
  }

  /**
   * Publish the plan and progress the owning thread is executing, so the
   * compaction extension can rebuild a checkpoint from them when a transcript
   * cannot be summarized. Session-keyed and best-effort: a thread with no plan
   * (or a harness without rebuild support) simply publishes an empty snapshot.
   */
  async publishCompactionContext(
    _projectPath: string,
    sessionId: string,
    context: CompactionFallbackContext | null
  ): Promise<void> {
    void _projectPath
    return this.cioFiles.publishCompactionContext(sessionId, context)
  }

  /** The base driver's mirror read, before pi's native transcript is preferred. */
  private loadMirroredMessages(projectPath: string, sessionId: string): Promise<AgentMessage[]> {
    return super.loadMessages(projectPath, sessionId)
  }

  override async loadMessages(projectPath: string, sessionId: string): Promise<AgentMessage[]> {
    return this.nativeSessions.loadMessages(projectPath, sessionId)
  }

  /** Flush-aware transcript load for delegated child sessions. */
  loadSubagentMessages(
    projectPath: string,
    sessionId: string,
    options?: { waitForFlush?: boolean }
  ): Promise<AgentMessage[]> {
    return this.nativeSessions.loadSubagentMessages(projectPath, sessionId, options)
  }

  async holdsNativeHistory(projectPath: string, sessionId: string): Promise<boolean> {
    return this.nativeSessions.holdsNativeHistory(projectPath, sessionId)
  }

  /**
   * Restore this session's native pi transcript binding from the most recent
   * resumable session record for the thread.
   */
  async restoreNativeBinding(
    projectPath: string,
    sessionId: string,
    threadId: string
  ): Promise<boolean> {
    return this.nativeSessions.restoreNativeBinding(projectPath, sessionId, threadId)
  }

  /**
   * Seed a fresh session with the thread's edited history as a native pi
   * transcript.
   */
  async prefillNativeSession(
    projectPath: string,
    sessionId: string,
    messages: readonly AgentMessage[]
  ): Promise<boolean> {
    return this.nativeSessions.prefillNativeSession(projectPath, sessionId, messages)
  }

  /** Carry a replaced session's native pi transcript binding to its replacement. */
  async inheritNativeSession(
    projectPath: string,
    fromSessionId: string,
    toSessionId: string
  ): Promise<boolean> {
    return this.nativeSessions.inheritNativeSession(projectPath, fromSessionId, toSessionId)
  }

  /**
   * Quota telemetry for the battery popover: the latest provider rate-limit
   * windows (keyed by pi provider id, shared across projects) plus prepaid
   * credits for known gateways, and live context stats when a session for
   * the project is running.
   */
  async readAccountUsage(
    projectPath: string,
    providerId?: string
  ): Promise<{
    rateLimits: AgentRateLimitWindow[]
    credits?: AgentUsageCredits
    contextWindow?: number
    contextUsed?: number
  } | null> {
    return this.usage.readAccountUsage(projectPath, providerId)
  }

  /** Narrow host surface for the extracted units; every call stays typed. */
  emitEvent(event: AgentEvent): void {
    this.emit(event)
  }

  cachedSession(sessionId: string): PersistentCliSession | undefined {
    return this.sessionCache.get(sessionId)
  }

  applySessionEvent(session: PersistentCliSession, event: AgentEvent): void {
    this.applyEventToSession(session, event)
  }

  applyMessagesEvent(messages: AgentMessage[], event: AgentEvent): void {
    this.applyEventToMessages(messages, event)
  }

  /** Queue corrective feedback before resolving the blocked permission gate. */
  override async replyPermission(
    _projectPath: string,
    requestId: string,
    reply: PermissionReply,
    message?: string,
    sessionId?: string
  ): Promise<void> {
    void _projectPath
    return this.uiRequests.replyPermission(requestId, reply, message, sessionId)
  }

  override async replyToQuestion(
    _projectPath: string,
    sessionId: string,
    requestId: string,
    answers: string[][]
  ): Promise<void> {
    void _projectPath
    return this.uiRequests.replyToQuestion(sessionId, requestId, answers)
  }

  override async rejectQuestion(
    _projectPath: string,
    sessionId: string,
    requestId: string
  ): Promise<void> {
    void _projectPath
    return this.uiRequests.rejectQuestion(sessionId, requestId)
  }

  async generateTitle(projectPath: string, options: GenerateTitleOptions): Promise<string | null> {
    return this.generateTitleWithCandidates(
      projectPath,
      options,
      options.candidates ?? (await this.cheapCandidateModels(projectPath))
    )
  }

  async listProviders(projectPath: string): Promise<ProviderCatalog[]> {
    return this.modelCatalog.listProviders(projectPath)
  }

  /** Every connected Pi model whose display name or id identifies it as free. */
  protected override async cheapCandidateModels(
    projectPath: string
  ): Promise<TitleModelCandidate[]> {
    return this.modelCatalog.cheapCandidateModels(projectPath)
  }

  /** Cheap staleness signature of the connected-provider set; see the interface contract. */
  async providerCatalogFingerprint(): Promise<string | null> {
    return this.modelCatalog.providerCatalogFingerprint()
  }

  /**
   * Force Pi's own model catalog to re-fetch from upstream (`pi update
   * --models`) against THIS account's agent directory, so the discovery that
   * follows reads catalogs that are fresh at the source instead of the store
   * Pi already has.
   */
  async refreshModelCatalog(): Promise<void> {
    return this.modelCatalog.refreshModelCatalog()
  }

  override async listCommands(projectPath?: string): Promise<HarnessCommand[]> {
    return this.modelCatalog.listCommands(projectPath)
  }

  protected async ensureCliReady(projectPath: string): Promise<void> {
    try {
      await runHarnessCommand('pi', ['--version'], {
        cwd: projectPath,
        env: await buildProcessEnvironmentAsync({ ...process.env, ...this.accountEnvironment }),
        timeoutMs: 5_000
      })
    } catch {
      throw new Error(
        'Pi is not installed. Install the Pi CLI globally, then retry. (npm i -g @earendil-works/pi-coding-agent)'
      )
    }
  }

  override async runCommand(
    projectPath: string,
    sessionId: string,
    command: HarnessCommand,
    args: string,
    _settings: ThreadSettings
  ): Promise<void> {
    void _settings
    const session = await this.requireSession(projectPath, sessionId)
    if (this.turns.hasActiveTurn(session.id)) {
      throw new Error(`A turn is already active for session ${session.id}`)
    }
    const client = await this.rpcSessions.ensureClient(projectPath, session.id)
    const commandText = (args.trim() ? `${command.name} ${args}` : command.name).trim()
    this.turns.clearSilentContinue(session.id)
    this.turns.addActiveTurn(session.id)
    try {
      await this.promptIntoSession(client, projectPath, session.id, commandText, undefined)
    } catch (error) {
      this.turns.removeActiveTurn(session.id)
      const message = error instanceof Error ? error.message : 'Pi command failed to start'
      this.emit({ type: 'session.error', sessionId: session.id, error: message })
      throw error
    }
  }

  /**
   * Start this session's Pi process and RPC channel without sending a turn.
   *
   * `sendPrompt` already goes through `ensureRpcClient`, so this is the same
   * work pulled forward: the spawn, the extension materialization and the
   * session bootstrap that a first turn would otherwise pay for while the user
   * waits. Nothing about the turn changes, because the first prompt finds the
   * client already registered and skips straight to its own RPC calls.
   */
  async warmSession(projectPath: string, sessionId: string): Promise<void> {
    const session = await this.requireSession(projectPath, sessionId)
    await this.rpcSessions.ensureClient(projectPath, session.id)
  }

  /**
   * Compact the session's transcript on demand (`/compact`).
   *
   * An idle thread has no live RPC process (app restart, idle dispose, crash
   * cleanup all evict clients). Boot one on demand   ensureClient resumes
   * the persisted native transcript so compaction sees the full history.
   */
  async compactSession(
    projectPath: string,
    sessionId: string,
    _settings: ThreadSettings
  ): Promise<void> {
    void _settings
    const session = await this.requireSession(projectPath, sessionId)
    const client = await this.rpcSessions.ensureClient(projectPath, sessionId)
    return this.turns.compactSession(session, projectPath, client)
  }

  override async sendPrompt(projectPath: string, options: SendPromptOptions): Promise<void> {
    const session = await this.requireSession(projectPath, options.sessionId)
    // Dev-only phase clock for the harness half of the dispatch: the spawn (or
    // warm reuse) of the session process, the settings round-trips, and the
    // handoff files that have to be on disk before pi can run the prompt. This
    // separates "our process was cold" from "the provider is thinking" when a
    // follow-up turn feels slow (see `turn-dispatch-timer` on the engine side).
    const dispatchStartedAt = performance.now()
    // Step clock for the harness half: the spawn admission wait, the session
    // lookup, the extension rewrites and the bootstrap round-trips are all
    // inside the single `client` phase, which is 4-10 s on a project turn.
    const dispatchSteps = new DevStepClock(dispatchStartedAt)
    let dispatchPhaseAt = dispatchStartedAt
    const dispatchPhases: { phase: string; ms: number }[] = []
    const markDispatch = (phase: string): void => {
      const now = performance.now()
      dispatchPhases.push({ phase, ms: Math.round(now - dispatchPhaseAt) })
      dispatchPhaseAt = now
    }
    const client = await this.rpcSessions.ensureClient(projectPath, session.id, dispatchSteps) // A real user turn is not a continuation of a stop: clear the stop request
    markDispatch('client')
    // the extension applies to worker sessions, and re-arm pi's automatic retry
    // that the stop disarmed.
    await this.cioFiles.clearStopRequest(session.id)
    void client.setAutoRetry(true).catch((error: unknown) => {
      Logger.dev('Pi auto-retry re-arm failed:', error)
    })
    // A live turn owns this session (silent continue, auto-retry, an idle race
    // between the harness and the chat-engine status). Throwing here surfaced a
    // second user-facing error on top of a turn that is still producing output
    //   the user clicks retry and is told the session already has an active
    // turn. Instead, re-anchor provenance with the incoming settings and
    // deliver the prompt through pi's steer channel so the live working trace
    // simply continues.
    if (this.turns.hasActiveTurn(session.id)) {
      const activeModel = this.resolveModel(options.settings.providerId, options.settings.modelId)
      if (activeModel) {
        try {
          await this.applyPiSettingsIfChanged(
            session.id,
            client,
            activeModel,
            options.settings.thinkingLevel
          )
        } catch {
          // The active turn keeps its current model/thinking level; steering
          // must not fail just because a mid-turn model switch was rejected.
        }
      }
      this.setTurnProvenance(
        session.id,
        options.settings.providerId,
        options.settings.modelId,
        options.settings.thinkingLevel
      )
      this.appendUserMessage(session, options)
      this.turns.clearSilentContinue(session.id)
      await this.steerIntoActiveTurn(session.id, options.text, options.attachments)
      return
    }
    const model = this.resolveModel(options.settings.providerId, options.settings.modelId)
    if (!model) {
      throw new Error(
        `Pi model is unavailable: ${options.settings.providerId}/${options.settings.modelId}`
      )
    }
    let turnClient = client
    try {
      await this.applyPiSettingsIfChanged(
        session.id,
        turnClient,
        model,
        options.settings.thinkingLevel
      )
    } catch (error) {
      if (!isPiModelNotFoundError(error)) throw error
      // The running process predates a provider/model edit: regenerate the
      // custom-providers extension and retry once on a fresh process (which
      // reloads extensions at boot). Any second failure surfaces unchanged.
      this.rpcSessions.disposeClient(session.id)
      turnClient = await this.rpcSessions.ensureClient(projectPath, session.id)
      await this.applyPiSettingsIfChanged(
        session.id,
        turnClient,
        model,
        options.settings.thinkingLevel
      )
    }

    this.setTurnProvenance(
      session.id,
      options.settings.providerId,
      options.settings.modelId,
      options.settings.thinkingLevel
    )
    markDispatch('settings')
    this.appendUserMessage(session, options)
    this.turns.clearSilentContinue(session.id)
    this.turns.clearReconcileAnswer(session.id)
    this.turns.addActiveTurn(session.id)

    const { inlineSvg, images, references } = await composePiAttachments(options.attachments)
    markDispatch('attachments')
    if (options.systemPrompt) {
      await this.cioFiles.publishCioSystemPrompt(session.id, options.systemPrompt)
    }
    await this.cioFiles.publishCioHistoryRecap(session.id, options.historyRecap ?? '')
    // Publish every turn: an empty list clears a previous restriction, so a
    // mid-session File-System toggle takes effect without a session restart.
    await this.cioFiles.publishCioAllowedTools(session.id, options.allowedTools)
    markDispatch('handoffFiles')
    const prompt = [inlineSvg, ...references, options.text].filter(Boolean).join('\n\n')

    // The user's input is the thing that must survive: a session that turns out
    // to be mid-run takes the prompt into that run instead of refusing it.
    try {
      await this.promptIntoSession(turnClient, projectPath, session.id, prompt, images)
    } catch (error) {
      this.turns.removeActiveTurn(session.id)
      const message = error instanceof Error ? error.message : 'Pi turn failed to start'
      this.emit({ type: 'session.error', sessionId: session.id, error: message })
      await this.turns.finishTurn(session)
      throw error
    }
    markDispatch('promptAccepted')
    Logger.dev('Pi dispatch phases', {
      sessionId: session.id,
      totalMs: Math.round(performance.now() - dispatchStartedAt),
      phases: dispatchPhases,
      steps: dispatchSteps.records()
    })
  }

  private resolveModel(
    providerId: string,
    modelId: string
  ): { provider: string; modelId: string } | null {
    if (!providerId || !modelId) return null
    return { provider: providerId, modelId }
  }

  /**
   * Only send `set_model`/`set_thinking_level` when the session's live pi
   * process doesn't already have them applied. Each is a full RPC round-trip
   * with no progress event, so paying for both on every turn   as opposed to
   * only when the user actually changes a setting, which is what pi's own
   * interactive mode does   left follow-up turns stuck on a bare spinner for
   * however long those round-trips took.
   */
  private async applyPiSettingsIfChanged(
    sessionId: string,
    client: PiRpcClient,
    model: { provider: string; modelId: string },
    thinkingLevel: string
  ): Promise<void> {
    const level = piThinkingLevel(thinkingLevel)
    const applied = this.rpcSessions.appliedSettings(sessionId)
    if (
      applied &&
      applied.provider === model.provider &&
      applied.modelId === model.modelId &&
      applied.thinkingLevel === level
    ) {
      return
    }
    // Both settings are independent; on a fresh process neither is applied, so
    // issue them as concurrent RPC commands instead of two sequential blocking
    // round-trips on the prompt's critical path. The RPC client correlates
    // responses by id, so interleaved commands are safe.
    const wantsModel =
      !applied || applied.provider !== model.provider || applied.modelId !== model.modelId
    const wantsLevel = !applied || applied.thinkingLevel !== level
    if (wantsModel && wantsLevel) {
      await Promise.all([
        client.setModel(model.provider, model.modelId),
        client.setThinkingLevel(level)
      ])
    } else if (wantsModel) {
      await client.setModel(model.provider, model.modelId)
    } else if (wantsLevel) {
      await client.setThinkingLevel(level)
    }
    this.rpcSessions.setAppliedSettings(sessionId, {
      provider: model.provider,
      modelId: model.modelId,
      thinkingLevel: level
    })
  }

  async steerPrompt(projectPath: string, options: SteerPromptOptions): Promise<void> {
    const session = await this.requireSession(projectPath, options.sessionId)
    const client = await this.rpcSessions.settledClient(options.sessionId)
    // A registered live turn takes the steer channel. When it is not
    // registered, the session may still be busy inside pi's own lifecycle
    // (auto-compaction, retry windows) that CodeInOven reports as "working"
    //   pi's docs treat compaction/retry as part of the running trace, so
    // never reject user input there. `follow_up` is accepted in exactly those
    // states: pi queues it and runs it as the continuation of the same
    // session, whether the trace is compacting, retrying, or momentarily
    // between agent runs. Manual compaction drains the queue afterwards
    // (see `compactSession`).
    if (client && this.turns.hasActiveTurn(options.sessionId)) {
      await this.steerIntoActiveTurn(options.sessionId, options.text, options.attachments)
      return
    }
    if (client && (await this.isSessionBusy(projectPath, options.sessionId))) {
      const { inlineSvg, images, references } = await composePiAttachments(options.attachments)
      const message = [inlineSvg, ...references, options.text].filter(Boolean).join('\n\n')
      this.appendUserMessage(session, options)
      this.turns.clearSilentContinue(options.sessionId)
      // Delivering a real user message supersedes a stop the user requested
      // earlier: workers it spawns belong to this message, not to the stopped
      // turn.
      await this.cioFiles.clearStopRequest(options.sessionId)
      await client.followUp(message, images)
      return
    }
    // Neither a registered turn nor a busy pi lifecycle: the harness is idle
    // or its process was evicted mid-turn. A steered message must never be
    // rejected   resume the work by starting a fresh run with it. pi keeps
    // the session's model in its durable state, so no settings round-trip is
    // needed; the run's own `agent_settled` finalizes the turn normally.
    const activeClient =
      client ?? (await this.rpcSessions.ensureClient(projectPath, options.sessionId))
    this.appendUserMessage(session, options)
    this.turns.clearSilentContinue(options.sessionId)
    // A steered message that has to start its own run is a new turn, not a
    // continuation of a stop: clear the stop request and re-arm the automatic
    // retry the stop disarmed.
    await this.cioFiles.clearStopRequest(options.sessionId)
    void activeClient.setAutoRetry(true).catch((error: unknown) => {
      Logger.dev('Pi auto-retry re-arm failed:', error)
    })
    this.turns.addActiveTurn(options.sessionId)
    const { inlineSvg, images, references } = await composePiAttachments(options.attachments)
    const message = [inlineSvg, ...references, options.text].filter(Boolean).join('\n\n')
    try {
      await this.promptIntoSession(activeClient, projectPath, options.sessionId, message, images)
    } catch (error) {
      this.turns.removeActiveTurn(options.sessionId)
      const failure = error instanceof Error ? error.message : 'Pi turn failed to start'
      this.emit({ type: 'session.error', sessionId: options.sessionId, error: failure })
      await this.turns.finishTurn(session)
      throw error
    }
  }

  /** Compose attachments + text and deliver them into the session's live turn
   *  through pi's steer channel. The caller must have verified an active turn. */
  private async steerIntoActiveTurn(
    sessionId: string,
    text: string,
    attachments: SendPromptOptions['attachments']
  ): Promise<void> {
    this.turns.markSteerResume(sessionId)
    const client = await this.rpcSessions.settledClient(sessionId)
    if (!client) {
      throw new Error(`No active Pi turn is available to steer for session ${sessionId}`)
    }
    const { inlineSvg, images, references } = await composePiAttachments(attachments)
    const message = [inlineSvg, ...references, text].filter(Boolean).join('\n\n')
    await client.steer(message, images)
  }

  /**
   * Stop the session: end its run, stop every nested worker session, and leave
   * nothing behind that could resume the work the user just cancelled.
   *
   * A stop has four parts, because pi's own abort RPC only reaches the root run:
   *  1. drop an owed silent continue, which would otherwise re-prompt
   *     'Continue.' as soon as the aborted run settles;
   *  2. publish a stop request into the session's stop-flag file, which the
   *     app-owned core-tools extension applies to the worker sessions it owns
   *     and which disarms its own wake-up paths;
   *  3. disarm pi's automatic retry of the aborted run;
   *  4. after the graceful abort, verify the run actually ended (bounded) and
   *     kill the process if it did not.
   */
  override async abort(projectPath: string, sessionId: string): Promise<void> {
    // An owed silent continue belongs to the turn the user is stopping: pi
    // settles the aborted run with `agent_settled`, and the continuation would
    // then start a fresh run seconds after the stop.
    this.turns.resetForStop(sessionId)
    // A stop closes every card this session owns, so the dialog pi is parked on
    // has no one left to answer it. Pi cannot unwind the run it is blocked on
    // until that dialog is settled, so cancelling first is what lets the abort
    // land at all. Without it the abort waits for the RPC client's full request
    // timeout, leaving the thread reading as working for two minutes.
    this.uiRequests.cancelPendingDialogs(sessionId)
    // Published before the abort so the extension already sees it when the
    // run's own settle hook fires.
    await this.cioFiles.publishStopRequest(sessionId)
    const session = await this.requireSession(projectPath, sessionId).catch(() => null)
    const client = this.rpcSessions.client(sessionId)
    if (!session || !client) {
      // No live process to abort: nothing can still be running under it, so a
      // registration left behind is stale and must not keep the engine
      // ignoring this session's idles as if a turn were still live.
      this.turns.removeActiveTurn(sessionId)
      this.subagentStreams.settleChildStreams(sessionId, 'aborted')
      return
    }
    void client.setAutoRetry(false).catch((error: unknown) => {
      Logger.dev('Pi auto-retry disarm after stop failed:', error)
    })
    try {
      const answered = await withTimeout(
        client.abort().then(() => true),
        PI_ABORT_RPC_TIMEOUT_MS
      )
      if (answered === null) {
        // Pi never acknowledged the abort: it is wedged or parked on a run it
        // cannot unwind. Terminate the process (the exit event finalizes the
        // session state) instead of holding the caller for the RPC timeout.
        Logger.info('Pi did not answer the abort request; terminating the session process', {
          sessionId
        })
        client.dispose()
      }
    } catch {
      // The abort RPC failed   the pi process is wedged or already gone, so a
      // graceful abort can never land. Kill the process so the run actually
      // stops instead of silently continuing; the exit event finalizes the
      // session state and a fresh run spawns a new process on demand.
      client.dispose()
    } finally {
      this.turns.removeActiveTurn(sessionId)
    }
    // The workers report their own settle a poll window later at worst;
    // settling them here is what makes the cards and child statuses stop with
    // the stop instead of spinning until the last transcript lands.
    this.subagentStreams.settleChildStreams(sessionId, 'aborted')
    void this.enforceStoppedSession(projectPath, sessionId)
  }

  /**
   * Stop one nested worker session without touching the root run. Pi keeps its
   * sub-agent sessions inside its own process, so the child can never be
   * addressed by `abort`; the extension owns them and acts on this request.
   */
  async abortSubagent(
    projectPath: string,
    parentSessionId: string,
    childSessionId: string
  ): Promise<void> {
    // The request is keyed by the parent session, so a missing parent means
    // there is no live harness holding this worker at all.
    const parent = await this.requireSession(projectPath, parentSessionId).catch(() => null)
    if (!parent) return
    await this.cioFiles.publishStopRequest(parentSessionId, [childSessionId])
    this.subagentStreams.settleChildStreams(parentSessionId, 'aborted', childSessionId)
  }

  /**
   * Bounded backstop for a user stop. The graceful abort plus the extension's
   * stop sweep end the run and its workers in the normal case; when pi still
   * reports a live run after the grace window it ignored the abort, so the
   * process is terminated   which takes every nested worker session with it.
   */
  private async enforceStoppedSession(projectPath: string, sessionId: string): Promise<void> {
    const deadline = Date.now() + PI_ABORT_ENFORCE_MS
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, PI_ABORT_ENFORCE_INTERVAL_MS))
      const client = this.rpcSessions.client(sessionId)
      if (!client || this.rpcSessions.projectOf(sessionId) !== projectPath) return
      let state: Record<string, unknown> | null
      try {
        state = record(await withTimeout(client.getState(), PI_ABORT_PROBE_TIMEOUT_MS))
      } catch {
        // A session that cannot answer a state probe after its own abort is
        // wedged: a graceful stop can never land on it.
        this.killStoppedSession(sessionId)
        return
      }
      // A probe that timed out (null) cannot confirm the run ended, so it keeps
      // waiting and terminates at the end of the grace window instead.
      if (state && state['isStreaming'] !== true && state['isCompacting'] !== true) return
    }
    this.killStoppedSession(sessionId)
  }

  /** Terminate a stopped session's pi process. The exit event finalizes the
   *  turn and the next run resumes the persisted native transcript. */
  private killStoppedSession(sessionId: string): void {
    if (!this.rpcSessions.hasClient(sessionId)) return
    Logger.info('Pi ignored the abort request   terminating the session process', { sessionId })
    this.subagentStreams.settleChildStreams(sessionId, 'aborted')
    this.rpcSessions.disposeClient(sessionId)
  }

  override async deleteSession(projectPath: string, sessionId: string): Promise<void> {
    this.rpcSessions.disposeClient(sessionId)
    this.turns.deleteSessionState(sessionId)
    await this.cioFiles.removeGatewayHandoff(sessionId)
    await super.deleteSession(projectPath, sessionId)
  }

  /** Pi keeps its own session transcript on disk, so discarding a session has
   *  to discard that file too: a leftover transcript is what lets removed
   *  turns be re-read into the thread after an edit or delete. */
  protected override async deleteNativeTranscript(
    projectPath: string,
    session: PersistentCliSession
  ): Promise<void> {
    await this.nativeSessions.deleteNativeTranscript(projectPath, session.nativeSessionId)
  }

  /**
   * Park this session instead of releasing it: the record and its native
   * transcript stay on disk so a switch back to pi resumes them, but the live
   * RPC process, the gateway handoff and the turn bookkeeping are dropped now,
   * because a parked session must not keep a background pi runtime alive.
   */
  override async parkThreadSession(
    projectPath: string,
    threadId: string,
    sessionId: string
  ): Promise<void> {
    this.rpcSessions.disposeClient(sessionId)
    this.turns.deleteSessionState(sessionId)
    await this.cioFiles.removeGatewayHandoff(sessionId)
    await super.parkThreadSession(projectPath, threadId, sessionId)
  }

  override releaseProjectResources(projectPath: string): void {
    this.rpcSessions.releaseProject(projectPath)
    super.releaseProjectResources(projectPath)
  }

  /**
   * Restart every session's RPC process so the next turn spawns the Pi runtime
   * currently on disk. A session's client is long-lived (`pi --mode rpc` keeps
   * the resumed native transcript in memory), so without this an updated Pi
   * binary only reaches the app at the next launch.
   */
  override restartRuntime(): void {
    this.rpcSessions.restartAll()
    super.restartRuntime()
  }

  protected async buildTurnCommand(): Promise<CliTurnCommand> {
    throw new Error('PiDriver drives pi over RPC; buildTurnCommand is not used')
  }

  protected parseJsonLine(value: unknown, context: CliLineParseContext): CliLineParseResult | null {
    return this.turns.parseJsonLine(value, context)
  }

  taskReconcileAnswerId(sessionId: string): string | undefined {
    return this.turns.taskReconcileAnswerId(sessionId)
  }

  /**
   * Driver contract hook (`reconcileSession`): recover compaction reporting
   * from pi's durable session transcript when a session settled without
   * driver finalization, so the engine's finalization and the next turn's
   * history replay see the recovered boundary.
   */
  async reconcileSession(projectPath: string, sessionId: string): Promise<void> {
    return this.turns.reconcileSession(projectPath, sessionId)
  }

  dispose(): void {
    this.rpcSessions.clear()
    this.turns.clearAll()
    this.subagentStreams.clear()
    this.uiRequests.clear()
    this.cioFiles.clear()
    super.dispose()
  }

  /**
   * Live probe of the pi session's streaming state (`get_state` →
   * `isStreaming`), used by restart recovery to avoid resuming a turn the
   * surviving pi process is still executing   the same role OpenCode's
   * session-status probe plays for its shared server.
   */
  /** Whether the driver still tracks a live turn for this session. The engine's
   *  watchdog uses this to detect a turn the session settled without the
   *  driver noticing (pi's auto-compaction / retry gap). */
  hasActiveTurn(sessionId: string): boolean {
    return this.turns.hasActiveTurn(sessionId)
  }

  /**
   * The run this pi session has in flight right now, read from pi's own state
   * (`get_state` → `isStreaming` / `isCompacting`) plus the one gap pi does not
   * report there: its own provider retry.
   *
   * Pi keeps running across the windows where the app's view of the turn has
   * already settled   an auto-compaction, a provider retry, a run adopted after
   * a restart   so this is the only authority on whether the session will accept
   * a bare `prompt`. `null` means no live run is visible: the session is idle,
   * or its process is gone, and each caller decides what that means.
   *
   * Pi's own provider retry is a gap in the stream, not in the turn: the run is
   * alive and resumes when the retry lands, so the session is busy. A retry gap
   * reported as idle let the engine take one failed request for the turn's
   * outcome   it finalized the live turn and cleared the utility gateway
   * handoff the resumed run was still calling `cio_util_*` through, which is how
   * a design turn lost its gateway mid-flight. The retry flag is only read off a
   * state probe that answered, so a dead or wedged process still reports idle
   * instead of busy forever.
   */
  private async readLiveRun(
    projectPath: string,
    sessionId: string
  ): Promise<'streaming' | 'compacting' | 'retrying' | null> {
    const client = this.rpcSessions.client(sessionId)
    if (!client || this.rpcSessions.projectOf(sessionId) !== projectPath) return null
    try {
      const state = record(await client.getState())
      if (state === null) return null
      if (state['isStreaming'] === true) return 'streaming'
      if (state['isCompacting'] === true) return 'compacting'
    } catch (error) {
      Logger.dev('Pi live-run probe failed:', error)
      return null
    }
    return this.turns.isProviderRetryPending(sessionId) ? 'retrying' : null
  }

  async isSessionBusy(projectPath: string, sessionId: string): Promise<boolean> {
    return (await this.readLiveRun(projectPath, sessionId)) !== null
  }

  /**
   * Deliver a composed prompt to the session, continuing into the run that is
   * already in flight when the app's snapshot of the turn went stale.
   *
   * Pi refuses a bare `prompt` while the agent streams ("Agent is already
   * processing. Specify streamingBehavior ('steer' or 'followUp') to queue the
   * message."). Taking that refusal for the turn's outcome ended a run that was
   * still producing output and put pi's protocol prose in front of the user in
   * place of their message, so the prompt asks pi to steer when a run is live
   * (`streamingBehavior`, decided on pi's own state) and, if it is still refused
   *   an older pi that does not know the field, or a manual compaction, the one
   * state pi does not arbitrate   a re-probe picks the channel that run accepts:
   * a steer while it streams, a follow-up while it compacts or retries.
   *
   * A refusal with no live run behind it stays the caller's error to report.
   */
  private async promptIntoSession(
    client: PiRpcClient,
    projectPath: string,
    sessionId: string,
    prompt: string,
    images: PiRpcImage[] | undefined
  ): Promise<void> {
    try {
      await client.prompt(prompt, images, 'steer')
    } catch (error) {
      if (!isPiInputRefusal(error)) throw error
      const liveRun = await this.readLiveRun(projectPath, sessionId)
      if (!liveRun) throw error
      if (liveRun === 'streaming') {
        await client.steer(prompt, images)
      } else {
        await client.followUp(prompt, images)
      }
      Logger.dev('Pi prompt joined the run already in flight:', { sessionId, liveRun })
    }
  }

  /** Node uses TEMP/TMP on Windows and TMPDIR on Unix. The runtime boundary
   * translates TMPDIR for WSL and forwards it into the Linux process. Keep
   * output files available across turns under the scope's working directory.
   */
  private async workspaceTemporaryEnvironment(
    projectPath: string
  ): Promise<{ TMPDIR: string; TEMP: string; TMP: string }> {
    return this.modelCatalog.workspaceTemporaryEnvironment(projectPath)
  }

  private async materializeCioProvidersExtension(sessionId: string): Promise<string | null> {
    return this.modelCatalog.materializeProvidersExtension(sessionId)
  }
}
