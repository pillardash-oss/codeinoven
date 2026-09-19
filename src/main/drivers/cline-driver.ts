import { chmod, mkdir, readdir, readFile, rm, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import type { BaseUrlProvider, ProviderCatalog, ProviderModel } from '../../lib/types'
import { isQuestionToolName } from '../../lib/agent-interactions'
import type {
  CliLineParseContext,
  CliLineParseResult,
  CliTurnCommand,
  PersistentCliSession,
  TitleModelCandidate
} from './persistent-cli-driver'
import { PersistentCliDriver } from './persistent-cli-driver'
import {
  QuestionRequestGoneError,
  type GenerateTitleOptions,
  type GradeTurnOptions,
  type HarnessCapabilities,
  type SendPromptOptions,
  type UtilityRuntimeOverlay,
  type UtilityRuntimePreparationRequest
} from './driver.interface'
import { PermissionPolicy } from '../permissions/permission-policy'
import { Logger } from '../system/logger'
import { buildProcessEnvironment } from './cli-environment'
import { attachmentReferences, attachmentTarget } from './attachment-reference'
import { runHarnessCommand } from './harness-runtime'
import type { BaseUrlProviderService } from '../providers/base-url-provider-service'
import type { SecretVault } from '../storage/secret-vault'
import type { StorageEngine } from '../storage/storage-engine'
import {
  clineApprovalRequest,
  clineWebOnlyHook,
  isClineWebOnlyTurn,
  type ClineApprovalBridge
} from './cline/cline-approval'
import {
  CLINE_FALLBACK_CATALOG,
  CLINE_PASS_PROVIDER_ID,
  CLINE_THINKING_LEVELS,
  CLINE_THINKING_PRESETS,
  applyClineObservedContextWindows,
  clineFreeModelIds,
  cloneCatalogs,
  fetchClineCatalog,
  filterClineCatalogForAccount,
  hasClinePassSubscription,
  isClineAvailable,
  observeClineContextWindow,
  refreshClineCatalogOnce
} from './cline/cline-models'
import { clineModelContextWindow } from './cline/cline-usage'
import { mapClineRecord, mapCurrentClineRecord } from './cline/cline-stream-fold'
import type { ClineTurnState } from './cline/cline-stream-fold'
import { record, stringValue, utilityKey } from './cline/cline-values'

export class ClineDriver extends PersistentCliDriver {
  readonly id = 'cline'
  readonly name = 'Cline'
  readonly capabilities: HarnessCapabilities = {
    runtimeTopology: { kind: 'turn_process', scope: 'session' },
    streaming: true,
    steering: true,
    // Cline 3.x currently routes `--id` into its interactive code path when
    // combined with `--json`, rejecting the positional prompt. Replay the
    // durable CodeInOven transcript instead so retry remains deterministic.
    nativeResume: false,
    messageHistory: 'mirrored',
    interactivePermissions: false,
    attachments: true,
    commands: false,
    providerCatalog: true,
    sessionStatus: false,
    // Emits per-iteration token, cost and context-occupancy telemetry, and
    // reports the model context window it resolved on every run result.
    contextUsage: true,
    compaction: false,
    subagents: false,
    nativeUtilities: ['web_search', 'web_fetch']
  }

  private turnStates = new Map<string, ClineTurnState>()
  private turnCounts = new Map<string, number>()
  /** Approval bridges keyed by CodeInOven session id; cleaned up on turn end. */
  private approvalBridges = new Map<string, ClineApprovalBridge>()
  /** Web-only hook directories keyed by CodeInOven session id. */
  private webOnlyHookDirectories = new Map<string, string>()
  /**
   * Options of the turn that raised a pending question, kept so the user's
   * answer can resume the stateless turn as a continuation prompt.
   */
  private continuationOptions = new Map<string, SendPromptOptions>()
  /** Sessions whose continuation prompt must stay out of the visible transcript. */
  private hiddenContinuationSessions = new Set<string>()

  constructor(
    storage: StorageEngine,
    private readonly baseUrlProviders?: BaseUrlProviderService,
    private readonly secretVault?: SecretVault
  ) {
    super(storage)
  }

  /** The enabled custom base-URL provider matching a selected provider id, if any. */
  private async resolveCustomProvider(
    providerId: string | undefined
  ): Promise<BaseUrlProvider | null> {
    if (!providerId || !this.baseUrlProviders || !this.secretVault) return null
    const provider = await this.baseUrlProviders.getProvider(this.id, providerId)
    if (!provider || provider.harnessId !== this.id || !provider.enabled) return null
    return provider
  }

  protected async ensureCliReady(projectPath: string): Promise<void> {
    await runHarnessCommand('cline', ['--version'], {
      cwd: projectPath,
      env: buildProcessEnvironment(),
      timeoutMs: 10_000
    })
  }

  async listProviders(): Promise<ProviderCatalog[]> {
    const customProviders = this.baseUrlProviders
      ? await this.baseUrlProviders.listEnabled(this.id)
      : []
    const appendCustom = (catalogs: ProviderCatalog[]): ProviderCatalog[] => {
      for (const custom of customProviders) {
        catalogs.push({
          id: custom.id,
          name: custom.name,
          harnessId: 'cline',
          models: custom.models.map((model) => ({
            id: model.id,
            providerId: custom.id,
            name: model.name || model.id,
            reasoning: model.reasoning,
            thinkingPresets: model.reasoning ? CLINE_THINKING_PRESETS : undefined,
            attachment: model.vision !== false,
            toolcall: true,
            ...(model.contextWindow ? { contextWindow: model.contextWindow } : {})
          }))
        })
      }
      return catalogs
    }

    // Do not pay a network round-trip for Cline's remote catalog when the
    // harness is not installed   return the static fallback instead.
    if (!(await isClineAvailable())) {
      return applyClineObservedContextWindows(appendCustom(cloneCatalogs(CLINE_FALLBACK_CATALOG)))
    }
    // The chat engine already gives slow driver probes a background enrichment
    // path. Await Cline's live feed here so that enrichment persists the real
    // free-model list instead of persisting the baked-in fallback for a day.
    const [remote, hasClinePass] = await Promise.all([
      refreshClineCatalogOnce(),
      hasClinePassSubscription()
    ])
    const discovered = remote.length > 0 ? remote : cloneCatalogs(CLINE_FALLBACK_CATALOG)
    return applyClineObservedContextWindows(
      appendCustom(filterClineCatalogForAccount(discovered, hasClinePass))
    )
  }

  /** Cheapest available free/pass models, shared by title and grading runs. */
  private async cheapestCandidates(): Promise<TitleModelCandidate[]> {
    const remote = await fetchClineCatalog()
    const catalogs = remote.length > 0 ? remote : await this.listProviders()
    const models = catalogs.flatMap((catalog) => catalog.models)
    const free = clineFreeModelIds
      .map((modelId) => models.find((model) => model.id === modelId))
      .filter((model): model is ProviderModel => model !== undefined)
      .sort(
        (left, right) => Number(!/flash/iu.test(left.id)) - Number(!/flash/iu.test(right.id))
      )[0]
    const passFlash = models.find(
      (model) =>
        model.providerId === CLINE_PASS_PROVIDER_ID && model.id === 'cline-pass/deepseek-v4-flash'
    )
    return [
      ...(free ? [{ providerId: free.providerId, modelId: free.id }] : []),
      ...(passFlash ? [{ providerId: passFlash.providerId, modelId: passFlash.id }] : [])
    ]
  }

  async generateTitle(projectPath: string, options: GenerateTitleOptions): Promise<string | null> {
    return this.generateTitleWithCandidates(
      projectPath,
      options,
      options.candidates ?? (await this.cheapestCandidates())
    )
  }

  async gradeTurn(projectPath: string, options: GradeTurnOptions): Promise<number | null> {
    return this.gradeTurnWithCandidates(
      projectPath,
      options,
      options.candidates ?? (await this.cheapestCandidates())
    )
  }

  /** Cheapest candidates for any auxiliary one-shot run. */
  protected override async cheapCandidateModels(): Promise<TitleModelCandidate[]> {
    return this.cheapestCandidates()
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
          throw new TypeError(`Cline MCP utility "${utility.name}" requires a command`)
        }
        mcpServers[key] = {
          command: config.command,
          args: [...(config.args ?? [])],
          env: { ...(config.environment ?? {}) },
          disabled: false
        }
        continue
      }
      if (!config.url) throw new TypeError(`Cline MCP utility "${utility.name}" requires a URL`)
      mcpServers[key] = {
        type: config.transport === 'sse' ? 'sse' : 'streamableHttp',
        url: config.url,
        ...(config.headers ? { headers: config.headers } : {}),
        disabled: false
      }
    }

    if (Object.keys(mcpServers).length === 0) return {}
    // Override only MCP settings; moving the data directory hides the user's
    // account access and refresh tokens. Each launch gets its own MCP config.
    return {
      env: { CLINE_MCP_SETTINGS_PATH: '{{config:cline-mcp}}' },
      configFiles: [
        {
          id: 'cline-mcp',
          relativePath: 'cline-data/settings/cline_mcp_settings.json',
          content: JSON.stringify({ mcpServers }, null, 2)
        }
      ]
    }
  }

  protected async buildTurnCommand(
    projectPath: string,
    session: PersistentCliSession,
    options: SendPromptOptions
  ): Promise<CliTurnCommand> {
    const args: string[] = ['--json']
    const previousTurnCount = Math.max(
      this.turnCounts.get(session.id) ?? 0,
      session.messages.filter((message) => message.role === 'user').length,
      session.messages.filter((message) => message.role === 'assistant').length
    )
    const turnIndex = previousTurnCount + 1
    this.turnCounts.set(session.id, turnIndex)
    this.turnStates.set(session.id, {
      turnIndex,
      iteration: 1,
      messageId: `cline:${session.id}:${turnIndex}:1`,
      createdAt: Date.now(),
      parts: [],
      questionRequestIds: new Set()
    })

    const customProvider = await this.resolveCustomProvider(options.settings.providerId)
    let modelId =
      options.settings.modelId && options.settings.modelId !== 'default'
        ? options.settings.modelId
        : (customProvider?.models[0]?.id ?? options.settings.modelId)

    if (
      !customProvider &&
      options.settings.providerId === CLINE_PASS_PROVIDER_ID &&
      modelId?.startsWith(`${CLINE_PASS_PROVIDER_ID}/`) &&
      !(await hasClinePassSubscription())
    ) {
      // Existing threads may still point at a subscription model saved before
      // account-aware discovery was introduced. Route those turns to a live
      // free model so retry works immediately without another setup step.
      await fetchClineCatalog()
      modelId =
        clineFreeModelIds.find((id) => /deepseek.*flash/iu.test(id)) ??
        clineFreeModelIds[0] ??
        modelId
    }

    if (customProvider) {
      // Cline keeps a single `openai-compatible` slot, so a custom endpoint is
      // seeded into an app-owned data dir and selected through that stable id.
      args.push('-P', 'openai-compatible')
      if (modelId) args.push('-m', modelId)
    } else {
      if (modelId && modelId !== 'default') args.push('-m', modelId)
      if (options.settings.providerId) args.push('-P', options.settings.providerId)
    }

    if (options.systemPrompt) {
      args.push('-s', options.systemPrompt)
    }

    const thinking = CLINE_THINKING_LEVELS[options.settings.thinkingLevel]
    if (thinking) args.push('--thinking', thinking)

    const webOnlyTurn = isClineWebOnlyTurn(options.allowedTools)
    const webOnlyHookDirectory = webOnlyTurn
      ? await this.prepareWebOnlyHook(session.id, options)
      : undefined

    if (options.settings.permissionLevel === 'full_access' || webOnlyTurn) {
      args.push('--auto-approve', 'true')
    } else {
      args.push('--auto-approve', 'false')
    }
    if (webOnlyHookDirectory) args.push('--hooks-dir', webOnlyHookDirectory)

    args.push('-c', projectPath)

    // Cline 3 treats a single-word positional prompt as an unquoted command.
    // A trailing newline preserves the prompt while selecting headless prompt mode.
    const attached = await attachmentReferences(options.attachments)
    const promptBody = [attached, options.text].filter(Boolean).join('\n\n')
    const prompt = /\s/u.test(promptBody) ? promptBody : `${promptBody}\n`
    args.push(prompt)

    const env = buildProcessEnvironment()
    if (customProvider) {
      await this.seedCustomProvider(customProvider, modelId, session, env)
    }
    // Run Cline in-process (per-turn CLI process) instead of delegating to the
    // background hub daemon. When the hub owns the session, the CLI child is
    // only a stream client, so aborting the thread cannot stop the in-flight
    // run and headless tool approvals never reach an interactive session. A
    // local backend keeps the session in this process: killing it aborts the
    // turn, and the desktop approval bridge below can answer tool requests.
    env['CLINE_SESSION_BACKEND_MODE'] = 'local'

    let onProcessExit: (() => void) | undefined
    if (options.settings.permissionLevel !== 'full_access' && !webOnlyTurn) {
      const bridge = await this.startApprovalBridge(
        session.id,
        projectPath,
        options.readOnly === true ? 'read_only' : 'auto_review'
      )
      env['CLINE_TOOL_APPROVAL_MODE'] = 'desktop'
      env['CLINE_TOOL_APPROVAL_DIR'] = bridge.directory
      onProcessExit = () => this.stopApprovalBridge(session.id)
    } else if (webOnlyHookDirectory) {
      onProcessExit = () => this.stopWebOnlyHook(session.id)
    }

    // Continuation support for headless questions: Cline's headless
    // `ask_question` executor never blocks on stdin (it resolves with the
    // first option immediately), so the only way to honor a user's answer is
    // to stop the turn at the question boundary and resume it with the
    // user's answers as a new turn. The durable CodeInOven transcript replays
    // the conversation (`nativeResume: false`, `messageHistory: 'mirrored'`).
    const turnState = this.turnStates.get(session.id)
    if (turnState && turnState.questionRequestIds.size === 0) {
      this.continuationOptions.set(session.id, {
        ...options,
        settings: { ...options.settings },
        attachments: [...options.attachments]
      })
    }

    return {
      command: 'cline',
      args,
      env,
      parseStderrJson: true,
      onJsonRecord: (value) => {
        // The question tool call just started (its `content_end` record carries
        // the full input). Stop the process at this boundary: the turn result
        // is otherwise meaningless because the executor auto-picked an option.
        const envelope = record(value)
        const event = record(envelope?.['event'])
        if (
          turnState &&
          stringValue(envelope?.['type']) === 'agent_event' &&
          stringValue(event?.['type']) === 'content_end' &&
          stringValue(event?.['contentType']) === 'tool' &&
          isQuestionToolName(stringValue(event?.['toolName']) ?? '')
        ) {
          turnState.expectsProcessStop = true
          this.stopActiveProcess(session.id)
        }
      },
      suppressIdle: () => turnState !== undefined && turnState.questionRequestIds.size > 0,
      isExpectedExit: () => turnState?.expectsProcessStop === true,
      ...(onProcessExit ? { onProcessExit } : {})
    }
  }

  private async prepareWebOnlyHook(sessionId: string, options: SendPromptOptions): Promise<string> {
    const safeSessionId = sessionId.replace(/[^a-zA-Z0-9._-]+/gu, '_')
    const relativeDirectory = `drivers/cline/hooks/${safeSessionId}`
    const relativeHookPath = `${relativeDirectory}/PreToolUse`
    const attachmentPaths = (
      await Promise.all(
        options.attachments.map(async (attachment) => {
          const target = await attachmentTarget(attachment)
          return /^(?:data:|https?:\/\/)/u.test(target) ? null : target
        })
      )
    ).filter((path): path is string => path !== null)
    await this.storage.writeRaw(relativeHookPath, clineWebOnlyHook(attachmentPaths))
    const hookPath = this.storage.resolve(relativeHookPath)
    await chmod(hookPath, 0o700)
    const directory = this.storage.resolve(relativeDirectory)
    this.webOnlyHookDirectories.set(sessionId, directory)
    return directory
  }

  private stopWebOnlyHook(sessionId: string): void {
    const directory = this.webOnlyHookDirectories.get(sessionId)
    if (!directory) return
    this.webOnlyHookDirectories.delete(sessionId)
    void rm(directory, { recursive: true, force: true }).catch(() => undefined)
  }

  private async startApprovalBridge(
    sessionId: string,
    projectPath: string,
    mode: 'read_only' | 'auto_review'
  ): Promise<ClineApprovalBridge> {
    const directory = join(this.storage.resolve('drivers/cline'), 'approvals', sessionId)
    await mkdir(directory, { recursive: true })
    const policy = new PermissionPolicy({ projectRoot: projectPath, mode: 'auto_review' })
    const handled = new Set<string>()
    const pending = new Map<string, Promise<void>>()
    const sweep = (): void => {
      void this.sweepApprovalRequests(
        directory,
        projectPath,
        policy,
        mode === 'read_only',
        handled,
        pending
      )
    }
    const timer = setInterval(sweep, 250)
    timer.unref()
    const bridge: ClineApprovalBridge = { directory, timer, handled }
    this.approvalBridges.set(sessionId, bridge)
    sweep()
    return bridge
  }

  private async sweepApprovalRequests(
    directory: string,
    projectPath: string,
    policy: PermissionPolicy,
    readOnly: boolean,
    handled: Set<string>,
    pending: Map<string, Promise<void>>
  ): Promise<void> {
    let entries: string[]
    try {
      // Cline names request files `<sessionId>.request.<requestId>.json` and
      // waits for `<sessionId>.decision.<requestId>.json`.
      entries = (await readdir(directory)).filter((entry) => /\.request\.[^.]+\.json$/u.test(entry))
    } catch {
      return
    }
    for (const entry of entries) {
      if (handled.has(entry) || pending.has(entry)) continue
      const requestPath = join(directory, entry)
      const decisionPath = join(directory, entry.replace(/\.request\./u, '.decision.'))
      pending.set(
        entry,
        (async () => {
          try {
            const raw = await readFile(requestPath, 'utf8')
            const payload: unknown = JSON.parse(raw)
            const request = clineApprovalRequest((payload as Record<string, unknown>) ?? {})
            // Read-only turns only permit read tools; everything else is denied
            // outright because the CLI can never surface an interactive prompt.
            const decision =
              readOnly && request.permission !== 'read'
                ? {
                    approved: false,
                    reason: 'This prompt is read-only; only read tools are allowed.'
                  }
                : policy.evaluate(request)
            await writeFile(
              decisionPath,
              `${JSON.stringify({
                approved: decision.approved,
                ...(decision.reason ? { reason: decision.reason } : {})
              })}\n`,
              'utf8'
            )
            await unlink(requestPath).catch(() => undefined)
            handled.add(entry)
          } catch {
            // Cline may still be streaming the request file (or the JSON is
            // malformed)   leave the request in place so the next sweep can
            // revisit it instead of silently denying the tool.
            Logger.dev('Cline approval request could not be evaluated yet:', {
              projectPath,
              entry
            })
          } finally {
            pending.delete(entry)
          }
        })()
      )
    }
  }

  private stopApprovalBridge(sessionId: string): void {
    const bridge = this.approvalBridges.get(sessionId)
    if (!bridge) return
    clearInterval(bridge.timer)
    this.approvalBridges.delete(sessionId)
    void rm(bridge.directory, { recursive: true, force: true }).catch(() => undefined)
  }

  /**
   * Write Cline's `providers.json` for one custom endpoint and point Cline at
   * the app-owned data dir. When a per-turn utility runtime is active its
   * directory is reused (auto-cleaned after the turn); otherwise a stable
   * driver-owned directory beneath the config root is used. When no custom
   * provider is selected Cline keeps running against the user's real `~/.cline`.
   */
  private async seedCustomProvider(
    provider: BaseUrlProvider,
    modelId: string | undefined,
    session: PersistentCliSession,
    env: NodeJS.ProcessEnv
  ): Promise<void> {
    const runtime = this.utilityRuntime(session.id)
    const dataDir = runtime
      ? join(runtime.directory, 'config', 'cline-data')
      : join(this.storage.resolve('drivers/cline'), 'isolated')
    const apiKey = provider.apiKeyRef
      ? await this.secretVault?.resolve(provider.apiKeyRef)
      : undefined
    const store = {
      version: 1,
      lastUsedProvider: 'openai-compatible',
      providers: {
        'openai-compatible': {
          settings: {
            provider: 'openai-compatible',
            ...(apiKey ? { apiKey } : { apiKey: 'local' }),
            ...(modelId ? { model: modelId } : {}),
            baseUrl: provider.baseURL
          },
          updatedAt: new Date().toISOString(),
          tokenSource: 'manual'
        }
      }
    }
    await mkdir(join(dataDir, 'settings'), { recursive: true })
    await writeFile(
      join(dataDir, 'settings', 'providers.json'),
      `${JSON.stringify(store, null, 2)}\n`
    )
    env['CLINE_DATA_DIR'] = dataDir
  }

  protected parseJsonLine(value: unknown, context: CliLineParseContext): CliLineParseResult | null {
    const entry = record(value)
    const state = this.turnStates.get(context.sessionId)
    if (entry) {
      if (stringValue(entry['type']) === 'run_result') {
        this.learnModelContextWindow(context.sessionId, entry)
      }
      if (state) {
        const current = mapCurrentClineRecord(entry, context, state)
        if (current) return current
      }
    }
    return mapClineRecord(value, context)
  }

  /**
   * Learn the context window Cline resolved for the model it just ran.
   *
   * Cline's catalog publishes no window, so this run result is the app's only
   * source for one. A newly learned value changes the denominator of the
   * occupancy meter and the budget a history recap is truncated against, for
   * every project, so it is worth asking the engine to re-list the catalogs.
   */
  private learnModelContextWindow(sessionId: string, entry: Record<string, unknown>): void {
    const model = record(entry['model'])
    const modelId = stringValue(model?.['id'])
    const contextWindow = clineModelContextWindow(model)
    if (!modelId || contextWindow === undefined) return
    if (!observeClineContextWindow(modelId, contextWindow)) return
    Logger.dev('Cline reported a model context window the catalog did not have', {
      sessionId,
      modelId,
      contextWindow
    })
    this.emit({ type: 'catalog.updated', harnessId: this.id })
  }

  /**
   * Resume a question-blocked Cline turn with the user's answers. Cline
   * cannot receive interactive replies (headless `ask_question` resolves
   * instantly), so the blocked turn is settled and restarted with the
   * answers woven into a continuation prompt. Mirrors the Muse driver's
   * interaction continuation contract.
   */
  override async replyToQuestion(
    projectPath: string,
    sessionId: string,
    requestId: string,
    answers: string[][]
  ): Promise<void> {
    const options = this.continuationOptions.get(sessionId)
    if (!options) throw new QuestionRequestGoneError(sessionId, requestId, this.name)
    const formatted = answers
      .map((values, index) => `${index + 1}. ${values.join(', ')}`)
      .join('\n')
    await this.continueAfterQuestion(
      projectPath,
      sessionId,
      `The user answered Cline's earlier ask_question prompt through CodeInOven:\n${formatted}\nContinue from these answers without asking the same question again.`
    )
  }

  override async rejectQuestion(
    projectPath: string,
    sessionId: string,
    requestId: string
  ): Promise<void> {
    const options = this.continuationOptions.get(sessionId)
    if (!options) throw new QuestionRequestGoneError(sessionId, requestId, this.name)
    await this.continueAfterQuestion(
      projectPath,
      sessionId,
      "The user dismissed Cline's earlier ask_question prompt. Continue without that answer, or explain why the task cannot continue."
    )
  }

  private async continueAfterQuestion(
    projectPath: string,
    sessionId: string,
    text: string
  ): Promise<void> {
    const options = this.continuationOptions.get(sessionId)
    if (!options) return
    // Consume the continuation options immediately so a double resolution
    // (answer racing dismiss) cannot dispatch two continuation turns.
    this.continuationOptions.delete(sessionId)
    const continuationText = [
      'Continue this CodeInOven-managed task without relying on Cline session memory.',
      `Active task context:\n${options.text}`,
      `New interaction result:\n${text}`
    ].join('\n\n')
    this.hiddenContinuationSessions.add(sessionId)
    try {
      // The gated run was stopped at the question boundary. Await the process
      // settlement so resuming never collides with the still-active turn
      // ("A turn is already active")   same teardown contract steerPrompt
      // relies on.
      await this.settleActiveProcess(sessionId)
      // Drop the stopped turn's state only after settlement; `sendPrompt`
      // installs a fresh state for the continuation turn, and the old
      // questionRequestIds must not leak into its suppressIdle check.
      const previousState = this.turnStates.get(sessionId)
      if (previousState?.expectsProcessStop) this.turnStates.delete(sessionId)
      await this.sendPrompt(projectPath, {
        ...options,
        sessionId,
        text: continuationText,
        attachments: [...options.attachments]
      })
    } finally {
      this.hiddenContinuationSessions.delete(sessionId)
    }
  }

  protected override appendUserMessage(
    session: PersistentCliSession,
    options: Pick<SendPromptOptions, 'text' | 'attachments' | 'userMessageId'>
  ): void {
    super.appendUserMessage(session, options)
    if (!this.hiddenContinuationSessions.has(session.id)) return
    const message = session.messages.findLast((candidate) => candidate.role === 'user')
    if (message) message.visibility = 'hidden'
  }

  override async deleteSession(projectPath: string, sessionId: string): Promise<void> {
    this.stopApprovalBridge(sessionId)
    this.stopWebOnlyHook(sessionId)
    this.continuationOptions.delete(sessionId)
    this.hiddenContinuationSessions.delete(sessionId)
    this.turnStates.delete(sessionId)
    await super.deleteSession(projectPath, sessionId)
  }

  override dispose(): void {
    for (const sessionId of [...this.approvalBridges.keys()]) {
      this.stopApprovalBridge(sessionId)
    }
    for (const sessionId of [...this.webOnlyHookDirectories.keys()]) {
      this.stopWebOnlyHook(sessionId)
    }
    this.turnStates.clear()
    this.turnCounts.clear()
    this.continuationOptions.clear()
    this.hiddenContinuationSessions.clear()
    super.dispose()
  }
}
