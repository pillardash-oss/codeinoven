import { resolve } from 'path'
import { Logger } from '../../system/logger'
import { DEFAULT_HARNESS } from '../../../lib/harness-default'
import type { SearchSummaryRequest } from '../../search/thread-search-summary'
import {
  budgetSearchSummaryPrompt,
  SearchSummaryUnavailableError,
  validateSearchSummary
} from '../../search/thread-search-summary'
import { broadcastThreadUpdate } from '../thread-events'
import type { HarnessDriver } from '../../drivers/driver.interface'
import { instanceRegistry } from '../../system/instance-registry'
import type { AgentEvent, Thread, ThreadSettings } from '../../../lib/types'
import { recapTokenBudget } from '../../../lib/prompt-budget'
import type { SessionInfo } from './chat-engine-types'
import { rawErrorMessage } from './chat-engine-errors'
import { formatHistoryRecap } from './chat-engine-message-text'
import { broadcastToast, isCoordinatorThread } from './chat-engine-pure'
import type { ChatEngine } from '../chat-engine'

/** ChatEngine transcripts: one concern, moved verbatim from the composition root. */
export class ChatEngineTranscripts {
  constructor(private readonly host: ChatEngine) {}

  /** Search summaries use the existing tool-free auxiliary provider lane. */
  async summarizeSearchThread(input: SearchSummaryRequest): Promise<string> {
    input.signal.throwIfAborted()
    const thread = await this.host.threadManager.getThreadViaWorker(input.projectId, input.threadId)
    if (!thread?.settings)
      throw new Error('The thread model settings are unavailable for search summarization.')
    const harnessId = thread.settings.harnessId ?? DEFAULT_HARNESS
    // This task reads only its supplied text. Oven projects need no local checkout.
    const projectPath = await this.host.units['turns'].ephemeralWorkingDirectory(input.threadId)
    const auxiliary = await this.host.units['turns'].resolveAuxiliaryRoute({
      projectId: input.projectId,
      threadId: input.threadId,
      threadHarnessId: harnessId,
      projectPath
    })
    // An assigned auxiliary agent can run on another harness than the thread's,
    // and then it is that harness whose accounts serve the summary.
    const routeHarnessId = auxiliary?.harnessId ?? harnessId
    const accountIds = await this.host.units['providers-accounts'].summaryAccountIds(
      routeHarnessId,
      auxiliary?.settings.providerId ?? thread.settings.providerId,
      auxiliary?.settings.modelId ?? thread.settings.modelId,
      auxiliary?.settings.accountId ?? thread.settings.accountId
    )
    const candidates = auxiliary?.candidates
    let failure: string | null = null
    for (const [index, accountId] of accountIds.entries()) {
      input.signal.throwIfAborted()
      let driver: HarnessDriver
      try {
        driver = await this.host.driverForAccount(routeHarnessId, accountId)
      } catch (error) {
        failure = rawErrorMessage(error)
        continue
      }
      const settings: ThreadSettings = {
        ...(auxiliary?.settings ?? thread.settings),
        accountId,
        thinkingLevel: 'minimal',
        permissionLevel: 'auto_review',
        assignmentMode: false,
        loopMode: false
      }
      // The first account keeps the harness's own cheap-candidate discovery, so
      // a healthy setup still summarizes with the cheapest model it has. A
      // fallback account is a probe of one credential, so it asks this model
      // directly instead of paying every candidate again on every account.
      const attemptCandidates =
        candidates ??
        (index === 0
          ? undefined
          : settings.providerId && settings.modelId
            ? [{ providerId: settings.providerId, modelId: settings.modelId }]
            : [])
      try {
        const result = await driver.provideCheapModel(projectPath, {
          settings,
          purpose: 'Thread search summary',
          prompt: input.prompt,
          timeoutMs: 45_000,
          preparePrompt: (candidate) => {
            const reported = this.modelContextWindow(
              input.projectId,
              candidate.providerId,
              candidate.modelId
            )
            const selectedWindow =
              candidate.modelId === settings.modelId && candidate.providerId === settings.providerId
                ? settings.contextWindow
                : undefined
            const window =
              reported && selectedWindow
                ? Math.min(reported, selectedWindow)
                : (reported ?? selectedWindow)
            // An unknown window gets a conservative small request, never the
            // application's large default conversation budget.
            const inputBudget = window && window > 0 ? Math.max(0, window - 4096) : 1024
            return budgetSearchSummaryPrompt(input.prompt, inputBudget)
          },
          validateResponse: validateSearchSummary,
          ...(attemptCandidates ? { candidates: attemptCandidates } : {})
        })
        input.signal.throwIfAborted()
        const text = result.text?.trim()
        if (text) return text
        failure = result.attempts.at(-1)?.failure ?? null
      } catch (error) {
        if (input.signal.aborted) throw error
        failure = rawErrorMessage(error)
      }
      Logger.dev('Search summary account could not answer; trying the next one', {
        harnessId: routeHarnessId,
        accountId,
        failure
      })
    }
    throw new SearchSummaryUnavailableError(
      `No account could summarize this thread for search.${failure ? ` ${failure}` : ''}`
    )
  }

  /**
   * Ask the driver whether the harness itself holds a session's conversation.
   *
   * Returns undefined for a driver that cannot answer, so callers keep their
   * own evidence-based fallback. A driver error is unknown, never "no
   * history": treating a failed probe as an absent conversation would replay
   * the mirror on top of a session that already holds it.
   */
  async probeNativeHistory(
    driver: HarnessDriver,
    projectPath: string,
    sessionId: string
  ): Promise<boolean | undefined> {
    if (!driver.holdsNativeHistory) return undefined
    try {
      return await driver.holdsNativeHistory(projectPath, sessionId)
    } catch (error) {
      Logger.dev('Native history probe failed:', error)
      return undefined
    }
  }

  /** Recap of the mirrored transcript when no reusable harness session exists. */
  async buildHistoryRecap(
    projectId: string,
    threadId: string,
    driverId: string,
    maxInputTokens?: number,
    currentMessageId?: string
  ): Promise<string> {
    const thread = await this.host.threadManager.getThread(projectId, threadId)
    const sameHarness = !thread?.settings?.harnessId || thread.settings.harnessId === driverId
    const fallbackBudget = this.host.units['runtime-agents'].selectedModelInputBudget(
      thread?.settings?.providerId,
      thread?.settings?.modelId,
      projectId
    )
    // The replay is capped by the checkpoint line as well as any caller's own
    // allowance, so a rebuilt session on a large-window model never
    // materializes a recap far past what the turn will actually send.
    const budget = Math.min(maxInputTokens ?? fallbackBudget, recapTokenBudget(fallbackBudget))

    // A native resumed session already owns its history. Check that fact before
    // reading the mirror so every ordinary follow-up remains O(1) with respect
    // to thread age.
    if (thread?.sessionId && sameHarness) {
      const nativeHistory = this.host.state.sessionNativeHistory.get(thread.sessionId)
      if (nativeHistory === true) return ''
      if (nativeHistory === undefined) {
        try {
          const { driver, projectPath } = await this.host.resolve(projectId, driverId, threadId)
          if (driver.capabilities?.nativeResume !== false) {
            const held = await this.probeNativeHistory(driver, projectPath, thread.sessionId)
            if (held === true) return ''
            if (held === false) this.host.state.sessionNativeHistory.set(thread.sessionId, false)
            // No probe on this driver: keep the message-count evidence, which
            // is all a driver without native transcripts can offer.
            if (held === undefined) {
              const messages = await driver.loadMessages(projectPath, thread.sessionId)
              if (messages.length > 0) return ''
            }
          }
        } catch {
          // Session unreachable   replay the durable mirror below.
        }
      }
    }

    const persistedMirror = await this.host.threadManager.loadMessageRecords(projectId, threadId)
    let queuedHandoffIds = new Set<string>()
    if (isCoordinatorThread(thread)) {
      try {
        const queue = await this.host.units['assignment'].readCoordinatorHandoffQueue(
          projectId,
          threadId
        )
        queuedHandoffIds = new Set(queue.items.map((item) => item.id))
      } catch (error) {
        Logger.error('Coordinator handoff queue could not be excluded from history recap', {
          projectId,
          threadId,
          error: rawErrorMessage(error)
        })
      }
    }
    // A queued child report has not reached the harness yet. Exclude it from a
    // fresh-session recap so it appears exactly once as the next prompt when
    // the Sr. Engineer becomes idle, never once in history and again as input.
    const mirrored = persistedMirror.filter((message) => !queuedHandoffIds.has(message.id))
    // The current turn's user message is always delivered as the prompt itself,
    // in every branch below. It must never also appear as a "restored from
    // history" entry: on a brand-new or forked thread the mirror holds nothing
    // else, and a recap that announces an earlier conversation but only echoes
    // the question back reads to the model as a fabricated/injected context
    // the exact pattern that makes resuming models refuse to continue.
    // Matched by id, not merely by trailing role: an earlier turn that errored
    // out before an assistant reply was persisted (e.g. a rate limit) also
    // leaves a trailing 'user' record, and it is real prior history, not a
    // duplicate of the prompt about to be sent   stripping it by role alone
    // silently drops the last thing the user said across a harness switch.
    const last = mirrored.at(-1)
    const mirror =
      last?.role === 'user' && (!currentMessageId || last.id === currentMessageId)
        ? mirrored.slice(0, -1)
        : mirrored
    if (mirror.length === 0) return ''
    // `mirror` is non-empty real prior history at this point. If the format
    // step still can't render it into text, that content would otherwise be
    // silently lost from the conversation   rescue it into a fresh thread
    // rather than let the turn proceed with no memory of it.
    const emitRecap = (): string => {
      const recap = formatHistoryRecap(mirror, { maxInputTokens: budget })
      if (!recap) {
        void this.rescueUnreplayableHistory(projectId, threadId, driverId).catch(() => {})
      }
      return recap
    }
    // A session adopted from a parked branch already owns the conversation up to
    // the message it stopped at. Only what happened while the thread was on the
    // other harness is missing, so replay that delta instead of the whole
    // transcript: the parked prefix stays a provider cache read and the fresh
    // tokens are just this turn's. The rendered delta is memoized for the life
    // of the session; a driver that does not retain a recap natively keeps
    // replaying it, one that does drops it after the turn is dispatched.
    const replaySessionId = thread?.sessionId
    const replay = replaySessionId
      ? this.host.state.parkedSessionReplay.get(replaySessionId)
      : undefined
    if (replay) {
      if (replay.recap !== undefined && (replay.recapBudget ?? 0) >= budget) return replay.recap
      const boundaryIndex =
        replay.boundary === null
          ? -1
          : mirror.findIndex((message) => message.id === replay.boundary)
      // The message the parked transcript stopped at is gone from the mirror, so
      // what the harness already holds cannot be known. Replaying the whole
      // thread once is a fallback; replaying it on every later turn would put
      // the entire conversation back into each request and grow the cost with
      // thread age, so this case is delivered once.
      if (replay.boundary !== null && boundaryIndex < 0) replay.repeat = false
      const delta = boundaryIndex >= 0 ? mirror.slice(boundaryIndex + 1) : mirror
      const recap = delta.length === 0 ? '' : formatHistoryRecap(delta, { maxInputTokens: budget })
      replay.recap = recap
      replay.recapBudget = budget
      return recap
    }
    if (thread?.sessionId && sameHarness) {
      // `ensureSession` already confirmed whether the harness natively holds
      // the conversation   skip the redundant provider history load entirely
      // (A-13), whether the first load returned messages or zero.
      const nativeHistory = this.host.state.sessionNativeHistory.get(thread.sessionId)
      if (nativeHistory === true) return ''
      if (nativeHistory === false) {
        return emitRecap()
      }
      try {
        const { driver } = await this.host.resolve(projectId, driverId, threadId)
        if (driver.capabilities?.nativeResume === false) {
          return emitRecap()
        }
      } catch {
        // The durable mirror remains the safe fallback when the driver is unavailable.
      }
    }
    return emitRecap()
  }

  /**
   * Safety net for history that could not be carried forward as a recap
   * (e.g. a harness switch where the durable mirror still failed to render).
   * Forks the thread's full transcript into a new thread so the conversation
   * is never silently lost, and notifies the user where to find it.
   */
  async rescueUnreplayableHistory(
    projectId: string,
    threadId: string,
    driverId: string
  ): Promise<void> {
    try {
      const thread = await this.host.threadManager.getThread(projectId, threadId)
      if (!thread) return
      const rescueTitle = `${thread.title || 'Untitled'} (recovered)`
      const forked = await this.host.threadManager.forkThread(projectId, threadId, rescueTitle)
      broadcastThreadUpdate(forked)
      broadcastToast(
        `Prior context on "${thread.title || 'this thread'}" couldn't carry over to ${driverId}. Saved the full conversation to a new thread: "${rescueTitle}".`,
        'info'
      )
    } catch (error) {
      Logger.error('History rescue fork failed', {
        projectId,
        threadId,
        error: rawErrorMessage(error)
      })
    }
  }

  /** Last-known native context usage (tokens) for the thread's session.
   *  Prefers the renderer-committed thread snapshot for the same harness and
   *  provider, then falls back to the latest mirrored assistant message. */
  async lastSessionContextUsed(
    projectId: string,
    threadId: string,
    harnessId: string,
    providerId: string
  ): Promise<number | undefined> {
    try {
      const thread = await this.host.threadManager.getThread(projectId, threadId)
      const stored = thread?.contextUsage
      if (stored?.harnessId === harnessId && stored.providerId === providerId) {
        if (typeof stored.contextUsed === 'number' && stored.contextUsed > 0) {
          return stored.contextUsed
        }
      }
    } catch {
      // Fall through to the mirrored transcript.
    }
    try {
      const records = await this.host.threadManager.loadMessageRecords(projectId, threadId)
      for (const message of [...records].reverse()) {
        if (message.role !== 'assistant') continue
        if (message.providerId && message.providerId !== providerId) continue
        if (typeof message.contextUsed === 'number' && message.contextUsed > 0) {
          return message.contextUsed
        }
      }
    } catch {
      // No usable usage signal   compaction cannot be judged.
    }
    return undefined
  }

  /** Context window of a provider/model from the cached provider catalog. */
  modelContextWindow(
    projectId: string,
    providerId: string | undefined,
    modelId: string | undefined
  ): number | undefined {
    if (!providerId || !modelId) return undefined
    return this.host.state.providerCache
      .get(projectId)
      ?.flatMap((catalog) => catalog.models)
      .find((model) => model.providerId === providerId && model.id === modelId)?.contextWindow
  }

  async finishCheckpoint(
    sessionId: string,
    info: SessionInfo | undefined,
    status: 'completed' | 'failed' | 'interrupted',
    failure?: string
  ): Promise<void> {
    if (!info?.activeTurnId) return
    const turnId = info.activeTurnId
    // Re-read the durable harness transcript on every completion path, including
    // failures and interrupts. Live tool events can arrive late or be dropped.
    const messages = await this.host.units['speech'].turnTranscriptMessages(info)
    if (info.activeTurnId !== turnId) return
    this.host.reassertTurnToolEvidence(info, messages)
    // A shell tool still in flight (interrupted turn) never emitted a terminal
    // state, so close its window here before the after-snapshot is taken.
    if (info.unboundedWindowStart) this.host.units['utilities-tools'].closeUnboundedToolWindow(info)
    if (info.pendingWindowScans?.size) await Promise.all([...info.pendingWindowScans])
    const ownThreadIds = await this.host.units['thread-lifecycle'].selfFamilyThreadIds(
      info.projectId,
      info.threadId
    )
    // Edits the user made from an in-app terminal during this turn are the
    // user's work, not the thread's: exclude them from the final checkpoint
    // just like in-app editor saves.
    const userTerminalPaths = await this.host.units['processes'].userTerminalChangedPaths(info)
    if (info.activeTurnId !== turnId) return
    // Stale sessions are the reason a filtered card has no visible cause: their
    // claims must be dropped before they can take paths from this turn.
    const activeTurnThreadIds = await this.host.checkpointManager
      .activeTurnThreadIds(info.projectId)
      .catch(() => undefined)
    const foreignLive = this.host.units['runtime-connectivity'].liveForeignClaimedPaths(
      info,
      ownThreadIds,
      activeTurnThreadIds
    )
    // Another thread with a turn in flight here or in a sibling instance makes
    // the project-wide diff ambiguous: its writes look exactly like this turn's.
    // Only this turn's own evidence may claim a path in that state.
    const contestedDiff = [...(activeTurnThreadIds ?? [])].some(
      (threadId) => threadId !== info.threadId && !ownThreadIds.has(threadId)
    )
    try {
      const checkpoint = await this.host.checkpointManager.completeTurn(
        info.projectId,
        info.threadId,
        info.activeTurnId,
        info.projectPath,
        status,
        failure,
        // The final content snapshot is authoritative, including writes hidden
        // in scripts, nested tools, commits, and missed stream events. Reconcile
        // user and foreign-thread edits below instead of requiring parsed paths.
        undefined,
        {
          changeSources: info.changeSources,
          precisePaths: new Set(info.preciseChangedPaths?.keys() ?? []),
          foreignPrecisePaths: foreignLive.claimed,
          foreignWindowPaths: foreignLive.window,
          foreignClaimants: foreignLive.claimants,
          contestedDiff,
          // Worker sub-agent threads dispatched by this thread are part of the
          // same logical turn: their captured checkpoints must never mark the
          // turn's real changes as foreign concurrent edits.
          ownThreadIds,
          excludedPaths: this.host.units['processes'].withUserTerminalPaths(
            info.userTouchedPaths,
            userTerminalPaths
          )
        }
      )
      info.activeTurnId = undefined
      info.activeTurnUserMessageId = undefined
      info.changedPaths = undefined
      info.preciseChangedPaths = undefined
      info.changeSources = undefined
      info.rejectedChangeSources = undefined
      info.userTouchedPaths = undefined
      info.openUnboundedTools = undefined
      info.unboundedWindowToolIds = undefined
      info.unboundedToolObserved = undefined
      info.unboundedWindowStart = undefined
      info.pendingWindowScans = undefined
      const checkpointEvent = {
        type: 'checkpoint.updated',
        sessionId,
        projectId: info.projectId,
        threadId: info.threadId,
        checkpointId: checkpoint.id
      } satisfies Extract<AgentEvent, { type: 'checkpoint.updated' }>
      // Preserve normal stream ordering in this process, then invalidate every
      // other process that shares the durable checkpoint database.
      this.host.broadcast(checkpointEvent)
      instanceRegistry.publishCheckpointUpdated(checkpointEvent)
      // The turn's `active_turns` row was released above, which is the moment a
      // sibling's view of "who is running this thread" actually changes. The
      // idle announcement fires earlier, before this checkpoint settles, so
      // without a publish here a sibling keeps the finished turn marked as work
      // in progress until its next heartbeat decides otherwise.
      instanceRegistry.publishTurnActivity()
    } catch (error) {
      Logger.error('turn checkpoint completion failed:', error)
    }
  }
}
