import { createHash } from 'crypto'
import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { generateId } from '../../lib/utils'
import { APP_NAME } from '../../lib/brand'
import { classifyProviderIssue } from '../../lib/provider-issue'
import type {
  AgentEvent,
  AgentMessage,
  AgentPart,
  AgentProviderIssue,
  AgentQuestionRequest,
  AgentTokenUsage,
  HarnessCommand,
  PermissionReply,
  ProviderCatalog,
  SessionAgentEvent,
  ThinkingLevel,
  UsagePricingProvenance
} from '../../lib/types'
import { Logger } from '../system/logger'
import { estimateTokenCostUsd } from '../providers/pricing'
import type { StorageEngine } from '../storage/storage-engine'
import { buildHarnessEnvironment } from './cli-environment'
import type {
  AgentEventCallback,
  AgentProcessObserver,
  GenerateTitleOptions,
  HarnessCapabilities,
  HarnessDriver,
  PreparedUtilityRuntime,
  SendPromptOptions
} from './driver.interface'
import { buildTitlePrompt, sanitizeGeneratedTitle } from '../chat/title-generator'
import {
  isPermissionToolName,
  isQuestionToolName,
  normalizeAgentQuestions,
  permissionPatterns
} from '../../lib/agent-interactions'

export interface TitleModelCandidate {
  providerId: string
  modelId: string
}

/** Provider-reported usage for one title-candidate attempt, when available. */
export interface TitleAttemptUsage {
  tokens?: AgentTokenUsage
  cost?: number
  costProvenance?: UsagePricingProvenance
}

/** Outcome of one title-candidate attempt, for event-level ledger integration. */
export interface TitleAttemptAccounting {
  /** 1-based position of this attempt in the candidate sequence. */
  attempt: number
  /** Model/provider asked to produce the title. */
  providerId: string
  modelId: string
  /** Whether this attempt produced a usable title. */
  success: boolean
  /** Why this attempt fell back, or null when it succeeded. */
  fallbackReason: string | null
  /** Provider-reported usage retained from this attempt, or null when absent. */
  usage: TitleAttemptUsage | null
}

interface TitleTurnWaiter {
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

class TitleTurnProviderIssueError extends Error {
  constructor(readonly issue: AgentProviderIssue) {
    super(issue.message)
    this.name = 'TitleTurnProviderIssueError'
  }
}

const TITLE_GENERATION_TIMEOUT_MS = 180_000

/** Durable state for a logical CodeInOven session backed by a turn-based CLI. */
export interface PersistentCliSession {
  id: string
  title: string
  projectPathHash: string
  nativeSessionId?: string
  messages: AgentMessage[]
  createdAt: number
  updatedAt: number
}

/** Process invocation constructed by a provider-specific CLI driver. */
export interface CliTurnCommand {
  command: string
  args: string[]
  input?: string
  /** Keep stdin writable until the provider reports the turn result. */
  keepInputOpen?: boolean
  env?: NodeJS.ProcessEnv
  /** Display model that produced the turn when it differs from the selected base model. */
  provenanceModelId?: string
  /** Called for each parsed provider record before provider-specific mapping. */
  onJsonRecord?: (value: unknown) => void
  /** Called when spawning fails or the child exits. Must be safe to call more than once. */
  onProcessExit?: () => void
}

/** Output of parsing one provider JSONL record. */
export interface CliLineParseResult {
  /** Parsed events are always tied to the active session. */
  events?: SessionAgentEvent[]
  messages?: AgentMessage[]
  nativeSessionId?: string
}

/** Context supplied to provider parsers without leaking transport state. */
export interface CliLineParseContext {
  session: PersistentCliSession
  sessionId: string
  projectPath?: string
}

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
  private utilityRuntimes = new Map<string, PreparedUtilityRuntime>()
  private sessionCache = new Map<string, PersistentCliSession>()
  private deletedSessions = new Set<string>()
  /** Sessions whose provider stream already supplied a structured terminal issue. */
  private structuredProcessIssues = new Set<string>()
  /** Model/provider/thinking level of the running turn — CLIs do not echo them back per message. */
  private turnProvenance = new Map<
    string,
    { providerId?: string; modelId?: string; thinkingLevel?: ThinkingLevel }
  >()
  private titleSessions = new Set<string>()
  private titleTurnWaiters = new Map<string, TitleTurnWaiter>()
  /** Outcomes of the most recent title-candidate run, for ledger integration. */
  private lastTitleAttempts: TitleAttemptAccounting[] = []
  private processObserver: AgentProcessObserver | null = null
  /** Provider-neutral interaction cards already surfaced for this driver instance. */
  private interactionRequests = new Set<string>()

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
      projectPathHash: this.projectPathHash(projectPath),
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

  /** Run title attempts in disposable sessions, cheapest candidate first. */
  protected async generateTitleWithCandidates(
    projectPath: string,
    options: GenerateTitleOptions,
    candidates: TitleModelCandidate[]
  ): Promise<string | null> {
    const fallback = {
      providerId: options.settings.providerId,
      modelId: options.settings.modelId
    }
    const attempts = [...candidates, fallback].filter(
      (candidate, index, all) =>
        Boolean(candidate.providerId && candidate.modelId) &&
        all.findIndex(
          (other) =>
            other.providerId === candidate.providerId && other.modelId === candidate.modelId
        ) === index
    )
    const accounted: TitleAttemptAccounting[] = []

    for (let index = 0; index < attempts.length; index++) {
      const candidate = attempts[index]
      const sessionId = await this.createSession(projectPath, 'Thread title')
      this.titleSessions.add(sessionId)
      const completion = this.waitForTitleTurn(sessionId)
      try {
        await this.sendPrompt(projectPath, {
          sessionId,
          settings: {
            ...options.settings,
            providerId: candidate.providerId,
            modelId: candidate.modelId,
            thinkingLevel: 'minimal',
            inferenceMode: 'normal',
            permissionLevel: 'auto_review',
            engineeringMode: false
          },
          text: buildTitlePrompt(options.message.slice(0, 2_000)),
          attachments: [],
          readOnly: true,
          allowedTools: []
        })
        await completion.promise
        const messages = await this.loadMessages(projectPath, sessionId)
        const response = [...messages].reverse().find((message) => message.role === 'assistant')
        if (response?.error) {
          accounted.push(
            this.buildTitleAttempt(index + 1, candidate, false, response.error, response)
          )
          continue
        }
        const raw = response?.parts
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n')
        const title = raw ? sanitizeGeneratedTitle(raw) : null
        if (title) {
          accounted.push(this.buildTitleAttempt(index + 1, candidate, true, null, response))
          this.lastTitleAttempts = accounted
          return title
        }
        accounted.push(
          this.buildTitleAttempt(
            index + 1,
            candidate,
            false,
            'No usable title text produced',
            response
          )
        )
      } catch (error) {
        const fallbackReason = this.describeTitleFailure(error)
        if (error instanceof TitleTurnProviderIssueError && error.issue.kind === 'authentication') {
          accounted.push(this.buildTitleAttempt(index + 1, candidate, false, fallbackReason))
          this.lastTitleAttempts = accounted
          return null
        }
        Logger.dev(
          `${this.name} title model ${candidate.providerId}/${candidate.modelId} unavailable:`,
          error
        )
        accounted.push(this.buildTitleAttempt(index + 1, candidate, false, fallbackReason))
      } finally {
        completion.cancel()
        await this.abort(projectPath, sessionId).catch(() => undefined)
        await this.deleteSession(projectPath, sessionId).catch(() => undefined)
        this.titleSessions.delete(sessionId)
      }
    }
    this.lastTitleAttempts = accounted
    return null
  }

  generateTitle(projectPath: string, options: GenerateTitleOptions): Promise<string | null> {
    return this.generateTitleWithCandidates(projectPath, options, [])
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
   * Drop in-memory transcripts for a project's sessions so an idle project's
   * memory is released. Sessions stay on disk and reload on next use. Active
   * turns are never evicted.
   */
  releaseProjectResources(projectPath: string): void {
    const projectPathHash = this.projectPathHash(projectPath)
    for (const [sessionId, session] of this.sessionCache) {
      if (session.projectPathHash !== projectPathHash) continue
      if (this.activeProcesses.has(sessionId)) continue
      this.sessionCache.delete(sessionId)
      this.turnProvenance.delete(sessionId)
    }
  }

  async sendPrompt(projectPath: string, opts: SendPromptOptions): Promise<void> {
    const session = await this.requireSession(projectPath, opts.sessionId)
    if (this.activeProcesses.has(session.id)) {
      throw new Error(`A turn is already active for session ${session.id}`)
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
    const invocationEnv = runtime
      ? {
          ...(invocation.env ?? buildHarnessEnvironment()),
          ...runtimeEnv
        }
      : (invocation.env ?? buildHarnessEnvironment())
    this.setTurnProvenance(
      session.id,
      opts.settings.providerId,
      invocation.provenanceModelId ?? opts.settings.modelId,
      opts.settings.thinkingLevel
    )
    this.appendUserMessage(session, opts)
    let child: ChildProcess
    try {
      child = spawn(invocation.command, invocationArgs, {
        cwd: projectPath,
        env: invocationEnv,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (error) {
      invocation.onProcessExit?.()
      throw error
    }
    this.observeHarnessProcess(session.id, child, invocation.command, projectPath)
    this.structuredProcessIssues.delete(session.id)
    this.activeProcesses.set(session.id, child)

    let stdoutBuffer = ''
    let stderrBuffer = ''
    let completed = false
    const finish = async (error?: string): Promise<void> => {
      if (completed) return
      completed = true
      invocation.onProcessExit?.()
      this.activeProcesses.delete(session.id)
      if (!this.deletedSessions.has(session.id)) {
        try {
          await this.persistSession(session)
        } catch (persistError) {
          Logger.error('CLI session persistence failed:', persistError)
          error ??= 'Harness session could not be persisted'
        }
      }
      if (error && !this.structuredProcessIssues.has(session.id)) {
        const kind = classifyProviderIssue(error)
        this.emit({
          type: 'session.error',
          sessionId: session.id,
          error,
          ...(kind === 'unknown'
            ? {}
            : {
                issue: {
                  kind,
                  message:
                    kind === 'authentication'
                      ? `${this.name} sign-in expired. Sign in again, then retry this message.`
                      : error,
                  rawError: error,
                  harnessId: this.id,
                  retryable: kind !== 'billing'
                }
              })
        })
      }
      this.structuredProcessIssues.delete(session.id)
      this.emit({ type: 'session.idle', sessionId: session.id })
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString()
      stdoutBuffer = this.consumeJsonLines(stdoutBuffer, session, projectPath, invocation)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuffer = `${stderrBuffer}${chunk.toString()}`.slice(-4_000)
    })
    child.on('error', (error) => void finish(error.message))
    child.on('exit', (code, signal) => {
      if (stdoutBuffer.trim())
        this.consumeJsonLine(stdoutBuffer.trim(), session, projectPath, invocation)
      const failure =
        code === 0 || signal === 'SIGTERM'
          ? undefined
          : `Harness process exited with code ${code ?? 'unknown'}${
              stderrBuffer.trim() ? `: ${stderrBuffer.trim()}` : ''
            }`
      void finish(failure)
    })

    if (invocation.input) child.stdin?.write(invocation.input)
    if (!invocation.keepInputOpen) child.stdin?.end()
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
    if (child && !child.killed) child.kill()
  }

  async listProviders(_projectPath: string): Promise<ProviderCatalog[]> {
    void _projectPath
    return []
  }

  async listCommands(): Promise<HarnessCommand[]> {
    return []
  }

  async runCommand(
    _projectPath: string,
    _sessionId: string,
    _command: string,
    _args: string
  ): Promise<void> {
    void _projectPath
    void _sessionId
    void _command
    void _args
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
    for (const runtime of this.utilityRuntimes.values()) {
      void runtime.cleanup().catch((error) => {
        Logger.error(`${this.name} utility runtime cleanup failed:`, error)
      })
    }
    this.utilityRuntimes.clear()
    this.sessionCache.clear()
    this.turnProvenance.clear()
    for (const waiter of this.titleTurnWaiters.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error(`${this.name} is shutting down`))
    }
    this.titleTurnWaiters.clear()
    this.titleSessions.clear()
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
    return this.titleSessions.has(sessionId)
  }

  protected observeHarnessProcess(
    sessionId: string | undefined,
    child: ChildProcess,
    command: string,
    cwd: string
  ): void {
    this.processObserver?.watchProcess(sessionId, child.pid, command, cwd)
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
    const userMessageId = opts.userMessageId ?? generateId()
    const userParts: AgentPart[] = [
      {
        type: 'text',
        id: `${userMessageId}:text`,
        messageID: userMessageId,
        text: opts.text
      },
      ...opts.attachments.map((attachment, index): AgentPart => ({
        type: 'file',
        id: `${userMessageId}:file:${index}`,
        messageID: userMessageId,
        mime: attachment.mime,
        url: attachment.url,
        filename: attachment.filename
      }))
    ]
    this.mergeMessages(session, [
      {
        id: userMessageId,
        role: 'user',
        parts: userParts,
        createdAt: Date.now(),
        completedAt: Date.now()
      }
    ])
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

  private consumeJsonLines(
    buffer: string,
    session: PersistentCliSession,
    projectPath: string,
    invocation: CliTurnCommand
  ): string {
    const lines = buffer.split(/\r?\n/u)
    const remainder = lines.pop() ?? ''
    for (const line of lines) this.consumeJsonLine(line, session, projectPath, invocation)
    return remainder
  }

  private consumeJsonLine(
    line: string,
    session: PersistentCliSession,
    projectPath: string,
    invocation: CliTurnCommand
  ): void {
    // Some CLIs interleave a progress redraw (`\r`) on the same line as a real
    // event. Normalize the raw line, then fall back to extracting the bracketed
    // JSON object so a genuine event is never dropped because of that noise.
    const normalized = line.replace(/^\r+|\s+$/gu, '')
    if (!normalized) return
    let value: unknown
    try {
      value = JSON.parse(normalized) as unknown
    } catch {
      const recovered = this.recoverJsonValue(normalized)
      if (recovered === null) {
        Logger.dev(`${this.id} emitted a non-JSONL stdout line`, normalized.slice(0, 400))
        return
      }
      value = recovered
    }
    invocation.onJsonRecord?.(value)
    const result = this.parseJsonLine(value, {
      session,
      sessionId: session.id,
      projectPath
    })
    if (!result) return
    if (result.nativeSessionId) session.nativeSessionId = result.nativeSessionId
    if (result.messages) this.mergeMessages(session, result.messages)
    for (const event of this.normalizeInteractionEvents(session.id, result.events ?? [])) {
      if (event.type === 'session.error' || (event.type === 'message.completed' && event.issue)) {
        this.structuredProcessIssues.add(session.id)
      } else if (event.type === 'session.status') {
        if (event.status.state === 'waiting' || event.status.state === 'error') {
          this.structuredProcessIssues.add(session.id)
        } else {
          this.structuredProcessIssues.delete(session.id)
        }
      }
      this.applyEventToSession(session, event)
      this.emit({ ...event, sessionId: session.id })
    }
    session.updatedAt = Date.now()
  }

  /**
   * Recover a JSON value from a line that mixes non-JSON noise with a single
   * `{...}` object (e.g. `\rProgress… {"event":"…"}`). Only lines whose prefix
   * before the first `{` and suffix after the last `}` contain no braces are
   * treated as recoverable, so a genuinely malformed JSON line is still dropped.
   */
  private recoverJsonValue(line: string): unknown | null {
    const start = line.indexOf('{')
    const end = line.lastIndexOf('}')
    if (start === -1 || end <= start) return null
    const prefix = line.slice(0, start)
    const suffix = line.slice(end + 1)
    if (prefix.includes('{') || suffix.includes('}')) return null
    try {
      return JSON.parse(line.slice(start, end + 1)) as unknown
    } catch {
      return null
    }
  }

  protected mergeMessages(session: PersistentCliSession, messages: AgentMessage[]): void {
    const provenance = this.turnProvenance.get(session.id)
    for (const raw of messages) {
      const message: AgentMessage = {
        ...raw,
        providerId: raw.providerId ?? provenance?.providerId,
        modelId: raw.modelId ?? provenance?.modelId,
        thinkingLevel: raw.thinkingLevel ?? provenance?.thinkingLevel,
        harnessId: raw.harnessId ?? this.id
      }
      const index = session.messages.findIndex((current) => current.id === message.id)
      if (index === -1) session.messages.push(message)
      else session.messages[index] = message
    }
    session.messages.sort((left, right) => left.createdAt - right.createdAt)
  }

  protected applyEventToSession(session: PersistentCliSession, event: AgentEvent): void {
    if (event.type === 'message.part.updated') {
      const message = session.messages.findLast(
        (candidate) => candidate.id === event.part.messageID
      )
      if (!message) return
      const index = message.parts.findLastIndex((part) => part.id === event.part.id)
      if (index === -1) message.parts.push(event.part)
      else message.parts[index] = event.part
      return
    }
    if (event.type === 'message.part.delta') {
      const message = session.messages.findLast((candidate) => candidate.id === event.messageId)
      const part = message?.parts.findLast((candidate) => candidate.id === event.partId)
      if (part && (part.type === 'text' || part.type === 'reasoning') && event.field === 'text') {
        part.text += event.delta
      }
      return
    }
    if (event.type === 'message.completed') {
      const message = session.messages.findLast((candidate) => candidate.id === event.messageId)
      if (message) {
        message.completedAt = Date.now()
        message.error = event.error
        if (event.tokens) message.tokens = event.tokens
        if (event.normalizedUsage) message.normalizedUsage = event.normalizedUsage
        if (event.contextWindow !== undefined) message.contextWindow = event.contextWindow
        if (event.contextUsed !== undefined) message.contextUsed = event.contextUsed
        if (event.rateLimits) message.rateLimits = event.rateLimits
        if (event.credits) message.credits = event.credits
        this.estimateMissingCost(message)
      }
    }
    if (event.type === 'usage.updated') {
      const message = session.messages.findLast((candidate) => candidate.id === event.messageId)
      if (message) {
        if (event.tokens) message.tokens = event.tokens
        if (event.normalizedUsage) message.normalizedUsage = event.normalizedUsage
        if (event.contextWindow !== undefined) message.contextWindow = event.contextWindow
        if (event.contextUsed !== undefined) message.contextUsed = event.contextUsed
        if (event.cost !== undefined) message.cost = event.cost
        if (event.rateLimits) message.rateLimits = event.rateLimits
        if (event.credits) message.credits = event.credits
        this.estimateMissingCost(message)
      }
    }
  }

  /** Promote JSONL question/approval tool parts into the shared interaction stream. */
  protected normalizeInteractionEvents(
    sessionId: string,
    events: SessionAgentEvent[]
  ): SessionAgentEvent[] {
    const normalized: SessionAgentEvent[] = []
    for (const event of events) {
      normalized.push(event)
      if (event.type === 'question.asked') {
        this.interactionRequests.add(this.interactionKey('question', sessionId, event.requestId))
        continue
      }
      if (event.type !== 'message.part.updated') continue
      const part = event.part
      if (part.type === 'question') {
        const requestId = this.interactionRequestId('question', sessionId, part.callID ?? part.id)
        const key = this.interactionKey('question', sessionId, requestId)
        if (this.interactionRequests.has(key)) continue
        this.interactionRequests.add(key)
        normalized.push({
          type: 'question.asked',
          sessionId,
          requestId,
          questions: [{ ...part.question, requestId }],
          tool: { messageID: part.messageID, callID: part.callID ?? part.id }
        })
        continue
      }
      if (part.type !== 'tool') continue
      const active = part.state.status === 'pending' || part.state.status === 'running'
      if (!active) continue
      const requestId = this.interactionRequestId('interaction', sessionId, part.callID || part.id)
      if (isQuestionToolName(part.tool)) {
        const key = this.interactionKey('question', sessionId, requestId)
        if (this.interactionRequests.has(key)) continue
        this.interactionRequests.add(key)
        normalized.push({
          type: 'question.asked',
          sessionId,
          requestId,
          questions: normalizeAgentQuestions(part.state.input),
          tool: { messageID: part.messageID, callID: part.callID }
        })
        continue
      }
      if (!isPermissionToolName(part.tool)) continue
      const key = this.interactionKey('permission', sessionId, requestId)
      if (this.interactionRequests.has(key)) continue
      this.interactionRequests.add(key)
      normalized.push({
        type: 'permission.asked',
        sessionId,
        permission: {
          id: requestId,
          sessionId,
          permission: part.tool,
          patterns: permissionPatterns(part.state.input),
          metadata: { tool: part.tool, input: part.state.input }
        }
      })
    }
    return normalized
  }

  private interactionRequestId(kind: string, sessionId: string, providerId: string): string {
    return `${this.id}-${kind}-${sessionId}-${providerId}`
      .replace(/[^a-zA-Z0-9._-]/gu, '-')
      .slice(0, 256)
  }

  private interactionKey(kind: string, sessionId: string, requestId: string): string {
    return `${kind}:${sessionId}:${requestId}`
  }

  /**
   * When a harness reports tokens but no dollar cost, fill in an estimate from
   * the local model-catalog pricing so usage reports aren't zero. Only applies
   * when cost is genuinely missing; a provider-reported cost is never replaced.
   */
  protected estimateMissingCost(message: AgentMessage): void {
    if (typeof message.cost === 'number') return
    const estimated = estimateTokenCostUsd(message.modelId, message.providerId, message.tokens)
    if (estimated === null) return
    message.cost = estimated
    message.costProvenance = {
      source: 'model_catalog',
      sourceId: message.modelId,
      currency: 'USD',
      capturedAt: message.completedAt ?? message.createdAt ?? Date.now()
    }
  }

  protected async requireSession(
    projectPath: string,
    sessionId: string
  ): Promise<PersistentCliSession> {
    const expectedHash = this.projectPathHash(projectPath)
    const cached = this.sessionCache.get(sessionId)
    const session =
      cached ?? (await this.storage.read<PersistentCliSession>(this.sessionPath(sessionId)))
    if (!session || session.projectPathHash !== expectedHash) {
      throw new Error(`CLI session is unavailable: ${sessionId}`)
    }
    this.sessionCache.set(sessionId, session)
    return session
  }

  protected async persistSession(session: PersistentCliSession): Promise<void> {
    session.updatedAt = Date.now()
    await this.storage.write(this.sessionPath(session.id), session)
  }

  private sessionPath(sessionId: string): string {
    return `drivers/${this.id}/sessions/${sessionId}.json`
  }

  private projectPathHash(projectPath: string): string {
    return createHash('sha256').update(projectPath).digest('hex')
  }

  protected emit(event: AgentEvent): void {
    if ('sessionId' in event && this.titleSessions.has(event.sessionId)) {
      const waiter = this.titleTurnWaiters.get(event.sessionId)
      if (event.type === 'session.error') {
        this.clearTitleTurnWaiter(event.sessionId)
        waiter?.reject(
          event.issue
            ? new TitleTurnProviderIssueError(event.issue)
            : new Error(event.error ?? `${this.name} title generation failed`)
        )
      } else if (event.type === 'message.completed' && event.issue) {
        this.clearTitleTurnWaiter(event.sessionId)
        waiter?.reject(new TitleTurnProviderIssueError(event.issue))
      } else if (
        event.type === 'session.idle' ||
        (event.type === 'session.status' && event.status.state === 'idle')
      ) {
        this.clearTitleTurnWaiter(event.sessionId)
        waiter?.resolve()
      }
      return
    }
    this.eventCallback?.(event)
  }

  private waitForTitleTurn(sessionId: string): { promise: Promise<void>; cancel: () => void } {
    let resolvePromise: () => void = () => undefined
    let rejectPromise: (error: Error) => void = () => undefined
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
    })
    const timer = setTimeout(() => {
      this.clearTitleTurnWaiter(sessionId)
      rejectPromise(new Error(`${this.name} title generation timed out`))
    }, TITLE_GENERATION_TIMEOUT_MS)
    this.titleTurnWaiters.set(sessionId, {
      resolve: resolvePromise,
      reject: rejectPromise,
      timer
    })
    return { promise, cancel: () => this.clearTitleTurnWaiter(sessionId) }
  }

  private clearTitleTurnWaiter(sessionId: string): void {
    const waiter = this.titleTurnWaiters.get(sessionId)
    if (!waiter) return
    clearTimeout(waiter.timer)
    this.titleTurnWaiters.delete(sessionId)
  }

  private buildTitleAttempt(
    attempt: number,
    candidate: TitleModelCandidate,
    success: boolean,
    fallbackReason: string | null,
    response?: AgentMessage
  ): TitleAttemptAccounting {
    const usage: TitleAttemptUsage | null =
      response &&
      (response.tokens || response.cost !== undefined || response.costProvenance !== undefined)
        ? {
            tokens: response.tokens,
            cost: response.cost,
            costProvenance: response.costProvenance
          }
        : null
    return {
      attempt,
      providerId: candidate.providerId,
      modelId: candidate.modelId,
      success,
      fallbackReason,
      usage
    }
  }

  private describeTitleFailure(error: unknown): string {
    if (error instanceof TitleTurnProviderIssueError) return error.issue.message
    if (error instanceof Error) return error.message
    return String(error)
  }
}
