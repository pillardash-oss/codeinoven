import type {
  AgentMessage,
  AgentPart,
  AgentQuestionRequest,
  HarnessCommand,
  PermissionReply,
  ProviderCatalog,
  ThreadSettings
} from '../../lib/types'
import { APP_NAME } from '../../lib/brand'
import type {
  CliLineParseContext,
  CliLineParseResult,
  CliTurnCommand,
  PersistentCliSession
} from './persistent-cli-driver'
import { PersistentCliDriver } from './persistent-cli-driver'
import {
  PermissionRequestGoneError,
  QuestionRequestGoneError,
  type CheapModelRequest,
  type CheapModelResult,
  type GenerateTitleOptions,
  type HarnessCapabilities,
  type HarnessDriver,
  type SendHeartbeatPingOptions,
  type SendPromptOptions,
  type SteerPromptOptions
} from './driver.interface'
import { Logger } from '../system/logger'
import type { StorageEngine } from '../storage/storage-engine'
import type { AcpAgent } from '../../lib/acp'
import { acpAgentStore, currentAcpAgents, type AcpAgentStore } from './acp/acp-agents-store'
import { AcpTransport } from './acp/acp-transport'
import { acpProviderCatalog } from './acp/acp-catalog'
import { AcpTurnFold } from './acp/acp-session'
import { NO_PROMPT_CAPABILITIES, acpPromptBlocks } from './acp/acp-content'
import { AcpPermissionRegistry } from './acp/acp-permissions'
import {
  acpRecord,
  acpSessionIdOf,
  acpString,
  type AcpPromptCapabilities,
  type AcpRequestPermissionParams,
  type AcpSessionUpdate
} from './acp/acp-protocol'

const HARNESS_NAME = 'ACP agent'
const TURN_TIMEOUT_MS = 60 * 60 * 1000
const AUXILIARY_TIMEOUT_MS = 90_000
const TITLE_PROMPT_PREFIX =
  'Reply with a title of at most eight words for the conversation below, and nothing else.'

/** One CodeInOven session's binding to the ACP session that holds its context. */
interface AcpSessionBinding {
  projectPath: string
  acpSessionId: string
  modelId?: string
  commands: HarnessCommand[]
}

/** The turn currently streaming on one app session. */
interface AcpActiveTurn {
  sessionId: string
  messageId: string
  fold: AcpTurnFold
  startedAt: number
}

/**
 * Generic Agent Client Protocol harness.
 *
 * Any agent binary that speaks ACP can be driven through this one adapter: the
 * user names the command, and every turn, tool call and approval then travels
 * over the protocol. Nothing here knows which product it is talking to, which is
 * what lets a harness we ship no dedicated driver for still work.
 */
export class AcpDriver extends PersistentCliDriver implements HarnessDriver {
  readonly id: string
  readonly name: string
  readonly capabilities: HarnessCapabilities = {
    // One long-lived agent process per project hosts every session in it.
    runtimeTopology: { kind: 'shared_daemon', scope: 'application' },
    streaming: true,
    // ACP has no append-to-active-turn primitive; a steer would start a new prompt.
    steering: false,
    nativeResume: false,
    messageHistory: 'mirrored',
    interactivePermissions: true,
    attachments: false,
    commands: true,
    providerCatalog: true,
    sessionStatus: true,
    contextUsage: true,
    compaction: false,
    subagents: false
  }

  private readonly store: AcpAgentStore
  private readonly transports = new Map<string, AcpTransport>()
  private readonly bindings = new Map<string, AcpSessionBinding>()
  private readonly activeTurns = new Map<string, AcpActiveTurn>()
  private readonly permissions = new AcpPermissionRegistry(HARNESS_NAME)
  private readonly catalogs = new Map<string, ProviderCatalog[]>()
  private closed = false

  constructor(
    storage: StorageEngine,
    private agent: AcpAgent,
    private readonly clientVersion?: string
  ) {
    super(storage)
    this.id = agent.id
    this.name = agent.name
    this.store = acpAgentStore(storage)
  }

  // ---------------------------------------------------------------- transport

  private transportFor(projectPath: string): AcpTransport {
    const existing = this.transports.get(projectPath)
    if (existing) return existing
    const transport = new AcpTransport(projectPath, {
      resolveConfig: () => this.store.get(this.id),
      notification: (method, params) => this.handleNotification(method, params),
      request: (method, params) => this.handleAgentRequest(method, params),
      exit: (info) => this.handleAgentExit(projectPath, info),
      ...(this.clientVersion ? { clientVersion: this.clientVersion } : {})
    })
    this.transports.set(projectPath, transport)
    return transport
  }

  /** One agent notification: only session updates carry app-visible content. */
  private handleNotification(method: string, params: unknown): void {
    if (method !== 'session/update') return
    const acpSessionId = acpSessionIdOf(params)
    if (!acpSessionId) return
    const session = this.sessionForAcpId(acpSessionId)
    if (!session) return
    const update = acpRecord(acpRecord(params)?.['update'])
    if (!update) return
    const turn = this.activeTurns.get(session.id)
    const typed = update as AcpSessionUpdate
    if (typed.sessionUpdate === 'available_commands_update') {
      const binding = this.bindings.get(session.id)
      if (binding) binding.commands = [...typed.availableCommands]
      return
    }
    if (typed.sessionUpdate === 'usage_update') {
      this.emit({
        type: 'usage.updated',
        sessionId: session.id,
        messageId: turn?.messageId ?? `${session.id}:usage`,
        contextWindow: typed.size,
        contextUsed: typed.used
      })
      return
    }
    turn?.fold.apply(typed)
  }

  /** One agent request. Permission cards are the only thing we implement. */
  private async handleAgentRequest(method: string, params: unknown): Promise<unknown> {
    if (method === 'session/request_permission') return this.requestPermission(params)
    // fs/* and terminal/* are advertised as unsupported, so an agent that asks
    // anyway gets a protocol-level refusal instead of silent machine access.
    throw new Error(`The ACP request "${method}" is not supported by ${APP_NAME}`)
  }

  private requestPermission(params: unknown): Promise<unknown> {
    const record = acpRecord(params)
    const acpSessionId = acpString(record?.['sessionId'])
    if (!record || !acpSessionId) return Promise.resolve({ outcome: { outcome: 'cancelled' } })
    const session = this.sessionForAcpId(acpSessionId)
    if (!session) return Promise.resolve({ outcome: { outcome: 'cancelled' } })
    const { request, decision } = this.permissions.open(
      record as unknown as AcpRequestPermissionParams
    )
    this.emit({ type: 'permission.asked', sessionId: session.id, permission: request })
    return decision
  }

  private handleAgentExit(
    projectPath: string,
    info: { code: number | null; signal: NodeJS.Signals | null; expected: boolean }
  ): void {
    this.transports.delete(projectPath)
    this.permissions.cancelAll()
    for (const [sessionId, turn] of this.activeTurns) {
      const binding = this.bindings.get(sessionId)
      if (binding?.projectPath !== projectPath) continue
      this.abandonTurn(turn, info.expected ? null : 'The ACP agent process exited')
    }
    if (info.expected || this.closed) return
    Logger.info('ACP agent exited', { projectPath, code: info.code, signal: info.signal })
  }

  // ------------------------------------------------------------------ driver

  protected async ensureCliReady(projectPath: string): Promise<void> {
    void projectPath
    const agent = await this.store.get(this.id)
    if (!agent) throw new Error(`${this.name} is no longer configured. Add it again in Harnesses.`)
    const resolved = await this.store.statuses()
    const status = resolved.find((entry) => entry.id === this.id)
    if (status?.detail) throw new Error(status.detail)
  }

  /** ACP never spawns a per-turn CLI process; `sendPrompt` owns the transport. */
  protected buildTurnCommand(
    _projectPath: string,
    _session: PersistentCliSession,
    _options: SendPromptOptions
  ): Promise<CliTurnCommand> {
    return Promise.reject(new Error('The ACP driver does not run per-turn CLI processes'))
  }

  /** ACP speaks JSON-RPC, not JSONL turn records; content is folded in `acp-session`. */
  protected parseJsonLine(
    _value: unknown,
    _context: CliLineParseContext
  ): CliLineParseResult | null {
    return null
  }

  async listProviders(projectPath: string): Promise<ProviderCatalog[]> {
    const cached = this.catalogs.get(projectPath)
    if (cached) return cached
    const agent = await this.store.get(this.id)
    if (!agent) {
      return [
        {
          id: this.id,
          name: this.name,
          harnessId: this.id,
          models: [],
          catalogStatus: 'unavailable',
          catalogMessage: 'This ACP agent is no longer configured.'
        }
      ]
    }
    try {
      const transport = this.transportFor(projectPath)
      const opened = await transport.newSession()
      const catalogs = acpProviderCatalog(opened, agent.name, agent.id)
      this.catalogs.set(projectPath, catalogs)
      await this.discardSession(transport, opened.sessionId)
      return catalogs
    } catch (error) {
      return [
        {
          id: this.id,
          name: agent.name,
          harnessId: this.id,
          models: [],
          catalogStatus: 'unavailable',
          catalogMessage:
            error instanceof Error ? error.message : 'The ACP agent did not report any models'
        }
      ]
    }
  }

  async sendPrompt(projectPath: string, opts: SendPromptOptions): Promise<void> {
    const session = await this.requireSession(projectPath, opts.sessionId)
    this.appendUserMessage(session, opts)
    this.setTurnProvenance(
      session.id,
      opts.settings.providerId,
      opts.settings.modelId,
      opts.settings.thinkingLevel
    )
    await this.persistSession(session)

    const turnIndex = session.messages.filter((message) => message.role === 'user').length
    const turn = this.startTurn(session, `acp:${session.id}:${turnIndex}:1`)
    this.emit({ type: 'session.status', sessionId: session.id, status: { state: 'working' } })
    try {
      const transport = this.transportFor(projectPath)
      const init = await transport.initialize()
      const binding = await this.bindSession(projectPath, session, opts.settings, transport)
      const capabilities: AcpPromptCapabilities =
        init.agentCapabilities?.promptCapabilities ?? NO_PROMPT_CAPABILITIES
      const blocks = await acpPromptBlocks(opts.text, opts.attachments, capabilities)
      const result = await transport.prompt(binding.acpSessionId, blocks, TURN_TIMEOUT_MS)
      await this.completeTurn(turn, session, result)
    } catch (error) {
      this.failTurn(turn, session, error)
    }
  }

  async abort(projectPath: string, sessionId: string): Promise<void> {
    await this.requireSession(projectPath, sessionId)
    const binding = this.bindings.get(sessionId)
    if (!binding) return
    this.transports.get(projectPath)?.cancel(binding.acpSessionId)
  }

  async replyPermission(
    projectPath: string,
    requestId: string,
    reply: PermissionReply
  ): Promise<void> {
    void projectPath
    if (!this.permissions.has(requestId)) {
      throw new PermissionRequestGoneError(undefined, requestId, HARNESS_NAME)
    }
    this.permissions.reply(requestId, reply)
  }

  async replyToQuestion(_projectPath: string, sessionId: string, requestId: string): Promise<void> {
    throw new QuestionRequestGoneError(sessionId, requestId, HARNESS_NAME)
  }

  async rejectQuestion(_projectPath: string, sessionId: string, requestId: string): Promise<void> {
    throw new QuestionRequestGoneError(sessionId, requestId, HARNESS_NAME)
  }

  async listPendingQuestions(): Promise<AgentQuestionRequest[]> {
    return []
  }

  async steerPrompt(_projectPath: string, _opts: SteerPromptOptions): Promise<void> {
    throw new Error('ACP does not support steering an active turn')
  }

  async listCommands(): Promise<HarnessCommand[]> {
    for (const binding of this.bindings.values()) {
      if (binding.commands.length > 0) return [...binding.commands]
    }
    return []
  }

  async runCommand(): Promise<void> {
    throw new Error('ACP agents do not expose slash commands through CodeInOven')
  }

  hasActiveTurn(sessionId: string): boolean {
    return this.activeTurns.has(sessionId)
  }

  async isSessionBusy(sessionId: string): Promise<boolean> {
    return this.activeTurns.has(sessionId)
  }

  /**
   * A cheap fingerprint of this agent's catalog inputs: the record the user
   * saved. Editing the command or parking the agent changes it, so cached
   * discovery cannot keep serving models the agent no longer offers.
   */
  async providerCatalogFingerprint(): Promise<string | null> {
    const agent = await this.store.get(this.id)
    if (!agent) return null
    return [agent.id, agent.command, agent.args.join(' '), agent.enabled ? 'on' : 'off'].join('|')
  }

  async restartRuntime(): Promise<void> {
    for (const transport of this.transports.values()) transport.stop()
    this.transports.clear()
    this.catalogs.clear()
  }

  async releaseProjectResources(projectPath: string): Promise<void> {
    this.transports.get(projectPath)?.stop()
    this.transports.delete(projectPath)
    this.catalogs.delete(projectPath)
  }

  prepareForProcessCleanup(): void {
    this.closed = true
  }

  dispose(): void {
    this.closed = true
    for (const transport of this.transports.values()) transport.stop()
    this.transports.clear()
    this.permissions.cancelAll()
  }

  // ------------------------------------------------------------------ models

  private async bindSession(
    projectPath: string,
    session: PersistentCliSession,
    settings: ThreadSettings,
    transport: AcpTransport
  ): Promise<AcpSessionBinding> {
    let binding = this.bindings.get(session.id)
    if (!binding) {
      const opened = await transport.newSession()
      binding = { projectPath, acpSessionId: opened.sessionId, commands: [] }
      this.bindings.set(session.id, binding)
    }
    const wanted = settings.modelId
    if (wanted && wanted !== 'default' && wanted !== binding.modelId) {
      try {
        await transport.setModel(binding.acpSessionId, wanted)
        binding.modelId = wanted
      } catch (error) {
        Logger.dev('The ACP agent refused the selected model', error)
      }
    }
    return binding
  }

  /** A probe session is not a conversation: close it when the agent allows that. */
  private async discardSession(transport: AcpTransport, sessionId: string): Promise<void> {
    await transport.closeSession(sessionId).catch(() => undefined)
  }

  // ------------------------------------------------------------------- turns

  private startTurn(session: PersistentCliSession, messageId: string): AcpActiveTurn {
    const fold = new AcpTurnFold(
      session.id,
      messageId,
      {
        partUpdated: (part) => this.publishPart(session, part),
        partDelta: (partId, field, delta) =>
          this.publishDelta(session, messageId, partId, field, delta)
      },
      this.id
    )
    const turn: AcpActiveTurn = { sessionId: session.id, messageId, fold, startedAt: Date.now() }
    this.activeTurns.set(session.id, turn)
    return turn
  }

  private publishPart(session: PersistentCliSession, part: AgentPart): void {
    const event = { type: 'message.part.updated' as const, sessionId: session.id, part }
    this.applyEventToSession(session, event)
    this.emit(event)
  }

  private publishDelta(
    session: PersistentCliSession,
    messageId: string,
    partId: string,
    field: string,
    delta: string
  ): void {
    const event = {
      type: 'message.part.delta' as const,
      sessionId: session.id,
      messageId,
      partId,
      field,
      delta
    }
    this.applyEventToSession(session, event)
    this.emit(event)
  }

  private async completeTurn(
    turn: AcpActiveTurn,
    session: PersistentCliSession,
    result: unknown
  ): Promise<void> {
    this.activeTurns.delete(turn.sessionId)
    // The mirrored transcript has to hold the finished message before the turn
    // is announced as complete: this driver streams parts, and a part event
    // only folds into a message that already exists. Without this merge the
    // session kept no assistant message at all, so finalization reported "the
    // harness ended the turn without returning a final response" even though
    // the answer had streamed.
    this.mergeMessages(session, [turn.fold.message()])
    await this.persistSession(session).catch(() => undefined)
    const usage = acpRecord(acpRecord(result)?.['usage'])
    const tokens = usage ? acpTokens(usage) : undefined
    this.emit({
      type: 'message.completed',
      sessionId: turn.sessionId,
      messageId: turn.messageId,
      ...(tokens ? { tokens } : {}),
      ...(turn.fold.contextWindow ? { contextWindow: turn.fold.contextWindow } : {}),
      ...(turn.fold.usedContext ? { contextUsed: turn.fold.usedContext } : {})
    })
    this.emit({ type: 'session.idle', sessionId: turn.sessionId })
  }

  /** End a turn whose transport disappeared. `error` null means a deliberate stop. */
  private abandonTurn(turn: AcpActiveTurn, error: string | null): void {
    this.activeTurns.delete(turn.sessionId)
    if (error)
      this.emit({
        type: 'message.completed',
        sessionId: turn.sessionId,
        messageId: turn.messageId,
        error
      })
    if (error) this.emit({ type: 'session.error', sessionId: turn.sessionId, error })
    this.emit({ type: 'session.idle', sessionId: turn.sessionId })
  }

  private failTurn(turn: AcpActiveTurn, session: PersistentCliSession, error: unknown): void {
    const message = error instanceof Error ? error.message : 'The ACP turn failed'
    this.activeTurns.delete(turn.sessionId)
    // Keep whatever the turn produced, so a failed turn still explains itself.
    this.mergeMessages(session, [turn.fold.message()])
    void this.persistSession(session).catch(() => undefined)
    this.emit({
      type: 'message.completed',
      sessionId: turn.sessionId,
      messageId: turn.messageId,
      error: message
    })
    this.emit({ type: 'session.error', sessionId: turn.sessionId, error: message })
    this.emit({ type: 'session.idle', sessionId: turn.sessionId })
  }

  // -------------------------------------------------------- auxiliary runs

  async generateTitle(projectPath: string, options: GenerateTitleOptions): Promise<string | null> {
    const answer = await this.oneShot(
      projectPath,
      `${TITLE_PROMPT_PREFIX}\n\n${options.message}`,
      options.settings
    )
    const title = answer?.split(/\r?\n/u)[0]?.trim()
    return title && title.length > 0 ? title.slice(0, 120) : null
  }

  async gradeTurn(): Promise<number | null> {
    return null
  }

  async provideCheapModel(
    _projectPath: string,
    _request: CheapModelRequest
  ): Promise<CheapModelResult> {
    return { text: null, attempts: [] }
  }

  async sendHeartbeatPing(
    _projectPath: string,
    _options: SendHeartbeatPingOptions
  ): Promise<boolean> {
    return false
  }

  /** Run one disposable ACP session and return the text the agent produced. */
  private async oneShot(
    projectPath: string,
    prompt: string,
    settings: ThreadSettings
  ): Promise<string | null> {
    const sessionId = await this.createSession(projectPath, 'ACP one-shot')
    const transport = this.transportFor(projectPath)
    try {
      await transport.initialize()
      const opened = await transport.newSession()
      try {
        if (settings.modelId && settings.modelId !== 'default') {
          await transport.setModel(opened.sessionId, settings.modelId).catch(() => undefined)
        }
        const fold = new AcpTurnFold(
          sessionId,
          `acp:${sessionId}:1:1`,
          {
            partUpdated: () => undefined,
            partDelta: () => undefined
          },
          this.id
        )
        this.activeTurns.set(sessionId, {
          sessionId,
          messageId: `acp:${sessionId}:1:1`,
          fold,
          startedAt: Date.now()
        })
        const blocks = await acpPromptBlocks(prompt, [], NO_PROMPT_CAPABILITIES)
        await transport.prompt(opened.sessionId, blocks, AUXILIARY_TIMEOUT_MS)
        const answer = fold.answerText().trim()
        return answer.length > 0 ? answer : null
      } finally {
        this.activeTurns.delete(sessionId)
        await this.discardSession(transport, opened.sessionId)
      }
    } catch (error) {
      Logger.dev('ACP auxiliary run failed', error)
      return null
    } finally {
      this.activeTurns.delete(sessionId)
      await this.deleteSession(projectPath, sessionId).catch(() => undefined)
    }
  }

  // ------------------------------------------------------------------ lookups

  /** Resolve the app session that owns an ACP session id. */
  private sessionForAcpId(acpSessionId: string): PersistentCliSession | null {
    for (const [sessionId, binding] of this.bindings) {
      if (binding.acpSessionId !== acpSessionId) continue
      return this.sessionCache.get(sessionId) ?? null
    }
    return null
  }

  /** The model an ACP session last selected, so a caller can skip a redundant set. */
  selectedModel(sessionId: string): string | undefined {
    return this.bindings.get(sessionId)?.modelId
  }

  catalogFor(projectPath: string): ProviderCatalog[] | undefined {
    return this.catalogs.get(projectPath)
  }
}

function acpTokens(usage: Record<string, unknown>): AgentMessage['tokens'] {
  const count = (key: string): number =>
    typeof usage[key] === 'number' ? (usage[key] as number) : 0
  return {
    input: count('inputTokens'),
    output: count('outputTokens'),
    reasoning: count('thoughtTokens'),
    cacheRead: count('cachedReadTokens'),
    cacheWrite: count('cachedWriteTokens'),
    total: count('totalTokens')
  }
}

/** Every enabled agent, so the engine builds one driver per usable agent. */
export function configuredAcpAgents(): AcpAgent[] {
  return currentAcpAgents().filter((agent) => agent.enabled !== false)
}
