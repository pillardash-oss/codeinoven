import { randomUUID } from 'crypto'
import { Logger } from '../../system/logger'
import { supportsIsolatedSessions } from '../../drivers/isolated-session'
import { DEFAULT_HARNESS } from '../../../lib/harness-default'
import {
  currentHarnessVersion,
  episodeFromPieces,
  tokenUsageAttribution
} from '../token-usage-attribution'
import { leanAgentNameForMode } from '../../opencode/opencode-agent-definitions'
import {
  validateBoundedString,
  validateEntityId,
  validateThreadSettings
} from '../../ipc/ipc-validation'
import type { SendPromptOptions } from '../../drivers/driver.interface'
import type {
  AgentMessage,
  AgentQuestion,
  AutoAnswerEntry,
  PermissionRequest,
  ThreadSettings
} from '../../../lib/types'
import { type TurnStepTimer } from '../turn-dispatch-timer'
import { GLOBAL_BROWSER_PROJECT_ID } from '../../../lib/ipc/browser'
import { GenerationClock, windowCoversOutput } from '../../../lib/usage-rate'
import { messageId as createMessageId } from '../../../lib/id'
import type { AutoAnswerReport, SessionInfo, VirtualTaskOptions } from './chat-engine-types'
import { rawErrorMessage } from './chat-engine-errors'
import {
  LOOP_MAX_ITERATIONS,
  assertHarnessRequestCapabilities,
  traceLeanAgent
} from './chat-engine-constants'
import { auditRequiresRework, broadcastToast } from './chat-engine-pure'
import type { ChatEngine } from '../chat-engine'

/** ChatEngine misc: one concern, moved verbatim from the composition root. */
export class ChatEngineMisc {
  constructor(private readonly host: ChatEngine) {}

  /** App-owned browser calls share the same policy, queue and attention events as harness calls. */
  async requestBrowserActionApproval(
    request: import('../../browser/browser-service').BrowserAgentActionApproval
  ): Promise<import('../../browser/browser-service').BrowserAgentActionDecision> {
    const info = request.sessionId ? this.host.sessionRegistry.get(request.sessionId) : undefined
    if (!info || info.projectId !== request.projectId || info.threadId !== request.threadId) {
      throw new Error('The browser action has no active conversation session')
    }
    let settle!: (approved: boolean, alternative?: string) => void
    const decision = new Promise<
      import('../../browser/browser-service').BrowserAgentActionDecision
    >((resolve) => {
      settle = (approved, alternative) => resolve({ approved, alternative })
    })
    const permission: PermissionRequest = {
      id: randomUUID(),
      sessionId: info.sessionId,
      permission: 'browser_action',
      patterns: [],
      metadata: {
        surface: `browser.${request.operation}`,
        description: request.action,
        origin: request.origin,
        pageUrl: request.pageUrl
      }
    }
    try {
      await this.host.units['permissions'].handlePermissionAsked(
        info.driverId,
        { type: 'permission.asked', sessionId: info.sessionId, permission },
        undefined,
        settle,
        request.review
      )
    } catch (error) {
      this.host.state.pendingPermissions.delete(permission.id)
      settle(false)
      throw error
    }
    return decision
  }

  /**
   * Time one unit of turn preparation, when the caller passed a dispatch timer.
   *
   * The turn's context build is one phase that used to hide everything inside it,
   * so every awaited unit reports its own step whether the dispatch was timed or
   * not: an untimed caller (older tests, an isolated session) simply runs the work.
   */
  timedStep<T>(timer: TurnStepTimer | undefined, step: string, work: Promise<T>): Promise<T> {
    return timer ? timer.step(step, work) : work
  }

  /**
   * Run a disposable project-scoped agent task without creating a Thread row.
   * Like title generation, this sends only the caller's exact task prompt
   * instead of assembling durable thread context. Model and thinking settings
   * remain under the user's control.
   * Session and process bookkeeping are retired as soon as the result is ready.
   * Provider deletion and process cleanup continue asynchronously so they do
   * not delay the caller after the response has been captured.
   */
  async runVirtualTask(
    projectId: string,
    virtualTaskId: string,
    settings: ThreadSettings,
    title: string,
    text: string,
    options: VirtualTaskOptions = {}
  ): Promise<AgentMessage> {
    projectId = validateEntityId(projectId, 'Project ID')
    virtualTaskId = validateEntityId(virtualTaskId, 'Virtual task ID')
    settings = validateThreadSettings({
      ...settings,
      assignmentMode: false,
      loopMode: false
    })
    title = validateBoundedString(title, 'Virtual task title', 1, 512)
    text = validateBoundedString(text, 'Virtual task prompt', 1, 200_000)
    this.host.units['turns'].markProjectActive(projectId)

    const driverId = settings.harnessId || DEFAULT_HARNESS
    const { driver, projectPath } = await this.host.resolve(projectId, driverId)
    assertHarnessRequestCapabilities(driver, [], settings.permissionLevel)
    // Isolation is opt-in per caller: a task that must not appear in the user's
    // own harness sessions asks for it, and everyone else runs a normal one.
    const isolated =
      supportsIsolatedSessions(driver) && options.isolateOpenCode === true
        ? await driver.createIsolatedSession(projectPath, title)
        : undefined
    const sessionId = isolated?.sessionId ?? (await driver.createSession(projectPath, title))
    const turnId = createMessageId()
    this.host.registerSession(
      sessionId,
      projectId,
      virtualTaskId,
      projectPath,
      settings.permissionLevel,
      driverId,
      turnId,
      true
    )
    const initialCompletion = this.host.units['turns-sessions'].waitForSessionCompletion(
      sessionId,
      180_000,
      title
    )

    try {
      const request: SendPromptOptions = {
        sessionId,
        settings,
        text,
        attachments: [],
        systemPrompt: options.systemPrompt,
        readOnly: options.readOnly ?? false,
        agent: leanAgentNameForMode('pr-compose'),
        ...(options.allowedTools === undefined ? {} : { allowedTools: options.allowedTools }),
        ...(options.structuredOutput === undefined || driver.capabilities.structuredOutput !== true
          ? {}
          : { structuredOutput: options.structuredOutput }),
        userMessageId: turnId
      }
      traceLeanAgent('pr-compose', sessionId, driverId)
      tokenUsageAttribution.recordPromptAttribution(
        episodeFromPieces({
          key: `pr:${sessionId}`,
          mode: 'pr-compose',
          driverId,
          pieces: [{ title: 'Virtual task prompt', content: text }]
        })
      )
      const runAttempt = async (
        prompt: SendPromptOptions,
        completion: Promise<unknown | undefined>
      ): Promise<AgentMessage> => {
        if (isolated && supportsIsolatedSessions(driver)) {
          await driver.sendPrompt(projectPath, prompt, isolated)
        } else {
          await driver.sendPrompt(projectPath, prompt)
        }
        await completion
        const messages =
          isolated && supportsIsolatedSessions(driver)
            ? await driver.loadMessages(projectPath, sessionId, isolated)
            : await driver.loadMessages(projectPath, sessionId)
        const response = [...messages].reverse().find((message) => message.role === 'assistant')
        if (!response) throw new Error(`${title} returned no response`)
        if (response.error) throw new Error(response.error)
        return response
      }
      const recordUsage = (response: AgentMessage, key: string): void => {
        tokenUsageAttribution.recordTurnTotals({
          key,
          agent: leanAgentNameForMode('pr-compose'),
          driverId,
          harnessVersion: currentHarnessVersion(),
          providerId: response.providerId ?? settings.providerId ?? null,
          modelId: response.modelId ?? settings.modelId ?? null,
          reportedInputTokens: response.normalizedUsage?.uncachedInput ?? null,
          reportedTotalTokens: response.normalizedUsage?.rawTotal ?? null
        })
        // A virtual task owns no thread row, so its spend is recorded against
        // the disposable session it ran in and the project it served.
        this.host.units['messages-write'].recordEphemeralTurnUsage({
          projectId,
          threadId: null,
          sessionId,
          callId: key,
          message: response
        })
      }

      let response = await runAttempt(request, initialCompletion)
      recordUsage(response, `pr:${sessionId}`)

      const fallback = options.textOutputFallback
      const requestedRetries = options.structuredOutput?.retryCount ?? 0
      const retryCount =
        Number.isSafeInteger(requestedRetries) && requestedRetries > 0
          ? Math.min(requestedRetries, 3)
          : 0
      if (fallback && driver.capabilities.structuredOutput !== true) {
        for (let attempt = 1; attempt <= retryCount && !fallback.accepts(response); attempt += 1) {
          const repairText = validateBoundedString(
            fallback.repairPrompt(response, attempt),
            'Virtual task repair prompt',
            1,
            200_000
          )
          const attributionKey = `pr:${sessionId}:repair:${attempt}`
          tokenUsageAttribution.recordPromptAttribution(
            episodeFromPieces({
              key: attributionKey,
              mode: 'pr-compose',
              driverId,
              pieces: [{ title: `Virtual task repair ${attempt}`, content: repairText }]
            })
          )
          const completion = this.host.units['turns-sessions'].waitForSessionCompletion(
            sessionId,
            180_000,
            title
          )
          response = await runAttempt(
            {
              ...request,
              text: repairText,
              attachments: [],
              userMessageId: createMessageId()
            },
            completion
          )
          recordUsage(response, attributionKey)
        }
      }
      return response
    } catch (error) {
      if (isolated && supportsIsolatedSessions(driver)) {
        await driver.abort(projectPath, sessionId, isolated).catch(() => undefined)
      } else {
        await driver.abort(projectPath, sessionId).catch(() => undefined)
      }
      throw error
    } finally {
      this.host.units['runtime-connectivity'].clearCompletionWaiter(sessionId)
      this.host.units['turns-sessions'].retireSessionState(sessionId)
      void (async () => {
        await this.host.units['utilities'].cleanupTurnUtilities(sessionId).catch(() => undefined)
        await this.host.state.agentProcesses
          .releaseThread(projectId, virtualTaskId)
          .catch((error) => Logger.dev('Virtual task process cleanup was incomplete:', error))
        if (isolated && supportsIsolatedSessions(driver)) {
          driver.disposeIsolatedSession(isolated)
        } else if (driver.deleteSession) {
          await driver.deleteSession(projectPath, sessionId).catch(() => undefined)
        }
      })().catch((error) => Logger.dev('Virtual task cleanup was incomplete:', error))
    }
  }

  async continueLoop(projectId: string, threadId: string): Promise<void> {
    const key = `${projectId}:${threadId}`
    if (this.host.state.activeLoopRuns.has(key)) return
    this.host.state.activeLoopRuns.add(key)

    try {
      const thread = await this.host.threadManager.getThread(projectId, threadId)
      const settings = thread?.settings
      if (!thread || settings?.loopMode !== true) return
      const assignment = this.host.state.assignmentEngine.getActive(projectId, threadId)
      if (assignment && assignment.status !== 'completed') return

      const persistedReport =
        thread.auditState === 'report_ready' && thread.activeAuditId && thread.activeAuditVersion
          ? this.host.state.auditEngine
              .listVersions(projectId, threadId, thread.activeAuditId)
              .find((candidate) => candidate.version === thread.activeAuditVersion)
          : undefined
      const iteration = persistedReport
        ? Math.max(1, thread.loopIteration ?? 1)
        : (thread.loopIteration ?? 0) + 1
      let report = persistedReport
      if (!report) {
        await this.host.threadManager.setLoopIteration(projectId, threadId, iteration)
        const auditSettings = await this.host.units['audit'].loopAuditSettings(settings)
        if (assignment) {
          report = (await this.host.generateAssignmentAudit(projectId, threadId, auditSettings))
            .report
        } else {
          await this.host.ensureAchievementScope(projectId, threadId)
          report = (await this.host.generateAchievementAudit(projectId, threadId, auditSettings))
            .report
        }
      }

      const current = await this.host.threadManager.getThread(projectId, threadId)
      if (current?.settings?.loopMode !== true) return

      if (!auditRequiresRework(report.content)) {
        await this.host.threadManager.setAuditState(projectId, threadId, undefined)
        await this.host.threadManager.updateSettings(projectId, threadId, {
          ...current.settings,
          loopMode: false
        })
        await this.host.threadManager.setStatus(projectId, threadId, 'completed', { read: false })
        if (current.sessionId) {
          this.host.state.engineeringImplementationSessions.delete(current.sessionId)
        }
        broadcastToast(
          `Achievement completed after ${iteration} ${iteration === 1 ? 'audit' : 'audits'}.`,
          'info'
        )
        return
      }

      if (iteration >= LOOP_MAX_ITERATIONS) {
        const failure = `Achievement stopped after ${LOOP_MAX_ITERATIONS} audits without satisfying the goal.`
        await this.host.threadManager.setAuditState(projectId, threadId, undefined)
        await this.host.threadManager.updateSettings(projectId, threadId, {
          ...current.settings,
          loopMode: false
        })
        this.host.units['turns'].markEngineeringLifecycleFailure(projectId, threadId, failure)
        if (current.sessionId) {
          this.host.state.engineeringImplementationSessions.delete(current.sessionId)
        }
        broadcastToast(failure)
        return
      }

      await this.host.threadManager.setAuditState(projectId, threadId, 'reworking')
      await this.host.sendPrompt(
        projectId,
        threadId,
        current.settings,
        await this.host.units['turns-dispatch'].loopReworkPrompt(report, iteration),
        [],
        'implement',
        undefined,
        undefined,
        undefined,
        undefined,
        'internal'
      )
    } catch (error) {
      Logger.error('Achievement loop failed', {
        projectId,
        threadId,
        error: rawErrorMessage(error)
      })
      const current = await this.host.threadManager.getThread(projectId, threadId)
      if (current?.settings?.loopMode) {
        await this.host.threadManager.updateSettings(projectId, threadId, {
          ...current.settings,
          loopMode: false
        })
      }
      if (current?.auditState === 'running' || current?.auditState === 'reworking') {
        await this.host.threadManager.setAuditState(projectId, threadId, undefined)
      }
      this.host.units['turns'].markEngineeringLifecycleFailure(projectId, threadId, error)
      if (current?.sessionId) {
        this.host.state.engineeringImplementationSessions.delete(current.sessionId)
      }
      broadcastToast(`Achievement stopped: ${rawErrorMessage(error)}`)
    } finally {
      this.host.state.activeLoopRuns.delete(key)
    }
  }

  /**
   * Ensure the reserved global-browser scope (its hidden project and its single
   * hidden parent thread) exists before a per-tab agent session resolves scope
   * against it. Idempotent, so it is safe on every first send.
   */
  async ensureGlobalBrowserScope(projectId: string): Promise<void> {
    if (projectId !== GLOBAL_BROWSER_PROJECT_ID) return
    await this.host.state.projectManager.ensureGlobalBrowserSpace()
    await this.host.threadManager.ensureGlobalBrowserThread()
  }

  /**
   * Record activity from a surface that is not a card interaction, such as the
   * composer. Composer typing is a user working in the app, so it holds every
   * pending card's countdown exactly as answer typing does; the renderer
   * forwards it at a throttled pace so a busy composer never floods the main
   * process with one call per keystroke.
   */
  noteUserActivity(): void {
    this.host.units['messages'].touchUserActivity()
  }

  /** Report an auto-resolved gate, never letting a recording failure affect the
   *  resolution itself. */
  reportAutoAnswer(report: AutoAnswerReport): void {
    try {
      this.host.state.autoAnswerRecorder?.(report)
    } catch (error) {
      Logger.error('Auto-answer recording failed:', error)
    }
  }

  /**
   * Build the attention entries for one request: each question's prompt, its
   * offered option labels, and what the engine chose (null when it could not
   * choose). Falls back to the rich-option labels when the plain option list
   * was not supplied.
   */
  autoAnswerEntries(
    questions: AgentQuestion[],
    answers: string[][] | undefined
  ): AutoAnswerEntry[] {
    return questions.map((question, index) => {
      const options =
        question.options && question.options.length > 0
          ? [...question.options]
          : (question.richOptions?.map((option) => option.label) ?? [])
      const picked = answers?.[index]?.find((value) => value.length > 0) ?? null
      return {
        prompt: question.prompt,
        ...(question.header ? { header: question.header } : {}),
        options,
        picked
      }
    })
  }

  /**
   * The moment the judge routes of one row reopen, or null while one lane can
   * still judge it. A resolvable route with no window knowledge is treated as
   * free, so a row is held back only when every existing route sits inside a
   * window the provider itself reported closed.
   */
  blockedUntilOf(lando: ReadonlyArray<number | null | undefined>): number | null {
    const closed = lando.filter(
      (until): until is number => typeof until === 'number' && until < Number.POSITIVE_INFINITY
    )
    if (closed.length === 0) return null
    if (lando.some((until) => until === null)) return null
    return Math.min(...closed)
  }

  /** Apply in-memory reasoning time stamps to loaded messages (populated during streaming). */
  applyReasoningStamps(sessionId: string, messages: AgentMessage[]): void {
    const sessionReasoning = this.host.state.reasoningTimes.get(sessionId)
    if (!sessionReasoning) return
    for (const msg of messages) {
      if (msg.role !== 'assistant') continue
      let changed = false
      for (const part of msg.parts) {
        if (part.type === 'reasoning') {
          const stamp = sessionReasoning.get(part.id)
          if (stamp && (!part.time?.start || !part.time?.end)) {
            part.time = { start: stamp.start, end: stamp.end }
            changed = true
          }
        }
      }
      if (changed) msg.parts = [...msg.parts]
    }
  }

  /**
   * Apply the accumulated generation window to loaded assistant messages,
   * persisting the model-active duration as `generationMs`.
   *
   * A message whose output mostly arrived as buffered flushes is left without a
   * window: the clock measured no generation to divide its tokens by, and a
   * stamped window would outlive this process as a rate nobody can read
   * correctly. The renderer withholds a rate for exactly the same samples, so the
   * live figure and the reopened figure agree.
   */
  applyGenerationStamps(sessionId: string, messages: AgentMessage[]): void {
    for (const msg of messages) {
      if (msg.role !== 'assistant' || msg.generationMs !== undefined) continue
      const sample = this.host.state.generationClock.sample(GenerationClock.key(sessionId, msg.id))
      if (!sample || sample.activeMs <= 0) continue
      if (!windowCoversOutput(sample)) continue
      msg.generationMs = Math.round(sample.activeMs)
    }
  }

  /** True when a silent session has live work we must not abort: an in-flight
   *  shell/CLI tool or a running provider-native sub-agent. */
  hasInFlightWork(sessionId: string, info: SessionInfo): boolean {
    if (info.openUnboundedTools && info.openUnboundedTools.size > 0) return true
    for (const [childSessionId, owner] of this.host.state.childSessionOwners) {
      if (owner.parentSessionId !== sessionId) continue
      if (this.host.sessionStatuses.get(childSessionId)?.state === 'working') return true
    }
    return false
  }
}
