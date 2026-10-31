import { Logger } from '../../system/logger'
import { DRIVER_EVENTS_LOG_FILE, dailyLogRelativePath } from '../../system/log-paths'
import type { IsolatedSessionHandle } from '../../drivers/isolated-session'
import { supportsIsolatedSessions } from '../../drivers/isolated-session'
import { toPosixPath } from '../../../lib/paths'
import { estimateTokens } from '../memory-service'
import { currentHarnessVersion, tokenUsageAttribution } from '../token-usage-attribution'
import type { HarnessDriver } from '../../drivers/driver.interface'
import type {
  AgentEvent,
  AgentMessage,
  AgentPart,
  UsageBearingMessage,
  PromptAttachment,
  PromptProjectReference,
  PromptReference,
  SessionAgentEvent,
  UserMessagePresentation,
  Thread,
  ThreadSettings,
  UsageEventDetails,
  UsageEventFeature
} from '../../../lib/types'
import { capPersistedPart } from '../bounded-tool-output'
import { groupStreamPartsIntoMessages } from '../turn-stream'
import type { TurnStreamEvent } from '../turn-stream'
import { estimateModelCost } from '../../providers/pricing'
import type { AutoAnswerReport, SessionInfo } from './chat-engine-types'
import { rawErrorMessage } from './chat-engine-errors'
import { MAX_PERSISTED_DELTA, assistantText } from './chat-engine-message-text'
import { aggregateTurnUsage, turnStreamPath } from './chat-engine-pure'
import type { ChatEngine } from '../chat-engine'

/** ChatEngine messages-write: one concern, moved verbatim from the composition root. */
export class ChatEngineMessagesWrite {
  constructor(private readonly host: ChatEngine) {}

  /**
   * The user saved a file through the in-app editor. Record the path against
   * every active turn session in that project so their own edit is never
   * attributed to a running agent thread's file-changes card.
   */
  recordUserFileSave(projectId: string, relativePath: string): void {
    const normalized = toPosixPath(relativePath.trim())
    if (!normalized || normalized.startsWith('../') || normalized === '..') return
    for (const session of this.host.sessionRegistry.values()) {
      if (session.projectId !== projectId || !session.activeTurnId) continue
      ;(session.userTouchedPaths ??= new Set()).add(normalized)
    }
  }

  /**
   * Drop a message and everything after it from the mirror   editing a
   * message replaces that history. The harness session is discarded so the
   * next prompt starts fresh and replays the preserved context via the recap.
   */
  async truncateMessages(
    projectId: string,
    threadId: string,
    messageId: string
  ): Promise<AgentMessage[]> {
    return this.host.deleteMessages(projectId, threadId, messageId, 'down')
  }

  /**
   * Persist a user message to the mirror immediately so thread navigation
   * cannot lose the latest message while the driver is still starting or
   * streaming. Returns the persisted message so the renderer can reconcile its
   * optimistic bubble with the authoritative ID.
   */
  async persistOutboundMessage(
    projectId: string,
    threadId: string,
    messageId: string,
    displayText: string,
    transportText: string,
    attachments: PromptAttachment[],
    references: PromptReference[],
    projectReferences: PromptProjectReference[],
    presentation?: UserMessagePresentation,
    dispatchOrigin: 'user' | 'internal' = 'user',
    visiblePrompt = false
  ): Promise<AgentMessage> {
    // Attachments enter the thread here, so drop any memoized allowlist and let
    // the next permission request rebuild it from the latest message records.
    this.host.state.chatAttachmentAllowlists.delete(threadId)
    const mirror = await this.host.threadManager.loadMessageRecords(projectId, threadId)
    const existing = mirror.find((message) => message.id === messageId)
    if (existing) return existing
    const createdAt = Date.now()
    const fileParts = attachments.map((attachment, index): AgentPart => ({
      type: 'file',
      id: `${messageId}-file-${index}`,
      messageID: messageId,
      mime: attachment.mime,
      url: attachment.url,
      filename: attachment.filename
    }))
    const visible = dispatchOrigin === 'user' || presentation !== undefined || visiblePrompt
    const userMessage: AgentMessage = {
      id: messageId,
      role: 'user',
      origin: visible ? 'user' : 'orchestrator',
      visibility: visible ? 'conversation' : 'hidden',
      parts: [
        ...(!presentation
          ? [
              {
                type: 'text' as const,
                id: `${messageId}-text`,
                messageID: messageId,
                text: displayText
              }
            ]
          : []),
        ...fileParts,
        ...(presentation
          ? [
              {
                type: 'user-presentation' as const,
                id: `${messageId}-presentation`,
                messageID: messageId,
                presentation
              }
            ]
          : [])
      ],
      transportParts: [
        {
          type: 'text',
          id: `${messageId}-transport-text`,
          messageID: messageId,
          text: transportText
        },
        ...fileParts
      ],
      transportOrigin:
        dispatchOrigin === 'user' && presentation === undefined && displayText === transportText
          ? 'user'
          : 'orchestrator',
      references: visible && references.length > 0 ? references : undefined,
      projectReferences: visible && projectReferences.length > 0 ? projectReferences : undefined,
      createdAt,
      completedAt: createdAt
    }
    await this.host.threadManager.upsertMessages(projectId, threadId, [userMessage])
    return userMessage
  }

  /** Persist identifiers and state transitions without recording prompt/tool content. */
  async recordDriverEvent(driverId: string, event: SessionAgentEvent): Promise<void> {
    if (
      event.type === 'message.part.updated' ||
      event.type === 'message.part.delta' ||
      event.type === 'usage.updated'
    ) {
      return
    }

    const session = this.host.sessionRegistry.get(event.sessionId)
    const childOwner = this.host.state.childSessionOwners.get(event.sessionId)
    // A driver session the engine never registered has no project, thread or
    // turn to report. Ten of fifteen idle records in one day's file were exactly
    // that, each with three fields silently dropped by `JSON.stringify`, so the
    // row now says which kind of unattributed session it was: a reader can
    // filter the probes out instead of meeting a half-written record.
    const attribution =
      !session && !childOwner
        ? (
            this.host.drivers.get(driverId) ?? this.host.state.accountDrivers.get(driverId)
          )?.isAuxiliarySession?.(event.sessionId)
          ? 'auxiliary'
          : 'unregistered'
        : undefined
    const identifiers: Record<string, string> = {}

    if (attribution) identifiers.attribution = attribution

    if (event.type === 'message.completed') {
      identifiers.messageId = event.messageId
    } else if (event.type === 'permission.asked') {
      identifiers.permissionRequestId = event.permission.id
    } else if (event.type === 'permission.replied') {
      identifiers.permissionRequestId = event.requestId
    } else if (event.type === 'question.asked' || event.type === 'question.resolved') {
      identifiers.questionRequestId = event.requestId
    }

    try {
      await this.host.storage.appendRaw(
        dailyLogRelativePath(DRIVER_EVENTS_LOG_FILE),
        `${JSON.stringify({
          timestamp: Date.now(),
          eventType: event.type,
          driverId,
          sessionId: event.sessionId,
          projectId: session?.projectId ?? childOwner?.projectId,
          threadId: session?.threadId ?? childOwner?.threadId,
          turnId: session?.activeTurnId,
          ...identifiers
        })}\n`
      )
    } catch (error) {
      Logger.error('Driver event audit write failed:', error)
    }
  }

  /** Append one working-trace part event to the thread's durable SSE log. */
  async persistTurnStreamEvent(
    owner: SessionInfo,
    event: Extract<AgentEvent, { type: 'message.part.updated' | 'message.part.delta' }>
  ): Promise<void> {
    const streamPath = turnStreamPath(owner.projectId, owner.threadId)
    // A deleted thread's append is a no-op: the deletion removed the file, and a
    // late write would recreate the directory it just freed.
    if (this.host.state.deletedTurnStreams.has(streamPath)) return
    const ts = Date.now()
    const sessionId = event.sessionId
    // Bind the event to the session's active turn; while the active turn is
    // unbound (pre-registration setup, post-checkpoint teardown, silent
    // continues) fall back to the session's LAST bound turn so the durable
    // trace keeps a real anchor instead of an empty tag that no reload fold
    // can ever re-attach.
    const turnId = owner.activeTurnId ?? owner.lastTurnId ?? ''
    // Oversized tool outputs (base64 image payloads, megabyte file dumps) are
    // capped before they reach the durable stream log   an uncapped line makes
    // every later log re-parse (reopen, fold, fork) pay for it forever.
    const streamEvent: TurnStreamEvent =
      event.type === 'message.part.updated'
        ? {
            kind: 'part.updated',
            sessionId,
            messageId: event.part.messageID,
            turnId,
            ts,
            part: capPersistedPart(event.part)
          }
        : {
            kind: 'part.delta',
            sessionId,
            messageId: event.messageId,
            partId: event.partId,
            field: event.field,
            delta: event.delta.length > MAX_PERSISTED_DELTA ? '' : event.delta,
            turnId,
            ts
          }
    if (
      event.type === 'message.part.delta' &&
      streamEvent.kind === 'part.delta' &&
      streamEvent.delta === ''
    ) {
      // A single delta larger than the whole bounded output is pure payload
      // (e.g. one base64 chunk); persisting it would re-poison the log.
      return
    }
    await this.host.storage.appendRaw(streamPath, `${JSON.stringify(streamEvent)}\n`)
  }

  /**
   * Persist the work a turn streamed but never reported.
   *
   * A stop ends a turn before the provider transcript is finalized, and a crash
   * can end one before its idle finalization runs at all. The mirror then holds
   * no assistant row for the turn, so the work exists only in the durable stream
   * log, which the next turn's boundary scopes out and the log's eventual
   * compaction trims away. Folding the log into the assistant messages the
   * harness was streaming when the turn died keeps that work in the transcript
   *   across the stop, across a restart, and across whatever turn comes next.
   *
   * A gap filler and nothing more. A turn that already has an assistant row is
   * left exactly as the provider reported it, so a finalized transcript is never
   * rewritten from the log and a provider's own message ids are never shadowed
   * by the log's. It returns quietly when there is nothing to recover.
   */
  async persistStreamedTurnWork(
    projectId: string,
    threadId: string,
    sessionId: string | null
  ): Promise<void> {
    try {
      // A session still working owns its turn and will report it itself; the log
      // must never race a live turn into the transcript.
      if (sessionId && this.host.sessionStatuses.get(sessionId)?.state === 'working') return
      const thread = await this.host.threadManager.getThread(projectId, threadId)
      if (!thread) return
      const turnStartTs = await this.host.units['lifecycle'].currentTurnStartTs(projectId, threadId)
      const tail = await this.host.threadManager.loadMessagePage(projectId, threadId, undefined, 60)
      // The provider's own transcript wins whenever the turn has one. Its
      // message ids are the ones the transcript was built with; adding the
      // log's ids beside them would double the turn, not fill a gap.
      if (
        tail.messages.some(
          (message) =>
            message.role === 'assistant' &&
            // A compaction summary is an assistant row mid-turn, not the turn's
            // report, so it must not pass for one here.
            message.origin !== 'compaction' &&
            message.parts.some((part) => part.type !== 'compaction') &&
            (turnStartTs === undefined || message.createdAt >= turnStartTs)
        )
      ) {
        return
      }
      const folded = await this.host.units['turns-stream'].readWholeTurnStream(
        projectId,
        threadId,
        turnStartTs
      )
      if (folded.parts.length === 0) return
      const existingIds = new Set(tail.messages.map((message) => message.id))
      const selection = sessionId ? this.host.state.sessionModelIds.get(sessionId) : undefined
      const settings = thread.settings
      const recovered: AgentMessage[] = []
      let previousCreatedAt: number | undefined
      for (const rebuilt of groupStreamPartsIntoMessages(folded.parts, folded.lastActivityTs)) {
        if (existingIds.has(rebuilt.id)) continue
        // Keep the messages in stream order even when the harness reported a
        // timestamp for only some of them.
        const createdAt = Math.max(
          rebuilt.startedAt ?? Number.NEGATIVE_INFINITY,
          (previousCreatedAt ?? Number.NEGATIVE_INFINITY) + 1,
          turnStartTs ?? 0
        )
        previousCreatedAt = createdAt
        recovered.push({
          id: rebuilt.id,
          role: 'assistant',
          origin: 'harness',
          visibility: 'conversation',
          parts: rebuilt.parts,
          harnessId: thread.sessionHarnessId ?? settings?.harnessId,
          providerId: selection?.providerId ?? settings?.providerId,
          modelId: selection?.modelId ?? settings?.modelId,
          thinkingLevel: selection?.thinkingLevel ?? settings?.thinkingLevel,
          accountId: thread.sessionAccountId,
          createdAt
        })
      }
      if (recovered.length === 0) return
      await this.host.threadManager.upsertMessages(
        projectId,
        threadId,
        recovered,
        sessionId ?? undefined
      )
      Logger.info('Recovered streamed turn work into the transcript', {
        projectId,
        threadId,
        messages: recovered.length
      })
    } catch (error) {
      Logger.error('Recovering streamed turn work failed', {
        projectId,
        threadId,
        error: rawErrorMessage(error)
      })
    }
  }

  /**
   * Wire the auto-answer recorder. Fired the moment the engine settles a gate
   * on the user's behalf   a question's timer picking the recommended option, a
   * secret card expiring unanswered, or an image-descriptor decision timing out   so
   * the app can record what was asked, offered and chosen and surface it on the
   * attention rail.
   */
  attachAutoAnswerRecorder(recorder: ((report: AutoAnswerReport) => void) | null): void {
    this.host.state.autoAnswerRecorder = recorder
  }

  recordMessageUsageEvent(
    threadId: string,
    thread: Thread | null,
    parentTurnId: string | null,
    message: AgentMessage,
    responses: readonly UsageBearingMessage[],
    failure?: string
  ): void {
    const feature: UsageEventFeature =
      thread?.achievementRole === 'auditor'
        ? 'audit'
        : thread?.assignmentRole === 'worker' || thread?.assignmentRole === 'coordinator'
          ? 'assignment'
          : 'main'
    // One row per user turn, carrying the whole turn's spend. The terminal
    // response still supplies the attribution; the aggregate supplies the
    // tokens, cost and timing of every response in the turn.
    //
    // The row is keyed by the turn, not by the terminal response, because a turn
    // can finalize more than once (resume, continuation, per-response idle).
    // Keying it by the response would append a second aggregate that re-counts
    // the responses the first row already held.
    const turnKey = parentTurnId ?? message.id
    const aggregate = aggregateTurnUsage(responses)
    const normalizedUsage = aggregate.normalizedUsage
    tokenUsageAttribution.recordTurnTotals({
      key: turnKey,
      agent: null,
      driverId: message.harnessId ?? thread?.settings?.harnessId ?? null,
      harnessVersion: currentHarnessVersion(),
      providerId: message.providerId ?? thread?.settings?.providerId ?? null,
      modelId: message.modelId ?? thread?.settings?.modelId ?? null,
      reportedInputTokens: normalizedUsage?.uncachedInput ?? null,
      reportedTotalTokens: normalizedUsage?.rawTotal ?? null
    })
    this.host.units['assistant-authoring'].recordAssistantUsageEvent({
      idPrefix: 'message',
      threadId,
      projectId: null,
      parentTurnId: turnKey,
      feature,
      featureCallId: turnKey,
      replace: true,
      message: {
        id: turnKey,
        role: 'assistant',
        createdAt: aggregate.startedAt,
        completedAt: aggregate.completedAt,
        ...(message.error ? { error: message.error } : {}),
        ...(message.harnessId ? { harnessId: message.harnessId } : {}),
        ...(message.providerId ? { providerId: message.providerId } : {}),
        ...(message.modelId ? { modelId: message.modelId } : {}),
        ...(message.thinkingLevel ? { thinkingLevel: message.thinkingLevel } : {}),
        ...(message.accountId ? { accountId: message.accountId } : {}),
        ...(normalizedUsage ? { normalizedUsage } : {})
      },
      cost: aggregate.cost,
      thinkingLevelFallback: thread?.settings?.thinkingLevel ?? null,
      failure
    })
  }

  /**
   * Record one disposable session's usage.
   *
   * Ephemeral sessions own no user turn, so they are anchored to the owning
   * thread when one exists and to a synthetic `virtual:` scope otherwise, with
   * the session id as the turn key. That keeps their spend in the profile,
   * model and daily totals while never matching a real thread turn in the
   * per-turn KPIs.
   */
  recordEphemeralTurnUsage(input: {
    projectId: string | null
    threadId: string | null
    sessionId: string
    /** Identity of the call inside the disposable session (turn or attempt). */
    callId: string
    message: AgentMessage | undefined
  }): void {
    const message = input.message
    if (!message || message.role !== 'assistant' || !message.harnessId) return
    if (message.tokens === undefined && message.normalizedUsage === undefined) return
    this.host.units['assistant-authoring'].recordAssistantUsageEvent({
      idPrefix: 'ephemeral',
      threadId: input.threadId ?? `virtual:${input.sessionId}`,
      projectId: input.projectId,
      parentTurnId: `ephemeral:${input.sessionId}`,
      feature: 'ephemeral',
      featureCallId: input.callId,
      message,
      thinkingLevelFallback: null
    })
  }

  /**
   * Record every usage-bearing turn of a disposable generation session.
   *
   * PRD, brainstorm, spec and assignment drafts run in sessions that own no
   * user turn and never finalize through `onSessionIdle`, so their spend is only
   * visible while the session transcript is still readable. Runs before the
   * session is torn down, so a generation that failed still records what it
   * spent.
   */
  async recordEphemeralSessionUsage(input: {
    projectId: string
    threadId: string
    sessionId: string
    projectPath: string
    driver: HarnessDriver
    isolated?: IsolatedSessionHandle
  }): Promise<void> {
    try {
      const messages =
        input.isolated && supportsIsolatedSessions(input.driver)
          ? await input.driver.loadMessages(input.projectPath, input.sessionId, input.isolated)
          : await input.driver.loadMessages(input.projectPath, input.sessionId)
      for (const message of messages) {
        if (message.role !== 'assistant') continue
        if (message.tokens === undefined && message.normalizedUsage === undefined) continue
        this.recordEphemeralTurnUsage({
          projectId: input.projectId,
          threadId: input.threadId,
          sessionId: input.sessionId,
          callId: message.id,
          message
        })
      }
    } catch (error) {
      Logger.dev('Disposable session usage read failed:', error)
    }
  }

  recordAuxiliaryUsageEvent(input: {
    feature: 'memory' | 'image_descriptor' | 'search_nudge'
    threadId: string
    parentTurnId: string
    featureCallId: string
    attempt: number
    harnessId: string
    settings: ThreadSettings
    inputText: string
    response?: AgentMessage
    failure: string | null
  }): void {
    const reported = input.response?.normalizedUsage
    const inputTokens = reported?.uncachedInput ?? estimateTokens(input.inputText)
    const outputTokens =
      reported?.output ?? estimateTokens(input.response ? assistantText(input.response) : '')
    const cost = input.response?.cost ?? null
    if (input.feature === 'memory' || input.feature === 'search_nudge') {
      this.host.state.memoryService.recordAuxiliaryUsage(
        input.feature,
        inputTokens,
        input.inputText.length,
        {
          outputTokens,
          costUsd: cost,
          costStatus: cost === null ? 'unavailable' : 'known'
        }
      )
    }
    const details: UsageEventDetails = {
      id: `${input.feature}:${input.parentTurnId}:${input.featureCallId}:${input.attempt}`,
      threadId: input.threadId,
      parentTurnId: input.parentTurnId,
      featureCallId: input.featureCallId,
      attempt: input.attempt,
      feature: input.feature,
      harnessId: input.harnessId,
      accountId: input.response?.accountId ?? input.settings.accountId ?? null,
      providerId: input.settings.providerId,
      modelId: input.settings.modelId,
      thinkingLevel: input.settings.thinkingLevel ?? null,
      utilityId: null,
      rawProviderUsage: reported?.rawProviderUsage ?? {},
      tokens: {
        uncachedInput: inputTokens,
        cachedInput: reported?.cachedInput ?? null,
        cacheWrite: reported?.cacheWrite ?? null,
        output: outputTokens,
        reasoning: reported?.reasoning ?? null
      },
      rawTotal: reported?.rawTotal ?? null,
      totalSemantics: reported?.totalSemantics ?? 'unavailable',
      toolFeeUsd: null,
      success: input.failure === null && !input.response?.error,
      retryCause: input.failure ?? input.response?.error ?? null,
      durationMs:
        input.response?.completedAt !== undefined && input.response.createdAt !== undefined
          ? Math.max(0, Math.floor(input.response.completedAt - input.response.createdAt))
          : 0,
      createdAt: input.response?.completedAt ?? input.response?.createdAt ?? Date.now()
    }
    const estimated =
      cost === null
        ? estimateModelCost(
            input.settings.modelId,
            input.settings.providerId,
            reported
              ? {
                  input: reported.uncachedInput ?? 0,
                  output: reported.output ?? 0,
                  reasoning: reported.reasoning ?? 0,
                  cacheRead: reported.cachedInput ?? 0,
                  cacheWrite: reported.cacheWrite ?? 0,
                  total:
                    (reported.uncachedInput ?? 0) +
                    (reported.cachedInput ?? 0) +
                    (reported.cacheWrite ?? 0) +
                    (reported.output ?? 0)
                }
              : inputTokens > 0 || outputTokens > 0
                ? {
                    input: inputTokens,
                    output: outputTokens,
                    reasoning: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    total: inputTokens + outputTokens
                  }
                : undefined,
            // The window that governed the run is the run's own timestamp, not
            // the moment the record is written.
            new Date(details.createdAt)
          )
        : null
    if (cost !== null) {
      this.host.state.usageRepo.recordEvent({
        ...details,
        costStatus: 'known',
        costUsd: cost,
        pricingProvenance: {
          source: 'provider',
          currency: 'USD',
          capturedAt: details.createdAt
        }
      })
      return
    }
    if (estimated !== null) {
      this.host.state.usageRepo.recordEvent({
        ...details,
        costStatus: 'estimated',
        costUsd: estimated.costUsd,
        // The record keeps its own inputs: which entry priced it, the rates it
        // used, the snapshot version, and the window the run fell in.
        pricingProvenance: {
          source: 'model_catalog',
          sourceId: estimated.entryId,
          currency: 'USD',
          capturedAt: details.createdAt,
          rates: estimated.rates,
          ...(estimated.priceVersion === null ? {} : { priceVersion: estimated.priceVersion }),
          ...(estimated.window ? { priceWindow: estimated.window } : {})
        }
      })
      return
    }
    this.host.state.usageRepo.recordEvent({
      ...details,
      costStatus: 'unavailable',
      costUsd: null,
      pricingProvenance: null
    })
  }
}
