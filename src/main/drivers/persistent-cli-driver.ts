import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { generateId } from '../../lib/utils'
import { APP_NAME } from '../../lib/brand'
import { classifyProviderIssue } from '../../lib/provider-issue'
import type {
  AgentEvent,
  AgentMessage,
  AgentQuestionRequest,
  HarnessCommand,
  PermissionReply,
  ProviderCatalog,
  SessionAgentEvent,
  ThreadSettings,
  ThinkingLevel
} from '../../lib/types'
import { Logger } from '../system/logger'
import type { StorageEngine } from '../storage/storage-engine'
import { buildProcessEnvironment, OWNED_SESSION_MARKER } from './cli-environment'
import { describeHarnessExit, prepareHarnessInvocation } from './harness-runtime'
import { spawnInUtilityHost } from './harness-utility-host'
import type {
  AgentEventCallback,
  AgentProcessObserver,
  AuxiliaryModelCandidate,
  CheapModelRequest,
  CheapModelResult,
  GenerateTitleOptions,
  GradeTurnOptions,
  HarnessCapabilities,
  HarnessDriver,
  PreparedUtilityRuntime,
  SendHeartbeatPingOptions,
  SendPromptOptions,
  SteerPromptOptions
} from './driver.interface'
import {
  buildTitlePrompt,
  HEARTBEAT_PROMPT,
  sanitizeGeneratedTitle,
  sanitizeHeartbeatReply
} from '../chat/title-generator'
import { buildRankingGradePrompt } from '../chat/turn-grader-prompt'
import type {
  CliLineParseContext,
  CliLineParseResult,
  CliTurnCommand,
  OneShotOutcome,
  PersistentCliSession,
  TitleAttemptAccounting,
  TitleModelCandidate
} from './persistent-cli/persistent-cli-types'
import {
  cliProjectPathHash,
  cliSessionPath,
  findLatestThreadCliSession,
  persistCliSession,
  requireCliSession
} from './persistent-cli/persistent-cli-session'
import {
  estimateMissingCost as estimateMessageCost,
  foldEventIntoMessages,
  mergeSessionMessages,
  normalizeCliInteractionEvents
} from './persistent-cli/persistent-cli-transcript'
import { PersistentCliLineReader } from './persistent-cli/persistent-cli-stream'
import {
  parseRankingGradeForAttempt,
  sanitizeAuxiliaryText,
  TITLE_GENERATION_TIMEOUT_MS,
  TitleTurnRegistry
} from './persistent-cli/persistent-cli-title'
import {
  auxiliaryBlockUntil,
  runOneShotWithCandidates,
  type AuxiliaryQuotaBlock
} from './persistent-cli/persistent-cli-one-shot'
import { hasProcessExited, waitForProcessExit } from './persistent-cli/persistent-cli-process'
import { buildUserMessage } from './persistent-cli/persistent-cli-user-message'

export type {
  CliLineParseContext,
  CliLineParseResult,
  CliTurnCommand,
  OneShotOutcome,
  PersistentCliSession,
  TitleAttemptAccounting,
  TitleAttemptUsage,
  TitleModelCandidate
} from './persistent-cli/persistent-cli-types'

const ABORT_TERM_GRACE_MS = 1_500
const ABORT_KILL_GRACE_MS = 1_500
/**
 * How long a resolved auxiliary route stays usable as a closed-route verdict.
 * A provider catalog can gain a free candidate while a route is held back, and
 * a stale list would postpone rows that can already be judged, so the route is
 * re-resolved by the next run rather than trusted indefinitely.
 */
export const AUXILIARY_ROUTE_TTL_MS = 10 * 60 * 1000

/**
 * Base class for headless, one-process-per-turn harness CLIs.
 *
 * The persistent ID returned to ChatEngine is CodeInOven-owned. Provider-native
 * session IDs are learned after a first turn and kept private in the driver
 * record, allowing safe rehydration after application restart.
 */
export abstract class PersistentCliDriver implements HarnessDriver {
  abstract readonly id: string
  abstract readonly name: string
  abstract readonly capabilities: HarnessCapabilities

  private eventCallback: AgentEventCallback | null = null
  private activeProcesses = new Map<string, ChildProcess>()
  /** Full turn context retained so process-per-turn CLIs can emulate steering by resuming. */
  private activeTurnOptions = new Map<string, SendPromptOptions>()
  /** Resolves after the stopped process has flushed output and persisted its native session. */
  private activeProcessSettlements = new Map<string, Promise<void>>()
  private activeProcessSettlementResolvers = new Map<string, () => void>()
  /** Prevent an intermediate idle event while an emulated steer replaces the active process. */
  private steeringSessions = new Set<string>()
  /** Public user payload retained when a stateless steer needs richer transport context. */
  private outboundMessageOverrides = new Map<
    string,
    Pick<SendPromptOptions, 'text' | 'attachments'>
  >()
  private utilityRuntimes = new Map<string, PreparedUtilityRuntime>()
  protected sessionCache = new Map<string, PersistentCliSession>()
  private deletedSessions = new Set<string>()
  /** Sessions whose provider stream already supplied a structured terminal issue. */
  private structuredProcessIssues = new Set<string>()
  /** Model/provider/thinking level of the running turn   CLIs do not echo them back per message. */
  private turnProvenance = new Map<
    string,
    { providerId?: string; modelId?: string; thinkingLevel?: ThinkingLevel }
  >()
  private readonly titleTurns = new TitleTurnRegistry()
  /**
   * Provider-reported usage reset per auxiliary candidate (`providerId/modelId`),
   * so an exhausted account is probed once per window instead of once per
   * queued background job. In-process state by design: an app restart forgets
   * it and probes afresh, so a stale block can never outlive the session.
   */
  private readonly auxiliaryQuotaBlocks = new Map<string, AuxiliaryQuotaBlock>()
  /**
   * The candidate list this driver's own auxiliary runs resolved last, kept so
   * the ranking drain can tell whether a harness's whole route is inside a
   * provider window without paying for discovery again. Null until a run
   * resolves one, and read as unknown once it is stale.
   */
  private auxiliaryRoute: { at: number; candidates: TitleModelCandidate[] } | null = null
  /** Outcomes of the most recent title-candidate run, for ledger integration. */
  private lastTitleAttempts: TitleAttemptAccounting[] = []
  private lastGradeTurnAttempts: TitleAttemptAccounting[] = []
  private processObserver: AgentProcessObserver | null = null
  /** Provider-neutral interaction cards already surfaced for this driver instance. */
  private interactionRequests = new Set<string>()

  /**
   * JSONL reader for provider stdout and stderr. Built lazily so it observes
   * the concrete driver's `id`, which is not initialized while base fields run.
   */
  private lineReaderInstance: PersistentCliLineReader | null = null
  private get lineReader(): PersistentCliLineReader {
    return (this.lineReaderInstance ??= new PersistentCliLineReader(
      this.id,
      (value, context) => this.parseJsonLine(value, context),
      (result, session) => this.applyParseResult(result, session, { trackProcessIssues: true })
    ))
  }

  constructor(protected readonly storage: StorageEngine) {}

  setProcessObserver(observer: AgentProcessObserver): void {
    this.processObserver = observer
  }

  async ensureReady(projectPath: string): Promise<void> {
    await this.ensureCliReady(projectPath)
  }

  async applyPreparedUtilityRuntime(
    _projectPath: string,
    runtime: PreparedUtilityRuntime | null,
    sessionId: string
  ): Promise<void> {
    void _projectPath
    const previous = this.utilityRuntimes.get(sessionId)
    if ((previous?.id ?? null) === runtime?.id) return
    if (runtime) this.utilityRuntimes.set(sessionId, runtime)
    else this.utilityRuntimes.delete(sessionId)
    if (previous) await previous.cleanup()
  }

  async createSession(projectPath: string, title: string): Promise<string> {
    const id = generateId()
    const now = Date.now()
    const session: PersistentCliSession = {
      id,
      title,
      projectPathHash: cliProjectPathHash(projectPath),
      messages: [],
      createdAt: now,
      updatedAt: now
    }
    await this.persistSession(session)
    this.deletedSessions.delete(id)
    this.sessionCache.set(id, session)
    return id
  }

  async deleteSession(projectPath: string, sessionId: string): Promise<void> {
    const session = await this.requireSession(projectPath, sessionId)
    this.deletedSessions.add(session.id)
    const active = this.activeProcesses.get(session.id)
    if (active) {
      active.kill()
      this.activeProcesses.delete(session.id)
    }
    this.sessionCache.delete(session.id)
    await this.storage.remove(this.sessionPath(session.id))
  }

  /** Run one auxiliary one-shot completion per disposable session, cheapest candidate first. */
  protected async oneShotWithCandidates(
    projectPath: string,
    options: GenerateTitleOptions,
    candidates: TitleModelCandidate[],
    promptText: string,
    validate: (raw: string) => string | null,
    timeoutMs: number = TITLE_GENERATION_TIMEOUT_MS
  ): Promise<OneShotOutcome> {
    return runOneShotWithCandidates(
      {
        driverName: this.name,
        titleTurns: this.titleTurns,
        quotaBlocks: this.auxiliaryQuotaBlocks,
        createSession: (path, title) => this.createSession(path, title),
        sendPrompt: (path, promptOptions) => this.sendPrompt(path, promptOptions),
        requireSession: (path, id) => this.requireSession(path, id),
        abort: (path, id) => this.abort(path, id),
        deleteSession: (path, id) => this.deleteSession(path, id)
      },
      projectPath,
      options,
      candidates,
      promptText,
      validate,
      timeoutMs
    )
  }

  /** Run title attempts in disposable sessions, cheapest candidate first. */
  protected async generateTitleWithCandidates(
    projectPath: string,
    options: GenerateTitleOptions,
    candidates: TitleModelCandidate[]
  ): Promise<string | null> {
    if (!options.candidates?.length) this.recordAuxiliaryRoute(candidates)
    const outcome = await this.oneShotWithCandidates(
      projectPath,
      options,
      candidates,
      buildTitlePrompt(options.message.slice(0, 2_000)),
      sanitizeGeneratedTitle
    )
    this.lastTitleAttempts = outcome.attempts
    return outcome.value
  }

  /** Grade a completed turn with disposable sessions, cheapest candidate first. */
  protected async gradeTurnWithCandidates(
    projectPath: string,
    options: GradeTurnOptions,
    candidates: TitleModelCandidate[]
  ): Promise<number | null> {
    if (!options.candidates?.length) this.recordAuxiliaryRoute(candidates)
    const outcome = await this.oneShotWithCandidates(
      projectPath,
      {
        settings: options.settings,
        message: '',
        ...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {})
      },
      candidates,
      buildRankingGradePrompt({
        userMessage: options.userMessage,
        assistantOutput: options.assistantOutput,
        followUp: options.followUp ?? null
      }),
      parseRankingGradeForAttempt
    )
    this.lastGradeTurnAttempts = outcome.attempts
    return outcome.value === null ? null : Number.parseInt(outcome.value, 10)
  }

  /**
   * One self-contained cheap-model completion, cheapest candidate first.
   * Subclasses expose their cheapest models through `cheapCandidateModels`;
   * without any, the active thread model is used as the sole candidate.
   * Every cheap-model scenario (title, grading, lessons, proposals) routes
   * through this single entry point.
   */
  async provideCheapModel(
    projectPath: string,
    request: CheapModelRequest
  ): Promise<CheapModelResult> {
    const candidates = request.candidates ?? (await this.cheapCandidateModels(projectPath))
    if (!request.candidates?.length) this.recordAuxiliaryRoute(candidates)
    const outcome = await this.oneShotWithCandidates(
      projectPath,
      {
        settings: request.settings,
        message: '',
        ...(request.parentSessionId ? { parentSessionId: request.parentSessionId } : {})
      },
      candidates,
      request.prompt,
      sanitizeAuxiliaryText,
      request.timeoutMs ?? TITLE_GENERATION_TIMEOUT_MS
    )
    return {
      text: outcome.value,
      attempts: outcome.attempts.map((attempt) => ({
        providerId: attempt.providerId,
        modelId: attempt.modelId,
        ok: attempt.success,
        failure: attempt.fallbackReason
      }))
    }
  }

  /**
   * Until when every candidate of the given auxiliary route is inside a
   * provider usage window, or null while one of them is free. See the
   * `HarnessDriver` contract: the caller names the complete route, because a
   * candidate left out would flip the verdict.
   */
  auxiliaryWindowUntil(candidates: readonly AuxiliaryModelCandidate[]): number | null {
    return auxiliaryBlockUntil(candidates, this.auxiliaryQuotaBlocks, Date.now())
  }

  /** The route this driver's own auxiliary runs resolved, or null when unknown. */
  auxiliaryRouteCandidates(): readonly AuxiliaryModelCandidate[] | null {
    const route = this.auxiliaryRoute
    if (!route) return null
    if (Date.now() - route.at > AUXILIARY_ROUTE_TTL_MS) return null
    return route.candidates
  }

  /**
   * Remember the candidates an unpinned auxiliary run resolved, for
   * `auxiliaryRouteCandidates`. An empty resolution forgets the route instead
   * of keeping the previous list, because a harness whose cheap models just
   * failed to resolve has an unknown route, not a closed one.
   */
  private recordAuxiliaryRoute(candidates: readonly TitleModelCandidate[]): void {
    this.auxiliaryRoute =
      candidates.length > 0 ? { at: Date.now(), candidates: [...candidates] } : null
  }

  /** Cheapest auxiliary candidates for this harness; subclasses override. */
  protected async cheapCandidateModels(_projectPath: string): Promise<TitleModelCandidate[]> {
    return []
  }

  async generateTitle(projectPath: string, options: GenerateTitleOptions): Promise<string | null> {
    return this.generateTitleWithCandidates(
      projectPath,
      options,
      options.candidates ?? (await this.cheapCandidateModels(projectPath))
    )
  }

  /** Ping the exact configured model   no cheap-candidate substitution. */
  async sendHeartbeatPing(
    projectPath: string,
    options: SendHeartbeatPingOptions
  ): Promise<boolean> {
    const outcome = await this.oneShotWithCandidates(
      projectPath,
      { settings: options.settings, message: '' },
      [],
      HEARTBEAT_PROMPT,
      sanitizeHeartbeatReply
    )
    return outcome.value !== null
  }

  async gradeTurn(projectPath: string, options: GradeTurnOptions): Promise<number | null> {
    return this.gradeTurnWithCandidates(
      projectPath,
      options,
      options.candidates ?? (await this.cheapCandidateModels(projectPath))
    )
  }

  /**
   * Outcomes of the most recent title-candidate run. Each entry exposes the
   * candidate identity, whether it produced a usable title, why it fell back,
   * and the provider-reported usage when available. Intended for the event-level
   * usage ledger to record one attempt per candidate.
   */
  getTitleAttempts(): readonly TitleAttemptAccounting[] {
    return this.lastTitleAttempts
  }

  /**
   * Outcomes of the most recent turn-grading run, mirroring getTitleAttempts.
   */
  getGradeTurnAttempts(): readonly TitleAttemptAccounting[] {
    return this.lastGradeTurnAttempts
  }

  /**
   * Drop in-memory transcripts for a project's sessions so an idle project's
   * memory is released. Sessions stay on disk and reload on next use. Active
   * turns are never evicted.
   */
  releaseProjectResources(projectPath: string): void {
    const projectPathHash = cliProjectPathHash(projectPath)
    for (const [sessionId, session] of this.sessionCache) {
      if (session.projectPathHash !== projectPathHash) continue
      if (this.activeProcesses.has(sessionId)) continue
      this.sessionCache.delete(sessionId)
      this.turnProvenance.delete(sessionId)
    }
  }

  /**
   * Stop every in-flight turn process so the next turn spawns the harness
   * binary currently on disk.
   *
   * These harnesses run one process per turn, so between turns nothing holds
   * the old install and the next turn already picks up a new one; the running
   * turn is the only thing left to restart. The durable session record stays,
   * so the conversation resumes exactly as it was   only the turn in flight is
   * interrupted, which is what the caller's confirmation warned about.
   */
  restartRuntime(): void {
    for (const [sessionId, child] of [...this.activeProcesses]) {
      if (child.killed) continue
      Logger.info(`${this.name} turn process stopped for a harness restart`, { sessionId })
      child.kill()
    }
  }

  async sendPrompt(projectPath: string, opts: SendPromptOptions): Promise<void> {
    const session = await this.requireSession(projectPath, opts.sessionId)
    // A previous turn can leave a lingering process behind (e.g. a CLI hung on
    // a dead socket after a network failure) while the chat engine already
    // considers the session idle and dispatches a retry here. Replace the
    // orphaned turn   stop its process and drain its settlement   instead of
    // rejecting the retry with "A turn is already active".
    const orphan = this.activeProcesses.get(session.id)
    if (orphan) {
      this.steeringSessions.add(session.id)
      try {
        if (orphan.exitCode === null && orphan.signalCode === null && !orphan.killed) {
          orphan.kill()
        }
        const settlement = this.activeProcessSettlements.get(session.id)
        if (settlement) await settlement
      } finally {
        this.steeringSessions.delete(session.id)
      }
    }

    const invocation = await this.buildTurnCommand(projectPath, session, opts)
    const runtime = this.utilityRuntime(session.id)
    const invocationArgs = runtime
      ? [
          ...runtime.args.map((arg) => this.resolveRuntimePlaceholders(arg, runtime)),
          ...invocation.args.map((arg) => this.resolveRuntimePlaceholders(arg, runtime))
        ]
      : invocation.args
    const runtimeEnv = runtime
      ? Object.fromEntries(
          Object.entries(runtime.env).map(([key, value]) => [
            key,
            this.resolveRuntimePlaceholders(value, runtime)
          ])
        )
      : {}
    const invocationEnv = {
      ...(runtime
        ? {
            ...(invocation.env ?? buildProcessEnvironment()),
            ...runtimeEnv
          }
        : (invocation.env ?? buildProcessEnvironment())),
      // Session-scoped ownership marker so any daemon this harness spawns that
      // re-parents away from the process tree (e.g. the adb server) can still
      // be attributed back to this session by the agent process service.
      [OWNED_SESSION_MARKER]: session.id
    }
    this.setTurnProvenance(
      session.id,
      opts.settings.providerId,
      invocation.provenanceModelId ?? opts.settings.modelId,
      opts.settings.thinkingLevel
    )
    this.appendUserMessage(session, opts)
    let child: ChildProcess
    try {
      const prepared = await prepareHarnessInvocation(invocation.command, invocationArgs, {
        cwd: projectPath,
        env: invocationEnv
      })
      // Bundled harnesses (electron run-as-node) run in-process inside Electron's
      // utilityProcess helper so macOS never shows a bouncing Dock app per session.
      child =
        prepared.runtime?.target?.kind === 'bundled'
          ? spawnInUtilityHost(prepared)
          : spawn(prepared.command, prepared.args, {
              ...(prepared.cwd ? { cwd: prepared.cwd } : {}),
              env: prepared.env,
              shell: prepared.shell,
              stdio: ['pipe', 'pipe', 'pipe']
            })
    } catch (error) {
      invocation.onProcessExit?.()
      throw error
    }
    this.observeHarnessProcess(session.id, child, invocation.command, projectPath)
    this.structuredProcessIssues.delete(session.id)
    this.activeProcesses.set(session.id, child)
    this.activeTurnOptions.set(session.id, {
      ...opts,
      settings: { ...opts.settings },
      attachments: [...opts.attachments]
    })
    let resolveProcessSettlement: (() => void) | undefined
    const processSettlement = new Promise<void>((resolve) => {
      resolveProcessSettlement = resolve
    })
    this.activeProcessSettlements.set(session.id, processSettlement)
    this.activeProcessSettlementResolvers.set(session.id, () => resolveProcessSettlement?.())

    let stdoutBuffer = ''
    let stderrBuffer = ''
    /**
     * Whether the process said anything at all before it ended.
     *
     * A byte on either stream is proof the executable ran, which is what
     * separates a harness the system refused to start from one that crashed
     * partway through its work.
     */
    let producedOutput = false
    let completed = false
    const finish = async (error?: string, detail?: string): Promise<void> => {
      if (completed) return
      completed = true
      try {
        invocation.onProcessExit?.()
        this.activeProcesses.delete(session.id)
        if (invocation.loadTrailingRecords && !this.deletedSessions.has(session.id)) {
          try {
            const records = await invocation.loadTrailingRecords()
            for (const record of records) {
              this.lineReader.consumeValue(record, session, projectPath)
            }
          } catch (trailingError) {
            Logger.dev(`${this.name} trailing interaction records were unavailable:`, trailingError)
          }
        }
        if (!this.deletedSessions.has(session.id)) {
          try {
            await this.persistSession(session)
          } catch (persistError) {
            Logger.error('CLI session persistence failed:', persistError)
            error ??= 'Harness session could not be persisted'
          }
        }
        if (error && !this.structuredProcessIssues.has(session.id)) {
          // The stderr tail (typically the harness's stack trace) must never
          // appear in the beautified card body. Classify on the combined text
          // so embedded signals (auth, quota, billing) still match, but keep
          // `message` short and carry the trace only in `rawError`.
          const classificationSource = detail ? `${error}: ${detail}` : error
          const kind = classifyProviderIssue(classificationSource)
          const rawError = detail ? `${error}\n\n${detail}` : error
          this.emit({
            type: 'session.error',
            sessionId: session.id,
            error,
            rawError,
            ...(kind === 'unknown'
              ? {}
              : {
                  issue: {
                    kind,
                    message:
                      kind === 'authentication'
                        ? `${this.name} sign-in expired. Sign in again, then retry this message.`
                        : error,
                    rawError,
                    harnessId: this.id,
                    retryable: kind !== 'billing'
                  }
                })
          })
        }
        this.structuredProcessIssues.delete(session.id)
        if (!invocation.suppressIdle?.() && !this.steeringSessions.has(session.id)) {
          this.emit({ type: 'session.idle', sessionId: session.id })
        }
      } finally {
        this.activeProcessSettlements.delete(session.id)
        this.activeProcessSettlementResolvers.get(session.id)?.()
        this.activeProcessSettlementResolvers.delete(session.id)
      }
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      producedOutput = true
      stdoutBuffer += chunk.toString()
      stdoutBuffer = this.lineReader.consumeLines(stdoutBuffer, session, projectPath, invocation)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      producedOutput = true
      stderrBuffer = `${stderrBuffer}${chunk.toString()}`.slice(-4_000)
    })
    child.on('error', (error) => void finish(error.message))
    child.on('exit', (code, signal) => {
      if (stdoutBuffer.trim())
        this.lineReader.consumeLine(stdoutBuffer.trim(), session, projectPath, invocation)
      if (invocation.parseStderrJson) {
        for (const line of stderrBuffer.split(/\r?\n/u)) {
          this.lineReader.consumeLineIfPresent(line, session, projectPath, invocation)
        }
      }
      const exitedCleanly =
        code === 0 || signal === 'SIGTERM' || invocation.isExpectedExit?.(code, signal)
      const failure = exitedCleanly
        ? undefined
        : this.describeTurnExit(code, signal, producedOutput, child.killed)
      const failureDetail = exitedCleanly || !stderrBuffer.trim() ? undefined : stderrBuffer.trim()
      void finish(failure, failureDetail)
    })

    if (invocation.input) child.stdin?.write(invocation.input)
    if (!invocation.keepInputOpen) child.stdin?.end()
  }

  /**
   * The failure message for a turn process that did not exit cleanly.
   *
   * A signal death is where this app held evidence and threw it away. An
   * executable the operating system will not run reaches the exit handler with
   * no exit code and not one byte of output, because macOS kills an arm64
   * binary whose code signature no longer matches its contents during exec,
   * before the program starts. Reporting that as "exited with code unknown"
   * left a broken harness install looking like an anonymous crash, so a signal
   * death that produced nothing says what it is. A stop this app asked for
   * (abort, steer, dispose) is never that, and `requestedStop` is what
   * separates the two.
   */
  private describeTurnExit(
    code: number | null,
    signal: NodeJS.Signals | null,
    producedOutput: boolean,
    requestedStop: boolean
  ): string {
    const reason = describeHarnessExit('Harness process', code, signal)
    if (!signal || producedOutput || requestedStop) return reason
    return `${reason} before it produced any output, so ${this.name} could not start on this machine. Its install is the likeliest cause: uninstall it under Settings, Harnesses, then install it again   or pick a different harness and retry.`
  }

  /**
   * Deterministic steering fallback for one-process-per-turn CLIs.
   *
   * These transports cannot inject input into a running process. Stop at the
   * current output boundary, wait for the provider-native session to persist,
   * then resume that same session with the steering message and unchanged turn
   * settings. The chat engine therefore exposes one steering contract across
   * native-streaming and process-per-turn harnesses.
   */
  async steerPrompt(projectPath: string, options: SteerPromptOptions): Promise<void> {
    const session = await this.requireSession(projectPath, options.sessionId)
    const active = this.activeProcesses.get(session.id)
    const settlement = this.activeProcessSettlements.get(session.id)
    const previous = this.activeTurnOptions.get(session.id)
    const usesNativeHistory = this.capabilities.nativeResume !== false
    if (!previous) {
      throw new Error(`No active ${this.name} turn is available to steer for session ${session.id}`)
    }
    if (!active || active.killed || !settlement) {
      if (usesNativeHistory) {
        throw new Error(
          `No active ${this.name} turn is available to steer for session ${session.id}`
        )
      }
      // A stateless process-per-turn driver can still deliver the steer from
      // the durable transcript when its child has already exited but the
      // chat-engine status has not observed the terminal event yet. This is
      // the same replay path used after a normal process boundary.
      if (active && settlement) await settlement
      return this.restartStatelessSteer(projectPath, options, session, previous)
    }

    this.steeringSessions.add(session.id)
    active.kill()
    await settlement
    return this.restartSteerAfterStop(projectPath, options, session, previous, usesNativeHistory)
  }

  private async restartStatelessSteer(
    projectPath: string,
    options: SteerPromptOptions,
    session: PersistentCliSession,
    previous: SendPromptOptions
  ): Promise<void> {
    this.steeringSessions.add(session.id)
    return this.restartSteerAfterStop(projectPath, options, session, previous, false)
  }

  private async restartSteerAfterStop(
    projectPath: string,
    options: SteerPromptOptions,
    session: PersistentCliSession,
    previous: SendPromptOptions,
    usesNativeHistory: boolean
  ): Promise<void> {
    const transportText = usesNativeHistory
      ? options.text
      : [
          'Continue the active task using the steering update below. CodeInOven restarted this stateless harness turn to deliver it.',
          `Active user request:\n${previous.text}`,
          `User steering update:\n${options.text}`
        ].join('\n\n')
    const transportAttachments = usesNativeHistory
      ? options.attachments
      : [...previous.attachments, ...options.attachments]
    if (!usesNativeHistory && options.userMessageId) {
      this.outboundMessageOverrides.set(options.userMessageId, {
        text: options.text,
        attachments: options.attachments
      })
    }
    try {
      await this.sendPrompt(projectPath, {
        ...previous,
        sessionId: session.id,
        text: transportText,
        attachments: transportAttachments,
        userMessageId: options.userMessageId
      })
    } catch (error) {
      this.emit({ type: 'session.idle', sessionId: session.id })
      throw error
    } finally {
      if (options.userMessageId) this.outboundMessageOverrides.delete(options.userMessageId)
      this.steeringSessions.delete(session.id)
    }
  }

  async loadMessages(projectPath: string, sessionId: string): Promise<AgentMessage[]> {
    const session = await this.requireSession(projectPath, sessionId)
    return session.messages
  }

  async loadMessagesSince(
    projectPath: string,
    sessionId: string,
    messageId: string
  ): Promise<AgentMessage[]> {
    const session = await this.requireSession(projectPath, sessionId)
    const startIndex = session.messages.findLastIndex((message) => message.id === messageId)
    return startIndex >= 0 ? session.messages.slice(startIndex) : session.messages
  }

  /** Resolve the provider-native session id needed by provider maintenance APIs. */
  protected async nativeSessionId(projectPath: string, sessionId: string): Promise<string> {
    const session = await this.requireSession(projectPath, sessionId)
    if (!session.nativeSessionId) {
      throw new Error(`${this.name} has not assigned a native session id yet`)
    }
    return session.nativeSessionId
  }

  async abort(projectPath: string, sessionId: string): Promise<void> {
    await this.requireSession(projectPath, sessionId)
    const child = this.activeProcesses.get(sessionId)
    if (!child || hasProcessExited(child)) return

    const termExit = waitForProcessExit(child, ABORT_TERM_GRACE_MS)
    child.kill('SIGTERM')
    const exitedAfterTerm = await termExit
    if (!exitedAfterTerm && !hasProcessExited(child)) {
      const killExit = waitForProcessExit(child, ABORT_KILL_GRACE_MS)
      child.kill('SIGKILL')
      await killExit
    }

    // `finish()` removes the process before resolving this promise. Keep the
    // abort contract bounded even if persistence or provider cleanup stalls.
    const settlement = this.activeProcessSettlements.get(sessionId)
    if (settlement) {
      await Promise.race([
        settlement,
        new Promise<void>((resolve) => setTimeout(resolve, ABORT_KILL_GRACE_MS))
      ])
    }
  }

  /**
   * Cheap liveness probe for the session watchdog: true while this session's
   * child process is still running. Persistent-CLI drivers (claude-code among
   * them) never emit an explicit error when their process dies mid-turn   the
   * stream just goes silent   so without this the watchdog can never tell a
   * dead process from a long-running one and extends the "working" state
   * forever, leaving the turn stuck until the user ends it manually.
   */
  async isSessionBusy(projectPath: string, sessionId: string): Promise<boolean> {
    await this.requireSession(projectPath, sessionId)
    const child = this.activeProcesses.get(sessionId)
    return !!child && !hasProcessExited(child)
  }

  async listProviders(_projectPath: string): Promise<ProviderCatalog[]> {
    void _projectPath
    return []
  }

  async listCommands(_projectPath: string): Promise<HarnessCommand[]> {
    void _projectPath
    return []
  }

  async runCommand(
    _projectPath: string,
    _sessionId: string,
    _command: HarnessCommand,
    _args: string,
    _settings: ThreadSettings
  ): Promise<void> {
    void _projectPath
    void _sessionId
    void _command
    void _args
    void _settings
    throw new Error(`${this.name} does not expose slash commands through ${APP_NAME}`)
  }

  async replyPermission(
    _projectPath: string,
    _requestId: string,
    _reply: PermissionReply,
    _message?: string,
    _sessionId?: string
  ): Promise<void> {
    void _projectPath
    void _requestId
    void _reply
    void _message
    void _sessionId
    throw new Error(`${this.name} does not support interactive permission replies`)
  }

  async replyToQuestion(
    _projectPath: string,
    _sessionId: string,
    _requestId: string,
    _answers: string[][]
  ): Promise<void> {
    void _projectPath
    void _sessionId
    void _requestId
    void _answers
    throw new Error(`${this.name} does not support interactive questions`)
  }

  async rejectQuestion(
    _projectPath: string,
    _sessionId: string,
    _requestId: string
  ): Promise<void> {
    void _projectPath
    void _sessionId
    void _requestId
    throw new Error(`${this.name} does not support interactive questions`)
  }

  async listPendingQuestions(_projectPath: string): Promise<AgentQuestionRequest[]> {
    void _projectPath
    return []
  }

  onEvent(callback: AgentEventCallback): void {
    this.eventCallback = callback
  }

  dispose(): void {
    for (const child of this.activeProcesses.values()) child.kill()
    this.activeProcesses.clear()
    this.activeTurnOptions.clear()
    for (const resolve of this.activeProcessSettlementResolvers.values()) resolve()
    this.activeProcessSettlements.clear()
    this.activeProcessSettlementResolvers.clear()
    this.steeringSessions.clear()
    this.outboundMessageOverrides.clear()
    for (const runtime of this.utilityRuntimes.values()) {
      void runtime.cleanup().catch((error) => {
        Logger.error(`${this.name} utility runtime cleanup failed:`, error)
      })
    }
    this.utilityRuntimes.clear()
    this.sessionCache.clear()
    this.turnProvenance.clear()
    this.titleTurns.rejectAll(this.name)
    this.interactionRequests.clear()
    this.eventCallback = null
  }

  /** Verify provider installation/authentication before a new session starts. */
  protected abstract ensureCliReady(projectPath: string): Promise<void>

  /** Build the single child-process invocation for one logical turn. */
  protected abstract buildTurnCommand(
    projectPath: string,
    session: PersistentCliSession,
    options: SendPromptOptions
  ): Promise<CliTurnCommand>

  /** Map one parsed JSONL value into CodeInOven events and durable session data. */
  protected abstract parseJsonLine(
    value: unknown,
    context: CliLineParseContext
  ): CliLineParseResult | null

  protected utilityRuntime(sessionId: string): PreparedUtilityRuntime | undefined {
    return this.utilityRuntimes.get(sessionId)
  }

  /** Write provider-native streaming input to the running turn. */
  protected writeActiveInput(sessionId: string, input: string): void {
    const child = this.activeProcesses.get(sessionId)
    if (!child || child.killed || !child.stdin) {
      throw new Error(`No active ${this.name} turn is available to steer for session ${sessionId}`)
    }
    child.stdin.write(input)
  }

  /** Stop a turn synchronously at a provider record boundary. */
  protected stopActiveProcess(sessionId: string): void {
    const child = this.activeProcesses.get(sessionId)
    if (child && !child.killed) child.kill()
  }

  /**
   * Wait for a session's in-flight harness process to fully settle (stream
   * flushed and the active-turn state released) before resuming the same
   * session. Mirrors the teardown used by `steerPrompt` so interaction
   * continuations never race the process they just stopped.
   */
  protected async settleActiveProcess(sessionId: string, timeoutMs = 10_000): Promise<void> {
    const active = this.activeProcesses.get(sessionId)
    if (active && !active.killed) active.kill()
    const settlement = this.activeProcessSettlements.get(sessionId)
    if (settlement) {
      try {
        await Promise.race([
          settlement,
          new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
        ])
      } catch {
        // Timed out waiting for the harness process to settle; continue best-effort.
      }
    }
    const deadline = Date.now() + timeoutMs
    while (this.activeProcesses.has(sessionId) && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25))
    }
  }

  /** Close a streaming-input turn after its final provider result arrives. */
  protected closeActiveInput(sessionId: string): void {
    this.activeProcesses.get(sessionId)?.stdin?.end()
  }

  /** Logical sessions that currently own a live provider process. */
  protected activeSessionIds(): string[] {
    return [...this.activeProcesses.keys()]
  }

  /** True for the disposable sessions owned by automatic title generation. */
  protected isTitleSession(sessionId: string): boolean {
    return this.titleTurns.isTitleSession(sessionId)
  }

  protected observeHarnessProcess(
    sessionId: string | undefined,
    child: ChildProcess,
    command: string,
    cwd: string
  ): void {
    const pid = child.pid
    if (typeof pid === 'number' && pid > 0) {
      this.processObserver?.watchProcess(sessionId, pid, command, cwd)
      return
    }
    // A bundled harness runs inside an Electron utilityProcess, whose OS pid is
    // `undefined` until the helper has spawned (Electron reads it
    // asynchronously), so the synchronous read above misses it in the packaged
    // app. Register the root once the child reports the pid, so bundled harnesses
    // appear in the task manager and are covered by orphan reaping exactly like
    // a natively spawned one.
    const onSpawn = (): void => {
      const spawnedPid = child.pid
      if (typeof spawnedPid === 'number' && spawnedPid > 0) {
        this.processObserver?.watchProcess(sessionId, spawnedPid, command, cwd)
      }
    }
    child.once('spawn', onSpawn)
  }

  protected setTurnProvenance(
    sessionId: string,
    providerId?: string,
    modelId?: string,
    thinkingLevel?: ThinkingLevel
  ): void {
    this.turnProvenance.set(sessionId, {
      providerId: providerId || undefined,
      modelId: modelId || undefined,
      thinkingLevel: thinkingLevel || undefined
    })
  }

  protected appendUserMessage(
    session: PersistentCliSession,
    opts: Pick<SendPromptOptions, 'text' | 'attachments' | 'userMessageId'>
  ): void {
    this.mergeMessages(session, [buildUserMessage(this.outboundMessageOverrides, opts)])
  }

  protected resolveRuntimePlaceholders(value: string, runtime: PreparedUtilityRuntime): string {
    return value
      .replaceAll('{{runtime-directory}}', runtime.directory)
      .replace(/\{\{config:([^{}]+)\}\}/gu, (_placeholder, configId: string) => {
        const path = runtime.configPaths[configId]
        if (!path) {
          throw new Error(`Utility runtime config is unavailable: ${configId}`)
        }
        return path
      })
  }

  /**
   * Apply a parse result produced outside the live stdout loop (e.g. a
   * harness-side log replay or a driver-side finalize pass) to the durable
   * session and the live event stream. Mirrors the stdout application path
   * exactly, minus process-issue bookkeeping.
   */
  protected applyParseResult(
    result: CliLineParseResult,
    session: PersistentCliSession,
    options?: { trackProcessIssues?: boolean }
  ): void {
    if (result.nativeSessionId) session.nativeSessionId = result.nativeSessionId
    if (result.messages) this.mergeMessages(session, result.messages)
    for (const event of this.normalizeInteractionEvents(session.id, result.events ?? [])) {
      if (options?.trackProcessIssues) {
        if (event.type === 'session.error' || (event.type === 'message.completed' && event.issue)) {
          this.structuredProcessIssues.add(session.id)
        } else if (event.type === 'session.status') {
          if (event.status.state === 'waiting' || event.status.state === 'error') {
            this.structuredProcessIssues.add(session.id)
          } else {
            this.structuredProcessIssues.delete(session.id)
          }
        }
      }
      this.applyEventToSession(session, event)
      this.emit({ ...event, sessionId: session.id })
    }
    session.updatedAt = Date.now()
  }

  protected mergeMessages(session: PersistentCliSession, messages: AgentMessage[]): void {
    mergeSessionMessages(session, messages, this.turnProvenance.get(session.id), this.id)
  }

  protected applyEventToSession(session: PersistentCliSession, event: AgentEvent): void {
    this.applyEventToMessages(session.messages, event)
  }

  /**
   * Apply one stream event to a transcript. Sessions keep their transcript on
   * the session record, but a harness-native child session has no app session
   * record of its own   the pi driver tracks delegated sub-agent transcripts
   * as a plain message list, and both paths must fold events identically so a
   * child transcript renders exactly like a root one.
   */
  protected applyEventToMessages(messages: AgentMessage[], event: AgentEvent): void {
    foldEventIntoMessages(messages, event)
  }

  /** Promote JSONL question/approval tool parts into the shared interaction stream. */
  protected normalizeInteractionEvents(
    sessionId: string,
    events: SessionAgentEvent[]
  ): SessionAgentEvent[] {
    return normalizeCliInteractionEvents(this.id, this.interactionRequests, sessionId, events)
  }

  /**
   * When a harness reports tokens but no dollar cost, fill in an estimate from
   * the local model-catalog pricing so usage reports aren't zero. Only applies
   * when cost is genuinely missing; a provider-reported cost is never replaced.
   */
  protected estimateMissingCost(message: AgentMessage): void {
    estimateMessageCost(message)
  }

  protected async requireSession(
    projectPath: string,
    sessionId: string
  ): Promise<PersistentCliSession> {
    return requireCliSession(this.storage, this.id, this.sessionCache, projectPath, sessionId)
  }

  protected async persistSession(session: PersistentCliSession): Promise<void> {
    await persistCliSession(this.storage, this.id, session)
  }

  protected sessionPath(sessionId: string): string {
    return cliSessionPath(this.id, sessionId)
  }

  /**
   * Stamp the owning thread onto a session record. The engine calls this when
   * binding a session so the driver can relocate the thread's sessions later  
   * e.g. after a harness switch moved the thread's session slot elsewhere.
   */
  async tagSessionThread(projectPath: string, sessionId: string, threadId: string): Promise<void> {
    try {
      const session = await this.requireSession(projectPath, sessionId)
      if (session.threadId === threadId) return
      session.threadId = threadId
      await this.persistSession(session)
    } catch {
      // Best-effort: an untagged session only costs native resume after a
      // harness switch, never the current turn.
    }
  }

  /**
   * The most recent session record for a thread in this project, or null.
   * Scans this driver's session records by project hash + stamped thread id.
   */
  protected async findLatestThreadSession(
    projectPath: string,
    threadId: string
  ): Promise<PersistentCliSession | null> {
    return findLatestThreadCliSession(this.storage, this.id, projectPath, threadId)
  }

  protected emit(event: AgentEvent): void {
    if (this.titleTurns.intercept(event, this.name)) return
    this.eventCallback?.(event)
  }
}
