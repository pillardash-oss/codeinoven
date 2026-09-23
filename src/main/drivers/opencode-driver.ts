import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { readFile } from 'node:fs/promises'
import { Logger } from '../system/logger'
import type {
  AgentEvent,
  AgentMessage,
  AgentQuestionRequest,
  AgentRateLimitWindow,
  HarnessCommand,
  PermissionReply,
  ProviderCatalog,
  ThreadSettings
} from '../../lib/types'
import type {
  AgentEventCallback,
  AgentProcessObserver,
  CheapModelAttempt,
  CheapModelRequest,
  CheapModelResult,
  GenerateTitleOptions,
  GradeTurnOptions,
  HarnessCapabilities,
  HarnessDriver,
  HarnessToolDefinition,
  PreparedUtilityRuntime,
  SendHeartbeatPingOptions,
  SendPromptOptions,
  SteerPromptOptions,
  UtilityRuntimeOverlay,
  UtilityRuntimePreparationRequest
} from './driver.interface'
import { QuestionRequestGoneError } from './driver.interface'
import { buildProcessEnvironment } from './cli-environment'
import { BaseUrlProviderService } from '../providers/base-url-provider-service'
import { opencodeNativeProviderIds } from '../agents/native-provider-config-service'
import { SecretVault } from '../storage/secret-vault'
import { buildTitlePrompt, HEARTBEAT_PROMPT, sanitizeGeneratedTitle } from '../chat/title-generator'
import { buildRankingGradePrompt, parseRankingGrade } from '../chat/turn-grader-prompt'
import { prepareHarnessInvocation, runHarnessCommand } from './harness-runtime'
import { mapOpenCodeAccountUsage, OPENCODE_ACCOUNT_USAGE_ENDPOINT } from './opencode-provider-usage'
import { mapOpenCodeEvent } from './opencode/opencode-events'
import { errorFromResponse, questionReplyFailure } from './opencode/opencode-issues'
import { mapOpenCodeMessage } from './opencode/opencode-messages'
import { mapOpenCodeProvider, parseOpenCodeModels } from './opencode/opencode-models'
import { buildOpenCodePromptBody, buildOpenCodePromptParts } from './opencode/opencode-prompt'
import { mapOpenCodeQuestionRequest } from './opencode/opencode-questions'
import {
  narrowOpenCodeRuntimeForProvider,
  prepareOpenCodeUtilityRuntime
} from './opencode/opencode-utility-runtime'
import {
  apiKeyFromOpenCodeAuth,
  openCodeAuthPaths,
  recordValue,
  stringValue
} from './opencode/opencode-values'

export { mapOpenCodeAccountUsage } from './opencode-provider-usage'
export { mapOpenCodeEvent } from './opencode/opencode-events'
export { mapOpenCodePart } from './opencode/opencode-parts'
export { opencodePermissionTools, parseOpenCodeModels } from './opencode/opencode-models'

const SERVER_START_TIMEOUT_MS = 25000
const MODEL_DISCOVERY_TIMEOUT_MS = 20_000
const ACCOUNT_USAGE_TIMEOUT_MS = 10_000

const SSE_RECONNECT_MS = 1000
const TITLE_GENERATION_TIMEOUT_MS = 180_000
const TITLE_RESULT_POLL_INTERVAL_MS = 250

interface ServerHandle {
  projectPath: string
  runtimeId: string | null
  port: number
  baseUrl: string
  process: ChildProcess
  /** Aborts the SSE subscription loop when the server is disposed. */
  abortController: AbortController
}

/**
 * Handle for an isolated `opencode serve` process used for ephemeral work
 * (e.g., thread title generation) so it cannot block the project's main
 * pooled server.
 */
export interface IsolatedHandle extends ServerHandle {
  sessionId: string
}

export class OpenCodeDriver implements HarnessDriver {
  readonly id = 'opencode'
  readonly name = 'OpenCode'
  readonly capabilities: HarnessCapabilities = {
    runtimeTopology: { kind: 'shared_server', scope: 'application' },
    streaming: true,
    steering: true,
    nativeResume: true,
    messageHistory: 'native',
    interactivePermissions: true,
    attachments: true,
    commands: true,
    providerCatalog: true,
    sessionStatus: true,
    contextUsage: true,
    compaction: true,
    subagents: true,
    // OpenCode 1.18.10 accepts structured prompts but its history endpoint can
    // fail to decode their stored format, and structured output returns no
    // visible text into the conversation (the spec/assignment only appears in
    // the studio/panel). Keep deterministic JSON-only output so the generated
    // spec is written as a visible message the renderer reliably surfaces.
    structuredOutput: false,
    nativeUtilities: ['web_fetch'],
    // OpenCode schedules and performs its own provider retries (`session.status`
    // `retry` with a `next` timestamp). The app still records the wait in the
    // retry scheduler so a restart can resume the thread while it is awaiting a
    // reset; OpenCode's own resume clears that record.
    scheduledRetry: true
  }

  private server: ServerHandle | null = null
  private starting: Promise<ServerHandle> | null = null
  private projectSubscriptions = new Map<string, AbortController>()
  private activeSessions = new Map<string, string>()
  private turnServers = new Map<string, ServerHandle>()
  private turnStarting = new Map<string, Promise<ServerHandle>>()
  private utilityRuntimes = new Map<string, PreparedUtilityRuntime>()
  private messageRoles = new Map<string, 'user' | 'assistant'>()
  private eventCallback: AgentEventCallback | null = null
  private isolatedServers = new Set<IsolatedHandle>()
  private titleSessions = new Set<string>()
  private processObserver: AgentProcessObserver | null = null

  /**
   * Idle lifetimes for spawned `opencode serve` processes. These are a
   * self-defense net inside the driver: engine-side bookkeeping can lose track
   * of servers across interrupted turns and restarts, and each leaked server
   * costs hundreds of MB resident. After the TTL below with zero HTTP or SSE
   * traffic, processes are killed; the next demand transparently respawns one.
   */
  private static readonly TURN_SERVER_IDLE_TTL_MS = 10 * 60_000
  private static readonly ISOLATED_SERVER_IDLE_TTL_MS = 5 * 60_000
  private static readonly SHARED_SERVER_IDLE_TTL_MS = 10 * 60_000
  private static readonly IDLE_SWEEP_INTERVAL_MS = 60_000
  /**
   * A turn registered in `activeSessions` may legitimately emit no events far
   * longer than the traffic TTL   a long bash command, a download, a silent
   * sub-agent. Mirrors ChatEngine.SILENT_WORK_GRACE_MS: while a turn is this
   * young in silence terms, its server is never reaped, no matter how quiet.
   */
  private static readonly SILENT_TURN_GRACE_MS = 30 * 60_000
  /**
   * Entries silent past twice that grace are ghosts   a turn that died without
   * a terminal event (for example during an SSE reconnect gap). The engine's
   * own watchdog re-checks silent turns at 30 minutes, so by 60 only ghosts
   * remain; they are dropped so they cannot hold a server open forever.
   */
  private static readonly GHOST_SESSION_TTL_MS = 60 * 60_000
  /** Port → timestamp of the most recent HTTP request header or SSE frame. */
  private lastServerTrafficAt = new Map<number, number>()
  /** Session → timestamp of the most recent event or prompt targeting it.
   *  Ghost `activeSessions` entries (a turn that died without a terminal
   *  event) must not hold the shared server open forever, so liveness is
   *  judged per session, not per map membership. */
  private lastSessionActivityAt = new Map<string, number>()
  private idleSweepTimer: ReturnType<typeof setInterval> | null = null

  /** Coalesce concurrent battery hovers across threads into one account request. */
  private accountUsageRequest: Promise<{ rateLimits: AgentRateLimitWindow[] } | null> | null = null

  /**
   * Optional collaborators for custom base-URL providers. When supplied, the
   * driver resolves every enabled provider's API key from the vault and injects
   * the provider configuration into `OPENCODE_CONFIG_CONTENT` so the models
   * appear in the `/models` picker.
   */
  constructor(
    private readonly baseUrlProviders?: BaseUrlProviderService,
    private readonly secretVault?: SecretVault,
    private readonly accountEnvironment: NodeJS.ProcessEnv = {}
  ) {}

  /** Note live traffic against a spawned server so the idle reaper skips it. */
  private noteServerTraffic(port: number): void {
    this.lastServerTrafficAt.set(port, Date.now())
    this.ensureIdleSweeper()
  }

  private idleMs(port: number): number {
    const at = this.lastServerTrafficAt.get(port)
    // An unknown port is a freshly spawned server   treat it as brand new so
    // the sweeper can never kill a process between spawn and first request.
    return at === undefined ? 0 : Date.now() - at
  }

  private ensureIdleSweeper(): void {
    if (this.idleSweepTimer) return
    this.idleSweepTimer = setInterval(() => {
      try {
        this.sweepIdleHandles()
      } catch (error) {
        Logger.dev('opencode idle sweep failed:', error)
      }
    }, OpenCodeDriver.IDLE_SWEEP_INTERVAL_MS)
    this.idleSweepTimer.unref?.()
  }

  /**
   * Kill pooled servers whose traffic has been silent past their TTL. A busy
   * session always shows traffic (prompt calls, streamed SSE frames), so an
   * eviction can only reach processes nothing is using. Restarting an evicted
   * server on the next demand is a fast lazy spawn.
   */
  private sweepIdleHandles(): void {
    this.pruneGhostSessions()

    for (const [sessionId, handle] of [...this.turnServers]) {
      if (
        this.isSessionLive(sessionId) ||
        this.idleMs(handle.port) < OpenCodeDriver.TURN_SERVER_IDLE_TTL_MS
      ) {
        continue
      }
      Logger.info('Reaping idle opencode turn server', { sessionId, port: handle.port })
      void this.stopTurnServer(sessionId)
    }

    for (const handle of [...this.isolatedServers]) {
      if (this.idleMs(handle.port) < OpenCodeDriver.ISOLATED_SERVER_IDLE_TTL_MS) continue
      Logger.info('Reaping idle isolated opencode server', { port: handle.port })
      if (!handle.process.killed) handle.process.kill()
      handle.abortController.abort()
      this.isolatedServers.delete(handle)
    }

    const shared = this.server
    if (
      shared &&
      !this.starting &&
      this.idleMs(shared.port) >= OpenCodeDriver.SHARED_SERVER_IDLE_TTL_MS &&
      ![...this.activeSessions.keys()].some((sessionId) => this.isSessionLive(sessionId))
    ) {
      Logger.info('Reaping idle opencode serve host', { port: shared.port })
      shared.abortController.abort()
      if (!shared.process.killed) shared.process.kill()
      this.server = null
      this.starting = null
      for (const controller of this.projectSubscriptions.values()) controller.abort()
      this.projectSubscriptions.clear()
      this.activeSessions.clear()
    }
  }

  /**
   * Drop `activeSessions` entries that have shown no sign of life for double
   * the silent-turn grace. A real turn either emitted fresh activity or a
   * terminal event by then (the engine's watchdog resolves stalled turns at
   * 30 minutes); anything older is a record-keeping ghost, and keeping it
   * would pin its harness server in memory forever.
   */
  private pruneGhostSessions(): void {
    const now = Date.now()
    for (const sessionId of [...this.activeSessions.keys()]) {
      const at = this.lastSessionActivityAt.get(sessionId)
      if (at !== undefined && now - at >= OpenCodeDriver.GHOST_SESSION_TTL_MS) {
        Logger.info('Dropping ghost opencode session tracking entry', { sessionId })
        this.activeSessions.delete(sessionId)
        this.lastSessionActivityAt.delete(sessionId)
      }
    }
    for (const [sessionId, at] of this.lastSessionActivityAt) {
      if (!this.activeSessions.has(sessionId) && now - at >= OpenCodeDriver.GHOST_SESSION_TTL_MS) {
        this.lastSessionActivityAt.delete(sessionId)
      }
    }
  }

  /**
   * Whether a session may still be mid-turn. Membership in `activeSessions`
   * (set on prompt send, cleared on terminal events) is the structural
   * in-flight flag; recency of its last activity decides whether that flag is
   * fresh enough to protect the session's server from the idle reaper.
   */
  private isSessionLive(sessionId: string): boolean {
    if (!this.activeSessions.has(sessionId)) return false
    const at = this.lastSessionActivityAt.get(sessionId)
    if (at === undefined) return true
    return Date.now() - at < OpenCodeDriver.SILENT_TURN_GRACE_MS
  }

  private noteSessionActivity(sessionId: string | undefined): void {
    if (!sessionId) return
    this.lastSessionActivityAt.set(sessionId, Date.now())
  }

  // ─── HarnessDriver interface ──────────────────────────────────────────────

  onEvent(callback: AgentEventCallback): void {
    this.eventCallback = callback
  }

  setProcessObserver(observer: AgentProcessObserver): void {
    this.processObserver = observer
  }

  async ensureReady(projectPath: string): Promise<void> {
    await runHarnessCommand('opencode', ['--version'], {
      cwd: projectPath,
      env: this.buildEnv(),
      timeoutMs: 5_000
    })
  }

  async prepareUtilityRuntime(
    request: UtilityRuntimePreparationRequest
  ): Promise<UtilityRuntimeOverlay> {
    return prepareOpenCodeUtilityRuntime(request, this.id, this.baseUrlProviders, this.secretVault)
  }

  async applyPreparedUtilityRuntime(
    _projectPath: string,
    runtime: PreparedUtilityRuntime | null,
    sessionId: string
  ): Promise<void> {
    void _projectPath
    const previous = this.utilityRuntimes.get(sessionId)
    if ((previous?.id ?? null) === runtime?.id) return
    if (previous) await this.stopTurnServer(sessionId)
    if (runtime) this.utilityRuntimes.set(sessionId, runtime)
    else this.utilityRuntimes.delete(sessionId)
    if (previous) await previous.cleanup()
  }

  async preparePromptTransport(
    projectPath: string,
    sessionId: string,
    settings: ThreadSettings
  ): Promise<void> {
    if (this.utilityRuntimes.has(sessionId)) {
      await this.ensureTurnServer(projectPath, sessionId, settings.providerId)
      return
    }
    await this.ensureServer(projectPath)
  }

  async createSession(projectPath: string, title: string): Promise<string> {
    const handle = await this.ensureServer(projectPath)
    return this.createSessionOnHandle(handle, title)
  }

  /** Big Pickle is OpenCode's single cheap auxiliary candidate. */
  private async cheapCandidates(
    _projectPath: string
  ): Promise<Array<{ providerId: string; modelId: string }>> {
    void _projectPath
    // Pin the known alias so catalog discovery cannot block the fallback. The
    // one-shot runner appends the conversation model and tries it when Big
    // Pickle times out, fails, or produces an invalid response.
    return [{ providerId: 'opencode', modelId: 'big-pickle' }]
  }

  /** Run one auxiliary one-shot completion per candidate on isolated servers. */
  private async isolatedOneShot(
    projectPath: string,
    settings: ThreadSettings,
    purpose: string,
    candidates: Array<{ providerId: string; modelId: string }>,
    promptText: string,
    timeoutMs: number = TITLE_GENERATION_TIMEOUT_MS,
    attempts?: CheapModelAttempt[]
  ): Promise<string | null> {
    const attemptList = [
      ...candidates,
      { providerId: settings.providerId, modelId: settings.modelId }
    ].filter(
      (candidate, index, all) =>
        Boolean(candidate.providerId && candidate.modelId) &&
        all.findIndex(
          (other) =>
            other.providerId === candidate.providerId && other.modelId === candidate.modelId
        ) === index
    )
    for (const candidate of attemptList) {
      let isolated: IsolatedHandle | null = null
      try {
        isolated = await this.createIsolatedSession(projectPath, purpose)
        this.titleSessions.add(isolated.sessionId)
        await this.sendPrompt(
          projectPath,
          {
            sessionId: isolated.sessionId,
            settings: {
              ...settings,
              providerId: candidate.providerId,
              modelId: candidate.modelId,
              thinkingLevel: 'minimal',
              inferenceMode: 'normal',
              permissionLevel: 'auto_review'
            },
            text: promptText,
            attachments: [],
            readOnly: true,
            allowedTools: []
          },
          isolated
        )
        const result = await this.waitForTitleResult(isolated, timeoutMs)
        attempts?.push({
          providerId: candidate.providerId,
          modelId: candidate.modelId,
          ok: result !== null,
          failure: result === null ? 'No usable response produced' : null
        })
        if (result) return result
      } catch (error) {
        attempts?.push({
          providerId: candidate.providerId,
          modelId: candidate.modelId,
          ok: false,
          failure: error instanceof Error ? error.message : String(error)
        })
        Logger.dev(
          `OpenCode one-shot model ${candidate.providerId}/${candidate.modelId} unavailable:`,
          error
        )
      } finally {
        if (isolated) {
          this.titleSessions.delete(isolated.sessionId)
          await this.deleteSessionOnHandle(isolated, isolated.sessionId).catch(() => undefined)
          this.disposeIsolatedSession(isolated)
        }
      }
    }
    return null
  }

  async generateTitle(projectPath: string, options: GenerateTitleOptions): Promise<string | null> {
    const candidates = options.candidates ?? (await this.cheapCandidates(projectPath))
    return this.isolatedOneShot(
      projectPath,
      options.settings,
      'Thread title',
      candidates,
      buildTitlePrompt(options.message.slice(0, 2_000))
    )
  }

  /** Ping the exact configured model   no cheap-candidate substitution. */
  async sendHeartbeatPing(
    projectPath: string,
    options: SendHeartbeatPingOptions
  ): Promise<boolean> {
    const reply = await this.isolatedOneShot(
      projectPath,
      options.settings,
      'Heartbeat',
      [],
      HEARTBEAT_PROMPT
    )
    return reply !== null
  }

  /**
   * One self-contained cheap-model completion, cheapest candidate first
   * (big-pickle pinned, other free models as fallback, thread model last).
   * The single entry point every cheap-model scenario routes through.
   */
  async provideCheapModel(
    projectPath: string,
    request: CheapModelRequest
  ): Promise<CheapModelResult> {
    const candidates = request.candidates ?? (await this.cheapCandidates(projectPath))
    const attempts: CheapModelAttempt[] = []
    const text = await this.isolatedOneShot(
      projectPath,
      request.settings,
      request.purpose,
      candidates,
      request.prompt,
      request.timeoutMs ?? TITLE_GENERATION_TIMEOUT_MS,
      attempts
    )
    return { text, attempts }
  }

  async gradeTurn(projectPath: string, options: GradeTurnOptions): Promise<number | null> {
    const candidates = options.candidates ?? (await this.cheapCandidates(projectPath))
    const result = await this.isolatedOneShot(
      projectPath,
      options.settings,
      'Turn grade',
      candidates,
      buildRankingGradePrompt({
        userMessage: options.userMessage,
        assistantOutput: options.assistantOutput,
        followUp: options.followUp ?? null
      })
    )
    return result === null ? null : parseRankingGrade(result)
  }

  /**
   * Create a session on a fresh, isolated `opencode serve` process. Use this
   * for short, independent tasks that must not share the main project's
   * request queue (e.g., thread title generation).
   */
  async createIsolatedSession(projectPath: string, title: string): Promise<IsolatedHandle> {
    const handle = await this.startIsolatedServer(projectPath)
    try {
      const sessionId = await this.createSessionOnHandle(handle, title)
      const isolated: IsolatedHandle = { ...handle, sessionId }
      this.isolatedServers.add(isolated)
      isolated.process.on('exit', () => {
        this.isolatedServers.delete(isolated)
      })
      return isolated
    } catch (error) {
      handle.abortController.abort()
      handle.process.kill()
      throw error
    }
  }

  /** Delete the disposable session, then tear down its isolated server. */
  disposeIsolatedSession(handle: IsolatedHandle): void {
    this.isolatedServers.delete(handle)
    void this.deleteSessionOnHandle(handle, handle.sessionId)
      .catch((error) => Logger.dev('Isolated opencode session cleanup was incomplete:', error))
      .finally(() => {
        handle.abortController.abort()
        handle.process.kill()
      })
  }

  private async createSessionOnHandle(handle: ServerHandle, title: string): Promise<string> {
    const res = await fetch(`${handle.baseUrl}/session`, {
      method: 'POST',
      headers: this.headersFor(handle, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ title })
    })
    if (!res.ok) throw await errorFromResponse(res, 'Failed to create session')
    const session = (await res.json()) as { id: string }
    return session.id
  }

  async sendPrompt(
    projectPath: string,
    opts: SendPromptOptions,
    isolated?: IsolatedHandle
  ): Promise<void> {
    const handle =
      isolated ??
      (this.utilityRuntimes.has(opts.sessionId)
        ? await this.ensureTurnServer(projectPath, opts.sessionId, opts.settings.providerId)
        : await this.ensureServer(projectPath))

    const parts: Array<Record<string, unknown>> = [
      { type: 'text', text: opts.text },
      ...(await buildOpenCodePromptParts(opts.attachments))
    ]
    const body = buildOpenCodePromptBody(opts, parts)

    this.activeSessions.set(opts.sessionId, projectPath)
    this.noteSessionActivity(opts.sessionId)
    try {
      const res = await fetch(`${handle.baseUrl}/session/${opts.sessionId}/prompt_async`, {
        method: 'POST',
        headers: this.headersFor(handle, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(body)
      })
      if (!res.ok) {
        throw await errorFromResponse(res, 'Failed to send prompt')
      }
    } catch (error) {
      this.activeSessions.delete(opts.sessionId)
      throw error
    }
  }

  /** Append input through OpenCode's native asynchronous session prompt endpoint. */
  async steerPrompt(
    projectPath: string,
    opts: SteerPromptOptions,
    isolated?: IsolatedHandle
  ): Promise<void> {
    const handle =
      isolated ?? this.turnServers.get(opts.sessionId) ?? (await this.ensureServer(projectPath))
    const parts: Array<Record<string, unknown>> = [
      { type: 'text', text: opts.text },
      ...(await buildOpenCodePromptParts(opts.attachments))
    ]

    const res = await fetch(`${handle.baseUrl}/session/${opts.sessionId}/prompt_async`, {
      method: 'POST',
      headers: this.headersFor(handle, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ messageID: opts.userMessageId, parts })
    })
    if (!res.ok) throw await errorFromResponse(res, 'Failed to steer active OpenCode session')
  }

  /**
   * Live probe of the shared server's session-status map (`GET /session/status`,
   * a Record of sessionID → `{ type: 'busy' | 'idle' | 'retry' | 'completed' }`).
   * Used by restart recovery before resuming an "interrupted" thread: the
   * surviving `opencode serve` process may still be running the pre-restart
   * turn, and sending a prompt then would start a second concurrent loop on
   * the same session. Best-effort: any transport/parse failure reports
   * "not busy" so recovery keeps its legacy behavior rather than blocking.
   */
  async isSessionBusy(projectPath: string, sessionId: string): Promise<boolean> {
    let handle: ServerHandle
    try {
      handle = await this.ensureServer(projectPath)
    } catch {
      return false
    }
    try {
      const res = await fetch(`${handle.baseUrl}/session/status`, {
        method: 'GET',
        headers: this.headersFor(handle)
      })
      if (!res.ok) return false
      const statuses = recordValue(await res.json())
      if (!statuses) return false
      const status = recordValue(statuses[sessionId])
      return status?.['type'] === 'busy' || status?.['type'] === 'retry'
    } catch {
      return false
    }
  }

  async loadMessages(
    projectPath: string,
    sessionId: string,
    isolated?: IsolatedHandle
  ): Promise<AgentMessage[]> {
    const turnHandle = isolated ? undefined : this.turnServers.get(sessionId)
    const handle = isolated ?? turnHandle ?? (await this.ensureServer(projectPath))
    try {
      return await this.fetchMessages(handle, sessionId)
    } catch (error) {
      // End-of-turn mirroring and renderer refreshes can read concurrently.
      // Utility cleanup deliberately kills the per-turn server after the
      // canonical mirror finishes, which terminates any other fetch already in
      // flight. OpenCode sessions persist outside that process, so retry the
      // read once through whichever transport owns the session now.
      if (!turnHandle || isolated || this.turnServers.get(sessionId) === turnHandle) throw error
      const replacementHandle =
        this.turnServers.get(sessionId) ?? (await this.ensureServer(projectPath))
      return this.fetchMessages(replacementHandle, sessionId)
    }
  }

  async abort(projectPath: string, sessionId: string, isolated?: IsolatedHandle): Promise<void> {
    const handle =
      isolated ?? this.turnServers.get(sessionId) ?? (await this.ensureServer(projectPath))
    await fetch(`${handle.baseUrl}/session/${sessionId}/abort`, {
      method: 'POST',
      headers: this.headersFor(handle),
      signal: AbortSignal.timeout(5_000)
    })
  }

  /**
   * Forcefully terminate the harness process backing a session (SIGTERM).
   * Kills the per-session `opencode serve` process that streams the SSE turn so
   * the connection is torn down immediately   used when the user confirms a
   * forced close. Falls back to a graceful abort when no dedicated turn server
   * exists for the session (the pooled server is left for the app to dispose).
   */
  terminate(projectPath: string, sessionId: string): Promise<void> {
    const handle = this.turnServers.get(sessionId)
    if (handle) {
      handle.abortController.abort()
      if (!handle.process.killed) handle.process.kill('SIGTERM')
      return Promise.resolve()
    }
    return this.abort(projectPath, sessionId)
  }

  /**
   * Permanently remove a session from the harness, releasing the work it owned
   * (in-flight turns and any processes it spawned). When the project's pooled
   * server is running it deletes through that; otherwise it spins up a
   * transient server purely to remove the persisted session so it cannot
   * rehydrate on next use. An already-missing session counts as deleted.
   */
  async deleteSession(projectPath: string, sessionId: string): Promise<void> {
    this.activeSessions.delete(sessionId)
    const turnHandle = this.turnServers.get(sessionId)
    const handle = turnHandle ?? (this.server ? this.scopedHandle(this.server, projectPath) : null)
    if (!handle) {
      await this.deleteSessionViaTransientServer(projectPath, sessionId)
      this.stopSharedServerIfIdle()
      return
    }
    try {
      await this.deleteSessionOnHandle(handle, sessionId)
    } finally {
      if (turnHandle) await this.stopTurnServer(sessionId)
      this.stopSharedServerIfIdle()
    }
  }

  /**
   * Delete a persisted opencode session of an idle project whose server is not
   * running. Spawns a short-lived isolated `opencode serve` on the project,
   * issues opencode's own session DELETE through it (which removes the session
   * from opencode's on-disk store), then always tears the transient server down
   * so no orphaned session or process is left behind. Best-effort: failures
   * log and are swallowed.
   */
  private async deleteSessionViaTransientServer(
    projectPath: string,
    sessionId: string
  ): Promise<void> {
    let transient: IsolatedHandle | undefined
    try {
      const base = await this.startIsolatedServer(projectPath)
      transient = { ...base, sessionId }
      const handle = transient
      this.isolatedServers.add(handle)
      handle.process.on('exit', () => {
        this.isolatedServers.delete(handle)
      })
      await this.deleteSessionOnHandle(handle, sessionId)
    } catch (error) {
      Logger.dev('Transient opencode session deletion was incomplete:', error)
    } finally {
      if (transient) this.disposeIsolatedSession(transient)
    }
  }

  private async deleteSessionOnHandle(handle: ServerHandle, sessionId: string): Promise<void> {
    const res = await fetch(`${handle.baseUrl}/session/${sessionId}`, {
      method: 'DELETE',
      headers: this.headersFor(handle),
      signal: AbortSignal.timeout(10_000)
    })
    if (!res.ok && res.status !== 404) {
      throw await errorFromResponse(res, 'Failed to delete session')
    }
  }

  async listProviders(projectPath: string): Promise<ProviderCatalog[]> {
    const connected = await this.connectedProviderIds()
    if (connected !== null && connected.size === 0) return []
    const { stdout } = await runHarnessCommand('opencode', ['models', '--verbose'], {
      cwd: projectPath,
      env: this.buildEnv(),
      timeoutMs: MODEL_DISCOVERY_TIMEOUT_MS,
      maxOutputBytes: 16 * 1024 * 1024
    })
    const rawProviders = new Map<string, Record<string, unknown>>()
    for (const model of parseOpenCodeModels(stdout)) {
      const providerId = stringValue(model['providerID'])
      const modelId = stringValue(model['id'])
      if (!providerId || !modelId) continue
      const provider = rawProviders.get(providerId) ?? {
        id: providerId,
        name: providerId,
        models: {}
      }
      const models = recordValue(provider['models']) ?? {}
      models[modelId] = model
      provider['models'] = models
      rawProviders.set(providerId, provider)
    }
    const catalogs = [...rawProviders.values()]
      .map((provider) => mapOpenCodeProvider(provider))
      .filter((provider): provider is ProviderCatalog => provider !== null)
    if (!this.baseUrlProviders) return this.filterConnectedCatalogs(catalogs, connected)
    const customProviders = await this.baseUrlProviders.listEnabled(this.id)
    const customIds = new Set(customProviders.map((provider) => provider.id))
    const merged = catalogs.filter((catalog) => !customIds.has(catalog.id))
    for (const custom of customProviders) {
      merged.push({
        id: custom.id,
        name: custom.name,
        harnessId: this.id,
        models: custom.models.map((model) => ({
          id: model.id,
          providerId: custom.id,
          name: model.name,
          reasoning: model.reasoning,
          thinkingPresets: model.thinkingPresets,
          // Custom providers expose no capability data; use the user-declared
          // vision flag and default to vision-capable so a custom vision model
          // is never wrongly hidden or gated.
          attachment: model.vision !== false,
          toolcall: true,
          contextWindow: model.contextWindow,
          fastSupported: false
        }))
      })
    }
    return this.filterConnectedCatalogs(merged, connected)
  }

  /**
   * The providers the user is actually connected to, keyed by the same provider
   * ids `opencode models` reports: credentials in opencode's auth store
   * (`auth.json`   OAuth logins and stored API keys), providers configured in
   * `~/.config/opencode/opencode.json` (custom base URLs and keyless local
   * servers alike), and CodeInOven-managed base-URL providers injected through
   * the discovery overlay. Returns `null` when the connected set cannot be
   * determined reliably   callers then keep the catalog unfiltered rather than
   * wrongly hiding every provider behind a transient read failure.
   */
  private async connectedProviderIds(): Promise<Set<string> | null> {
    const overlay = this.baseUrlProviders
      ? await this.baseUrlProviders.listEnabled(this.id).catch(() => null)
      : []
    const nativeIds = await opencodeNativeProviderIds()
    const authIds = await this.authCredentialIds()
    if (overlay === null || nativeIds === null || authIds === null) return null
    const connected = new Set<string>([...authIds, ...nativeIds])
    for (const provider of overlay) connected.add(provider.id)
    return connected
  }

  /**
   * Credential ids held in opencode's auth store. `auth.json` is a record keyed
   * by provider id. A missing store simply means no credentials; one that is
   * present but unreadable or corrupt returns `null` so callers keep their
   * catalog unfiltered rather than hiding every provider.
   */
  private async authCredentialIds(): Promise<Set<string> | null> {
    const environment = this.buildEnv()
    for (const path of openCodeAuthPaths(environment)) {
      let raw: string
      try {
        raw = await readFile(path, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        return null
      }
      try {
        const auth = recordValue(JSON.parse(raw))
        return new Set(auth ? Object.keys(auth) : [])
      } catch {
        return null
      }
    }
    return new Set()
  }

  private filterConnectedCatalogs(
    catalogs: ProviderCatalog[],
    connected: Set<string> | null
  ): ProviderCatalog[] {
    if (connected === null) return catalogs
    return catalogs.filter((catalog) => connected.has(catalog.id))
  }

  /** Cheap staleness signature of the connected-provider set; see the interface contract. */
  async providerCatalogFingerprint(): Promise<string | null> {
    const connected = await this.connectedProviderIds()
    if (connected === null) return null
    const overlay = this.baseUrlProviders
      ? await this.baseUrlProviders.listEnabled(this.id).catch(() => [])
      : []
    const overlayModels = overlay
      .map((provider) => `${provider.id}=${provider.models.map((model) => model.id).join(',')}`)
      .sort()
      .join('|')
    return JSON.stringify([[...connected].sort(), overlayModels])
  }

  async listCommands(projectPath: string): Promise<HarnessCommand[]> {
    const handle = await this.ensureServer(projectPath)
    const res = await fetch(`${handle.baseUrl}/command`, { headers: this.headersFor(handle) })
    if (!res.ok) return []
    const data = (await res.json()) as Array<Record<string, unknown>>
    return data
      .map((c) => ({
        name: (c['name'] as string) ?? '',
        description: c['description'] as string | undefined,
        source: c['source'] as HarnessCommand['source']
      }))
      .filter((c) => c.name)
  }

  async listTools(
    projectPath: string,
    providerId: string,
    modelId: string
  ): Promise<HarnessToolDefinition[]> {
    const handle = await this.ensureServer(projectPath)
    const url = new URL(`${handle.baseUrl}/experimental/tool`)
    url.searchParams.set('provider', providerId)
    url.searchParams.set('model', modelId)
    url.searchParams.set('directory', projectPath)
    const res = await fetch(url, { headers: this.headersFor(handle) })
    if (!res.ok) {
      throw await errorFromResponse(res, 'Failed to list agent tools')
    }
    const data = (await res.json()) as Array<Record<string, unknown>>
    return data
      .map((item) => ({
        name: stringValue(item['id']) ?? '',
        description: stringValue(item['description']) ?? '',
        inputSchema: recordValue(item['parameters']) ?? {}
      }))
      .filter((tool) => tool.name)
  }

  /** Fetch OpenCode Go's account-wide quota windows without starting a model turn. */
  async readAccountUsage(
    _projectPath: string
  ): Promise<{ rateLimits: AgentRateLimitWindow[] } | null> {
    void _projectPath
    if (this.accountUsageRequest) return this.accountUsageRequest
    const request = this.fetchAccountUsage()
    this.accountUsageRequest = request
    try {
      return await request
    } finally {
      if (this.accountUsageRequest === request) this.accountUsageRequest = null
    }
  }

  private async fetchAccountUsage(): Promise<{ rateLimits: AgentRateLimitWindow[] } | null> {
    try {
      const apiKey = await this.readOpenCodeApiKey()
      if (!apiKey) return null
      const response = await fetch(OPENCODE_ACCOUNT_USAGE_ENDPOINT, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(ACCOUNT_USAGE_TIMEOUT_MS)
      })
      // A valid Zen key may not belong to an OpenCode Go subscription. Treat
      // both missing access and missing entitlement as unsupported telemetry.
      if (response.status === 401 || response.status === 403) return null
      if (!response.ok) throw new Error(`OpenCode usage request failed (${response.status})`)
      const rateLimits = mapOpenCodeAccountUsage((await response.json()) as unknown)
      return rateLimits.length > 0 ? { rateLimits } : null
    } catch (error) {
      Logger.dev('OpenCode on-demand account usage refresh unavailable:', error)
      return null
    }
  }

  private async readOpenCodeApiKey(): Promise<string | undefined> {
    const environment = this.buildEnv()
    const environmentKey = stringValue(environment['OPENCODE_API_KEY'])
    if (environmentKey) return environmentKey

    const authContent = stringValue(environment['OPENCODE_AUTH_CONTENT'])
    if (authContent) {
      try {
        const key = apiKeyFromOpenCodeAuth(JSON.parse(authContent) as unknown)
        if (key) return key
      } catch {
        // Fall back to OpenCode's persisted auth file.
      }
    }

    for (const path of openCodeAuthPaths(environment)) {
      try {
        const key = apiKeyFromOpenCodeAuth(JSON.parse(await readFile(path, 'utf8')) as unknown)
        if (key) return key
      } catch {
        // OpenCode may not use this platform-specific data path.
      }
    }
    return undefined
  }

  async runCommand(
    projectPath: string,
    sessionId: string,
    command: HarnessCommand,
    args: string,
    _settings: ThreadSettings
  ): Promise<void> {
    void _settings
    const handle = this.turnServers.get(sessionId) ?? (await this.ensureServer(projectPath))
    const res = await fetch(`${handle.baseUrl}/session/${sessionId}/command`, {
      method: 'POST',
      headers: this.headersFor(handle, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ command: command.name, arguments: args })
    })
    if (!res.ok) throw await errorFromResponse(res, 'Failed to run command')
  }

  async compactSession(
    projectPath: string,
    sessionId: string,
    settings: ThreadSettings
  ): Promise<void> {
    // Manual compaction is available only after the turn becomes idle. At that
    // boundary the per-turn server is being torn down, so reusing it races the
    // cleanup that follows OpenCode's idle event. Use the stable project server
    // for maintenance requests instead of sending them to a dying process.
    const handle = await this.ensureServer(projectPath)
    const res = await fetch(`${handle.baseUrl}/session/${sessionId}/summarize`, {
      method: 'POST',
      headers: this.headersFor(handle, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        providerID: settings.providerId,
        modelID: settings.modelId,
        auto: false
      })
    })
    if (!res.ok) {
      throw await errorFromResponse(res, 'Failed to compact session')
    }
    const accepted = (await res.json()) as unknown
    if (accepted !== true) {
      throw new Error('OpenCode did not accept the manual compaction request')
    }
  }

  async replyPermission(
    projectPath: string,
    requestId: string,
    reply: PermissionReply,
    message?: string,
    sessionId?: string
  ): Promise<void> {
    const handle =
      (sessionId ? this.turnServers.get(sessionId) : undefined) ??
      (await this.ensureServer(projectPath))
    try {
      const res = await fetch(`${handle.baseUrl}/permission/${requestId}/reply`, {
        method: 'POST',
        headers: this.headersFor(handle, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ reply, ...(message !== undefined ? { message } : {}) })
      })
      if (!res.ok) Logger.error(`permission reply rejected (${res.status})`)
    } catch (error) {
      Logger.error('permission reply failed:', error)
    }
  }

  async replyToQuestion(
    projectPath: string,
    sessionId: string,
    requestId: string,
    answers: string[][]
  ): Promise<void> {
    const handle = this.turnServers.get(sessionId) ?? (await this.ensureServer(projectPath))
    const res = await fetch(`${handle.baseUrl}/question/${encodeURIComponent(requestId)}/reply`, {
      method: 'POST',
      headers: this.headersFor(handle, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ answers })
    })
    if (!res.ok) {
      throw await this.questionReplyError(res, 'Failed to answer question', sessionId, requestId)
    }
  }

  async rejectQuestion(projectPath: string, sessionId: string, requestId: string): Promise<void> {
    const handle = this.turnServers.get(sessionId) ?? (await this.ensureServer(projectPath))
    const res = await fetch(`${handle.baseUrl}/question/${encodeURIComponent(requestId)}/reject`, {
      method: 'POST',
      headers: this.headersFor(handle)
    })
    if (!res.ok) {
      throw await this.questionReplyError(res, 'Failed to dismiss question', sessionId, requestId)
    }
  }

  /**
   * Translate a failed question reply/reject into the error the chat engine
   * understands. A question the server no longer holds (its owning
   * `opencode serve` process is gone) becomes `QuestionRequestGoneError`, the
   * same condition every other harness reports through its own bookkeeping, so
   * the engine closes the stale card and clears the pending request instead of
   * surfacing an IPC failure the user can never clear. Everything else keeps
   * throwing the real transport error.
   */
  private async questionReplyError(
    res: Response,
    fallback: string,
    sessionId: string,
    requestId: string
  ): Promise<Error> {
    const failure = await questionReplyFailure(res, fallback)
    if (!failure.gone) return failure.error
    Logger.dev(
      `opencode no longer holds question ${requestId} for session ${sessionId}: ${failure.detail}`
    )
    return new QuestionRequestGoneError(sessionId, requestId, this.name)
  }

  /**
   * Reuse-only poll: pending questions live in a running server's memory, so
   * spawning a fresh `opencode serve` could never surface them   it would only
   * boot the full harness. The thread mount calls this on every startup for
   * reconnect recovery, so collect the handles that already exist (pooled +
   * per-turn) and never start one here; a server spawned for real work gets
   * picked up by the next poll or the SSE stream.
   */
  async listPendingQuestions(projectPath: string): Promise<AgentQuestionRequest[]> {
    const pooled = this.server ? this.scopedHandle(this.server, projectPath) : null
    const handles = [
      ...(pooled ? [pooled] : []),
      ...[...this.turnServers.values()].filter((handle) => handle.projectPath === projectPath)
    ]
    if (handles.length === 0) return []
    const pending = await Promise.all(
      handles.map(async (handle) => {
        const response = await fetch(`${handle.baseUrl}/question`, {
          headers: this.headersFor(handle)
        })
        if (!response.ok) {
          throw await errorFromResponse(response, 'Failed to list pending questions')
        }
        const raw = (await response.json()) as unknown
        if (!Array.isArray(raw)) return []
        return raw
          .map((request) => mapOpenCodeQuestionRequest(request))
          .filter((request): request is AgentQuestionRequest => request !== null)
      })
    )
    return [
      ...new Map(pending.flat().map((request) => [request.requestId, request] as const)).values()
    ]
  }

  dispose(): void {
    if (this.idleSweepTimer) {
      clearInterval(this.idleSweepTimer)
      this.idleSweepTimer = null
    }
    this.lastServerTrafficAt.clear()
    this.lastSessionActivityAt.clear()
    for (const controller of this.projectSubscriptions.values()) controller.abort()
    this.projectSubscriptions.clear()
    this.server?.abortController.abort()
    this.server?.process.kill()
    this.server = null
    this.starting = null
    this.activeSessions.clear()
    for (const handle of this.turnServers.values()) {
      handle.abortController.abort()
      handle.process.kill()
    }
    this.turnServers.clear()
    for (const handle of this.isolatedServers) {
      handle.abortController.abort()
      handle.process.kill()
    }
    this.isolatedServers.clear()
    this.titleSessions.clear()
    this.turnStarting.clear()
    for (const runtime of this.utilityRuntimes.values()) {
      void runtime.cleanup().catch((error) => {
        Logger.error('OpenCode utility runtime cleanup failed:', error)
      })
    }
    this.utilityRuntimes.clear()
    this.eventCallback = null
  }

  // ─── Server pool ──────────────────────────────────────────────────────────

  private async ensureServer(projectPath: string): Promise<ServerHandle> {
    if (this.server) {
      this.ensureProjectSubscription(this.server, projectPath)
      return this.scopedHandle(this.server, projectPath)
    }
    if (this.starting) {
      const handle = await this.starting
      this.ensureProjectSubscription(handle, projectPath)
      return this.scopedHandle(handle, projectPath)
    }

    const promise = this.startServer(projectPath)
    this.starting = promise
    try {
      const handle = await promise
      this.server = handle
      this.ensureProjectSubscription(handle, projectPath)
      return this.scopedHandle(handle, projectPath)
    } finally {
      if (this.starting === promise) this.starting = null
    }
  }

  private scopedHandle(handle: ServerHandle, projectPath: string): ServerHandle {
    return handle.projectPath === projectPath ? handle : { ...handle, projectPath }
  }

  private headersFor(
    handle: ServerHandle,
    headers: Record<string, string> = {}
  ): Record<string, string> {
    this.noteServerTraffic(handle.port)
    const directory = [...handle.projectPath].some((character) => character.codePointAt(0)! > 127)
      ? encodeURIComponent(handle.projectPath)
      : handle.projectPath
    return { ...headers, 'x-opencode-directory': directory }
  }

  private ensureProjectSubscription(handle: ServerHandle, projectPath: string): void {
    if (this.projectSubscriptions.has(projectPath)) return
    const controller = new AbortController()
    this.projectSubscriptions.set(projectPath, controller)
    this.subscribeEvents(this.scopedHandle(handle, projectPath), controller.signal)
  }

  private async ensureTurnServer(
    projectPath: string,
    sessionId: string,
    providerId: string
  ): Promise<ServerHandle> {
    const sourceRuntime = this.utilityRuntimes.get(sessionId)
    const runtime = sourceRuntime
      ? await this.runtimeForProvider(sourceRuntime, providerId)
      : undefined
    const existing = this.turnServers.get(sessionId)
    if (existing?.runtimeId === (runtime?.id ?? null)) return existing
    if (existing) await this.stopTurnServer(sessionId)
    const pending = this.turnStarting.get(sessionId)
    if (pending) return pending

    const promise = this.startIsolatedServer(projectPath, runtime)
    this.turnStarting.set(sessionId, promise)
    try {
      const handle = await promise
      if (sourceRuntime && this.utilityRuntimes.get(sessionId)?.id !== sourceRuntime.id) {
        handle.abortController.abort()
        handle.process.kill()
        throw new Error('Utility runtime was released before the turn server became ready')
      }
      this.turnServers.set(sessionId, handle)
      this.processObserver?.watchProcess(
        sessionId,
        handle.process.pid,
        'opencode serve',
        projectPath
      )
      handle.process.once('exit', () => {
        if (this.turnServers.get(sessionId) === handle) this.turnServers.delete(sessionId)
      })
      return handle
    } finally {
      if (this.turnStarting.get(sessionId) === promise) this.turnStarting.delete(sessionId)
    }
  }

  /**
   * OpenCode validates every provider in OPENCODE_CONFIG_CONTENT at startup.
   * Keep utility-provided entries, but expose only the custom provider selected
   * for this turn so a broken unrelated provider cannot block prompt sending.
   */
  private async runtimeForProvider(
    runtime: PreparedUtilityRuntime,
    selectedProviderId: string
  ): Promise<PreparedUtilityRuntime> {
    if (!this.baseUrlProviders) return runtime
    const customProviders = (await this.baseUrlProviders.listProviders()).filter(
      (provider) => provider.harnessId === this.id
    )
    return narrowOpenCodeRuntimeForProvider(runtime, selectedProviderId, customProviders)
  }

  private async stopTurnServer(sessionId: string): Promise<void> {
    const pending = this.turnStarting.get(sessionId)
    if (pending) {
      try {
        const pendingHandle = await pending
        pendingHandle.abortController.abort()
        pendingHandle.process.kill()
      } catch {
        // A failed start has no live server to stop.
      }
      if (this.turnStarting.get(sessionId) === pending) this.turnStarting.delete(sessionId)
    }
    const handle = this.turnServers.get(sessionId)
    if (!handle) return
    handle.abortController.abort()
    handle.process.kill()
    this.turnServers.delete(sessionId)
  }

  /** Spawn a dedicated `opencode serve` process independent of the project pool. */
  private async startIsolatedServer(
    projectPath: string,
    runtime?: PreparedUtilityRuntime
  ): Promise<Omit<IsolatedHandle, 'sessionId'>> {
    // Temporary chats, title generation, and other disposable work bypass the
    // shared server. Give those fresh servers the same app-managed agent and
    // provider overlay as the shared server, otherwise prompts that select a
    // lean agent (for example `cio-eph`) fail before creating the user message.
    const overlay = runtime
      ? undefined
      : await this.prepareUtilityRuntime({ projectPath, resolvedUtilities: [] })
    const args = [
      'serve',
      '--port',
      '0',
      '--hostname',
      '127.0.0.1',
      ...(runtime?.args ?? overlay?.args ?? [])
    ]
    const env = runtime
      ? this.buildEnv(runtime)
      : buildProcessEnvironment({
          ...process.env,
          ...this.accountEnvironment,
          ...(overlay?.env ?? {})
        })
    const prepared = await prepareHarnessInvocation('opencode', args, { cwd: projectPath, env })

    return new Promise((resolve, reject) => {
      const child = spawn(prepared.command, prepared.args, {
        ...(prepared.cwd ? { cwd: prepared.cwd } : {}),
        env: prepared.env,
        shell: prepared.shell,
        stdio: ['ignore', 'pipe', 'pipe']
      })

      let buffer = ''
      let settled = false
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          child.kill()
          reject(new Error('Timed out waiting for isolated opencode server to start'))
        }
      }, SERVER_START_TIMEOUT_MS)

      child.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString()
        const match = buffer.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)
        if (match && !settled) {
          settled = true
          clearTimeout(timer)
          const port = parseInt(match[1] ?? '', 10)
          const handle: Omit<IsolatedHandle, 'sessionId'> = {
            projectPath,
            runtimeId: runtime?.id ?? null,
            port,
            baseUrl: `http://127.0.0.1:${port}`,
            process: child,
            abortController: new AbortController()
          }
          // The terminal's interrupt reaches the whole foreground process
          // group in development, so OpenCode may exit before Electron's
          // graceful disposal reaches this handle. Tie the SSE subscription
          // to the child lifecycle itself; otherwise its reconnect timer keeps
          // the Electron process alive after the server has gone away.
          child.once('exit', () => handle.abortController.abort())
          Logger.dev(`isolated opencode server up for ${projectPath} on :${port}`)
          this.subscribeEvents(handle)
          resolve(handle)
        }
      })

      child.stderr?.on('data', (chunk: Buffer) => {
        Logger.dev(`isolated opencode[${projectPath}]`, chunk.toString().trim())
      })

      child.on('error', (error) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(error)
        }
      })

      child.on('exit', (code) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(new Error(`isolated opencode exited before announcing a port (code ${code})`))
        }
      })
    })
  }

  /** Spawn the application-wide `opencode serve` host and wait for its port. */
  private async startServer(projectPath: string): Promise<ServerHandle> {
    const providerOverlay = await this.prepareUtilityRuntime({
      projectPath,
      resolvedUtilities: []
    })
    const args = ['serve', '--port', '0', '--hostname', '127.0.0.1']
    const prepared = await prepareHarnessInvocation('opencode', args, {
      cwd: projectPath,
      env: buildProcessEnvironment({
        ...process.env,
        ...this.accountEnvironment,
        ...(providerOverlay.env ?? {})
      })
    })
    return new Promise((resolve, reject) => {
      const child = spawn(prepared.command, prepared.args, {
        ...(prepared.cwd ? { cwd: prepared.cwd } : {}),
        env: prepared.env,
        shell: prepared.shell,
        stdio: ['ignore', 'pipe', 'pipe']
      })

      let buffer = ''
      let settled = false
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          child.kill()
          reject(new Error('Timed out waiting for opencode server to start'))
        }
      }, SERVER_START_TIMEOUT_MS)

      child.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString()
        const match = buffer.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)
        if (match && !settled) {
          settled = true
          clearTimeout(timer)
          const port = parseInt(match[1] ?? '', 10)
          const handle: ServerHandle = {
            projectPath,
            runtimeId: null,
            port,
            baseUrl: `http://127.0.0.1:${port}`,
            process: child,
            abortController: new AbortController()
          }
          Logger.dev(`shared opencode server up on :${port}`)
          this.processObserver?.watchProcess(undefined, child.pid, 'opencode serve', projectPath)
          resolve(handle)
        }
      })

      child.stderr?.on('data', (chunk: Buffer) => {
        Logger.dev(`opencode[${projectPath}]`, chunk.toString().trim())
      })

      child.on('error', (error) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(error)
        }
      })

      child.on('exit', (code) => {
        if (this.server?.process === child) {
          this.server.abortController.abort()
          this.server = null
          for (const controller of this.projectSubscriptions.values()) controller.abort()
          this.projectSubscriptions.clear()
        }
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(new Error(`opencode exited before announcing a port (code ${code})`))
        }
      })
    })
  }

  /** GUI apps don't inherit the shell PATH   augment with common install locations. */
  private buildEnv(runtime?: PreparedUtilityRuntime): NodeJS.ProcessEnv {
    if (!runtime) {
      return buildProcessEnvironment({ ...process.env, ...this.accountEnvironment })
    }

    const configPath =
      runtime.configPaths['OPENCODE_CONFIG'] ??
      runtime.configPaths['opencode-config'] ??
      runtime.configPaths['config']
    const skillPath =
      runtime.configPaths['OPENCODE_CONFIG_DIR'] ??
      runtime.configPaths['opencode-skills'] ??
      runtime.configPaths['skills']
    return buildProcessEnvironment({
      ...process.env,
      ...this.accountEnvironment,
      ...(configPath ? { OPENCODE_CONFIG: configPath } : {}),
      ...(skillPath ? { OPENCODE_CONFIG_DIR: skillPath } : {}),
      ...runtime.env
    })
  }

  /** Release project resources after the app's genuine-inactivity watchdog fires. */
  async releaseProjectResources(projectPath: string): Promise<void> {
    await this.stopProjectServers(projectPath)
    this.stopSharedServerIfIdle()
  }

  private stopSharedServerIfIdle(): void {
    if (
      this.activeSessions.size > 0 ||
      this.turnServers.size > 0 ||
      this.isolatedServers.size > 0
    ) {
      return
    }
    const server = this.server
    if (!server) return
    for (const controller of this.projectSubscriptions.values()) controller.abort()
    this.projectSubscriptions.clear()
    server.abortController.abort()
    if (!server.process.killed) server.process.kill()
    this.server = null
  }

  private async stopProjectServers(projectPath: string): Promise<void> {
    this.projectSubscriptions.get(projectPath)?.abort()
    this.projectSubscriptions.delete(projectPath)
    for (const isolated of this.isolatedServers) {
      if (isolated.projectPath !== projectPath) continue
      this.disposeIsolatedSession(isolated)
    }
    for (const [sessionId, turn] of this.turnServers) {
      if (turn.projectPath !== projectPath) continue
      await this.stopTurnServer(sessionId)
    }
  }

  // ─── Event stream ─────────────────────────────────────────────────────────

  /** Subscribe to the server's SSE bus and forward events, reconnecting on drops. */
  private subscribeEvents(
    handle: ServerHandle,
    signal: AbortSignal = handle.abortController.signal
  ): void {
    void (async () => {
      while (!signal.aborted) {
        try {
          const res = await fetch(`${handle.baseUrl}/event`, {
            signal,
            headers: this.headersFor(handle, { Accept: 'text/event-stream' })
          })
          if (!res.ok || !res.body) break
          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let sseBuffer = ''
          for (;;) {
            const { done, value } = await reader.read()
            if (done || signal.aborted) break
            // Streaming turns issue no HTTP requests of their own; incoming
            // frames are their heartbeat against the idle reaper.
            this.noteServerTraffic(handle.port)
            sseBuffer += decoder.decode(value, { stream: true })
            let separator: number
            while ((separator = sseBuffer.indexOf('\n\n')) !== -1) {
              const frame = sseBuffer.slice(0, separator)
              sseBuffer = sseBuffer.slice(separator + 2)
              this.handleSseFrame(frame)
            }
          }
        } catch (error) {
          if (signal.aborted) break
          Logger.dev('SSE connection dropped, reconnecting:', error)
          await new Promise((resolve) => setTimeout(resolve, SSE_RECONNECT_MS))
        }
      }
    })()
  }

  /** Parse a single SSE frame and route its `data:` payload. */
  private handleSseFrame(frame: string): void {
    const dataLines = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
    if (dataLines.length === 0) return

    let event: { type?: string; properties?: Record<string, unknown> }
    try {
      event = JSON.parse(dataLines.join('\n')) as {
        type?: string
        properties?: Record<string, unknown>
      }
    } catch {
      return
    }
    if (!event.type || !event.properties) return
    this.routeEvent(event.type, event.properties)
  }

  /** Map an opencode bus event onto an AgentEvent and emit it. */
  private routeEvent(type: string, props: Record<string, unknown>): void {
    if (type === 'message.updated') {
      const info = recordValue(props['info'])
      const id = stringValue(info?.['id'])
      const role = info?.['role']
      if (id && (role === 'user' || role === 'assistant')) {
        this.messageRoles.set(id, role)
      }
    }
    for (const event of mapOpenCodeEvent(type, props)) {
      this.noteSessionActivity('sessionId' in event ? event.sessionId : undefined)
      if (
        event.type === 'session.idle' ||
        (event.type === 'session.status' &&
          (event.status.state === 'idle' || event.status.state === 'error')) ||
        event.type === 'session.error'
      ) {
        this.activeSessions.delete(event.sessionId)
      }
      const messageId =
        event.type === 'message.part.updated'
          ? event.part.messageID
          : event.type === 'message.part.delta'
            ? event.messageId
            : undefined
      if (messageId && this.messageRoles.get(messageId) === 'user') {
        if (event.type === 'message.part.delta') continue
        if (
          event.type === 'message.part.updated' &&
          event.part.type !== 'compaction' &&
          event.part.type !== 'subagent'
        ) {
          continue
        }
      }
      this.emit(event)
    }
  }

  private emit(event: AgentEvent): void {
    if ('sessionId' in event && this.titleSessions.has(event.sessionId)) {
      // Title sessions are private utility work. Completion is read from the
      // isolated transcript so a fast response cannot race SSE subscription.
      return
    }
    this.eventCallback?.(event)
  }

  private async waitForTitleResult(
    handle: IsolatedHandle,
    timeoutMs: number = TITLE_GENERATION_TIMEOUT_MS
  ): Promise<string | null> {
    const deadline = Date.now() + timeoutMs
    let lastReadError: Error | null = null
    while (Date.now() < deadline) {
      if (
        handle.abortController.signal.aborted ||
        handle.process.exitCode !== null ||
        handle.process.signalCode !== null
      ) {
        throw new Error(
          `OpenCode title process exited (${handle.process.exitCode ?? handle.process.signalCode ?? 'aborted'})`
        )
      }
      let messages: AgentMessage[]
      try {
        messages = await this.fetchMessages(handle, handle.sessionId)
        lastReadError = null
      } catch (error) {
        lastReadError = error instanceof Error ? error : new Error('Title transcript read failed')
        await new Promise((resolve) => setTimeout(resolve, TITLE_RESULT_POLL_INTERVAL_MS))
        continue
      }
      const response = [...messages].reverse().find((message) => message.role === 'assistant')
      if (response?.error) throw new Error(response.error)
      if (response?.completedAt !== undefined) {
        const raw = response.parts
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n')
        return raw ? sanitizeGeneratedTitle(raw) : null
      }
      await new Promise((resolve) => setTimeout(resolve, TITLE_RESULT_POLL_INTERVAL_MS))
    }
    throw lastReadError ?? new Error('OpenCode auxiliary completion timed out')
  }

  // ─── Wire-format mapping ──────────────────────────────────────────────────

  private async fetchMessages(handle: ServerHandle, sessionId: string): Promise<AgentMessage[]> {
    const res = await fetch(`${handle.baseUrl}/session/${sessionId}/message`, {
      headers: this.headersFor(handle)
    })
    if (!res.ok) throw await errorFromResponse(res, 'Failed to load messages')
    const raw = (await res.json()) as Array<{
      info: Record<string, unknown>
      parts: Array<Record<string, unknown>>
    }>
    return raw
      .map((entry) => mapOpenCodeMessage(entry.info, entry.parts))
      .filter((message): message is AgentMessage => message !== null)
  }
}
