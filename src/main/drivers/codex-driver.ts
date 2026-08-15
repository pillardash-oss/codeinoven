import { execFile, spawn, type ChildProcess } from 'child_process'
import { promises as fs } from 'fs'
import { basename } from 'path'
import { fileURLToPath } from 'url'
import { promisify } from 'util'
import type {
  AgentEvent,
  AgentProviderIssue,
  AgentRateLimitWindow,
  AgentUsageCredits,
  AgentMessage,
  AgentPart,
  AgentTokenUsage,
  NormalizedUsage,
  PermissionLevel,
  PromptAttachment,
  ProviderCatalog,
  SessionAgentEvent,
  ProviderModel,
  ThreadSettings,
  ThinkingPreset
} from '../../lib/types'
import { classifyProviderIssue } from '../../lib/provider-issue'
import { resolveFastModelId } from '../../lib/fast-inference'
import { BaseUrlProviderService } from '../providers/base-url-provider-service'
import { Logger } from '../system/logger'
import { SecretVault } from '../storage/secret-vault'
import type { StorageEngine } from '../storage/storage-engine'
import { buildHarnessEnvironment } from './cli-environment'
import { attachmentReference } from './attachment-reference'
import type {
  GenerateTitleOptions,
  HarnessCapabilities,
  SendPromptOptions,
  SteerPromptOptions,
  UtilityRuntimeOverlay,
  UtilityRuntimePreparationRequest
} from './driver.interface'
import {
  PersistentCliDriver,
  type CliLineParseContext,
  type CliLineParseResult,
  type CliTurnCommand,
  type PersistentCliSession
} from './persistent-cli-driver'
import { inlineSvgAttachments, isSvgAttachment } from './svg-attachment'

const execFileAsync = promisify(execFile)

const THINKING_PRESETS: ThinkingPreset[] = [
  { id: 'minimal', label: 'Minimal', description: 'Minimum reasoning effort' },
  { id: 'low', label: 'Low', description: 'Low reasoning effort' },
  { id: 'medium', label: 'Medium', description: 'Moderate reasoning effort' },
  { id: 'high', label: 'High', description: 'High reasoning effort' },
  {
    id: 'xhigh',
    label: 'Extra high',
    description: 'Extra-high effort; uses significantly more quota'
  },
  {
    id: 'max',
    label: 'Max · high usage',
    description: 'Maximum effort; uses significantly more quota'
  },
  { id: 'ultra', label: 'Ultra · highest usage', description: 'Ultra effort; uses the most quota' }
]

/** Last-resort catalog for older Codex versions without the app-server model API. */
const CODEX_FALLBACK_MODELS = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']
const CODEX_COMPACTION_TIMEOUT_MS = 180_000
const CODEX_USAGE_TIMEOUT_MS = 15_000
const CODEX_APP_SERVER_REQUEST_TIMEOUT_MS = 30_000

interface CodexAppServerHost {
  child: ChildProcess
  nextRequestId: number
  stdoutBuffer: string
  stderrBuffer: string
  stopped: boolean
  pending: Map<
    number,
    {
      resolve: (value: Record<string, unknown>) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >
}

interface CodexAppServerTurn {
  host: CodexAppServerHost
  session: PersistentCliSession
  startParams?: Record<string, unknown>
  nativeThreadId?: string
  turnId?: string
  failure?: string
  summaryFallbackAttempted?: boolean
  finished: boolean
}

interface CodexCompactionRun {
  host: CodexAppServerHost
  session: PersistentCliSession
  messageId: string
  basePart: Extract<AgentPart, { type: 'compaction' }>
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface CodexContextUsageWaiter {
  host: CodexAppServerHost
  resolve: (usage: ReturnType<typeof mapCodexUsage>) => void
  timer: ReturnType<typeof setTimeout>
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function notificationThreadId(params: Record<string, unknown>): string | undefined {
  const turn = record(params['turn'])
  return (
    stringValue(params['threadId']) ??
    stringValue(params['thread_id']) ??
    stringValue(turn?.['threadId']) ??
    stringValue(turn?.['thread_id'])
  )
}

function codexThinkingPresets(value: unknown): ThinkingPreset[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const descriptions = new Map<string, string>()
  for (const option of value) {
    const entry = record(option)
    const effort = stringValue(entry?.['reasoningEffort'])
    if (!effort) continue
    descriptions.set(effort, stringValue(entry?.['description']) ?? `${effort} reasoning effort`)
  }
  const presets = THINKING_PRESETS.filter((preset) => descriptions.has(preset.id)).map(
    (preset) => ({ ...preset, description: descriptions.get(preset.id) })
  )
  return presets.length > 0 ? presets : undefined
}

function mapCodexModel(value: unknown): ProviderModel | null {
  const model = record(value)
  const id = stringValue(model?.['id'])
  if (!id || model?.['hidden'] === true) return null
  const serviceTiers = Array.isArray(model?.['serviceTiers']) ? model['serviceTiers'] : []
  const additionalSpeedTiers = Array.isArray(model?.['additionalSpeedTiers'])
    ? model['additionalSpeedTiers']
    : []
  const thinkingPresets = codexThinkingPresets(model?.['supportedReasoningEfforts'])
  const contextWindow =
    numberValue(model?.['contextWindow']) ??
    numberValue(model?.['context_window']) ??
    numberValue(model?.['modelContextWindow'])
  // Read a structured vision capability when the codex catalog reports one;
  // unknown state defaults to vision-capable.
  const capabilities = record(model?.['capabilities'])
  const explicitVision = capabilities?.['vision'] ?? capabilities?.['attachment']
  return {
    id,
    providerId: 'openai',
    name: stringValue(model?.['displayName']) ?? id,
    reasoning: thinkingPresets !== undefined,
    thinkingPresets,
    attachment: explicitVision === undefined ? true : explicitVision !== false,
    toolcall: true,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    fastSupported:
      additionalSpeedTiers.includes('fast') ||
      serviceTiers.some((tier) => stringValue(record(tier)?.['id']) === 'priority')
  }
}

function fallbackCodexModels(): ProviderModel[] {
  return CODEX_FALLBACK_MODELS.map((id) => ({
    id,
    providerId: 'openai',
    name: id,
    reasoning: true,
    thinkingPresets: THINKING_PRESETS,
    attachment: true,
    toolcall: true,
    fastSupported: true
  }))
}

function utilityKey(value: string): string {
  return (
    value
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9_]+/gu, '_')
      .replace(/^_+|_+$/gu, '') || 'utility'
  )
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

function tomlStringArray(values: string[]): string {
  return `[${values.map((value) => tomlString(value)).join(', ')}]`
}

function tomlStringMap(values: Record<string, string>): string {
  const entries = Object.entries(values).map(
    ([key, value]) => `${tomlString(key)} = ${tomlString(value)}`
  )
  return `{ ${entries.join(', ')} }`
}

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
    interactivePermissions: false,
    attachments: true,
    commands: false,
    providerCatalog: true,
    sessionStatus: false,
    contextUsage: true,
    compaction: true,
    subagents: false,
    nativeUtilities: ['web_search', 'web_fetch']
  }
  private activeTurns = new Map<string, CodexAppServerTurn>()
  private modelsWithoutReasoningSummaries = new Set<string>()
  private compactionsByThreadId = new Map<string, CodexCompactionRun>()
  private contextUsageByThreadId = new Map<string, CodexContextUsageWaiter>()
  /** Resident app-server hosts keyed by project working directory so the
   *  chats inbox (`chats-cwd`) runs on its own isolated app-server. */
  private hostsByProjectPath = new Map<string, CodexAppServerHost>()
  private hostsStartingByProjectPath = new Map<string, Promise<CodexAppServerHost>>()

  protected async ensureCliReady(): Promise<void> {
    try {
      await execFileAsync('codex', ['--version'], {
        env: buildHarnessEnvironment(),
        timeout: 10_000
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown error'
      throw new Error(`Codex CLI is unavailable: ${detail}`, { cause: error })
    }
  }

  constructor(
    storage: StorageEngine,
    private readonly baseUrlProviders?: BaseUrlProviderService,
    private readonly secretVault?: SecretVault
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
          attachment: true,
          toolcall: true,
          ...(model.contextWindow ? { contextWindow: model.contextWindow } : {})
        }))
      })
    }
    return catalogs
  }

  async generateTitle(projectPath: string, options: GenerateTitleOptions): Promise<string | null> {
    const catalogs = await this.listProviders(projectPath)
    const luna = catalogs
      .find((catalog) => catalog.id === 'openai')
      ?.models.find((model) => model.id === 'gpt-5.6-luna')
    return this.generateTitleWithCandidates(
      projectPath,
      options,
      luna ? [{ providerId: luna.providerId, modelId: luna.id }] : []
    )
  }

  /** Start a Codex turn through app-server so the same native turn can be steered. */
  override async sendPrompt(projectPath: string, options: SendPromptOptions): Promise<void> {
    const session = await this.requireSession(projectPath, options.sessionId)
    if (this.activeTurns.has(session.id)) {
      throw new Error(`A turn is already active for session ${session.id}`)
    }

    if (this.utilityRuntime(session.id)) {
      throw new Error('Codex per-session launch overlays cannot bypass the shared app-server host')
    }
    const fastInference =
      options.settings.inferenceMode === 'fast' && options.settings.providerId === 'openai'
    const host = await this.ensureAppServerHost(projectPath, session.id)
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
      const threadResult = session.nativeSessionId
        ? await this.appServerRequest(host, 'thread/resume', {
            threadId: session.nativeSessionId
          })
        : await this.appServerRequest(host, 'thread/start', {
            cwd: projectPath,
            model: options.settings.modelId,
            approvalPolicy: 'never',
            sandbox: sandboxFor(options.readOnly === true, options.settings.permissionLevel),
            serviceName: 'codeinoven'
          })
      const thread = recordValue(threadResult['thread'])
      const nativeThreadId = stringValue(thread?.['id']) ?? session.nativeSessionId
      if (!nativeThreadId) throw new Error('Codex app-server did not return a thread ID')
      active.nativeThreadId = nativeThreadId
      session.nativeSessionId = nativeThreadId
      await this.persistSession(session)

      const turnParams: Record<string, unknown> = {
        threadId: nativeThreadId,
        clientUserMessageId: options.userMessageId,
        input: await this.codexInput(options.text, options.systemPrompt, options.attachments),
        cwd: projectPath,
        approvalPolicy: 'never',
        sandboxPolicy: codexSandboxPolicy(
          projectPath,
          options.readOnly === true,
          options.settings.permissionLevel
        ),
        model: options.settings.modelId,
        ...(fastInference ? { serviceTier: 'fast' } : {}),
        effort: codexEffort(options.settings.thinkingLevel),
        ...(this.modelsWithoutReasoningSummaries.has(options.settings.modelId)
          ? { summary: 'none' }
          : {}),
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
      input: await this.codexInput(options.text, undefined, options.attachments),
      expectedTurnId: active.turnId
    })
    await this.persistSession(session)
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
    } catch (error) {
      await this.finishAppServerTurn(
        active,
        error instanceof Error ? error.message : 'Codex turn could not be interrupted'
      )
      throw error
    }
  }

  override async deleteSession(projectPath: string, sessionId: string): Promise<void> {
    const active = this.activeTurns.get(sessionId)
    if (active) await this.finishAppServerTurn(active)
    await super.deleteSession(projectPath, sessionId)
    this.stopResidentHostForPathIfIdle(projectPath)
  }

  override releaseProjectResources(projectPath: string): void {
    super.releaseProjectResources(projectPath)
    this.stopResidentHostForPathIfIdle(projectPath)
  }

  override dispose(): void {
    for (const active of this.activeTurns.values()) {
      active.finished = true
    }
    this.activeTurns.clear()
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
    for (const host of this.hostsByProjectPath.values()) {
      this.stopAppServerHost(host, 'Codex driver disposed')
    }
    this.hostsByProjectPath.clear()
    this.hostsStartingByProjectPath.clear()
    super.dispose()
  }

  private stopAppServerHost(host: CodexAppServerHost, reason: string): void {
    if (host.stopped) return
    host.stopped = true
    for (const pending of host.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
    host.pending.clear()
    if (!host.child.killed) host.child.kill()
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

  private async createAppServerHost(
    projectPath: string,
    observerSessionId?: string
  ): Promise<CodexAppServerHost> {
    const { env: providerEnv, args: providerArgs } = await this.customProviderOverlay()
    const child = spawn('codex', [...providerArgs, 'app-server', '--listen', 'stdio://'], {
      cwd: projectPath,
      env: { ...buildHarnessEnvironment(), ...providerEnv },
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
    this.bindAppServer(host)
    if (observerSessionId) {
      this.observeHarnessProcess(observerSessionId, child, 'codex app-server', projectPath)
    }
    try {
      await this.appServerRequest(host, 'initialize', {
        clientInfo: { name: 'codeinoven', title: 'CodeInOven', version: '1' },
        capabilities: { experimentalApi: true }
      })
      this.appServerNotify(host, 'initialized')
      return host
    } catch (error) {
      this.stopAppServerHost(host, 'Codex app-server initialization failed')
      throw error
    }
  }

  private async ensureAppServerHost(
    projectPath: string,
    observerSessionId?: string
  ): Promise<CodexAppServerHost> {
    const existing = this.hostsByProjectPath.get(projectPath)
    if (existing && !existing.stopped) {
      if (observerSessionId) {
        this.observeHarnessProcess(
          observerSessionId,
          existing.child,
          'codex app-server',
          projectPath
        )
      }
      return existing
    }
    const starting = this.hostsStartingByProjectPath.get(projectPath)
    if (starting) return starting
    const promise = (async (): Promise<CodexAppServerHost> => {
      const host = await this.createAppServerHost(projectPath, observerSessionId)
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
      this.respondToUnsupportedAppServerRequest(host, responseId, method)
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
          compaction.reject(new Error(`Codex compaction ${status}`))
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
    if (!active) return
    if (method === 'turn/started') {
      const turn = recordValue(params['turn'])
      active.turnId = stringValue(turn?.['id']) ?? active.turnId
      return
    }
    if (method === 'item/agentMessage/delta') {
      this.emitAppServerDelta(active, params, 'text')
      return
    }
    if (method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') {
      this.emitAppServerDelta(active, params, 'reasoning')
      return
    }
    if (method === 'item/started' || method === 'item/completed') {
      const item = normalizeAppServerItem(recordValue(params['item']))
      if (item) {
        this.applyCodexResult(
          active,
          parseItem(item, method === 'item/completed', active.session.id)
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
      active.failure = stringValue(error?.['message']) ?? 'Codex turn failed'
      return
    }
    if (method !== 'turn/completed') return
    const turn = recordValue(params['turn'])
    const status = stringValue(turn?.['status'])
    const error = recordValue(turn?.['error'])
    const message =
      status === 'failed'
        ? (stringValue(error?.['message']) ?? active.failure ?? 'Codex turn failed')
        : undefined
    const unsupportedSummary = [message, active.failure].some(
      (candidate) => candidate !== undefined && isUnsupportedReasoningSummary(candidate)
    )
    if (unsupportedSummary && !active.summaryFallbackAttempted) {
      void this.retryWithoutReasoningSummary(active)
      return
    }
    void this.completeAppServerTurn(active, message)
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
    kind: 'text' | 'reasoning'
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
      field: 'text',
      delta
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

  private async completeAppServerTurn(active: CodexAppServerTurn, error?: string): Promise<void> {
    if (!error) {
      try {
        const result = await this.appServerRequest(active.host, 'account/rateLimits/read')
        const telemetry = mapCodexRateLimits(result)
        const finalMessage = [...active.session.messages]
          .reverse()
          .find((message) => message.role === 'assistant')
        if ((telemetry.rateLimits.length > 0 || telemetry.credits) && finalMessage) {
          const event: AgentEvent = {
            type: 'usage.updated',
            sessionId: active.session.id,
            messageId: finalMessage.id,
            ...(telemetry.rateLimits.length > 0 ? { rateLimits: telemetry.rateLimits } : {}),
            ...(telemetry.credits ? { credits: telemetry.credits } : {})
          }
          this.applyEventToSession(active.session, event)
          this.emit(event)
        }
      } catch (refreshError) {
        Logger.dev('Codex account rate-limit refresh unavailable:', refreshError)
      }
    }
    await this.finishAppServerTurn(active, error)
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
    systemPrompt: string | undefined,
    attachments: PromptAttachment[]
  ): Promise<Array<Record<string, unknown>>> {
    const input: Array<Record<string, unknown>> = [
      { type: 'text', text: composePrompt(systemPrompt, text), text_elements: [] }
    ]
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
   * namespaced with the CodeInOven session when parsed. Session records written
   * by older builds still hold raw item ids; normalize those on read (and
   * collapse the raw + namespaced duplicates a resumed thread can produce).
   */
  async loadMessages(projectPath: string, sessionId: string): Promise<AgentMessage[]> {
    const messages = await super.loadMessages(projectPath, sessionId)
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
    if (fastInference) {
      args.push('-c', 'service_tier=fast', '-c', 'features.fast_mode=true')
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
      composePrompt(options.systemPrompt, options.text)
    ]
      .filter(Boolean)
      .join('\n\n')
    args.push(promptBody)
    return {
      command: 'codex',
      args,
      env: { ...buildHarnessEnvironment(), ...env },
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

    const host = await this.ensureAppServerHost(projectPath, sessionId)
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
    const host = await this.ensureAppServerHost(projectPath, session.id)
    const telemetry = mapCodexRateLimits(
      await this.appServerRequest(host, 'account/rateLimits/read')
    )

    if (telemetry.rateLimits.length === 0 && !telemetry.credits) return
    const event: AgentEvent = {
      type: 'usage.updated',
      sessionId: session.id,
      messageId,
      ...(telemetry.rateLimits.length > 0 ? { rateLimits: telemetry.rateLimits } : {}),
      ...(telemetry.credits ? { credits: telemetry.credits } : {})
    }
    this.applyEventToSession(session, event)
    this.emit(event)
    await this.persistSession(session)
  }

  /**
   * Fetch current quota telemetry through the resident app-server, including
   * for old threads whose turns predate quota capture.
   */
  async readAccountUsage(
    projectPath: string
  ): Promise<{ rateLimits: AgentRateLimitWindow[]; credits?: AgentUsageCredits } | null> {
    let temporaryHost: CodexAppServerHost | null = null
    try {
      const host =
        this.hostsByProjectPath.has(projectPath) || this.hostsStartingByProjectPath.has(projectPath)
          ? await this.ensureAppServerHost(projectPath)
          : (temporaryHost = await this.createAppServerHost(projectPath))
      const telemetry = mapCodexRateLimits(
        await this.appServerRequest(host, 'account/rateLimits/read')
      )
      if (telemetry.rateLimits.length === 0 && !telemetry.credits) return null
      return telemetry
    } catch (error) {
      Logger.dev('Codex on-demand account usage refresh unavailable:', error)
      return null
    } finally {
      if (temporaryHost) {
        this.stopAppServerHost(temporaryHost, 'Codex account usage probe completed')
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
    const host = await this.ensureAppServerHost(projectPath, session.id)
    const usagePromise = new Promise<ReturnType<typeof mapCodexUsage>>((resolve) => {
      const timer = setTimeout(() => {
        this.contextUsageByThreadId.delete(nativeThreadId)
        resolve(undefined)
      }, CODEX_USAGE_TIMEOUT_MS)
      this.contextUsageByThreadId.set(nativeThreadId, { host, resolve, timer })
    })
    try {
      await this.appServerRequest(host, 'thread/resume', { threadId: nativeThreadId })
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
    if (!isRecord(value)) return null
    const type = stringValue(value['type']) ?? stringValue(value['method'])
    if (!type) return null
    if (type === 'thread.started') {
      const threadId = stringValue(value['thread_id'])
      return threadId ? { nativeSessionId: threadId } : null
    }
    if (type === 'turn.failed' || type === 'error') {
      return {
        events: [
          {
            type: 'session.error',
            sessionId: context.sessionId,
            error: errorText(value)
          }
        ]
      }
    }
    if (type === 'event_msg') {
      const payload = recordValue(value['payload'])
      if (stringValue(payload?.['type']) !== 'token_count') return null
      const usage = mapCodexUsage(payload?.['info'])
      if (!usage) return { events: [] }
      const latestMessage = [...context.session.messages]
        .reverse()
        .find((message) => message.role === 'assistant')
      if (!latestMessage) return { events: [] }
      if (usage.normalizedUsage) latestMessage.normalizedUsage = usage.normalizedUsage
      return {
        events: [
          {
            type: 'usage.updated',
            sessionId: context.sessionId,
            messageId: latestMessage.id,
            ...(usage.aggregateTokens ? { tokens: usage.aggregateTokens } : {}),
            ...(usage.normalizedUsage ? { normalizedUsage: usage.normalizedUsage } : {}),
            ...(usage.contextUsed === undefined ? {} : { contextUsed: usage.contextUsed }),
            ...(usage.contextWindow === undefined ? {} : { contextWindow: usage.contextWindow })
          }
        ]
      }
    }
    if (type === 'turn.completed') {
      const usage = mapCodexUsage(value['usage'])
      const finalMessage = [...context.session.messages]
        .reverse()
        .find(
          (message) =>
            message.role === 'assistant' && message.parts.some((part) => part.type === 'text')
        )
      if (!finalMessage) return { events: [] }
      const finalTextPart = finalMessage.parts.find(
        (part): part is Extract<AgentPart, { type: 'text' }> => part.type === 'text'
      )
      const finalPhaseUpdate =
        finalTextPart && finalTextPart.phase !== 'final_answer'
          ? {
              type: 'message.part.updated' as const,
              sessionId: context.sessionId,
              part: { ...finalTextPart, phase: 'final_answer' as const }
            }
          : undefined
      const events: SessionAgentEvent[] = finalPhaseUpdate ? [finalPhaseUpdate] : []
      if (usage) {
        if (usage.normalizedUsage) finalMessage.normalizedUsage = usage.normalizedUsage
        events.push({
          type: 'message.completed',
          sessionId: context.sessionId,
          messageId: finalMessage.id,
          ...(usage.aggregateTokens ? { tokens: usage.aggregateTokens } : {}),
          ...(usage.normalizedUsage ? { normalizedUsage: usage.normalizedUsage } : {}),
          ...(usage.contextUsed === undefined ? {} : { contextUsed: usage.contextUsed }),
          ...(usage.contextWindow === undefined ? {} : { contextWindow: usage.contextWindow })
        })
      }
      if (context.projectPath) {
        if (context.session.nativeSessionId) {
          void this.refreshContextUsage(
            context.projectPath,
            context.session,
            finalMessage.id,
            context.session.nativeSessionId
          ).catch((error) => Logger.dev('Codex context usage refresh unavailable:', error))
        }
        void this.refreshRateLimits(context.projectPath, context.session, finalMessage.id).catch(
          (error) => Logger.dev('Codex account rate-limit refresh unavailable:', error)
        )
      }
      return { events }
    }
    if (type === 'thread/tokenUsage/updated' || type === 'thread.tokenUsage.updated') {
      const params = recordValue(value['params']) ?? value
      const usage = mapCodexUsage(
        params['tokenUsage'] ?? params['token_usage'] ?? params['usage'] ?? params
      )
      if (!usage) return { events: [] }
      const latestMessage = [...context.session.messages]
        .reverse()
        .find((message) => message.role === 'assistant')
      if (!latestMessage) return { events: [] }
      if (usage.normalizedUsage) latestMessage.normalizedUsage = usage.normalizedUsage
      return {
        events: [
          {
            type: 'usage.updated',
            sessionId: context.sessionId,
            messageId: latestMessage.id,
            ...(usage.aggregateTokens ? { tokens: usage.aggregateTokens } : {}),
            ...(usage.normalizedUsage ? { normalizedUsage: usage.normalizedUsage } : {}),
            ...(usage.contextUsed === undefined ? {} : { contextUsed: usage.contextUsed }),
            ...(usage.contextWindow === undefined ? {} : { contextWindow: usage.contextWindow })
          }
        ]
      }
    }
    if (type === 'item.started' || type === 'item.completed') {
      const item = recordValue(value['item'])
      return item ? parseItem(item, type === 'item.completed', context.sessionId) : null
    }
    return null
  }
}

function sandboxFor(readOnly: boolean, permissionLevel: PermissionLevel): string {
  if (readOnly) return 'read-only'
  return permissionLevel === 'full_access' ? 'danger-full-access' : 'workspace-write'
}

function codexSandboxPolicy(
  projectPath: string,
  readOnly: boolean,
  permissionLevel: PermissionLevel
): Record<string, unknown> {
  if (readOnly) return { type: 'readOnly', networkAccess: false }
  if (permissionLevel === 'full_access') return { type: 'dangerFullAccess' }
  return {
    type: 'workspaceWrite',
    writableRoots: [projectPath],
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false
  }
}

function codexEffort(value: ThreadSettings['thinkingLevel']): string {
  // Codex calls its lowest supported reasoning effort `low`; `minimal` is the
  // cross-harness alias used by the app and by lightweight internal turns.
  if (value === 'minimal') return 'low'
  return value
}

function isUnsupportedReasoningSummary(message: string): boolean {
  const normalized = message.toLowerCase()
  return (
    normalized.includes('reasoning.summary') &&
    (normalized.includes('unsupported parameter') || normalized.includes('unsupported_parameter'))
  )
}

function normalizeAppServerItem(
  item: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (!item) return null
  const rawType = stringValue(item['type'])
  const types: Record<string, string> = {
    agentMessage: 'agent_message',
    commandExecution: 'command_execution',
    fileChange: 'file_change',
    mcpToolCall: 'mcp_tool_call',
    dynamicToolCall: 'function_call'
  }
  return {
    ...item,
    type: rawType ? (types[rawType] ?? rawType) : rawType,
    aggregated_output: item['aggregated_output'] ?? item['aggregatedOutput'],
    exit_code: item['exit_code'] ?? item['exitCode']
  }
}

function composePrompt(systemPrompt: string | undefined, text: string): string {
  return systemPrompt ? `${systemPrompt}\n\n${text}` : text
}

async function localAttachmentPath(attachment: PromptAttachment): Promise<string> {
  let path: string
  try {
    path = attachment.url.startsWith('file:') ? fileURLToPath(attachment.url) : attachment.url
  } catch {
    throw new Error(
      `Codex attachment is not a valid local file: ${attachment.filename ?? attachment.url}`
    )
  }
  try {
    const stats = await fs.stat(path)
    if (!stats.isFile()) throw new Error('not a file')
  } catch {
    throw new Error(
      `Codex attachment is not a readable local file: ${attachment.filename ?? basename(path)}`
    )
  }
  return path
}

function parseItem(
  item: Record<string, unknown>,
  completed: boolean,
  sessionId: string
): CliLineParseResult | null {
  const itemType = stringValue(item['type'])
  const itemId = stringValue(item['id'])
  if (!itemType || !itemId) return null
  // Codex item ids (e.g. `item_0`) are only unique within one Codex thread.
  // Namespace them with the CodeInOven session so the agent_messages primary
  // key never collides across threads or freshly recreated sessions.
  const messageId = `${sessionId}:${itemId}`
  if (itemType === 'agent_message') return parseAgentMessage(item, messageId, completed, sessionId)
  if (itemType === 'reasoning') return parseReasoning(item, messageId, completed, sessionId)
  if (itemType === 'command_execution') return parseCommand(item, messageId, completed, sessionId)
  if (itemType === 'file_change')
    return parseTool(item, messageId, completed, sessionId, 'file_change')
  if (itemType === 'contextCompaction')
    return parseCompaction(item, messageId, completed, sessionId)
  if (itemType === 'mcp_tool_call' || itemType === 'function_call')
    return parseTool(
      item,
      messageId,
      completed,
      sessionId,
      stringValue(item['tool']) ?? stringValue(item['name']) ?? 'mcp_tool_call'
    )
  return null
}

function parseAgentMessage(
  item: Record<string, unknown>,
  itemId: string,
  completed: boolean,
  sessionId: string
): CliLineParseResult {
  const text = stringValue(item['text']) ?? ''
  const phase = stringValue(item['phase'])
  const normalizedPhase: 'commentary' | 'final_answer' =
    phase === 'final_answer' ? 'final_answer' : 'commentary'
  const part = {
    type: 'text' as const,
    id: `${itemId}:text`,
    messageID: itemId,
    text,
    phase: normalizedPhase
  }
  const events: SessionAgentEvent[] = [{ type: 'message.part.updated', sessionId, part }]
  const message: AgentMessage = {
    id: itemId,
    role: 'assistant',
    parts: [part],
    createdAt: Date.now()
  }
  if (completed) {
    message.completedAt = Date.now()
    events.push({ type: 'message.completed', sessionId, messageId: itemId })
  }
  return { events, messages: [message] }
}

function parseReasoning(
  item: Record<string, unknown>,
  itemId: string,
  completed: boolean,
  sessionId: string
): CliLineParseResult {
  const text = stringValue(item['text']) ?? ''
  const summary = arrayText(item['summary'])
  const part = {
    type: 'reasoning' as const,
    id: `${itemId}:reasoning`,
    messageID: itemId,
    text,
    ...(summary ? { summary } : {})
  }
  const events: SessionAgentEvent[] = [{ type: 'message.part.updated', sessionId, part }]
  if (completed) events.push({ type: 'message.completed', sessionId, messageId: itemId })
  const message: AgentMessage = {
    id: itemId,
    role: 'assistant',
    parts: [part],
    createdAt: Date.now()
  }
  return { events, messages: [message] }
}

function parseCommand(
  item: Record<string, unknown>,
  itemId: string,
  completed: boolean,
  sessionId: string
): CliLineParseResult {
  const command = stringValue(item['command'])
  return parseTool(item, itemId, completed, sessionId, 'command_execution', command)
}

function parseTool(
  item: Record<string, unknown>,
  itemId: string,
  completed: boolean,
  sessionId: string,
  providerTool: string,
  command?: string
): CliLineParseResult {
  const providerStatus = stringValue(item['status'])
  const failed = completed && (providerStatus === 'failed' || providerStatus === 'error')
  const toolPart = {
    type: 'tool' as const,
    id: `${itemId}:tool`,
    messageID: itemId,
    callID: itemId,
    tool: providerTool,
    state: {
      status: !completed
        ? ('running' as const)
        : failed
          ? ('error' as const)
          : ('completed' as const),
      input: toolInput(item),
      title: command,
      output: toolOutput(item)
    }
  }
  const events: SessionAgentEvent[] = [{ type: 'message.part.updated', sessionId, part: toolPart }]
  const message: AgentMessage = {
    id: itemId,
    role: 'assistant',
    parts: [toolPart],
    createdAt: Date.now()
  }
  return { events, messages: [message] }
}

function parseCompaction(
  item: Record<string, unknown>,
  itemId: string,
  completed: boolean,
  sessionId: string
): CliLineParseResult {
  const summary = stringValue(item['summary']) ?? stringValue(item['text'])
  const part = {
    type: 'compaction' as const,
    id: `${itemId}:compaction`,
    messageID: itemId,
    auto: true,
    ...(summary ? { summary } : {})
  }
  const events: SessionAgentEvent[] = [{ type: 'message.part.updated', sessionId, part }]
  if (completed) {
    events.push({ type: 'message.completed', sessionId, messageId: itemId, compaction: true })
  }
  const message: AgentMessage = {
    id: itemId,
    role: 'assistant',
    parts: [part],
    createdAt: Date.now()
  }
  return { events, messages: [message] }
}

function toolInput(item: Record<string, unknown>): Record<string, unknown> {
  for (const key of ['arguments', 'input', 'params']) {
    const value = item[key]
    const record = recordValue(value)
    if (record) return record
    if (typeof value !== 'string') continue
    try {
      const parsed = JSON.parse(value)
      const parsedRecord = recordValue(parsed)
      if (parsedRecord) return parsedRecord
    } catch {
      // Preserve schema tolerance for non-JSON provider payloads.
    }
  }
  if (Array.isArray(item['changes'])) return { changes: item['changes'] }
  return {}
}

function toolOutput(item: Record<string, unknown>): string | undefined {
  for (const key of ['result', 'output', 'aggregated_output']) {
    const text = outputText(item[key])
    if (text) return text
  }
  return undefined
}

function outputText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined
  if (Array.isArray(value)) {
    const text = value
      .map(outputText)
      .filter((entry): entry is string => Boolean(entry))
      .join('\n')
    return text || undefined
  }
  const record = recordValue(value)
  if (!record) return undefined

  const nested = ['text', 'content', 'output', 'result', 'structured_content']
    .map((key) => outputText(record[key]))
    .filter((entry): entry is string => Boolean(entry))
  if (nested.length > 0) return [...new Set(nested)].join('\n')

  try {
    return JSON.stringify(record)
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}
function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}
function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function appServerRequestId(value: unknown): string | number | undefined {
  return stringValue(value) ?? numberValue(value)
}

/** Map Codex accounting into the canonical normalized contract and display aggregates. */
function mapCodexTokenRecord(value: Record<string, unknown>): {
  aggregateTokens: AgentTokenUsage | undefined
  normalizedUsage: NormalizedUsage | undefined
} {
  const input =
    numberValue(value['inputTokens']) ??
    numberValue(value['input_tokens']) ??
    numberValue(value['input'])
  const output =
    numberValue(value['outputTokens']) ??
    numberValue(value['output_tokens']) ??
    numberValue(value['output'])
  const reasoning =
    numberValue(value['reasoningOutputTokens']) ??
    numberValue(value['reasoning_output_tokens']) ??
    numberValue(value['reasoning'])
  const cachedInput =
    numberValue(value['cachedInputTokens']) ??
    numberValue(value['cached_input_tokens']) ??
    numberValue(value['cacheRead'])
  const cacheWrite =
    numberValue(value['cacheWriteTokens']) ??
    numberValue(value['cache_write_tokens']) ??
    numberValue(value['cacheWrite'])
  const rawTotal = numberValue(value['totalTokens']) ?? numberValue(value['total_tokens'])
  const reported =
    input !== undefined ||
    output !== undefined ||
    reasoning !== undefined ||
    cachedInput !== undefined ||
    cacheWrite !== undefined ||
    rawTotal !== undefined
  if (!reported) return { aggregateTokens: undefined, normalizedUsage: undefined }
  // Codex reports `input` as the cache-inclusive input count, and cached input
  // is a subset of it, so uncached input is the remainder after the reported
  // cache portion is removed. A defensive clamp keeps a malformed cache value
  // that exceeds the input from producing a negative token count; when input is
  // absent uncached input stays null because there is nothing to subtract from.
  const uncachedInput = input === undefined ? null : Math.max(0, input - (cachedInput ?? 0))
  const normalizedUsage: NormalizedUsage = {
    uncachedInput,
    cachedInput: cachedInput ?? null,
    cacheWrite: cacheWrite ?? null,
    output: output ?? null,
    reasoning: reasoning ?? null,
    rawProviderUsage: { ...value },
    rawTotal: rawTotal ?? null,
    // Codex totals its cache-inclusive input (cached input and reasoning are
    // subsets of input/output), so a reported total includes cached tokens.
    // When no total is reported its semantics are unavailable.
    totalSemantics: rawTotal === undefined ? 'unavailable' : 'includes_cache'
  }
  const aggregateTokens: AgentTokenUsage | undefined =
    rawTotal === undefined
      ? undefined
      : {
          input: input ?? 0,
          output: output ?? 0,
          reasoning: reasoning ?? 0,
          cacheRead: cachedInput ?? 0,
          cacheWrite: cacheWrite ?? 0,
          total: rawTotal
        }
  return { aggregateTokens, normalizedUsage }
}

export function mapCodexUsage(value: unknown):
  | {
      aggregateTokens: AgentTokenUsage | undefined
      normalizedUsage: NormalizedUsage | undefined
      contextWindow?: number
      contextUsed?: number
    }
  | undefined {
  const usage = recordValue(value)
  if (!usage) return undefined

  const tokenUsage = recordValue(usage['tokenUsage']) ?? recordValue(usage['token_usage']) ?? usage
  const last =
    recordValue(tokenUsage['last']) ??
    recordValue(tokenUsage['lastTokenUsage']) ??
    recordValue(tokenUsage['last_token_usage']) ??
    tokenUsage
  const totalUsage =
    recordValue(tokenUsage['total']) ??
    recordValue(tokenUsage['totalUsage']) ??
    recordValue(tokenUsage['total_usage']) ??
    recordValue(tokenUsage['totalTokenUsage']) ??
    recordValue(tokenUsage['total_token_usage'])

  const lastRecord = mapCodexTokenRecord(last)
  const totalRecord = totalUsage ? mapCodexTokenRecord(totalUsage) : undefined
  const selectedRecord = lastRecord.normalizedUsage !== undefined ? lastRecord : totalRecord
  if (!selectedRecord?.normalizedUsage) return undefined

  const contextUsed =
    numberValue(last['inputTokens']) ??
    numberValue(last['input_tokens']) ??
    numberValue(last['input']) ??
    numberValue(tokenUsage['contextUsed']) ??
    numberValue(tokenUsage['context_used']) ??
    totalRecord?.aggregateTokens?.total ??
    numberValue(tokenUsage['totalTokens']) ??
    numberValue(tokenUsage['total_tokens'])
  const contextWindow =
    numberValue(tokenUsage['modelContextWindow']) ??
    numberValue(tokenUsage['model_context_window']) ??
    numberValue(tokenUsage['contextWindow']) ??
    numberValue(tokenUsage['context_window'])
  return {
    aggregateTokens: selectedRecord.aggregateTokens,
    normalizedUsage: selectedRecord.normalizedUsage,
    ...(contextUsed === undefined ? {} : { contextUsed }),
    ...(contextWindow === undefined ? {} : { contextWindow })
  }
}

function rateLimitLabel(window: Record<string, unknown>, fallback: string): string {
  const minutes = numberValue(window['windowDurationMins'])
  if (minutes === 300) return '5-hour limit'
  if (minutes === 10_080) return 'Weekly limit'
  if (minutes !== undefined) {
    if (minutes % 1_440 === 0) return `${minutes / 1_440}-day limit`
    if (minutes % 60 === 0) return `${minutes / 60}-hour limit`
    return `${minutes}-minute limit`
  }
  return fallback
}

/**
 * Normalize one Codex `RateLimitSnapshot` window (primary/secondary) plus the
 * per-limit metadata (window length, credits, plan) into the shared shape.
 * `credits.balance` is a decimal string from the server; it is parsed to a
 * number so the battery can render it.
 */
function mapCodexRateLimitSnapshot(
  limitId: string,
  snapshot: Record<string, unknown>,
  modelSuffix: string | undefined
): { rateLimits: AgentRateLimitWindow[]; credits?: AgentUsageCredits } {
  const mapped: AgentRateLimitWindow[] = []
  const primary = recordValue(snapshot['primary'])
  const secondary = recordValue(snapshot['secondary'])
  const windows: Array<[string, Record<string, unknown> | null, string]> = [
    ['primary', primary, 'Primary limit'],
    ['secondary', secondary, 'Secondary limit']
  ]
  for (const [key, window, fallback] of windows) {
    if (!window) continue
    const usedPercent = numberValue(window['usedPercent'])
    const resetsAt = numberValue(window['resetsAt'])
    const windowMinutes = numberValue(window['windowDurationMins'])
    if (usedPercent === undefined && resetsAt === undefined) continue
    const baseLabel = rateLimitLabel(window, fallback)
    mapped.push({
      id: `codex:${limitId}:${key}`,
      label: modelSuffix ? `${modelSuffix} · ${baseLabel}` : baseLabel,
      ...(usedPercent === undefined
        ? {}
        : { usedPercent: Math.max(0, Math.min(100, usedPercent)) }),
      ...(resetsAt === undefined ? {} : { resetsAt: resetsAt * 1_000 }),
      ...(windowMinutes === undefined ? {} : { windowMinutes }),
      ...(modelSuffix === undefined ? {} : { model: modelSuffix })
    })
  }

  const creditsValue = recordValue(snapshot['credits'])
  let credits: AgentUsageCredits | undefined
  if (creditsValue) {
    const hasCredits = creditsValue['hasCredits'] === true
    const unlimited = creditsValue['unlimited'] === true
    const rawBalance = creditsValue['balance']
    const balance =
      typeof rawBalance === 'string' ? Number.parseFloat(rawBalance) : numberValue(rawBalance)
    if (hasCredits || unlimited || balance !== undefined) {
      credits = {
        ...(typeof creditsValue['hasCredits'] === 'boolean' ? { hasCredits } : {}),
        ...(typeof creditsValue['unlimited'] === 'boolean' ? { unlimited } : {}),
        ...(balance !== undefined && Number.isFinite(balance) ? { balance } : {})
      }
    }
  }

  return { rateLimits: mapped, ...(credits ? { credits } : {}) }
}

/**
 * Map Codex's `account/rateLimits/read` payload into display windows. The
 * response carries a backward-compatible single-bucket `rateLimits` view plus a
 * `rateLimitsByLimitId` map for model-specific quotas (e.g. a separate
 * GPT-Codex-Spark limit). Prefer the per-limit map when present so model-scoped
 * windows are never collapsed into the default buckets.
 */
export function mapCodexRateLimits(value: unknown): {
  rateLimits: AgentRateLimitWindow[]
  credits?: AgentUsageCredits
} {
  const result = recordValue(value)
  if (!result) return { rateLimits: [] }
  const byLimitId = recordValue(result['rateLimitsByLimitId'])
  const limits = recordValue(result['rateLimits'])
  const mapped: AgentRateLimitWindow[] = []
  let credits: AgentUsageCredits | undefined

  if (byLimitId && Object.keys(byLimitId).length > 0) {
    for (const [limitId, raw] of Object.entries(byLimitId)) {
      const snapshot = recordValue(raw)
      if (!snapshot) continue
      const limitName = stringValue(snapshot['limitName']) ?? limitId
      const modelSuffix = limitId === 'codex' ? undefined : limitName
      const mappedSnapshot = mapCodexRateLimitSnapshot(limitId, snapshot, modelSuffix)
      mapped.push(...mappedSnapshot.rateLimits)
      if (mappedSnapshot.credits) credits = mappedSnapshot.credits
    }
  } else if (limits) {
    const mappedSnapshot = mapCodexRateLimitSnapshot('codex', limits, undefined)
    mapped.push(...mappedSnapshot.rateLimits)
    if (mappedSnapshot.credits) credits = mappedSnapshot.credits
  }

  if (credits) {
    const planType = stringValue(limits?.['planType']) ?? stringValue(result['planType'])
    if (planType) credits = { ...credits, planType }
  }
  return { rateLimits: mapped, ...(credits ? { credits } : {}) }
}

/**
 * Rewrite a legacy codex message id into its session-namespaced form. Only
 * assistant messages carry raw codex item ids; user messages keep the
 * generated id CodeInOven assigned at send time.
 */
function namespacedMessage(message: AgentMessage, sessionId: string): AgentMessage {
  const prefix = `${sessionId}:`
  if (message.role !== 'assistant' || message.id.startsWith(prefix)) return message
  const messageId = `${prefix}${message.id}`
  const parts = message.parts.map((part) => ({
    ...part,
    id: part.messageID === message.id ? `${prefix}${part.id}` : part.id,
    messageID: part.messageID === message.id ? messageId : part.messageID,
    ...(part.type === 'tool' && part.callID === message.id ? { callID: messageId } : {})
  }))
  return { ...message, id: messageId, parts }
}
function arrayText(value: unknown): string {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string').join('\n')
    : ''
}
function errorText(value: Record<string, unknown>): string {
  return stringValue(value['message']) ?? stringValue(value['error']) ?? 'Codex CLI failed'
}
