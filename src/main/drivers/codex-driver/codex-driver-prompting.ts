import type { AgentEvent, ProviderModel, ThreadSettings } from '../../../lib/types'
import { resolveFastModelId } from '../../../lib/fast-inference'
import { COMPACT_LINE_SHARE } from '../../../lib/prompt-budget'
import { Logger } from '../../system/logger'
import { GATEWAY_TOOLS, gatewayToolForModel } from '../../../lib/gateway-tools'
import { withActionSummaryAdvice, withActionSummarySchema } from '../../../lib/tool-action-label'
import { formatHistoryRecap } from '../../chat/chat-engine/chat-engine-message-text'
import type { SendPromptOptions, SteerPromptOptions } from '../driver.interface'
import { type PersistentCliSession } from '../persistent-cli-driver'
import { codexContextWindowOptions } from '../codex/codex-catalog'
import { CODEX_USAGE_TIMEOUT_MS, type CodexAppServerTurn } from '../codex/codex-protocol'
import {
  codexApprovalPolicy,
  codexEffort,
  codexQuestionTool,
  codexSandboxPolicy,
  sandboxFor
} from '../codex/codex-tools'
import { mapCodexUsage } from '../codex/codex-usage'
import { recordValue, stringValue } from '../codex/codex-values'
import { codexDeveloperInstructions, codexAuxiliaryConfig } from '../codex/codex-prompts'
import type { CodexDriver } from '../codex-driver'

/** CodexDriver prompting: one concern, moved verbatim from the composition root. */
export class CodexDriverPrompting {
  constructor(
    private readonly host: CodexDriver,
    private readonly base: CodexDriver['base']
  ) {}

  /**
   * The windows Codex states for this account's copy of one model.
   *
   * The read honors the per-home catalog TTL instead of forcing a fresh CLI
   * dump: the renderer asks for this the moment a thread's model lands, so a
   * forced read would spawn `codex debug models` on every thread open.
   */
  async modelContext(
    projectPath: string,
    modelId: string
  ): Promise<Pick<ProviderModel, 'contextWindow' | 'contextWindows'> | null> {
    const windows = await this.host.units['catalog'].codexWindowCatalog(projectPath)
    const window = windows.get(modelId)
    return window
      ? { contextWindow: window.defaultWindow, contextWindows: codexContextWindowOptions(window) }
      : null
  }

  /** Start a Codex turn through app-server so the same native turn can be steered. */
  async sendPrompt(projectPath: string, options: SendPromptOptions): Promise<void> {
    // A sibling can have rebound this app session since our last turn.
    if (!this.host.activeTurns.has(options.sessionId))
      this.host.base.sessionCache.delete(options.sessionId)
    const session = await this.host.base.requireSession(projectPath, options.sessionId)
    // A native turn can still be registered while the engine believes the
    // session is idle: a network failure tears down the visible turn, but the
    // `turn/completed` cleanup only arrives when the connection recovers (or
    // after the request timeout). Rejecting here poisons the thread with
    // "A turn is already active" on every retry, so a dispatch that lands on a
    // live native turn is delivered as a steer instead - the driver's turn
    // registry is authoritative, not the engine's session status.
    const previousTurn = this.host.activeTurns.get(session.id)
    if (previousTurn?.completionReceived) {
      // Let the old turn finish emitting idle before a new turn can start.
      await previousTurn.completion
    }
    if (this.host.activeTurns.has(session.id)) {
      await this.host.base.steerPrompt(projectPath, options)
      return
    }

    if (this.host.base.utilityRuntime(session.id)) {
      throw new Error('Codex per-session launch overlays cannot bypass the shared app-server host')
    }
    const fastInference =
      options.settings.inferenceMode === 'fast' && options.settings.providerId === 'openai'
    const serviceTier =
      options.settings.providerId === 'openai' && options.settings.inferenceMode === 'ultrafast'
        ? 'ultrafast'
        : fastInference
          ? 'fast'
          : 'default'
    const host = await this.host.units['runtime'].ensureAppServerHost(projectPath)
    const active: CodexAppServerTurn = {
      host,
      session,
      finished: false
    }
    this.host.activeTurns.set(session.id, active)
    this.host.base.setTurnProvenance(
      session.id,
      options.settings.providerId,
      resolveFastModelId(options.settings.modelId, fastInference ? 'fast' : 'normal'),
      options.settings.thinkingLevel
    )
    this.host.base.appendUserMessage(session, options)
    active.messageOffset = session.messages.length

    try {
      const dynamicTools = options.minimalContext
        ? []
        : [
            codexQuestionTool((await this.host.base.storage.getConfig()).agentQuestionCap),
            ...(this.host.utilityEndpoints.has(session.id)
              ? GATEWAY_TOOLS.filter(({ name }) => {
                  const granted = this.host.utilityEndpoints.get(session.id)?.toolNames
                  return granted === undefined || granted.includes(name)
                })
                  .map(gatewayToolForModel)
                  .map(({ name, description, inputSchema }) => ({
                    name,
                    description: withActionSummaryAdvice(description),
                    // Every harness that publishes this catalog declares the
                    // trace's action-summary field, so a codex agent can label
                    // its calls exactly like a pi agent does.
                    inputSchema: withActionSummarySchema(inputSchema)
                  }))
              : [])
          ]
      const developerInstructions = options.minimalContext
        ? 'Return only the requested auxiliary answer.'
        : codexDeveloperInstructions(options.systemPrompt)
      const contextWindow = this.host.codexContextWindowOverride(options.settings)
      const contextConfig = {
        config: {
          tool_output_token_limit: 3_000,
          ...(options.minimalContext ? await codexAuxiliaryConfig(projectPath) : {}),
          ...(contextWindow === undefined
            ? {}
            : {
                model_context_window: contextWindow,
                model_auto_compact_token_limit: Math.floor(contextWindow * COMPACT_LINE_SHARE)
              })
        }
      }
      const startThread = (): Promise<Record<string, unknown>> =>
        this.host.units['runtime'].appServerRequest(host, 'thread/start', {
          ...contextConfig,
          cwd: projectPath,
          dynamicTools,
          developerInstructions,
          model: options.settings.modelId,
          approvalPolicy: codexApprovalPolicy(
            options.readOnly === true,
            options.settings.permissionLevel
          ),
          ...(codexApprovalPolicy(options.readOnly === true, options.settings.permissionLevel) ===
          'on-request'
            ? { approvalsReviewer: 'user' }
            : {}),
          sandbox: sandboxFor(options.readOnly === true, options.settings.permissionLevel),
          serviceName: 'codeinoven'
        })
      const restoredHistory = (): string => {
        const currentMessageId = options.userMessageId ?? session.messages.at(-1)?.id
        return formatHistoryRecap(
          session.messages.filter((message) => message.id !== currentMessageId),
          // Apply the transport cap below, keeping the recent end of history,
          // so the formatter is given no budget of its own here: the cap that
          // follows is the one that trims the oldest end when it must.
          { maxInputTokens: Number.MAX_SAFE_INTEGER }
        )
      }
      let historyRecap = options.historyRecap
      let threadResult: Record<string, unknown>
      const previousNativeId = session.nativeSessionId
      const transferPath = `drivers/${this.host.base.id}/transfers/${session.id}.json`
      const transfer = await this.host.base.storage.read<{
        nativeThreadId: string
        projectPath: string
      }>(transferPath)
      const forkForTransfer =
        transfer?.projectPath === projectPath && previousNativeId === transfer.nativeThreadId
      if (forkForTransfer) {
        threadResult = await this.host.units['runtime'].appServerRequest(host, 'thread/fork', {
          ...contextConfig,
          threadId: transfer.nativeThreadId,
          excludeTurns: true,
          cwd: projectPath,
          dynamicTools,
          developerInstructions
        })
      } else if (previousNativeId) {
        try {
          threadResult = await this.host.units['runtime'].appServerRequest(host, 'thread/resume', {
            threadId: previousNativeId,
            // The app keeps its own transcript; native turn projection is unused.
            excludeTurns: true,
            ...contextConfig,
            dynamicTools,
            developerInstructions
          })
        } catch (error) {
          // Recover only an explicitly missing rollout. Auth, transport and
          // projection errors must retain the binding and their original error.
          if (
            !(error instanceof Error) ||
            error.message.trim() !== `no rollout found for thread id ${previousNativeId}`
          ) {
            throw error
          }
          historyRecap ||= restoredHistory()
          delete session.nativeSessionId
          this.host.threadSessionsByNativeId.delete(previousNativeId)
          await this.host.base.persistSession(session)
          Logger.info('Codex native rollout is missing; restoring mirrored history', {
            sessionId: session.id,
            nativeThreadId: previousNativeId
          })
          threadResult = await startThread()
        }
      } else {
        historyRecap ||= restoredHistory()
        threadResult = await startThread()
      }
      const thread = recordValue(threadResult['thread'])
      const nativeThreadId = stringValue(thread?.['id']) ?? session.nativeSessionId
      if (!nativeThreadId) throw new Error('Codex app-server did not return a thread ID')
      if (forkForTransfer && nativeThreadId === transfer.nativeThreadId) {
        throw new Error('Codex app-server did not return a new thread ID for the transfer')
      }
      active.nativeThreadId = nativeThreadId
      if (!previousNativeId || nativeThreadId !== previousNativeId) {
        session.codexUsageCheckpoint = {
          nativeThreadId,
          tokens:
            forkForTransfer && session.codexUsageCheckpoint
              ? session.codexUsageCheckpoint.tokens
              : { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        }
      }
      session.nativeSessionId = nativeThreadId
      this.host.threadSessionsByNativeId.set(nativeThreadId, { sessionId: session.id, projectPath })
      await this.host.base.persistSession(session)
      if (transfer?.projectPath === projectPath) await this.host.base.storage.remove(transferPath)

      const turnParams: Record<string, unknown> = {
        threadId: nativeThreadId,
        clientUserMessageId: options.userMessageId,
        input: await this.host.units['driver'].codexInput(
          options.text,
          options.attachments,
          session.id,
          historyRecap
        ),
        cwd: projectPath,
        approvalPolicy: codexApprovalPolicy(
          options.readOnly === true,
          options.settings.permissionLevel
        ),
        ...(codexApprovalPolicy(options.readOnly === true, options.settings.permissionLevel) ===
        'on-request'
          ? { approvalsReviewer: 'user' }
          : {}),
        sandboxPolicy: codexSandboxPolicy(
          projectPath,
          options.readOnly === true,
          options.settings.permissionLevel
        ),
        model: options.settings.modelId,
        serviceTier,
        effort: codexEffort(options.settings.thinkingLevel),
        summary: this.host.modelsWithoutReasoningSummaries.has(options.settings.modelId)
          ? 'none'
          : 'auto',
        ...(options.structuredOutput ? { outputSchema: options.structuredOutput.schema } : {})
      }
      active.startParams = turnParams
      const turnResult = await this.host.units['runtime'].appServerRequest(
        host,
        'turn/start',
        turnParams
      )
      const turn = recordValue(turnResult['turn'])
      const turnId = stringValue(turn?.['id'])
      if (!turnId) throw new Error('Codex app-server did not return an active turn ID')
      active.turnId = turnId
    } catch (error) {
      await this.host.units['runtime'].finishAppServerTurn(
        active,
        error instanceof Error ? error.message : 'Codex turn could not start'
      )
      throw error
    }
  }

  /** Append input to Codex's native in-flight turn without creating another turn. */
  async steerPrompt(projectPath: string, options: SteerPromptOptions): Promise<void> {
    const session = await this.host.base.requireSession(projectPath, options.sessionId)
    const active = this.host.activeTurns.get(session.id)
    if (!active?.nativeThreadId || !active.turnId || active.completionReceived || active.finished) {
      throw new Error(`No active Codex turn is available to steer for session ${session.id}`)
    }
    const input = await this.host.units['driver'].codexInput(
      options.text,
      options.attachments,
      session.id
    )
    if (
      this.host.activeTurns.get(session.id) !== active ||
      active.completionReceived ||
      active.finished
    ) {
      throw new Error(`Codex turn finished before steering session ${session.id}`)
    }
    await this.host.units['runtime'].appServerRequest(active.host, 'turn/steer', {
      threadId: active.nativeThreadId,
      clientUserMessageId: options.userMessageId,
      input,
      expectedTurnId: active.turnId
    })
    this.host.base.appendUserMessage(session, options)
    await this.host.base.persistSession(session)
  }

  /**
   * The context window this turn actually sends to Codex. Codex's own catalog
   * decides which windows a model runs with, so a stored window the model no
   * longer offers is dropped and the turn keeps Codex's default, exactly as the
   * picker shows it. A catalog that has not been read leaves the stored pick
   * untouched instead of silently discarding the user's choice.
   */
  codexContextWindowOverride(settings: ThreadSettings): number | undefined {
    const requested = settings.contextWindow
    if (requested === undefined || settings.providerId !== 'openai') return undefined
    const cached = this.host.codexWindowsByHome.get(this.host.codexHomeKey())
    if (!cached) return requested
    const offered = codexContextWindowOptions(cached.catalog.get(settings.modelId))
    return offered.length === 0 || offered.includes(requested) ? requested : undefined
  }

  /** Read persisted thread usage that `codex exec --json` does not stream. */
  async refreshContextUsage(
    projectPath: string,
    session: PersistentCliSession,
    messageId: string,
    nativeThreadId: string
  ): Promise<void> {
    const host = await this.host.units['runtime'].ensureAppServerHost(projectPath)
    const usagePromise = new Promise<ReturnType<typeof mapCodexUsage>>((resolve) => {
      const timer = setTimeout(() => {
        this.host.contextUsageByThreadId.delete(nativeThreadId)
        resolve(undefined)
      }, CODEX_USAGE_TIMEOUT_MS)
      this.host.contextUsageByThreadId.set(nativeThreadId, { host, resolve, timer })
    })
    try {
      await this.host.units['runtime'].appServerRequest(host, 'thread/resume', {
        threadId: nativeThreadId,
        excludeTurns: true
      })
    } catch (error) {
      const waiter = this.host.contextUsageByThreadId.get(nativeThreadId)
      if (waiter) clearTimeout(waiter.timer)
      this.host.contextUsageByThreadId.delete(nativeThreadId)
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
    this.host.base.applyEventToSession(session, event)
    this.host.base.emit(event)
    await this.host.base.persistSession(session)
  }
}
