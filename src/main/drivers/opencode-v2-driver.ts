import type { ChildProcess } from 'node:child_process'
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
  PreparedUtilityRuntime,
  SendHeartbeatPingOptions,
  SendPromptOptions,
  SteerPromptOptions,
  UtilityRuntimeOverlay,
  UtilityRuntimePreparationRequest
} from './driver.interface'
import type { IsolatedSessionDriver, IsolatedSessionHandle } from './isolated-session'
import { Logger } from '../system/logger'
import { buildProcessEnvironment } from './cli-environment'
import { runHarnessCommand } from './harness-runtime'
import { BaseUrlProviderService } from '../providers/base-url-provider-service'
import { SecretVault } from '../storage/secret-vault'
import { buildTitlePrompt, HEARTBEAT_PROMPT, sanitizeGeneratedTitle } from '../chat/title-generator'
import { buildRankingGradePrompt, parseRankingGrade } from '../chat/turn-grader-prompt'
import {
  OpenCodeV2Client,
  OpenCodeV2RequestError,
  parseOpenCodeV2SseFrame,
  splitOpenCodeV2SseBuffer,
  type OpenCodeV2SseEvent
} from '../opencode-v2/opencode-v2-client'
import {
  startOpenCodeV2Server,
  type OpenCodeV2ServerHandle
} from '../opencode-v2/opencode-v2-server'
import { OPENCODE_COMMAND } from '../../lib/opencode-version'
import {
  mapOpenCodeV2Catalogs,
  mapOpenCodeV2Commands,
  openCodeV2ModelVariants
} from './opencode-v2/v2-catalog'
import {
  eventSessionId,
  mapOpenCodeV2Event,
  type OpenCodeV2EventContext
} from './opencode-v2/v2-events'
import { buildOpenCodeV2FormReply, mapOpenCodeV2PendingForms } from './opencode-v2/v2-forms'
import { isOpenCodeV2AbortError, openCodeV2Issue } from './opencode-v2/v2-issues'
import { mapOpenCodeV2Messages } from './opencode-v2/v2-messages'
import {
  buildOpenCodeV2ModelRef,
  buildOpenCodeV2PermissionRuleset,
  buildOpenCodeV2PromptBody,
  buildOpenCodeV2PromptPayload,
  buildOpenCodeV2SyntheticBody,
  wrapOpenCodeV2SystemContext
} from './opencode-v2/v2-prompt'
import {
  narrowOpenCodeV2RuntimeForProvider,
  prepareOpenCodeV2UtilityRuntime
} from './opencode-v2/v2-utility-runtime'
import { recordValue, stringValue } from './opencode-v2/v2-values'

const MODEL_DISCOVERY_TIMEOUT_MS = 30_000
/**
 * How long a freshly spawned server gets to publish its catalog.
 *
 * V2 boots its model and agent catalogs asynchronously: immediately after
 * `serve` starts, `/api/model` and `/api/agent` answer with empty lists. A read
 * taken in that window would show the user an empty model list, so a fresh
 * handle is polled until it settles (a warm handle is read once).
 */
const CATALOG_SETTLE_TIMEOUT_MS = 45_000
const CATALOG_POLL_INTERVAL_MS = 500
/**
 * Ceiling for a request that has to wait out the server's first boot.
 *
 * V2 boots a location (plugins, providers, catalogs) on its first request for
 * that directory, which takes tens of seconds; a prompt is only acknowledged
 * after its input is durably admitted, and admission waits for the same boot.
 * The default request timeout would abort a perfectly healthy first turn.
 */
const CATALOG_REQUEST_TIMEOUT_MS = 60_000
const ADMISSION_TIMEOUT_MS = 120_000
const SSE_RECONNECT_MS = 1_000
const TITLE_GENERATION_TIMEOUT_MS = 180_000
const TITLE_RESULT_POLL_INTERVAL_MS = 250
/**
 * Messages page size. V2 rejects a `limit` above 200 (`Expected a value less
 * than or equal to 200`), so a full transcript is read by following the cursor.
 */
const MESSAGE_PAGE_SIZE = 200
/** Hard cap on history pages, so a corrupt cursor cannot spin forever. */
const MESSAGE_PAGE_LIMIT = 20

interface ServerHandle {
  projectPath: string
  runtimeId: string | null
  /** Epoch ms the process was spawned, so a fresh catalog read can wait for it. */
  startedAt: number
  port: number
  baseUrl: string
  password: string
  client: OpenCodeV2Client
  process: ChildProcess
  /** Idempotent teardown of the spawned process (SIGTERM, then SIGKILL). */
  close(): Promise<void>
  /** Aborts the SSE subscription loop when the server is disposed. */
  abortController: AbortController
}

interface IsolatedHandle extends ServerHandle {
  sessionId: string
}

/**
 * Driver for OpenCode V2 (the `opencode` command, `@opencode/cli`).
 *
 * V2 shares a family with the V1 harness and almost nothing else: a different
 * HTTP surface under `/api/*` with Basic auth, prompts without model/agent/
 * system/tools fields, inline message parts, forms instead of an interactive
 * question tool, and `session.execution.*` as the only turn terminal. It is
 * therefore a separate driver rather than a mode of the V1 one, while the
 * process-pooling model (one shared server per app, one server per turn that
 * needs its own config, one per disposable session) is deliberately the same.
 */
export class OpenCodeV2Driver implements HarnessDriver, IsolatedSessionDriver {
  readonly id = 'opencode'
  readonly name = 'OpenCode'
  readonly capabilities: HarnessCapabilities = {
    runtimeTopology: { kind: 'shared_server', scope: 'application' },
    streaming: true,
    // V2 injects a mid-turn prompt at the next step boundary (`delivery`).
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
    // V2 reports a delegated child agent as a `subagent` tool call whose result
    // carries the child session id (`metadata.sessionID`), and announces the
    // child with a `session.created` event carrying a non-null `parentID`.
    subagents: true,
    // V2 has no JSON-schema output mode: both `generate` routes take only a
    // prompt and return text, so deterministic JSON flows must not target it.
    structuredOutput: false,
    nativeUtilities: ['web_fetch', 'web_search'],
    // Retries are not events in V2; they appear as `retry` on the message.
    scheduledRetry: false
  }

  private server: ServerHandle | null = null
  private starting: Promise<ServerHandle> | null = null
  private projectSubscriptions = new Map<string, AbortController>()
  private activeSessions = new Map<string, string>()
  private turnServers = new Map<string, ServerHandle>()
  private turnStarting = new Map<string, Promise<ServerHandle>>()
  private utilityRuntimes = new Map<string, PreparedUtilityRuntime>()
  private isolatedServers = new Map<string, IsolatedHandle>()
  /** Sessions owned by disposable auxiliary work; their events stay private. */
  private auxiliarySessions = new Set<string>()
  private eventCallback: AgentEventCallback | null = null
  private processObserver: AgentProcessObserver | null = null

  /** Assistant message the current step streams into, per session. */
  private assistantMessages = new Map<string, string>()
  /** Tool name by call id, per session (V2 tool results carry no name). */
  private toolNames = new Map<string, Map<string, string>>()
  /** The step's most recent structured error, used to enrich final failures. */
  private stepErrors = new Map<string, unknown>()
  /** Message id the in-flight compaction writes to, per session. */
  private compactionMessages = new Map<string, string>()
  /** Model variants a server+location offers, keyed `providerID/modelID`. */
  private modelVariants = new Map<string, Map<string, Set<string>>>()
  /** Session that owns a pending permission or form request. */
  private pendingRequests = new Map<string, string>()

  /**
   * Idle lifetimes for spawned `serve` processes. A V2 server holds a large
   * native runtime resident, so the reaper is the app's defense against leaked
   * processes after interrupted turns and restarts.
   */
  private static readonly TURN_SERVER_IDLE_TTL_MS = 10 * 60_000
  private static readonly ISOLATED_SERVER_IDLE_TTL_MS = 5 * 60_000
  private static readonly SHARED_SERVER_IDLE_TTL_MS = 10 * 60_000
  private static readonly IDLE_SWEEP_INTERVAL_MS = 60_000
  /** Matches ChatEngine.SILENT_WORK_GRACE_MS: a live turn is never reaped. */
  private static readonly SILENT_TURN_GRACE_MS = 30 * 60_000
  /** Entries silent past twice that grace are ghosts (no terminal event). */
  private static readonly GHOST_SESSION_TTL_MS = 60 * 60_000
  private lastServerTrafficAt = new Map<number, number>()
  private lastSessionActivityAt = new Map<string, number>()
  private idleSweepTimer: ReturnType<typeof setInterval> | null = null

  private accountUsageRequest: Promise<{ rateLimits: AgentRateLimitWindow[] } | null> | null = null

  constructor(
    private readonly baseUrlProviders?: BaseUrlProviderService,
    private readonly secretVault?: SecretVault,
    private readonly accountEnvironment: NodeJS.ProcessEnv = {},
    /** The probed OpenCode binary to spawn; V1 and V2 share one harness entry. */
    private readonly command: string = OPENCODE_COMMAND
  ) {}

  // ─── HarnessDriver interface ──────────────────────────────────────────────

  onEvent(callback: AgentEventCallback): void {
    this.eventCallback = callback
  }

  setProcessObserver(observer: AgentProcessObserver): void {
    this.processObserver = observer
  }

  async ensureReady(projectPath: string): Promise<void> {
    await runHarnessCommand(this.command, ['--version'], {
      cwd: projectPath,
      env: this.buildEnv(),
      timeoutMs: 10_000
    })
  }

  async prepareUtilityRuntime(
    request: UtilityRuntimePreparationRequest
  ): Promise<UtilityRuntimeOverlay> {
    return prepareOpenCodeV2UtilityRuntime(
      request,
      this.id,
      this.baseUrlProviders,
      this.secretVault
    )
  }

  async applyPreparedUtilityRuntime(
    _projectPath: string,
    runtime: PreparedUtilityRuntime | null,
    sessionId: string
  ): Promise<void> {
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
    return this.createSessionOnHandle(handle, projectPath, title)
  }

  /** Delete a session and any children it owns. */
  async deleteSession(projectPath: string, sessionId: string): Promise<void> {
    this.activeSessions.delete(sessionId)
    const turnHandle = this.turnServers.get(sessionId)
    const handle = turnHandle ?? (this.server ? this.scopedHandle(this.server, projectPath) : null)
    try {
      if (handle) {
        await this.deleteSessionOnHandle(handle, sessionId)
        return
      }
      await this.deleteSessionViaTransientServer(projectPath, sessionId)
    } finally {
      if (turnHandle) await this.stopTurnServer(sessionId)
      this.stopSharedServerIfIdle()
    }
  }

  private async createSessionOnHandle(
    handle: ServerHandle,
    projectPath: string,
    title: string
  ): Promise<string> {
    const response = await handle.client.json<{ data?: { id?: string } }>('/api/session', {
      method: 'POST',
      body: { title, location: { directory: projectPath } }
    })
    const id = stringValue(response?.data?.id)
    if (!id) throw new Error('OpenCode V2 did not return a session id')
    return id
  }

  private async deleteSessionOnHandle(handle: ServerHandle, sessionId: string): Promise<void> {
    try {
      await handle.client.json(`/api/session/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE'
      })
    } catch (error) {
      // An already-missing session counts as deleted.
      if (error instanceof OpenCodeV2RequestError && error.status === 404) return
      throw error
    }
  }

  /** Remove a persisted session through a short-lived private server. */
  private async deleteSessionViaTransientServer(
    projectPath: string,
    sessionId: string
  ): Promise<void> {
    let transient: IsolatedHandle | undefined
    try {
      const base = await this.startIsolatedServer(projectPath)
      transient = { ...base, sessionId }
      this.isolatedServers.set(sessionId, transient)
      transient.process.once('exit', () => {
        if (this.isolatedServers.get(sessionId) === transient) {
          this.isolatedServers.delete(sessionId)
        }
      })
      await this.deleteSessionOnHandle(transient, sessionId)
    } catch (error) {
      Logger.dev('Transient OpenCode V2 session deletion was incomplete:', error)
    } finally {
      if (transient) this.disposeIsolatedSession(transient)
    }
  }

  async sendPrompt(
    projectPath: string,
    opts: SendPromptOptions,
    isolated?: IsolatedSessionHandle
  ): Promise<void> {
    const handle =
      this.resolveIsolatedSession(isolated) ??
      (this.utilityRuntimes.has(opts.sessionId)
        ? await this.ensureTurnServer(projectPath, opts.sessionId, opts.settings.providerId)
        : await this.ensureServer(projectPath))

    this.activeSessions.set(opts.sessionId, projectPath)
    this.noteSessionActivity(opts.sessionId)
    try {
      // V2 scopes the model, the agent, and the permission ruleset to the
      // session, not to the prompt, so each turn re-states the settings it runs
      // under before delivering its input.
      await this.applyTurnSettings(handle, projectPath, opts)
      const payload = await buildOpenCodeV2PromptPayload(opts.text, opts.attachments)
      if (opts.systemPrompt) {
        // V2's prompt body has no `system` field. A synthetic inbox item parked
        // ahead of the prompt is the only channel for context the user did not
        // type, and `resume: false` keeps it from starting a loop of its own.
        await handle.client.json(`/api/session/${encodeURIComponent(opts.sessionId)}/synthetic`, {
          method: 'POST',
          body: buildOpenCodeV2SyntheticBody(wrapOpenCodeV2SystemContext(opts.systemPrompt)),
          timeoutMs: ADMISSION_TIMEOUT_MS
        })
      }
      await handle.client.json(`/api/session/${encodeURIComponent(opts.sessionId)}/prompt`, {
        method: 'POST',
        body: buildOpenCodeV2PromptBody({
          text: payload.text,
          files: payload.files,
          ...(opts.userMessageId ? { userMessageId: opts.userMessageId } : {}),
          delivery: 'steer'
        }),
        timeoutMs: ADMISSION_TIMEOUT_MS
      })
    } catch (error) {
      this.activeSessions.delete(opts.sessionId)
      throw error
    }
  }

  /** State the model, lean agent, and permission ruleset a turn runs under. */
  private async applyTurnSettings(
    handle: ServerHandle,
    projectPath: string,
    opts: SendPromptOptions
  ): Promise<void> {
    const sessionPath = `/api/session/${encodeURIComponent(opts.sessionId)}`
    const model = buildOpenCodeV2ModelRef(opts)
    if (model) {
      const variant = await this.validatedVariant(
        handle,
        projectPath,
        model.providerID,
        model.id,
        opts.settings.thinkingLevel
      )
      await handle.client.json(`${sessionPath}/model`, {
        method: 'POST',
        body: {
          model: variant ? { ...model, variant } : { id: model.id, providerID: model.providerID }
        }
      })
    }
    if (opts.agent) {
      await handle.client.json(`${sessionPath}/agent`, {
        method: 'POST',
        body: { agent: opts.agent }
      })
    }
    const permissions = buildOpenCodeV2PermissionRuleset(opts)
    await handle.client.json(sessionPath, { method: 'PATCH', body: { permissions } })
  }

  /**
   * The requested thinking level as a model variant, or `undefined` when the
   * model does not declare it.
   *
   * V2 silently accepts an unknown variant when a model is switched and only
   * fails at the next turn, so the model list is read once per server and
   * location and cached: an invented variant must never be sent.
   */
  private async validatedVariant(
    handle: ServerHandle,
    projectPath: string,
    providerId: string,
    modelId: string,
    thinkingLevel: ThreadSettings['thinkingLevel']
  ): Promise<string | undefined> {
    if (!thinkingLevel) return undefined
    const cacheKey = `${handle.baseUrl}|${projectPath}`
    let variants = this.modelVariants.get(cacheKey)
    if (!variants) {
      try {
        const payload = await handle.client.json(
          `/api/model?${handle.client.locationQuery(projectPath)}`
        )
        variants = openCodeV2ModelVariants(payload)
      } catch (error) {
        Logger.dev('OpenCode V2 model variant read failed:', error)
        variants = new Map()
      }
      this.modelVariants.set(cacheKey, variants)
    }
    return variants.get(`${providerId}/${modelId}`)?.has(thinkingLevel) ? thinkingLevel : undefined
  }

  /** Append input to the active turn; V2 delivers it at the next step boundary. */
  async steerPrompt(
    projectPath: string,
    opts: SteerPromptOptions,
    isolated?: IsolatedSessionHandle
  ): Promise<void> {
    const handle =
      this.resolveIsolatedSession(isolated) ??
      this.turnServers.get(opts.sessionId) ??
      (await this.ensureServer(projectPath))
    const payload = await buildOpenCodeV2PromptPayload(opts.text, opts.attachments)
    await handle.client.json(`/api/session/${encodeURIComponent(opts.sessionId)}/prompt`, {
      method: 'POST',
      body: buildOpenCodeV2PromptBody({
        text: payload.text,
        files: payload.files,
        ...(opts.userMessageId ? { userMessageId: opts.userMessageId } : {}),
        delivery: 'steer'
      }),
      timeoutMs: ADMISSION_TIMEOUT_MS
    })
  }

  /**
   * Whether the harness still has a live agent loop for a session.
   *
   * `GET /api/session/active` is the server's own running map, which is the only
   * honest answer for restart recovery: the driver's in-memory registration is
   * empty after an app restart even though the surviving server may still be
   * running the pre-restart turn.
   */
  async isSessionBusy(projectPath: string, sessionId: string): Promise<boolean> {
    let handle: ServerHandle
    try {
      handle = await this.ensureServer(projectPath)
    } catch {
      return false
    }
    try {
      const response = await handle.client.json<{ data?: Record<string, unknown> }>(
        '/api/session/active'
      )
      return recordValue(response?.data)?.[sessionId] !== undefined
    } catch {
      return false
    }
  }

  hasActiveTurn(sessionId: string): boolean {
    return this.activeSessions.has(sessionId)
  }

  async loadMessages(
    projectPath: string,
    sessionId: string,
    isolated?: IsolatedSessionHandle
  ): Promise<AgentMessage[]> {
    const isolatedHandle = this.resolveIsolatedSession(isolated)
    const turnHandle = isolatedHandle ? undefined : this.turnServers.get(sessionId)
    const handle = isolatedHandle ?? turnHandle ?? (await this.ensureServer(projectPath))
    try {
      return await this.fetchMessages(handle, sessionId)
    } catch (error) {
      // Utility cleanup deliberately kills the per-turn server after the
      // canonical mirror finishes, which terminates any other read already in
      // flight. Sessions persist outside that process, so retry once through
      // whichever transport owns the session now.
      if (!turnHandle || isolatedHandle || this.turnServers.get(sessionId) === turnHandle) {
        throw error
      }
      const replacement = this.turnServers.get(sessionId) ?? (await this.ensureServer(projectPath))
      return this.fetchMessages(replacement, sessionId)
    }
  }

  async abort(
    projectPath: string,
    sessionId: string,
    isolated?: IsolatedSessionHandle
  ): Promise<void> {
    const handle =
      this.resolveIsolatedSession(isolated) ??
      this.turnServers.get(sessionId) ??
      (await this.ensureServer(projectPath))
    try {
      await handle.client.json(`/api/session/${encodeURIComponent(sessionId)}/interrupt`, {
        method: 'POST',
        timeoutMs: 5_000
      })
    } catch (error) {
      Logger.dev('OpenCode V2 interrupt failed:', error)
    }
  }

  /**
   * Forcefully terminate the process backing a session. A session that has its
   * own turn or isolated server is killed outright; otherwise the shared server
   * is left alone and the turn is interrupted instead.
   */
  async terminate(projectPath: string, sessionId: string): Promise<void> {
    const isolated = this.isolatedServers.get(sessionId)
    if (isolated) {
      this.disposeIsolatedSession(isolated)
      return
    }
    const turn = this.turnServers.get(sessionId)
    if (turn) {
      await this.stopTurnServer(sessionId)
      return
    }
    await this.abort(projectPath, sessionId)
  }

  async runCommand(
    projectPath: string,
    sessionId: string,
    command: HarnessCommand,
    args: string
  ): Promise<void> {
    const handle = this.turnServers.get(sessionId) ?? (await this.ensureServer(projectPath))
    await handle.client.json(`/api/session/${encodeURIComponent(sessionId)}/command`, {
      method: 'POST',
      body: { name: command.name, text: args }
    })
  }

  async listCommands(projectPath: string): Promise<HarnessCommand[]> {
    const handle = await this.ensureServer(projectPath)
    const query = handle.client.locationQuery(projectPath)
    const settleBy = handle.startedAt + CATALOG_SETTLE_TIMEOUT_MS
    for (;;) {
      const response = await handle.client.json(`/api/command?${query}`, {
        timeoutMs: CATALOG_REQUEST_TIMEOUT_MS
      })
      const commands = mapOpenCodeV2Commands(response)
      if (commands.length > 0 || Date.now() >= settleBy) {
        return commands.map((command) => ({
          name: command.name,
          ...(command.description ? { description: command.description } : {}),
          source: 'command'
        }))
      }
      await new Promise((resolve) => setTimeout(resolve, CATALOG_POLL_INTERVAL_MS))
    }
  }

  async compactSession(
    projectPath: string,
    sessionId: string,
    _settings: ThreadSettings
  ): Promise<void> {
    // Manual compaction is only available once the turn is idle, which is
    // exactly when a per-turn server is being torn down. Use the stable project
    // server for this maintenance request instead of a dying process.
    const handle = await this.ensureServer(projectPath)
    await handle.client.json(`/api/session/${encodeURIComponent(sessionId)}/compact`, {
      method: 'POST',
      body: {},
      timeoutMs: ADMISSION_TIMEOUT_MS
    })
  }

  async replyPermission(
    projectPath: string,
    requestId: string,
    reply: PermissionReply,
    message?: string,
    sessionId?: string
  ): Promise<void> {
    const owner = sessionId ?? this.pendingRequests.get(requestId)
    if (!owner) {
      Logger.error(`OpenCode V2 permission ${requestId} has no known session to reply to`)
      return
    }
    const handle = this.turnServers.get(owner) ?? (await this.ensureServer(projectPath))
    try {
      await handle.client.json(
        `/api/session/${encodeURIComponent(owner)}/permission/${encodeURIComponent(requestId)}/reply`,
        {
          method: 'POST',
          body: { decision: reply, ...(message === undefined ? {} : { message }) }
        }
      )
      this.pendingRequests.delete(requestId)
    } catch (error) {
      Logger.error('OpenCode V2 permission reply failed:', error)
    }
  }

  async replyToQuestion(
    projectPath: string,
    sessionId: string,
    requestId: string,
    answers: string[][]
  ): Promise<void> {
    const handle = this.turnServers.get(sessionId) ?? (await this.ensureServer(projectPath))
    const sessionPath = `/api/session/${encodeURIComponent(sessionId)}`
    // V2 types every answer against its field, so the form's own definition has
    // to be read back before the reply can be expressed in the shape it wants.
    const detail = await handle.client.json(`${sessionPath}/form/${encodeURIComponent(requestId)}`)
    const form = recordValue(recordValue(detail)?.['data']) ?? recordValue(detail)
    await handle.client.json(`${sessionPath}/form/${encodeURIComponent(requestId)}/reply`, {
      method: 'POST',
      body: buildOpenCodeV2FormReply(form, answers)
    })
    this.pendingRequests.delete(requestId)
  }

  async rejectQuestion(projectPath: string, sessionId: string, requestId: string): Promise<void> {
    const handle = this.turnServers.get(sessionId) ?? (await this.ensureServer(projectPath))
    // V2 has no reject value: cancelling the form is what dismisses a question,
    // and the waiting tool then fails with "The user dismissed this question".
    await handle.client.json(
      `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(requestId)}`,
      { method: 'DELETE' }
    )
    this.pendingRequests.delete(requestId)
  }

  /**
   * Reuse-only poll of pending forms.
   *
   * A pending form lives in a running server's memory, so spawning a fresh one
   * could never surface it; only handles that already exist are queried.
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
        try {
          const response = await handle.client.json('/api/form')
          return mapOpenCodeV2PendingForms(response)
        } catch (error) {
          Logger.dev('OpenCode V2 pending form read failed:', error)
          return []
        }
      })
    )
    return [
      ...new Map(pending.flat().map((request) => [request.requestId, request] as const)).values()
    ]
  }

  async listProviders(projectPath: string): Promise<ProviderCatalog[]> {
    const handle = await this.ensureServer(projectPath)
    const catalogs = await this.readCatalogs(handle, projectPath)
    if (!this.baseUrlProviders) return catalogs
    const custom = await this.baseUrlProviders.listEnabled(this.id)
    if (custom.length === 0) return catalogs
    const customIds = new Set(custom.map((provider) => provider.id))
    const merged = catalogs.filter((catalog) => !customIds.has(catalog.id))
    for (const provider of custom) {
      merged.push({
        id: provider.id,
        name: provider.name,
        harnessId: this.id,
        models: provider.models.map((model) => ({
          id: model.id,
          providerId: provider.id,
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
    return merged
  }

  /**
   * Read the server's catalog, waiting out its asynchronous boot.
   *
   * Only a handle that was just spawned can be mid-boot, so the wait is bounded
   * by the handle's own age: a warm server answers with the first read, and an
   * empty catalog on a long-lived server is reported as empty instead of being
   * polled for a value that will never arrive.
   */
  private async readCatalogs(
    handle: ServerHandle,
    projectPath: string
  ): Promise<ProviderCatalog[]> {
    const query = handle.client.locationQuery(projectPath)
    const settleBy = handle.startedAt + CATALOG_SETTLE_TIMEOUT_MS
    for (;;) {
      const [models, providers] = await Promise.all([
        handle.client.json(`/api/model?${query}`, { timeoutMs: CATALOG_REQUEST_TIMEOUT_MS }),
        handle.client
          .json(`/api/provider?${query}`, { timeoutMs: CATALOG_REQUEST_TIMEOUT_MS })
          .catch(() => null)
      ])
      const catalogs = mapOpenCodeV2Catalogs(models, providers)
      if (catalogs.length > 0 || Date.now() >= settleBy) return catalogs
      await new Promise((resolve) => setTimeout(resolve, CATALOG_POLL_INTERVAL_MS))
    }
  }

  /**
   * Read the account's quota telemetry. V2 keeps credentials in its own SQLite
   * store and exposes no quota surface, and the V1 usage endpoint is V1-only, so
   * there is nothing honest to report.
   */
  async readAccountUsage(_projectPath: string): Promise<null> {
    return null
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
    for (const handle of this.isolatedServers.values()) {
      handle.abortController.abort()
      handle.process.kill()
    }
    this.isolatedServers.clear()
    this.auxiliarySessions.clear()
    this.turnStarting.clear()
    this.assistantMessages.clear()
    this.toolNames.clear()
    this.stepErrors.clear()
    this.compactionMessages.clear()
    this.modelVariants.clear()
    this.pendingRequests.clear()
    for (const runtime of this.utilityRuntimes.values()) {
      void runtime.cleanup().catch((error) => {
        Logger.error('OpenCode V2 utility runtime cleanup failed:', error)
      })
    }
    this.utilityRuntimes.clear()
    this.eventCallback = null
  }

  /** Release project resources after the app's inactivity watchdog fires. */
  async releaseProjectResources(projectPath: string): Promise<void> {
    this.projectSubscriptions.get(projectPath)?.abort()
    this.projectSubscriptions.delete(projectPath)
    for (const isolated of [...this.isolatedServers.values()]) {
      if (isolated.projectPath !== projectPath) continue
      this.disposeIsolatedSession(isolated)
    }
    for (const [sessionId, turn] of [...this.turnServers]) {
      if (turn.projectPath !== projectPath) continue
      await this.stopTurnServer(sessionId)
    }
    this.stopSharedServerIfIdle()
  }

  // ─── Auxiliary (disposable) work ──────────────────────────────────────────

  /** Big Pickle is the family's cheap auxiliary candidate. */
  private async cheapCandidates(): Promise<Array<{ providerId: string; modelId: string }>> {
    return [{ providerId: 'opencode', modelId: 'big-pickle' }]
  }

  async generateTitle(projectPath: string, options: GenerateTitleOptions): Promise<string | null> {
    const candidates = options.candidates ?? (await this.cheapCandidates())
    return this.isolatedOneShot(
      projectPath,
      options.settings,
      'Thread title',
      candidates,
      buildTitlePrompt(options.message.slice(0, 2_000))
    )
  }

  /** Ping the exact configured model: no cheap-candidate substitution. */
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

  async provideCheapModel(
    projectPath: string,
    request: CheapModelRequest
  ): Promise<CheapModelResult> {
    const candidates = request.candidates ?? (await this.cheapCandidates())
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
    const candidates = options.candidates ?? (await this.cheapCandidates())
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

  /** Run one auxiliary completion per candidate, each on its own server. */
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
        const result = await this.waitForAssistantText(isolated, isolated.sessionId, timeoutMs)
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
          `OpenCode V2 one-shot model ${candidate.providerId}/${candidate.modelId} unavailable:`,
          error
        )
      } finally {
        if (isolated) {
          this.auxiliarySessions.delete(isolated.sessionId)
          this.disposeIsolatedSession(isolated)
        }
      }
    }
    return null
  }

  /**
   * Create a session on a fresh, private server.
   *
   * Disposable work (titles, grading, transcription, temporary chats, the
   * engineering offshoots) must not queue behind, or block, the turn the user
   * is waiting on, so it gets its own transport that is torn down at the end.
   */
  async createIsolatedSession(projectPath: string, title: string): Promise<IsolatedHandle> {
    const handle = await this.startIsolatedServer(projectPath)
    try {
      const sessionId = await this.createSessionOnHandle(handle, projectPath, title)
      const isolated: IsolatedHandle = { ...handle, sessionId }
      this.isolatedServers.set(sessionId, isolated)
      isolated.process.once('exit', () => {
        if (this.isolatedServers.get(sessionId) === isolated) {
          this.isolatedServers.delete(sessionId)
        }
      })
      return isolated
    } catch (error) {
      handle.abortController.abort()
      handle.process.kill()
      throw error
    }
  }

  /** Delete the disposable session, then tear down its private server. */
  disposeIsolatedSession(handle: IsolatedSessionHandle): void {
    const isolated = this.resolveIsolatedSession(handle)
    if (!isolated) return
    this.isolatedServers.delete(isolated.sessionId)
    void this.deleteSessionOnHandle(isolated, isolated.sessionId)
      .catch((error) => Logger.dev('Isolated OpenCode V2 session cleanup was incomplete:', error))
      .finally(() => {
        isolated.abortController.abort()
        isolated.process.kill()
      })
  }

  private resolveIsolatedSession(
    handle: IsolatedSessionHandle | undefined
  ): IsolatedHandle | undefined {
    if (!handle) return undefined
    const isolated = this.isolatedServers.get(handle.sessionId)
    if (!isolated) {
      throw new Error(`No live isolated OpenCode V2 session for ${handle.sessionId}`)
    }
    return isolated
  }

  /**
   * Poll a disposable session until its assistant message completes.
   *
   * The auxiliary paths read the transcript rather than the event stream: an
   * auxiliary session's events are private, and a fast reply must not be able to
   * race the SSE subscription.
   */
  private async waitForAssistantText(
    handle: ServerHandle,
    sessionId: string,
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
          `OpenCode V2 auxiliary process exited (${handle.process.exitCode ?? handle.process.signalCode ?? 'aborted'})`
        )
      }
      try {
        const messages = await this.fetchMessages(handle, sessionId)
        lastReadError = null
        const response = [...messages].reverse().find((message) => message.role === 'assistant')
        if (response?.error) throw new Error(response.error)
        if (response?.completedAt !== undefined) {
          const text = response.parts
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('\n')
          return text ? sanitizeGeneratedTitle(text) : null
        }
      } catch (error) {
        lastReadError =
          error instanceof Error ? error : new Error('Auxiliary transcript read failed')
      }
      await new Promise((resolve) => setTimeout(resolve, TITLE_RESULT_POLL_INTERVAL_MS))
    }
    throw lastReadError ?? new Error('OpenCode V2 auxiliary completion timed out')
  }

  // ─── Server pool ──────────────────────────────────────────────────────────

  private async ensureServer(projectPath: string): Promise<ServerHandle> {
    if (this.server) return this.scopedHandle(this.server, projectPath)
    if (this.starting) {
      const handle = await this.starting
      return this.scopedHandle(handle, projectPath)
    }
    const promise = this.startServer(projectPath)
    this.starting = promise
    try {
      const handle = await promise
      this.server = handle
      return this.scopedHandle(handle, projectPath)
    } finally {
      if (this.starting === promise) this.starting = null
    }
  }

  private scopedHandle(handle: ServerHandle, projectPath: string): ServerHandle {
    return handle.projectPath === projectPath ? handle : { ...handle, projectPath }
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
        `${this.command} serve`,
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
   * V2 validates every provider in its inline config when a location boots, so
   * expose only the custom provider selected for this turn: a broken unrelated
   * provider must not block prompt sending.
   */
  private async runtimeForProvider(
    runtime: PreparedUtilityRuntime,
    selectedProviderId: string
  ): Promise<PreparedUtilityRuntime> {
    if (!this.baseUrlProviders) return runtime
    const customProviders = (await this.baseUrlProviders.listProviders()).filter(
      (provider) => provider.harnessId === this.id
    )
    return narrowOpenCodeV2RuntimeForProvider(runtime, selectedProviderId, customProviders)
  }

  private async stopTurnServer(sessionId: string): Promise<void> {
    const pending = this.turnStarting.get(sessionId)
    if (pending) {
      try {
        const pendingHandle = await pending
        pendingHandle.abortController.abort()
        await pendingHandle.close()
      } catch {
        // A failed start has no live server to stop.
      }
      if (this.turnStarting.get(sessionId) === pending) this.turnStarting.delete(sessionId)
    }
    const handle = this.turnServers.get(sessionId)
    if (!handle) return
    handle.abortController.abort()
    this.turnServers.delete(sessionId)
    await handle.close()
  }

  /** Spawn a private `serve` process, independent of the project pool. */
  private async startIsolatedServer(
    projectPath: string,
    runtime?: PreparedUtilityRuntime
  ): Promise<Omit<IsolatedHandle, 'sessionId'>> {
    const overlay = runtime
      ? undefined
      : await this.prepareUtilityRuntime({ projectPath, resolvedUtilities: [] })
    const configContent = runtime
      ? runtime.env['OPENCODE_CONFIG_CONTENT']
      : overlay?.env?.['OPENCODE_CONFIG_CONTENT']
    const env = runtime
      ? this.buildEnv(runtime)
      : buildProcessEnvironment({
          ...process.env,
          ...this.accountEnvironment,
          ...(overlay?.env ?? {})
        })
    const spawned = await startOpenCodeV2Server({
      command: this.command,
      cwd: projectPath,
      env,
      ...(configContent ? { configContent } : {}),
      label: `isolated ${projectPath}`
    })
    const handle = this.toHandle(spawned, projectPath, runtime?.id ?? null)
    // The terminal's interrupt can reach the whole foreground process group in
    // development, so tie the SSE subscription to the process lifecycle: a
    // reconnect timer must never keep Electron alive after the server is gone.
    spawned.process.once('exit', () => handle.abortController.abort())
    this.subscribeEvents(handle)
    return handle
  }

  /** Spawn the application-wide `serve` host. */
  private async startServer(projectPath: string): Promise<ServerHandle> {
    const overlay = await this.prepareUtilityRuntime({ projectPath, resolvedUtilities: [] })
    const spawned = await startOpenCodeV2Server({
      command: this.command,
      cwd: projectPath,
      env: buildProcessEnvironment({
        ...process.env,
        ...this.accountEnvironment,
        ...(overlay.env ?? {})
      }),
      ...(overlay.env?.['OPENCODE_CONFIG_CONTENT']
        ? { configContent: overlay.env['OPENCODE_CONFIG_CONTENT'] }
        : {}),
      label: `shared ${projectPath}`
    })
    const handle = this.toHandle(spawned, projectPath, null)
    this.processObserver?.watchProcess(
      undefined,
      spawned.process.pid,
      `${this.command} serve`,
      projectPath
    )
    this.ensureProjectSubscription(handle, projectPath)
    return handle
  }

  private toHandle(
    spawned: OpenCodeV2ServerHandle,
    projectPath: string,
    runtimeId: string | null
  ): ServerHandle {
    const url = new URL(spawned.baseUrl)
    const port = Number.parseInt(url.port, 10)
    const client = new OpenCodeV2Client(spawned)
    this.noteServerTraffic(port)
    return {
      projectPath,
      runtimeId,
      startedAt: Date.now(),
      port,
      baseUrl: spawned.baseUrl,
      password: spawned.password,
      client,
      process: spawned.process,
      close: spawned.close,
      abortController: new AbortController()
    }
  }

  /** GUI apps do not inherit the shell PATH: augment with common locations. */
  private buildEnv(runtime?: PreparedUtilityRuntime): NodeJS.ProcessEnv {
    if (!runtime) {
      return buildProcessEnvironment({ ...process.env, ...this.accountEnvironment })
    }
    return buildProcessEnvironment({
      ...process.env,
      ...this.accountEnvironment,
      ...runtime.env
    })
  }

  // ─── Idle reaping ─────────────────────────────────────────────────────────

  private noteServerTraffic(port: number): void {
    this.lastServerTrafficAt.set(port, Date.now())
    this.ensureIdleSweeper()
  }

  private idleMs(port: number): number {
    const at = this.lastServerTrafficAt.get(port)
    // An unknown port is a freshly spawned server, so the sweeper can never kill
    // a process between spawn and its first request.
    return at === undefined ? 0 : Date.now() - at
  }

  private ensureIdleSweeper(): void {
    if (this.idleSweepTimer) return
    this.idleSweepTimer = setInterval(() => {
      try {
        this.sweepIdleHandles()
      } catch (error) {
        Logger.dev('OpenCode V2 idle sweep failed:', error)
      }
    }, OpenCodeV2Driver.IDLE_SWEEP_INTERVAL_MS)
    this.idleSweepTimer.unref?.()
  }

  private sweepIdleHandles(): void {
    this.pruneGhostSessions()
    for (const [sessionId, handle] of [...this.turnServers]) {
      if (
        this.isSessionLive(sessionId) ||
        this.idleMs(handle.port) < OpenCodeV2Driver.TURN_SERVER_IDLE_TTL_MS
      ) {
        continue
      }
      Logger.info('Reaping idle OpenCode V2 turn server', { sessionId, port: handle.port })
      void this.stopTurnServer(sessionId)
    }
    for (const handle of [...this.isolatedServers.values()]) {
      if (this.idleMs(handle.port) < OpenCodeV2Driver.ISOLATED_SERVER_IDLE_TTL_MS) continue
      Logger.info('Reaping idle isolated OpenCode V2 server', { port: handle.port })
      this.disposeIsolatedSession(handle)
    }
    const shared = this.server
    if (
      shared &&
      !this.starting &&
      this.idleMs(shared.port) >= OpenCodeV2Driver.SHARED_SERVER_IDLE_TTL_MS &&
      ![...this.activeSessions.keys()].some((sessionId) => this.isSessionLive(sessionId))
    ) {
      Logger.info('Reaping idle OpenCode V2 serve host', { port: shared.port })
      this.stopSharedServer()
    }
  }

  /** Drop tracking entries that show no sign of life for double the silent grace. */
  private pruneGhostSessions(): void {
    const now = Date.now()
    for (const sessionId of [...this.activeSessions.keys()]) {
      const at = this.lastSessionActivityAt.get(sessionId)
      if (at !== undefined && now - at >= OpenCodeV2Driver.GHOST_SESSION_TTL_MS) {
        Logger.info('Dropping ghost OpenCode V2 session tracking entry', { sessionId })
        this.activeSessions.delete(sessionId)
        this.lastSessionActivityAt.delete(sessionId)
      }
    }
    for (const [sessionId, at] of this.lastSessionActivityAt) {
      if (
        !this.activeSessions.has(sessionId) &&
        now - at >= OpenCodeV2Driver.GHOST_SESSION_TTL_MS
      ) {
        this.lastSessionActivityAt.delete(sessionId)
      }
    }
  }

  private isSessionLive(sessionId: string): boolean {
    if (!this.activeSessions.has(sessionId)) return false
    const at = this.lastSessionActivityAt.get(sessionId)
    if (at === undefined) return true
    return Date.now() - at < OpenCodeV2Driver.SILENT_TURN_GRACE_MS
  }

  private noteSessionActivity(sessionId: string | undefined): void {
    if (!sessionId) return
    this.lastSessionActivityAt.set(sessionId, Date.now())
  }

  private stopSharedServer(): void {
    const server = this.server
    if (!server) return
    for (const controller of this.projectSubscriptions.values()) controller.abort()
    this.projectSubscriptions.clear()
    server.abortController.abort()
    this.server = null
    this.starting = null
    void server.close()
  }

  private stopSharedServerIfIdle(): void {
    if (
      this.activeSessions.size > 0 ||
      this.turnServers.size > 0 ||
      this.isolatedServers.size > 0
    ) {
      return
    }
    this.stopSharedServer()
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
          const response = await handle.client.request('/api/event', {
            accept: 'text/event-stream',
            // A long-lived stream carries its own liveness: the request timeout
            // is disabled rather than set, so a large value can never overflow
            // into an immediate abort.
            timeoutMs: 0,
            signal
          })
          if (!response.ok || !response.body) break
          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          for (;;) {
            const { done, value } = await reader.read()
            if (done || signal.aborted) break
            // A streaming turn issues no HTTP requests of its own, so incoming
            // frames are its heartbeat against the idle reaper.
            this.noteServerTraffic(handle.port)
            buffer += decoder.decode(value, { stream: true })
            const { frames, rest } = splitOpenCodeV2SseBuffer(buffer)
            buffer = rest
            for (const frame of frames) {
              const event = parseOpenCodeV2SseFrame(frame)
              if (event) this.routeEvent(event)
            }
          }
        } catch (error) {
          if (signal.aborted) break
          Logger.dev('OpenCode V2 SSE connection dropped, reconnecting:', error)
          await new Promise((resolve) => setTimeout(resolve, SSE_RECONNECT_MS))
        }
      }
    })()
  }

  /** Record what an event teaches the driver, then forward what it maps to. */
  private routeEvent(event: OpenCodeV2SseEvent): void {
    const sessionId = eventSessionId(event)
    const assistantMessageId = stringValue(event.data['assistantMessageID'])
    if (sessionId && assistantMessageId) this.assistantMessages.set(sessionId, assistantMessageId)
    switch (event.type) {
      case 'session.tool.input.started': {
        const callId = stringValue(event.data['id'])
        const name = stringValue(event.data['name'])
        if (sessionId && callId && name) {
          const names = this.toolNames.get(sessionId) ?? new Map<string, string>()
          names.set(callId, name)
          this.toolNames.set(sessionId, names)
        }
        break
      }
      case 'session.step.failed':
        if (sessionId) this.stepErrors.set(sessionId, event.data['error'])
        break
      case 'permission.asked': {
        const requestId = stringValue(event.data['id'])
        if (requestId && sessionId) this.pendingRequests.set(requestId, sessionId)
        break
      }
      case 'permission.replied': {
        const requestId = stringValue(event.data['requestID'])
        if (requestId) this.pendingRequests.delete(requestId)
        break
      }
      case 'form.created': {
        const form = recordValue(event.data['form'])
        const formId = stringValue(form?.['id'])
        if (formId && sessionId) this.pendingRequests.set(formId, sessionId)
        break
      }
      case 'form.replied':
      case 'form.cancelled': {
        const formId = stringValue(event.data['id'])
        if (formId) this.pendingRequests.delete(formId)
        break
      }
      case 'session.compaction.started': {
        const messageId = stringValue(event.data['inputID'])
        if (sessionId && messageId) this.compactionMessages.set(sessionId, messageId)
        break
      }
      case 'session.compaction.ended':
        if (sessionId) this.compactionMessages.delete(sessionId)
        break
      default:
        break
    }

    if (sessionId) this.noteSessionActivity(sessionId)
    if (this.isTerminalExecutionEvent(event.type)) {
      this.finalizeExecution(event, sessionId)
      return
    }

    const context: OpenCodeV2EventContext = {
      ...(assistantMessageId ? { assistantMessageId } : {}),
      ...(sessionId && this.compactionMessages.has(sessionId)
        ? { compactionMessageId: this.compactionMessages.get(sessionId) as string }
        : {}),
      toolNames: this.toolNames.get(sessionId)
    }
    for (const mapped of mapOpenCodeV2Event(event, context)) {
      this.emit(mapped)
    }
  }

  /** The three V2 events that end a turn. */
  private isTerminalExecutionEvent(type: string): boolean {
    return (
      type === 'session.execution.succeeded' ||
      type === 'session.execution.failed' ||
      type === 'session.execution.interrupted'
    )
  }

  /**
   * Close a turn exactly once.
   *
   * V2's only turn terminal is `session.execution.*`: a step may fail and be
   * retried several times inside one turn, so a `session.step.failed` must never
   * end it. The message-level event carries the failure because the engine
   * treats `message.completed` with an error as the provider failure for that
   * turn (a second `session.error` would report the same failure twice).
   */
  private finalizeExecution(event: OpenCodeV2SseEvent, sessionId: string): void {
    if (!sessionId) return
    const messageId = this.assistantMessages.get(sessionId)
    const stepError = this.stepErrors.get(sessionId)
    this.activeSessions.delete(sessionId)
    this.assistantMessages.delete(sessionId)
    this.stepErrors.delete(sessionId)
    this.toolNames.delete(sessionId)
    this.compactionMessages.delete(sessionId)

    if (event.type === 'session.execution.failed') {
      const raw = event.data['error'] ?? stepError
      const issue = openCodeV2Issue(raw, 'The OpenCode V2 session failed')
      if (messageId) {
        this.emit({
          type: 'message.completed',
          sessionId,
          messageId,
          error: issue.message,
          ...(issue.rawError === undefined ? {} : { rawError: issue.rawError }),
          issue
        })
      } else {
        this.emit({
          type: 'session.error',
          sessionId,
          error: issue.message,
          ...(issue.rawError === undefined ? {} : { rawError: issue.rawError }),
          issue
        })
      }
      this.emit({ type: 'session.idle', sessionId })
      return
    }

    // A user interrupt is not a failure: the turn ends with whatever the model
    // produced, and the engine already knows why it stopped.
    if (event.type === 'session.execution.succeeded' && messageId) {
      this.emit({ type: 'message.completed', sessionId, messageId })
    }
    if (
      event.type === 'session.execution.interrupted' &&
      stepError &&
      !isOpenCodeV2AbortError(stepError)
    ) {
      Logger.dev('OpenCode V2 turn interrupted after a step error:', stepError)
    }
    this.emit({ type: 'session.idle', sessionId })
  }

  private emit(event: AgentEvent): void {
    if ('sessionId' in event && this.auxiliarySessions.has(event.sessionId)) {
      // Auxiliary sessions are private utility work: their completion is read
      // from the isolated transcript so a fast reply cannot race the stream.
      return
    }
    this.eventCallback?.(event)
  }

  // ─── Wire-format reads ────────────────────────────────────────────────────

  /** Load a session's full transcript, oldest first, following the page cursor. */
  private async fetchMessages(handle: ServerHandle, sessionId: string): Promise<AgentMessage[]> {
    const messages: AgentMessage[] = []
    let cursor: string | undefined
    for (let page = 0; page < MESSAGE_PAGE_LIMIT; page += 1) {
      // V2 rejects a cursor combined with `order` ("Cursor cannot be combined
      // with order"), so only the first page states its direction; every later
      // page is addressed purely by the cursor, which carries the order the
      // first page established.
      const query = cursor
        ? new URLSearchParams({ cursor })
        : new URLSearchParams({ order: 'asc', limit: String(MESSAGE_PAGE_SIZE) })
      const response = await handle.client.json(
        `/api/session/${encodeURIComponent(sessionId)}/message?${query.toString()}`,
        { timeoutMs: MODEL_DISCOVERY_TIMEOUT_MS }
      )
      messages.push(...mapOpenCodeV2Messages(response))
      const next = readNextCursor(response)
      if (!next || next === cursor) break
      cursor = next
    }
    return messages
  }
}

/** Read the opaque `cursor.next` of a paginated V2 page. */
function readNextCursor(payload: unknown): string | undefined {
  return stringValue(recordValue(recordValue(payload)?.['cursor'])?.['next'])
}
