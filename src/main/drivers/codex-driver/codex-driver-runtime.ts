import { spawn } from 'child_process'
import type { AgentEvent, AgentTokenUsage, AgentProviderIssue } from '../../../lib/types'
import { classifyProviderIssue } from '../../../lib/provider-issue'
import { Logger } from '../../system/logger'
import { buildProcessEnvironmentAsync } from '../cli-environment'
import { prepareHarnessInvocation } from '../harness-runtime'
import {
  CODEX_APP_SERVER_REQUEST_TIMEOUT_MS,
  type CodexAppServerHost,
  type CodexAppServerTurn
} from '../codex/codex-protocol'
import {
  CODEX_DEFAULT_QUESTION_CONFIG,
  isCodexDynamicQuestionItem,
  isCodexQuestionRequest,
  isUnsupportedReasoningSummary,
  normalizeAppServerItem
} from '../codex/codex-tools'
import {
  codexRetryIssue,
  codexUsageLimitIssue,
  isCodexRetryRecoveryActivity
} from '../codex/codex-errors'
import { mapCodexRateLimits, mapCodexUsage, mapCodexTotalUsage } from '../codex/codex-usage'
import {
  appServerRequestId,
  notificationThreadId,
  recordValue,
  stringValue
} from '../codex/codex-values'
import { parseItem } from '../codex/codex-stream-fold'
import {
  CODEX_APP_SERVER_RECOVERY_LIMIT,
  CODEX_APP_SERVER_RESTART_DELAY_MS,
  codexStartupQueue
} from '../codex-driver'
import type { CodexDriver } from '../codex-driver'

/** CodexDriver runtime: one concern, moved verbatim from the composition root. */
export class CodexDriverRuntime {
  constructor(
    private readonly host: CodexDriver,
    private readonly base: CodexDriver['base']
  ) {}

  /**
   * Codex's resident app-server keeps the OAuth credential it loaded at
   * startup. Re-authentication changes the credential on disk, but an existing
   * app-server keeps using the old one. Rebuild only this project's server so
   * the next retry resumes the same native thread with the new credential.
   */
  restartAfterAuthentication(projectPath: string): Promise<void> {
    const existing = this.host.authenticationRestartsByProjectPath.get(projectPath)
    if (existing) return existing

    const restart = this.restartAppServer(
      projectPath,
      'Codex app-server restarting after provider sign-in'
    ).finally(() => {
      if (this.host.authenticationRestartsByProjectPath.get(projectPath) === restart) {
        this.host.authenticationRestartsByProjectPath.delete(projectPath)
      }
    })
    this.host.authenticationRestartsByProjectPath.set(projectPath, restart)
    return restart
  }

  /**
   * Rebuild every resident app-server so the next turn spawns the Codex binary
   * currently on disk. A harness update replaces `codex` but not the app-server
   * already running from the old install, and that process is what every turn
   * in the project talks to. The native threads live in Codex's own store, so
   * the rebuilt server resumes them.
   */
  async restartRuntime(): Promise<void> {
    for (const projectPath of [...this.host.hostsByProjectPath.keys()]) {
      await this.restartAppServer(
        projectPath,
        'Codex app-server restarted to pick up a harness update'
      )
    }
    this.host.base.superRestartRuntime()
  }

  /**
   * The resident host whose native writer this session's thread lives in, or
   * null when this process holds no writer for it.
   */
  writerHostFor(
    projectPath: string,
    sessionId: string,
    nativeThreadId: string | null
  ): CodexAppServerHost | null {
    if (!nativeThreadId) return null
    const binding = this.host.threadSessionsByNativeId.get(nativeThreadId)
    const host = this.host.hostsByProjectPath.get(projectPath)
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

  dispose(): void {
    this.host.appServerGeneration += 1
    for (const active of this.host.activeTurns.values()) {
      active.finished = true
    }
    this.host.activeTurns.clear()
    this.host.utilityEndpoints.clear()
    for (const compaction of this.host.compactionsByThreadId.values()) {
      clearTimeout(compaction.timer)
      compaction.reject(new Error('Codex driver disposed'))
    }
    this.host.compactionsByThreadId.clear()
    for (const waiter of this.host.contextUsageByThreadId.values()) {
      clearTimeout(waiter.timer)
      waiter.resolve(undefined)
    }
    this.host.contextUsageByThreadId.clear()
    for (const host of this.host.appServerHosts) {
      this.stopAppServerHost(host, 'Codex driver disposed')
    }
    this.host.appServerHosts.clear()
    this.host.hostsByProjectPath.clear()
    this.host.hostsStartingByProjectPath.clear()
    this.host.authenticationRestartsByProjectPath.clear()
    this.host.serverRequests.clear()
    this.host.appServerRecoveriesBySessionId.clear()
    this.host.base.superDispose()
  }

  prepareForProcessCleanup(): void {
    for (const host of [...this.host.appServerHosts]) {
      this.stopAppServerHost(host, 'CodeInOven is shutting down')
    }
  }

  async restartAppServer(projectPath: string, reason: string): Promise<void> {
    const starting = this.host.hostsStartingByProjectPath.get(projectPath)
    if (starting) await starting.catch(() => undefined)

    const host = this.host.hostsByProjectPath.get(projectPath)
    if (!host) return

    this.host.hostsByProjectPath.delete(projectPath)
    await this.failAppServerHost(host, reason)
    if (!host.child.killed) host.child.kill()
  }

  stopAppServerHost(host: CodexAppServerHost, reason: string): void {
    if (host.stopped) return
    host.stopped = true
    this.host.appServerHosts.delete(host)
    for (const pending of host.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
    host.pending.clear()
    if (!host.child.killed) host.child.kill()
  }

  async stopAppServerHostAndWait(host: CodexAppServerHost, reason: string): Promise<boolean> {
    const exited = this.waitForAppServerExit(host.child)
    this.stopAppServerHost(host, reason)
    return exited
  }

  waitForAppServerExit(child: CodexAppServerHost['child'], timeoutMs = 5_000): Promise<boolean> {
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

  stopResidentHostForPathIfIdle(projectPath: string): void {
    const host = this.host.hostsByProjectPath.get(projectPath)
    if (!host || this.host.hostsStartingByProjectPath.has(projectPath)) return
    const busy =
      [...this.host.activeTurns.values()].some((active) => active.host === host) ||
      [...this.host.compactionsByThreadId.values()].some(
        (compaction) => compaction.host === host
      ) ||
      [...this.host.contextUsageByThreadId.values()].some((waiter) => waiter.host === host) ||
      host.pending.size > 0
    if (busy) return
    this.host.hostsByProjectPath.delete(projectPath)
    this.stopAppServerHost(host, 'Codex app-server stopped after genuine inactivity')
  }

  async createAppServerHost(projectPath: string): Promise<CodexAppServerHost> {
    const { env: providerEnv, args: providerArgs } = await this.host.customProviderOverlay()
    // Decided before the host starts: an app-server is shared for the life of a
    // project, so computer use has to be on the one launch that serves its turns.
    const computerUseArgs = await this.host.computerUseConfigArgs()
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
          ...(await buildProcessEnvironmentAsync({
            ...process.env,
            ...this.host.accountEnvironment
          })),
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
    this.host.appServerHosts.add(host)
    this.bindAppServer(host)
    // The shared app-server is app-scoped: register it under APP_SCOPE (undefined
    // session) so thread-scoped process kills (thread deletion, SourcesPanel
    // "kill thread processes") never SIGTERM the universal session.
    this.host.base.observeHarnessProcess(undefined, child, 'codex app-server', projectPath)
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

  async ensureAppServerHost(projectPath: string): Promise<CodexAppServerHost> {
    const existing = this.host.hostsByProjectPath.get(projectPath)
    if (existing && !existing.stopped) {
      return existing
    }
    const starting = this.host.hostsStartingByProjectPath.get(projectPath)
    if (starting) return starting
    const generation = this.host.appServerGeneration
    const promise = (async (): Promise<CodexAppServerHost> => {
      const host = await codexStartupQueue(async () => {
        if (generation !== this.host.appServerGeneration) throw new Error('Codex driver disposed')
        const created = await this.createAppServerHost(projectPath)
        if (generation !== this.host.appServerGeneration) {
          this.stopAppServerHost(created, 'Codex driver disposed')
          throw new Error('Codex driver disposed')
        }
        return created
      })
      this.host.hostsByProjectPath.set(projectPath, host)
      return host
    })()
    this.host.hostsStartingByProjectPath.set(projectPath, promise)
    try {
      return await promise
    } catch (error) {
      const host = this.host.hostsByProjectPath.get(projectPath)
      if (host && !host.child.killed) host.child.kill()
      this.host.hostsByProjectPath.delete(projectPath)
      throw error
    } finally {
      if (this.host.hostsStartingByProjectPath.get(projectPath) === promise) {
        this.host.hostsStartingByProjectPath.delete(projectPath)
      }
    }
  }

  bindAppServer(host: CodexAppServerHost): void {
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

  consumeAppServerLine(host: CodexAppServerHost, line: string): void {
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
      this.host.units['questions'].handleServerRequest(
        host,
        responseId,
        method,
        recordValue(payload['params']) ?? {}
      )
      return
    }
    if (method) this.handleAppServerNotification(host, method, recordValue(payload['params']) ?? {})
  }

  handleAppServerNotification(
    _host: CodexAppServerHost,
    method: string,
    params: Record<string, unknown>
  ): void {
    void _host
    if (method === 'serverRequest/resolved') {
      const requestId = appServerRequestId(params['requestId'] ?? params['request_id'])
      if (requestId === undefined) return
      const request = this.host.serverRequests.get(String(requestId))
      if (!request) return
      this.host.serverRequests.delete(String(requestId))
      if (isCodexQuestionRequest(request.method)) {
        this.host.base.emit({
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
      const waiter = this.host.contextUsageByThreadId.get(threadId)
      if (waiter) {
        clearTimeout(waiter.timer)
        this.host.contextUsageByThreadId.delete(threadId)
        waiter.resolve(mapCodexUsage(params['tokenUsage'] ?? params))
      }
    }
    if (threadId) {
      const compaction = this.host.compactionsByThreadId.get(threadId)
      if (compaction && (method === 'item/started' || method === 'item/completed')) {
        const item = recordValue(params['item'])
        if (stringValue(item?.['type']) === 'contextCompaction') {
          const summary = stringValue(item?.['summary']) ?? stringValue(item?.['text'])
          const part = summary ? { ...compaction.basePart, summary } : compaction.basePart
          this.host.base.applyEventToSession(compaction.session, {
            type: 'message.part.updated',
            sessionId: compaction.session.id,
            part
          })
          this.host.base.emit({
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
        this.host.compactionsByThreadId.delete(threadId)
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
          this.host.base.applyEventToSession(compaction.session, completed)
          this.host.base.emit(completed)
          this.host.base.emit({ type: 'session.idle', sessionId: compaction.session.id })
          void this.host.base
            .persistSession(compaction.session)
            .then(compaction.resolve, compaction.reject)
        }
        return
      }
    }
    const active = this.host.units['turns'].activeTurnForNotification(params)
    if (!active) {
      this.host.units['turns'].reportBetweenTurnCompaction(method, params)
      return
    }
    if (active.waitingForRetry && isCodexRetryRecoveryActivity(method)) {
      active.waitingForRetry = false
      this.host.base.emit({
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
      this.host.units['capabilities'].emitReasoningSummarySeparator(active, params)
      return
    }
    if (method === 'item/started' || method === 'item/completed') {
      const item = normalizeAppServerItem(recordValue(params['item']))
      // app-server echoes the submitted top-level input as a userMessage item.
      // The app already owns a presentation-safe user bubble, so broadcasting
      // this transport echo would expose developer instructions in the trace.
      if (item && stringValue(item['type']) !== 'user_message') {
        if (this.host.units['questions'].captureAsyncQuestion(active, item)) return
        if (isCodexDynamicQuestionItem(item)) return
        this.host.units['driver'].applyCodexResult(
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
        this.host.units['driver'].applyCodexResult(
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
        this.host.base.applyEventToSession(active.session, event)
        this.host.base.emit(event)
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
          this.host.base.emit({
            type: 'session.status',
            sessionId: active.session.id,
            status: { state: 'error', issue: retryIssue }
          })
          return
        }
        active.failure = undefined
        active.waitingForRetry = true
        this.host.base.emit({
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
      void this.host.units['capabilities'].retryWithoutReasoningSummary(active)
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

  emitAppServerDelta(
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
    this.host.base.applyEventToSession(active.session, event)
    this.host.base.emit(event)
  }

  appServerRequest(
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

  appServerNotify(host: CodexAppServerHost, method: string): void {
    host.child.stdin?.write(`${JSON.stringify({ method })}\n`)
  }

  respondToUnsupportedAppServerRequest(
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

  async completeAppServerTurn(
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
          this.host.base.applyEventToSession(active.session, event)
          this.host.base.emit(event)
        }
      } catch (refreshError) {
        Logger.dev('Codex account rate-limit refresh unavailable:', refreshError)
      }
    }
    await this.finishAppServerTurn(active, error, issue)
  }

  async finishAppServerTurn(
    active: CodexAppServerTurn,
    error?: string,
    issue?: AgentProviderIssue
  ): Promise<void> {
    if (!error) this.host.appServerRecoveriesBySessionId.delete(active.session.id)
    if (active.finished) return
    if (active.pendingUsage) {
      // A cancelled or failed request can report usage without ever emitting
      // content. Keep an accounting-only response rather than losing its spend.
      this.host.units['driver'].applyCodexResult(active, {
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
          message.harnessId !== this.host.base.id
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
        this.host.base.applyEventToSession(active.session, costEvent)
        this.host.base.emit(costEvent)
      }
    }
    active.finished = true
    if (this.host.activeTurns.get(active.session.id) === active) {
      this.host.activeTurns.delete(active.session.id)
    }
    try {
      await this.host.base.persistSession(active.session)
    } catch (persistError) {
      Logger.error('Codex app-server session persistence failed:', persistError)
      error ??= 'Codex session could not be persisted'
    }
    if (error) {
      this.host.base.emit({
        type: 'session.error',
        sessionId: active.session.id,
        error,
        ...(issue ? { issue } : {})
      })
    }
    this.host.base.emit({ type: 'session.idle', sessionId: active.session.id })
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
  gracefulAppServerIssue(error: string, sessionId: string): AgentProviderIssue {
    const attempted = this.host.appServerRecoveriesBySessionId.get(sessionId) ?? 0
    if (attempted >= CODEX_APP_SERVER_RECOVERY_LIMIT) {
      return {
        kind: classifyProviderIssue(error),
        message:
          attempted === CODEX_APP_SERVER_RECOVERY_LIMIT
            ? 'The Codex app-server keeps stopping unexpectedly. CodeInOven stopped retrying this turn automatically; retry the message to continue your work.'
            : 'The Codex app-server stopped unexpectedly. Retry the message to continue your work.',
        rawError: error,
        harnessId: this.host.base.id,
        retryable: true,
        ...(attempted === CODEX_APP_SERVER_RECOVERY_LIMIT ? { attempt: attempted } : {})
      }
    }
    this.host.appServerRecoveriesBySessionId.set(sessionId, attempted + 1)
    return {
      kind: 'provider_unavailable',
      message:
        'The Codex app-server stopped unexpectedly. CodeInOven is restarting it and will resume this turn.',
      rawError: error,
      harnessId: this.host.base.id,
      retryable: true,
      retryAt: Date.now() + CODEX_APP_SERVER_RESTART_DELAY_MS
    }
  }

  async failAppServerHost(
    host: CodexAppServerHost,
    error: string,
    recoverable = false
  ): Promise<void> {
    if (host.stopped) return
    host.stopped = true
    this.host.appServerHosts.delete(host)
    for (const [projectPath, candidate] of this.host.hostsByProjectPath) {
      if (candidate !== host) continue
      this.host.hostsByProjectPath.delete(projectPath)
      break
    }
    for (const pending of host.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(error))
    }
    host.pending.clear()
    for (const [threadId, compaction] of this.host.compactionsByThreadId) {
      if (compaction.host !== host) continue
      clearTimeout(compaction.timer)
      this.host.compactionsByThreadId.delete(threadId)
      compaction.reject(new Error(error))
    }
    for (const [threadId, waiter] of this.host.contextUsageByThreadId) {
      if (waiter.host !== host) continue
      clearTimeout(waiter.timer)
      this.host.contextUsageByThreadId.delete(threadId)
      waiter.resolve(undefined)
    }
    const affected = [...this.host.activeTurns.values()].filter((active) => active.host === host)
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
  deliberateAppServerIssue(error: string): AgentProviderIssue {
    return {
      kind: classifyProviderIssue(error),
      message: 'The Codex app-server was restarted. Retry the message to continue your work.',
      rawError: error,
      harnessId: this.host.base.id,
      retryable: true
    }
  }
}
