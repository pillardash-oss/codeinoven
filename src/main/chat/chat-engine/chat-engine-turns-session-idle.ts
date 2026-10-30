import { stripAbortedRunErrors } from '../stopped-run-errors'
import { Logger } from '../../system/logger'
import { latestAgentTodo } from '../../../lib/agent-todos'
import type {
  AssignmentPlan,
  BrainstormDocument,
  PrdDocument,
  EngineeringSpec,
  ThreadSettings
} from '../../../lib/types'
import { ASSISTANT_SPACE_ID, INBOX_PROJECT_ID, isAssistantThread } from '../../../lib/types'
import { GLOBAL_BROWSER_PROJECT_ID } from '../../../lib/ipc/browser'
import { mermaidRepairPrompt, validateMermaidOutput } from '../mermaid-output-validator'
import type { MermaidValidationFailure } from '../mermaid-output-validator'
import {
  concludesCapabilityUnavailable,
  searchNudgePromptForProse
} from '../not-available-detector'
import {
  CAPACITY_CONTINUE_MESSAGE,
  CAPACITY_CONTINUE_PROMPT,
  stripCapacityContinueErrors
} from '../../../lib/capacity-continue'
import {
  visualDeliverableRepairPrompt,
  visualDeliverableRequest
} from '../visual-deliverable-guard'
import { historyMirrorIssue, rawErrorDetail, rawErrorMessage } from './chat-engine-errors'
import {
  classifyProviderMessages,
  isDedicatedAssignmentAuditorThread,
  mergeAgentMessages,
  restoreMirrorAccount,
  restoreMirrorThinkingLevel,
  stampAccount,
  stampHarnessId
} from './chat-engine-message-merge'
import {
  assistantAdmitsIncompleteSpec,
  assistantMemoryDecisionContext,
  assistantText,
  hasTerminalSpecContractMarker,
  mermaidValidationFailureMessage,
  mermaidValidationNotice,
  rejectedAnswerMessage,
  rejectedMermaidMessage,
  terminalAssistantMessage,
  textForMessage
} from './chat-engine-message-text'
import {
  demoteTaskReconcileAnswer,
  taskReconcileAnswer,
  taskReconcileExchange
} from './chat-engine-task-reconcile'
import {
  INCOMPLETE_TURN_CONTINUATION_PROMPT,
  INCOMPLETE_TURN_MESSAGE,
  SPEC_CONTRACT_BLOCKED_MARKER,
  SPEC_CONTRACT_COMPLETE_MARKER,
  SPEC_CONTRACT_CONTINUATION_PROMPT,
  taskReconcilePrompt,
  SUPERSEDED_TURN_MESSAGE
} from './chat-engine-constants'
import { broadcastToast } from './chat-engine-pure'
import { ChatEngine } from '../chat-engine'

/** ChatEngine turns-session-idle: one concern, moved verbatim from the composition root. */
export class ChatEngineTurnsSessionIdle {
  constructor(private readonly host: ChatEngine) {}

  /** When a turn finishes, persist the canonical transcript and update thread state. */
  async onSessionIdle(sessionId: string): Promise<void> {
    const info = this.host.sessionRegistry.get(sessionId)
    if (!info) return
    if (info.ephemeral) return
    const completedGatewayId = this.host.state.utilityTurns.get(sessionId)?.gateway.id
    const pendingMemory = this.host.state.pendingMemoryDecisions.get(sessionId)
    this.host.state.pendingMemoryDecisions.delete(sessionId)
    let assistantResponse = ''
    let memoryParentTurnId: string | null = null
    let turnUtilitiesCleaned = false
    let assignmentContinuation: {
      assignment: AssignmentPlan
      settings: ThreadSettings
    } | null = null
    try {
      const driver = this.host.units['turns-dispatch'].driverForRuntime(
        info.driverId,
        info.accountId
      )
      if (!driver) return
      const thread = await this.host.threadManager.getThread(info.projectId, info.threadId)
      const account = await this.host.state.accountRegistry.resolve(info.driverId, info.accountId)
      const loadedMessages = stampAccount(
        stampHarnessId(
          info.activeTurnUserMessageId && driver.loadMessagesSince
            ? await driver.loadMessagesSince(
                info.projectPath,
                sessionId,
                info.activeTurnUserMessageId
              )
            : await driver.loadMessages(info.projectPath, sessionId),
          info.driverId
        ),
        account.id,
        account.label
      )
      const activeTurnStartIndex = info.activeTurnUserMessageId
        ? loadedMessages.findLastIndex((message) => message.id === info.activeTurnUserMessageId)
        : -1
      const messages =
        activeTurnStartIndex > 0 ? loadedMessages.slice(activeTurnStartIndex) : loadedMessages

      // Stamp the turn's thinking level from what the turn was dispatched
      // with   the per-session snapshot, not the thread's current settings.
      // The user may have changed the composer mid-turn while waiting; those
      // changes belong to the next turn and must never re-label this one.
      const latestUserIndex = messages.findLastIndex((message) => message.role === 'user')
      const turnOvenId = info.activeTurnOvenId ?? thread?.settings?.ovenId ?? 'local'
      const turnOvenLabel = await this.host.state.ovenChat
        .nameFor(turnOvenId)
        .catch(() => (turnOvenId === 'local' ? 'Local' : 'Oven'))
      const turnOvenAppearance = await this.host.state.ovenChat
        .appearanceFor(turnOvenId)
        .catch(() => undefined)
      if (latestUserIndex >= 0 && !messages[latestUserIndex].ovenId) {
        messages[latestUserIndex].ovenId = turnOvenId
        messages[latestUserIndex].ovenLabel = turnOvenLabel
        if (turnOvenAppearance) messages[latestUserIndex].ovenAppearance = turnOvenAppearance
      }
      const turnAssistant = [...messages.slice(latestUserIndex + 1)]
        .reverse()
        .find((message) => message.role === 'assistant')
      // The turn's answer is the last assistant message that actually carries one.
      // A turn whose final assistant message is only a task-list publication (the
      // reconcile continuation that corrects a lagging list and, as instructed,
      // adds no prose) must still be read as the answer the agent gave before it.
      let terminalAssistant = terminalAssistantMessage(messages, turnAssistant)
      const turnSelection = this.host.state.sessionModelIds.get(sessionId)
      const turnThinkingLevel = turnSelection?.thinkingLevel ?? thread?.settings?.thinkingLevel
      if (turnAssistant && !turnAssistant.thinkingLevel && turnThinkingLevel) {
        turnAssistant.thinkingLevel = turnThinkingLevel
      }
      if (turnAssistant && !turnAssistant.ovenId) {
        turnAssistant.ovenId = turnOvenId
        turnAssistant.ovenLabel = turnOvenLabel
        if (turnOvenAppearance) turnAssistant.ovenAppearance = turnOvenAppearance
      }
      // Providers that never report token usage leave assistant messages
      // without a contextUsed signal, blinding usage-based compaction and the
      // context indicator. Fall back to the composed-request occupancy captured
      // at dispatch, clearly flagged as an estimate   and only for sessions
      // whose provider reports nothing: where usage IS reported (the mirrored
      // per-turn totals), the composed text-layer estimate would clobber the
      // real occupancy with a small fraction of it. Failed turns are skipped
      // for the same reason: a rejected request proves nothing about size.
      if (
        turnAssistant &&
        turnAssistant.contextUsed === undefined &&
        turnAssistant.error === undefined &&
        info.hasReportedTokenUsage !== true
      ) {
        const composed = info.estimatedContextUsed
        if (composed !== undefined) {
          turnAssistant.contextUsed = composed
          turnAssistant.contextEstimated = true
        }
      }

      this.host.units['misc'].applyReasoningStamps(sessionId, messages)
      this.host.units['utilities-tools'].applyToolStamps(sessionId, messages)
      this.host.units['misc'].applyGenerationStamps(sessionId, messages)

      const mirrorAnchorId = info.activeTurnUserMessageId ?? messages[latestUserIndex]?.id
      const mirror = mirrorAnchorId
        ? (
            await this.host.threadManager.loadMessagePageAround(
              info.projectId,
              info.threadId,
              mirrorAnchorId,
              40
            )
          ).messages
        : []
      const suppressTerminalAnswer =
        this.host.state.planningSessions.has(sessionId) ||
        isDedicatedAssignmentAuditorThread(thread)
      const classifiedAll = classifyProviderMessages(messages, suppressTerminalAnswer)
      // A task-list reconcile exchange is bookkeeping, not a new answer. When it
      // added nothing but the corrected list, its prose must not become the
      // turn's closing statement: the answer the agent already gave stays the
      // answer (and therefore the one message the reader can select and
      // annotate), while the corrected list still renders in the working trace
      // beside the work it describes. Its tool calls, reasoning and usage are
      // untouched; only the words that would have replaced the answer are moved
      // out of the answer slot.
      const reconcileAnswerId = this.host.units['turns-sessions'].taskReconcileAnswerId(
        driver,
        info,
        sessionId
      )
      const reconcileExchange = taskReconcileExchange(classifiedAll, reconcileAnswerId)
      const reconcileKeepsAnswer = reconcileExchange !== null && !reconcileExchange.addedWork
      if (reconcileKeepsAnswer) {
        const keptAnswer = taskReconcileAnswer(classifiedAll, reconcileExchange.boundaryId, mirror)
        if (keptAnswer) terminalAssistant = keptAnswer
      }
      let classifiedMessages = classifiedAll.filter(
        (message) => !(message.role === 'user' && message.visibility === 'hidden')
      )
      if (reconcileKeepsAnswer) {
        classifiedMessages = demoteTaskReconcileAnswer(
          classifiedMessages,
          reconcileExchange.boundaryId
        )
      }
      let merged = restoreMirrorAccount(
        restoreMirrorThinkingLevel(mergeAgentMessages(mirror, classifiedMessages), mirror),
        mirror
      )
      // A stop is not a failure. When this process stopped the run itself (a
      // user Stop, a transfer handing the thread to a sibling instance, or the
      // sweep that stops a thread's nested workers with it) the harness still
      // closes the interrupted attempt with its own abort text, and that text
      // proves nothing: persisted, it paints an error card over work that was
      // stopped on purpose and makes a worker stopped by a hand-off read as a
      // failed worker. The thread's own status already says `interrupted`.
      const userAborted = this.host.state.userAbortedSessions.has(sessionId)
      if (userAborted) stripAbortedRunErrors(merged)
      // A provider that answered "model at capacity" has not given this turn a
      // verdict: the engine claimed that failure for a silent continuation when
      // it arrived (see `ChatEngineCapacityContinue`), and this finalization is
      // where that continuation is issued. Read the claim before the verdict is
      // decided so the transcript and the status never carry an error the app
      // already recovered from.
      const capacityOwed = userAborted
        ? undefined
        : this.host.units['capacity-continue'].owed(sessionId)
      const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant')
      // A thread that has already moved to another session discarded this one:
      // an edited or deleted turn is re-sent on a replacement session, that
      // session is cleared, and the old transcript must not come back. Writing
      // this session's messages into the mirror would splice the removed turn
      // straight back into the history the user just cleared, so the write is
      // skipped while everything else in this finalization still runs. A thread
      // whose binding was cleared (an account removal, for example) has no owner
      // to compare against and keeps its write.
      const mirrorOwner = await this.host.threadManager.getThread(info.projectId, info.threadId)
      const mirrorOrphaned =
        mirrorOwner !== null &&
        mirrorOwner.sessionId !== null &&
        mirrorOwner.sessionId !== sessionId
      // The provider transcript is the irreplaceable user data. Persist it
      // before Mermaid validation, usage accounting, specification parsing, or
      // any other optional end-of-turn work can throw. Later upserts may refine
      // visibility or attach validation notices, but can never be the first
      // durable write of a completed response.
      if (!mirrorOrphaned) {
        await this.host.threadManager.upsertMessages(
          info.projectId,
          info.threadId,
          merged,
          sessionId
        )
      }
      // The thread this turn belongs to, read fresh. Everything the engine
      // issues on its own initiative below must act on the thread's live turn:
      // a provider failure handled while this transcript was being finalized
      // can already have moved the thread to a fallback model and session,
      // leaving this finalization holding the failed session and its settings.
      const liveThread = await this.host.units['thread-lifecycle'].idleTurnThread(info, sessionId)
      const superseded = liveThread === null
      let failure = lastAssistant?.error
      // A deliberate stop is not a failure: keep the thread on `interrupted` and
      // never surface the abort of the run this process ended as a session
      // failure. `userAborted` was resolved above, before the transcript was
      // persisted, because it also decides whether that abort text may enter it.
      if (userAborted) failure = undefined
      // A session that already errored during this turn (watchdog abort, session
      // error, failed dispatch) must never be flipped back to `completed` by the
      // idle finalization. The transcript is truncated by the abort, so the last
      // assistant message usually carries no error   recover the recorded issue
      // instead, keeping the thread `failed` and preventing a bogus "done"
      // notification right after the real error notification.
      const erroredSession = this.host.sessionStatuses.get(sessionId)
      if (!userAborted && erroredSession?.state === 'error' && !failure) {
        failure = erroredSession.issue?.message ?? 'Agent session failed'
      }
      // A capacity refusal is recovered by the continuation issued below, not
      // by failing the turn, but only while there is a live thread with settings
      // to continue on. Without one the failure stays and reaches the user as a
      // real error instead of vanishing with the continuation.
      const capacityContinuation =
        capacityOwed !== undefined && liveThread !== null && liveThread.settings !== undefined
      if (capacityContinuation) failure = undefined
      else if (capacityOwed !== undefined) this.host.units['capacity-continue'].clearOwed(sessionId)
      const awaitingUser = this.host.units['turns-sessions'].sessionAwaitsUserInput(sessionId)
      const engineeringContractActive =
        this.host.state.engineeringImplementationSessions.has(sessionId)
      const contractResponse = terminalAssistant ? assistantText(terminalAssistant).trim() : ''
      const contractBlocked =
        engineeringContractActive &&
        hasTerminalSpecContractMarker(contractResponse, SPEC_CONTRACT_BLOCKED_MARKER)
      const contractCompleted =
        engineeringContractActive &&
        hasTerminalSpecContractMarker(contractResponse, SPEC_CONTRACT_COMPLETE_MARKER) &&
        !assistantAdmitsIncompleteSpec(contractResponse)
      if (contractCompleted) this.host.state.engineeringImplementationSessions.delete(sessionId)
      const missingFinalResponse =
        !capacityContinuation &&
        !failure &&
        !awaitingUser &&
        !suppressTerminalAnswer &&
        (!terminalAssistant ||
          (!assistantText(terminalAssistant).trim() &&
            terminalAssistant.structuredOutput === undefined))
      const contractContinuationRequired =
        engineeringContractActive &&
        !failure &&
        !awaitingUser &&
        !missingFinalResponse &&
        !contractBlocked &&
        !contractCompleted
      if (!missingFinalResponse) {
        this.host.state.incompleteTurnRecoveryAttempts.delete(sessionId)
      } else if (
        liveThread !== null &&
        ((this.host.state.incompleteTurnRecoveryAttempts.get(sessionId) ?? 0) >= 1 ||
          !liveThread.settings)
      ) {
        failure = INCOMPLETE_TURN_MESSAGE
      }
      let mermaidFailures: MermaidValidationFailure[] = []
      if (
        !capacityContinuation &&
        !failure &&
        !awaitingUser &&
        !suppressTerminalAnswer &&
        terminalAssistant
      ) {
        const validation = await validateMermaidOutput(assistantText(terminalAssistant))
        mermaidFailures = validation.failures
        if (mermaidFailures.length === 0) {
          this.host.state.mermaidRepairAttempts.delete(sessionId)
        } else {
          const rejectionReason = mermaidValidationFailureMessage(mermaidFailures)
          const rejected = rejectedMermaidMessage(terminalAssistant, rejectionReason)
          classifiedMessages = classifiedMessages.map((message) =>
            message.id === rejected.id ? rejected : message
          )
          merged = restoreMirrorAccount(
            restoreMirrorThinkingLevel(mergeAgentMessages(mirror, classifiedMessages), mirror),
            mirror
          )
          if (
            (this.host.state.mermaidRepairAttempts.get(sessionId) ?? 0) >= 1 ||
            !liveThread?.settings
          ) {
            failure = rejectionReason
            merged = mergeAgentMessages(merged, [
              mermaidValidationNotice(terminalAssistant, rejectionReason)
            ])
          }
        }
      }
      if (capacityContinuation) stripCapacityContinueErrors(merged)
      if (!mirrorOrphaned) {
        await this.host.threadManager.upsertMessages(
          info.projectId,
          info.threadId,
          merged,
          sessionId
        )
      }
      // The raw transcript may contain hidden user messages that are intentionally
      // filtered out of the persisted mirror. Usage events and turn outcomes
      // reference the durable parent turn, so anchor them to the persisted set.
      const parentTurnId =
        merged.findLast((message) => message.role === 'user' && message.origin === 'user')?.id ??
        null
      memoryParentTurnId = parentTurnId
      if (turnAssistant) {
        // The turn's model responses, in order. A harness answers one user turn
        // with many requests (the tool loop), and each carries its own usage,
        // so the ledger row has to fold them all instead of the terminal one.
        const turnResponses =
          latestUserIndex >= 0
            ? messages.slice(latestUserIndex + 1).filter((message) => message.role === 'assistant')
            : []
        this.host.units['messages-write'].recordMessageUsageEvent(
          info.threadId,
          thread,
          parentTurnId ?? turnAssistant.id,
          turnAssistant,
          turnResponses.length > 0 ? turnResponses : [turnAssistant],
          capacityOwed ?? failure
        )
      }
      if (parentTurnId && turnAssistant) {
        this.host.units['utilities-tools'].recordToolUsageEvents(
          info.threadId,
          parentTurnId,
          turnAssistant
        )
      }
      if (
        parentTurnId &&
        turnAssistant &&
        !failure &&
        !turnAssistant.error &&
        !contractContinuationRequired &&
        !contractBlocked
      ) {
        await this.host.openRankingSnapshot(info, thread, merged, turnAssistant, awaitingUser)
      }
      // Snapshot this turn's harness usage into the dedicated analytics table.
      // Runs on every turn end (success or failure) and is ledger-guarded, so
      // cost/tokens are added to the thread's existing per-harness totals once.
      await this.host.threadManager.accumulateHarnessUsage(info.projectId, info.threadId, messages)
      // A sub-agent worker runs as a nested session billed separately from the
      // parent turn, and its tokens live only in the child transcript mirrored
      // into this thread. Fold them into the same turn so nothing a worker
      // spent stays unattributed.
      await this.host.units['assignment-workers'].recordSubagentTurnUsage(
        info.projectId,
        info.threadId,
        parentTurnId ?? turnAssistant?.id ?? info.threadId,
        await this.host.threadManager.listSubagentUsageMessages(info.projectId, info.threadId)
      )
      // The harness demonstrably ran   confirm its behavior manifest in use so
      // the reliable declared baseline becomes a validated runtime confirmation
      // (unless the user explicitly overrode it). Fire-and-forget: never let
      // manifest bookkeeping block turn finalization.
      if (this.host.harnessManifest) {
        void this.host.harnessManifest
          .recordInUse(info.driverId)
          .catch((error) => Logger.dev('Harness manifest in-use confirmation failed:', error))
      }
      // The provider refused this turn for capacity and the engine already
      // claimed it. Issue the continuation here, after the attempt has been
      // recorded and its turn utilities released, so the failed run is fully
      // torn down before the same session is asked anything: a prompt sent
      // while the transport still owns the turn is rejected or interleaved.
      // `Continue.` is exactly what the user types by hand for this failure,
      // and it keeps the harness on its own work instead of starting a new
      // task. Every harness reaches this point, because the claim travels on
      // the session, not on a driver-specific code path.
      if (capacityContinuation && capacityOwed !== undefined && liveThread?.settings) {
        this.host.units['capacity-continue'].clearOwed(sessionId)
        await this.host.units['transcripts'].finishCheckpoint(
          sessionId,
          info,
          'failed',
          CAPACITY_CONTINUE_MESSAGE
        )
        await this.host.units['utilities'].cleanupTurnUtilities(sessionId, completedGatewayId ?? '')
        turnUtilitiesCleaned = true
        if (pendingMemory) this.host.state.pendingMemoryDecisions.set(sessionId, pendingMemory)
        try {
          await this.host.sendPrompt(
            info.projectId,
            info.threadId,
            liveThread.settings,
            CAPACITY_CONTINUE_PROMPT,
            [],
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            'internal'
          )
          return
        } catch (error) {
          // The continuation itself could not be admitted (the session died,
          // the provider refused the new turn). Surface the capacity failure as
          // the turn's verdict instead of stranding the thread on a card that
          // says it is working with nothing running.
          Logger.error('Capacity continuation could not be admitted', {
            projectId: info.projectId,
            threadId: info.threadId,
            sessionId,
            error: rawErrorMessage(error)
          })
          this.host.units['capacity-continue'].clear(sessionId)
          failure = capacityOwed
        }
      }
      if (mermaidFailures.length > 0 && !failure && liveThread?.settings) {
        this.host.state.mermaidRepairAttempts.set(sessionId, 1)
        await this.host.units['transcripts'].finishCheckpoint(
          sessionId,
          info,
          'failed',
          mermaidValidationFailureMessage(mermaidFailures)
        )
        await this.host.units['utilities'].cleanupTurnUtilities(sessionId, completedGatewayId ?? '')
        turnUtilitiesCleaned = true
        if (pendingMemory) this.host.state.pendingMemoryDecisions.set(sessionId, pendingMemory)
        try {
          await this.host.sendPrompt(
            info.projectId,
            info.threadId,
            liveThread.settings,
            mermaidRepairPrompt(mermaidFailures),
            [],
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            'internal'
          )
        } catch (error) {
          this.host.state.pendingMemoryDecisions.delete(sessionId)
          const issue = this.host.units['providers-accounts'].fallbackProviderIssue(
            info.driverId,
            rawErrorMessage(error),
            rawErrorDetail(error)
          )
          await this.host.threadManager.setStatus(info.projectId, info.threadId, 'failed', {
            error: issue.message,
            errorDetail: issue.rawError
          })
          await this.host.units['thread-lifecycle'].broadcastThreadSessionError(
            info.projectId,
            info.threadId,
            sessionId,
            issue
          )
        }
        return
      }
      // The agent's final prose concluded that a capability/tool/MCP is
      // unavailable, yet it never attempted the tool call (so the tool-error
      // nudge path never fired) and never used the app utility-search tool
      // (UTILITY_SEARCH_TOOL_NAME) despite the
      // gateway exposing it this turn. Nudge it   via the same tight
      // detector family that previously proved false-positive-prone, now
      // restricted to high-confidence availability conclusions (session-
      // scoped tool-shaped claims and personal possession denials). One nudge
      // per turn, shared with the tool-error path, so it cannot loop.
      if (
        !failure &&
        !awaitingUser &&
        !suppressTerminalAnswer &&
        turnAssistant &&
        liveThread?.settings &&
        (this.host.state.searchNudgeAttempts.get(sessionId) ?? 0) < 1
      ) {
        const utilityTurn = this.host.state.utilityTurns.get(sessionId)
        const searchExposed = Boolean(
          utilityTurn &&
          (utilityTurn.gateway.instructions.trim() || utilityTurn.gateway.directInstructions.trim())
        )
        const alreadySearched = utilityTurn
          ? this.host.state.utilityOrchestration.hasSearched(utilityTurn.gateway.id) ||
            this.host.state.utilityOrchestration.hasActivatedOnDemand(utilityTurn.gateway.id)
          : true
        const claimedUnavailable = concludesCapabilityUnavailable(assistantText(turnAssistant))
        if (searchExposed && !alreadySearched && claimedUnavailable) {
          this.host.state.searchNudgeAttempts.set(sessionId, 1)
          await this.host.units['transcripts'].finishCheckpoint(sessionId, info, 'completed')
          await this.host.units['utilities'].cleanupTurnUtilities(
            sessionId,
            completedGatewayId ?? ''
          )
          turnUtilitiesCleaned = true
          if (pendingMemory) this.host.state.pendingMemoryDecisions.set(sessionId, pendingMemory)
          try {
            await this.host.sendPrompt(
              info.projectId,
              info.threadId,
              liveThread.settings,
              searchNudgePromptForProse(claimedUnavailable),
              [],
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              'internal'
            )
          } catch (error) {
            this.host.state.pendingMemoryDecisions.delete(sessionId)
            const issue = this.host.units['providers-accounts'].fallbackProviderIssue(
              info.driverId,
              rawErrorMessage(error),
              rawErrorDetail(error)
            )
            await this.host.threadManager.setStatus(info.projectId, info.threadId, 'failed', {
              error: issue.message,
              errorDetail: issue.rawError
            })
            await this.host.units['thread-lifecycle'].broadcastThreadSessionError(
              info.projectId,
              info.threadId,
              sessionId,
              issue
            )
          }
          return
        }
      }
      // A turn that only described the asset it was asked to produce.
      //
      // An assistant thread once answered a logo request with "I've made the
      // first logo direction as a clean SVG wordmark ... The full name sits
      // beneath it" and delivered nothing: no file, no render call, no artifact.
      // Prose describing an asset is indistinguishable from prose reporting a
      // real one, so this guard never reads the answer for intent. It reads the
      // two things that can be checked: a conversation scope whose turn asked
      // for a visual deliverable, and the app's own record that nothing was
      // rendered. The rejected answer keeps its tool calls but loses its prose,
      // so a fabricated claim is never read as the turn's answer, and one
      // correction round supplies the authoring and render path. It never fires
      // twice for the same prompt: a second answer is accepted as it stands,
      // because a genuine blocker (missing input, a bitmap the agent cannot
      // draw) must still be able to reach the user.
      const conversationalScope =
        info.projectId === INBOX_PROJECT_ID ||
        info.projectId === ASSISTANT_SPACE_ID ||
        info.projectId === GLOBAL_BROWSER_PROJECT_ID
      if (
        conversationalScope &&
        !failure &&
        !userAborted &&
        !awaitingUser &&
        !suppressTerminalAnswer &&
        terminalAssistant &&
        liveThread?.settings &&
        !this.host.state.artifactRenderedSessions.has(sessionId) &&
        !merged.some((message) => message.inlineArtifact === true) &&
        (this.host.state.visualDeliverableNudges.get(sessionId) ?? 0) < 1 &&
        latestUserIndex >= 0
      ) {
        const requestedAsset = visualDeliverableRequest(textForMessage(messages[latestUserIndex]))
        if (requestedAsset) {
          const reason = `The reply described a ${requestedAsset.noun} without rendering one: no artifact was delivered.`
          this.host.state.visualDeliverableNudges.set(sessionId, 1)
          const rejected = rejectedAnswerMessage(terminalAssistant, reason)
          classifiedMessages = classifiedMessages.map((message) =>
            message.id === rejected.id ? rejected : message
          )
          merged = restoreMirrorAccount(
            restoreMirrorThinkingLevel(mergeAgentMessages(mirror, classifiedMessages), mirror),
            mirror
          )
          await this.host.threadManager.upsertMessages(
            info.projectId,
            info.threadId,
            merged,
            sessionId
          )
          await this.host.units['transcripts'].finishCheckpoint(sessionId, info, 'failed', reason)
          await this.host.units['utilities'].cleanupTurnUtilities(
            sessionId,
            completedGatewayId ?? ''
          )
          turnUtilitiesCleaned = true
          if (pendingMemory) this.host.state.pendingMemoryDecisions.set(sessionId, pendingMemory)
          try {
            await this.host.sendPrompt(
              info.projectId,
              info.threadId,
              liveThread.settings,
              visualDeliverableRepairPrompt(requestedAsset),
              [],
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              'internal'
            )
          } catch (error) {
            this.host.state.pendingMemoryDecisions.delete(sessionId)
            const issue = this.host.units['providers-accounts'].fallbackProviderIssue(
              info.driverId,
              rawErrorMessage(error),
              rawErrorDetail(error)
            )
            await this.host.threadManager.setStatus(info.projectId, info.threadId, 'failed', {
              error: issue.message,
              errorDetail: issue.rawError
            })
            await this.host.units['thread-lifecycle'].broadcastThreadSessionError(
              info.projectId,
              info.threadId,
              sessionId,
              issue
            )
          }
          return
        }
      }
      // A live usage-reset wait (the harness's turn ended because the limit
      // hit, not because it silently dropped output) already has a scheduled
      // resume via `enterRetryWait`/`scheduleAutomaticRetry`. Auto-continuing
      // here would race that scheduled retry and, once it also fails to
      // resume immediately, fall into the catch below and flip the thread
      // from the will-retry wait to a terminal error.
      const resetWaitActiveForRecovery =
        !userAborted && this.host.units['turns-dispatch'].isAutomaticRetryWaitActive(sessionId)
      if (missingFinalResponse && !failure && !resetWaitActiveForRecovery && liveThread?.settings) {
        this.host.state.incompleteTurnRecoveryAttempts.set(sessionId, 1)
        await this.host.units['transcripts'].finishCheckpoint(
          sessionId,
          info,
          'failed',
          INCOMPLETE_TURN_MESSAGE
        )
        await this.host.units['utilities'].cleanupTurnUtilities(sessionId, completedGatewayId ?? '')
        turnUtilitiesCleaned = true
        if (pendingMemory) this.host.state.pendingMemoryDecisions.set(sessionId, pendingMemory)
        try {
          await this.host.sendPrompt(
            info.projectId,
            info.threadId,
            liveThread.settings,
            INCOMPLETE_TURN_CONTINUATION_PROMPT,
            [],
            engineeringContractActive ? 'implement' : undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            'internal'
          )
        } catch (error) {
          this.host.state.pendingMemoryDecisions.delete(sessionId)
          const issue = this.host.units['providers-accounts'].fallbackProviderIssue(
            info.driverId,
            rawErrorMessage(error),
            rawErrorDetail(error)
          )
          await this.host.threadManager.setStatus(info.projectId, info.threadId, 'failed', {
            error: issue.message,
            errorDetail: issue.rawError
          })
          await this.host.units['thread-lifecycle'].broadcastThreadSessionError(
            info.projectId,
            info.threadId,
            sessionId,
            issue
          )
        }
        return
      }
      if (contractContinuationRequired && liveThread?.settings) {
        await this.host.units['transcripts'].finishCheckpoint(
          sessionId,
          info,
          'interrupted',
          'The approved specification contract is incomplete; continuing implementation.'
        )
        await this.host.units['utilities'].cleanupTurnUtilities(sessionId, completedGatewayId ?? '')
        turnUtilitiesCleaned = true
        if (pendingMemory) this.host.state.pendingMemoryDecisions.set(sessionId, pendingMemory)
        try {
          await this.host.sendPrompt(
            info.projectId,
            info.threadId,
            liveThread.settings,
            SPEC_CONTRACT_CONTINUATION_PROMPT,
            [],
            'implement',
            undefined,
            undefined,
            undefined,
            undefined,
            'internal'
          )
        } catch (error) {
          this.host.state.pendingMemoryDecisions.delete(sessionId)
          const issue = this.host.units['providers-accounts'].fallbackProviderIssue(
            info.driverId,
            rawErrorMessage(error),
            rawErrorDetail(error)
          )
          await this.host.threadManager.setStatus(info.projectId, info.threadId, 'failed', {
            error: issue.message,
            errorDetail: issue.rawError
          })
          await this.host.units['thread-lifecycle'].broadcastThreadSessionError(
            info.projectId,
            info.threadId,
            sessionId,
            issue
          )
        }
        return
      }
      const persistedRevision = this.host.state.pendingSpecRevisions.has(sessionId)
        ? null
        : await this.host.units['spec-lifecycle'].readPendingSpecRevision(
            info.projectId,
            info.threadId
          )
      const hasPendingRevision =
        this.host.state.pendingSpecRevisions.has(sessionId) ||
        persistedRevision?.sessionId === sessionId
      // Claim the pending entry up front: a duplicate idle finalization for the
      // same turn (double `session.idle`/`session.status` delivery after a late
      // part event cleared the idle guard) must not call reviewBrainstorm a
      // second time while the first refresh still holds the brainstorm lock
      // that race surfaced as a misleading "already updating this Brainstorm"
      // toast even though the first refresh completed fine.
      const pendingBrainstormTurn = this.host.state.pendingBrainstormTurns.get(sessionId)
      if (pendingBrainstormTurn && (!awaitingUser || failure))
        this.host.state.pendingBrainstormTurns.delete(sessionId)
      if (failure && hasPendingRevision) {
        this.host.state.pendingSpecRevisions.delete(sessionId)
        await this.host.units['spec-lifecycle'].clearPendingSpecRevision(
          info.projectId,
          info.threadId
        )
      }
      if (failure) this.host.state.pendingBrainstormTurns.delete(sessionId)
      // The PRD turn is captured only on a clean end without a user wait: a turn
      // that ended on a question keeps its pending record, because the answers
      // resume the same logical turn and the submission arrives with it.
      const pendingPrdTurn = this.host.state.pendingPrdTurns.get(sessionId)
      if (failure && pendingPrdTurn) {
        this.host.state.pendingPrdTurns.delete(sessionId)
        await this.host.units['prd'].clearPendingPrdTurn(info.projectId, info.threadId)
      }
      // The Assignment turn follows the same rule: an interview that ended on a
      // question keeps its pending record so the answers resume it, and a failed
      // turn drops it because there is no submission to capture.
      const pendingAssignmentTurn = this.host.state.pendingAssignmentTurns.get(sessionId)
      if (failure && pendingAssignmentTurn) {
        this.host.state.pendingAssignmentTurns.delete(sessionId)
        await this.host.units['assignment'].clearPendingAssignmentTurn(
          info.projectId,
          info.threadId
        )
      }
      let revisedSpec: EngineeringSpec | null = null
      let revisedBrainstorm: BrainstormDocument | null = null
      let createdPrd: PrdDocument | null = null
      let createdAssignment: AssignmentPlan | null = null
      // Post-turn artifact updates (spec revision, brainstorm report) must
      // stay silent when they fail: the main turn's work is already done, the
      // previous artifact version remains reviewable, and each surface has its
      // own retry affordance (review notes stay on the document; the brainstorm
      // trace carries the error into the conversation). Toasting or marking the
      // thread `failed` here fired a misleading "hit an error" notification for
      // a thread that kept working, so the error is only logged.
      let auxiliaryFailure: string | null = null
      if (!failure && !awaitingUser && hasPendingRevision) {
        try {
          revisedSpec = await this.host.units['spec-lifecycle'].runPendingSpecRevision(
            sessionId,
            messages,
            {
              projectId: info.projectId,
              threadId: info.threadId
            }
          )
        } catch (error) {
          auxiliaryFailure =
            error instanceof Error ? error.message : 'The specification revision was invalid.'
          Logger.error('Specification update failed after a completed turn', {
            projectId: info.projectId,
            threadId: info.threadId,
            sessionId,
            error: auxiliaryFailure
          })
        }
      }
      if (!failure && !awaitingUser && pendingBrainstormTurn) {
        try {
          const round = await this.host.units['brainstorm-review'].brainstormAlignmentRound(
            info.projectId,
            info.threadId
          )
          const expectedVersion = (pendingBrainstormTurn.version ?? 0) + 1
          const approved =
            round.version === expectedVersion &&
            (await this.host.state.brainstormAlignmentNotes.consumeApproval(round))
          if (approved)
            revisedBrainstorm =
              pendingBrainstormTurn.brainstormId && pendingBrainstormTurn.version
                ? await this.host.reviewBrainstorm(
                    info.projectId,
                    info.threadId,
                    pendingBrainstormTurn.brainstormId,
                    pendingBrainstormTurn.version,
                    pendingBrainstormTurn.note,
                    { sessionTurn: true }
                  )
                : await this.host.units['brainstorm'].createBrainstormSessionReport(
                    info.projectId,
                    info.threadId,
                    pendingBrainstormTurn.note
                  )
        } catch (error) {
          auxiliaryFailure =
            error instanceof Error ? error.message : 'The Brainstorm revision failed.'
          Logger.error('Brainstorm update failed after a completed turn', {
            projectId: info.projectId,
            threadId: info.threadId,
            sessionId,
            error: auxiliaryFailure
          })
          // The thread status intentionally stays on the previous artifact's
          // reviewable state below (not `failed`) so a background rebuild
          // hiccup never fires a misleading "hit an error" notification for a
          // turn that otherwise completed fine. But staying fully silent left
          // the user with no signal at all that their requested rebuild never
          // happened, so still surface it as a toast.
          broadcastToast(`Brainstorm update failed: ${auxiliaryFailure}`)
        }
      }
      if (!failure && !awaitingUser && pendingPrdTurn) {
        try {
          createdPrd = await this.host.units['prd'].runPendingPrdTurn(sessionId, messages, {
            projectId: info.projectId,
            threadId: info.threadId
          })
        } catch (error) {
          // A rejected submission is recoverable: the document is not created, the
          // PRD stage stays open, and the conversation carries on, so this must
          // never mark the thread failed or trip the terminal-failure gate.
          auxiliaryFailure =
            error instanceof Error ? error.message : 'The PRD submission was invalid.'
          Logger.error('PRD submission failed after a completed turn', {
            projectId: info.projectId,
            threadId: info.threadId,
            sessionId,
            error: auxiliaryFailure
          })
          broadcastToast(`The PRD was not created: ${auxiliaryFailure}`)
        }
      }
      if (!failure && !awaitingUser && pendingAssignmentTurn) {
        try {
          createdAssignment = await this.host.units['assignment-run'].runPendingAssignmentTurn(
            sessionId,
            messages,
            {
              projectId: info.projectId,
              threadId: info.threadId
            }
          )
        } catch (error) {
          // A rejected submission is recoverable: no draft is written, the
          // Assignment stage stays open, and the interview carries on, so this
          // must never mark the thread failed or trip the terminal-failure gate.
          auxiliaryFailure =
            error instanceof Error ? error.message : 'The Assignment submission was invalid.'
          Logger.error('Assignment submission failed after a completed turn', {
            projectId: info.projectId,
            threadId: info.threadId,
            sessionId,
            error: auxiliaryFailure
          })
          broadcastToast(`The Assignment was not created: ${auxiliaryFailure}`)
        }
      }
      // Race-safe guard: if the persisted thread is already `failed` (an
      // earlier session-error path marked it) and this finalization would
      // otherwise claim success, keep it failed so a terminal "done"
      // notification can never shadow the real error.
      const threadBeforeFinalize = await this.host.threadManager.getThread(
        info.projectId,
        info.threadId
      )
      // A superseded finalization owns nothing on the thread any more: its
      // session was replaced while the transcript was being finalized (a model
      // fallback moved the assistant onto its next model, the harness changed, or
      // a newer turn started). The transcript and its usage are durable above;
      // the live turn owns the status, the notifications, the run report, and
      // the coordinator hand-off, so this must not settle any of them.
      if (superseded) {
        // A newer turn running on this same session re-registered the active
        // turn id, and an idle finalization does not carry the turn id it
        // belongs to: closing the checkpoint then would steal the live turn's
        // checkpoint, so it is only closed when no newer turn owns the session.
        if (!awaitingUser && this.host.sessionStatuses.get(sessionId)?.state !== 'working') {
          await this.host.units['transcripts'].finishCheckpoint(
            sessionId,
            info,
            failure ? 'failed' : 'interrupted',
            failure ?? SUPERSEDED_TURN_MESSAGE
          )
        }
        Logger.dev('Stopped a superseded idle finalization', {
          projectId: info.projectId,
          threadId: info.threadId,
          sessionId,
          liveSessionId: threadBeforeFinalize?.sessionId ?? null
        })
        return
      }
      // Task-list guard: an agent that finished its work but never updated the
      // list it published leaves the app's task card frozen mid-run, reading as
      // abandoned work. A harness may reconcile this itself (pi's core-tools
      // extension does, and declares `handlesTaskReconcile`); for every other
      // harness the engine issues one hidden reconcile turn on the same thread
      // and session, so the agent makes the list match what it actually did.
      // Runs only on an otherwise-final turn with no artifact capture pending,
      // after every repair continuation above has already had its chance, and
      // is capped at one reconcile per user prompt by `todoReconcileAttempts`,
      // so it can never loop.
      if (
        !failure &&
        !awaitingUser &&
        !suppressTerminalAnswer &&
        !contractBlocked &&
        !userAborted &&
        assignmentContinuation === null &&
        !revisedSpec &&
        !revisedBrainstorm &&
        !createdPrd &&
        !createdAssignment &&
        !hasPendingRevision &&
        !pendingBrainstormTurn &&
        !pendingPrdTurn &&
        !pendingAssignmentTurn &&
        liveThread?.settings &&
        driver.capabilities.handlesTaskReconcile !== true &&
        (this.host.state.todoReconcileAttempts.get(sessionId) ?? 0) < 1
      ) {
        const latestTodo = latestAgentTodo(messages)
        const unfinishedLabels = latestTodo
          ? latestTodo.items.filter((item) => item.status !== 'completed').map((item) => item.label)
          : []
        if (unfinishedLabels.length > 0) {
          this.host.state.todoReconcileAttempts.set(sessionId, 1)
          this.host.state.taskReconcileTurns.add(sessionId)
          await this.host.units['transcripts'].finishCheckpoint(
            sessionId,
            info,
            'interrupted',
            'Reconciling the task list before finishing.'
          )
          await this.host.units['utilities'].cleanupTurnUtilities(
            sessionId,
            completedGatewayId ?? ''
          )
          turnUtilitiesCleaned = true
          if (pendingMemory) this.host.state.pendingMemoryDecisions.set(sessionId, pendingMemory)
          try {
            await this.host.sendPrompt(
              info.projectId,
              info.threadId,
              liveThread.settings,
              taskReconcilePrompt(unfinishedLabels),
              [],
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              'internal'
            )
          } catch (error) {
            this.host.state.pendingMemoryDecisions.delete(sessionId)
            const issue = this.host.units['providers-accounts'].fallbackProviderIssue(
              info.driverId,
              rawErrorMessage(error),
              rawErrorDetail(error)
            )
            await this.host.threadManager.setStatus(info.projectId, info.threadId, 'failed', {
              error: issue.message,
              errorDetail: issue.rawError
            })
            await this.host.units['thread-lifecycle'].broadcastThreadSessionError(
              info.projectId,
              info.threadId,
              sessionId,
              issue
            )
          }
          return
        }
      }
      // A live usage-reset wait owns this turn's outcome: the harness reported
      // its limit as the waiting card and the engine already persisted
      // `working-paused` with a scheduled resume. The idle finalization's own
      // failure scan (the limit message rides on the last assistant record) is
      // not a second terminal event   letting it set `failed` would overwrite
      // the pause, flip the row to an error badge, and fire a misleading
      // "hit an error" notification while the will-retry card is on screen.
      // The checkpoint still finalizes (same as the session-error wait path);
      // only the thread status stays paused.
      const resetWaitActive =
        !userAborted && this.host.units['turns-dispatch'].isAutomaticRetryWaitActive(sessionId)
      const finalStatus = resetWaitActive
        ? 'working-paused'
        : userAborted || contractBlocked
          ? 'interrupted'
          : failure
            ? 'failed'
            : revisedSpec || revisedBrainstorm
              ? 'spec'
              : // Every engineering stage that finishes (a revised Spec or Brainstorm,
                // a freshly drafted PRD, or an unsigned Assignment) parks the thread
                // on the user under the engineering-specific `spec` status. That
                // status is strictly for engineering, so a stage completion must
                // never settle as the generic `awaiting_approval` needs-attention
                // state, which is reserved for real harness gates (permissions,
                // questions, secrets). The `failed` guard keeps an already-failed
                // thread from being shadowed by a late successful artifact.
                (createdPrd || createdAssignment) && threadBeforeFinalize?.status !== 'failed'
                ? 'spec'
                : auxiliaryFailure
                  ? // An auxiliary artifact update failed: settle on the
                    // previous artifact's reviewable state instead of `failed`,
                    // which would fire a misleading error notification.
                    (await this.host.units['spec'].getActiveSpec(info.projectId, info.threadId)) ||
                    (await this.host.state.brainstormEngine.getActive(
                      info.projectId,
                      info.threadId
                    ))
                    ? 'spec'
                    : 'completed'
                  : awaitingUser
                    ? 'awaiting_approval'
                    : threadBeforeFinalize?.status === 'failed'
                      ? 'failed'
                      : 'completed'
      await this.host.threadManager.setStatus(info.projectId, info.threadId, finalStatus, {
        read: userAborted
      })
      // A live usage-reset wait already owns this turn's outcome (see
      // `resetWaitActive` above). Broadcasting the generic "incomplete turn"
      // failure here would overwrite the session's `waiting` status back to
      // `error` and swap the will-retry card for a misleading error card,
      // even though `finalStatus` correctly kept the thread `working-paused`.
      if (failure === INCOMPLETE_TURN_MESSAGE && !resetWaitActive) {
        await this.host.units['thread-lifecycle'].broadcastThreadSessionError(
          info.projectId,
          info.threadId,
          sessionId,
          this.host.units['providers-accounts'].fallbackProviderIssue(
            info.driverId,
            INCOMPLETE_TURN_MESSAGE
          )
        )
      }
      const finishedThread = await this.host.threadManager.getThread(info.projectId, info.threadId)
      // A settled run this app dispatched on an agent's behalf is reported back
      // into the thread that asked for it, so the outcome lands where the user
      // asked for it instead of only on a row they have to go find.
      const settledDispatch = finishedThread
        ? this.host.orchestration?.dispatches.settle(finishedThread.id)
        : undefined
      if (settledDispatch) {
        void this.host.units['turns-dispatch'].reportOrchestrationDispatch(
          settledDispatch,
          finalStatus
        )
      }
      // A settled turn on an assistant task is reported to the assistant scheduler,
      // which knows whether it dispatched a run on that task and stamps its last
      // successful run. Harmless for a user's own chat: the scheduler ignores a
      // thread no run was dispatched on.
      if (
        this.host.state.assistantRunSettled &&
        finishedThread &&
        isAssistantThread(finishedThread)
      ) {
        this.host.state.assistantRunSettled(finishedThread.id, finalStatus)
      }
      // A settled assistant task turn also leaves a durable Markdown report in
      // the assistant's workspace, so the report outlives the evicted thread. The
      // in-app report and its notification are unchanged.
      if (finishedThread && isAssistantThread(finishedThread)) {
        this.host.units['assistant-authoring'].captureAssistantReport(
          finishedThread,
          terminalAssistant,
          finalStatus
        )
      }
      if (!failure && !awaitingUser && !contractBlocked && finishedThread) {
        try {
          await this.host.units['audit'].notifyCoordinatorOfAssignmentAuditFeedback(
            finishedThread,
            lastAssistant
          )
        } catch (error) {
          Logger.error('Assignment audit feedback handoff failed', {
            auditorThreadId: finishedThread.id,
            coordinatorThreadId: finishedThread.coordinatorThreadId,
            error: error instanceof Error ? error.message : String(error)
          })
        }
        if (!userAborted) {
          try {
            await this.host.units[
              'assignment-workers'
            ].notifyCoordinatorOfUnreportedWorkerCompletion(
              finishedThread,
              sessionId,
              turnAssistant?.completedAt
            )
          } catch (error) {
            Logger.error('Unreported Assignment worker handoff failed', {
              workerThreadId: finishedThread.id,
              coordinatorThreadId: finishedThread.coordinatorThreadId,
              error: rawErrorMessage(error)
            })
          }
        }
      }
      if (!failure && !contractBlocked) {
        let assignment = this.host.state.assignmentEngine.getActive(info.projectId, info.threadId)
        const coordinatorSettings = finishedThread?.settings
        if (assignment && ['approved', 'running', 'attention'].includes(assignment.status)) {
          assignment =
            await this.host.units['assignment-workers'].reconcileUnavailableAssignmentWorkers(
              assignment
            )
          if (
            !awaitingUser &&
            !userAborted &&
            finishedThread?.assignmentRole === 'coordinator' &&
            coordinatorSettings &&
            (await this.host.units['assignment'].assignmentNeedsCoordinatorTurn(assignment))
          ) {
            assignmentContinuation = { assignment, settings: coordinatorSettings }
          } else {
            await this.host.state.assignmentEngine.rememberCoordinatorSnapshot(assignment.id)
          }
        }
        if (
          assignment?.status === 'draft' &&
          assignment.auditCycle?.status === 'awaiting_rework_approval'
        ) {
          await this.host.threadManager.setStatus(info.projectId, info.threadId, 'spec', {
            read: false
          })
        }
      }
      if (!awaitingUser) {
        this.host.reassertTurnToolEvidence(info, messages)
        await this.host.units['transcripts'].finishCheckpoint(
          sessionId,
          info,
          userAborted || contractBlocked ? 'interrupted' : failure ? 'failed' : 'completed',
          contractBlocked ? 'The specification contract requires user intervention.' : failure
        )
      }
      if (
        !failure &&
        !awaitingUser &&
        !contractBlocked &&
        !revisedSpec &&
        !revisedBrainstorm &&
        !pendingBrainstormTurn
      ) {
        try {
          await this.host.units['spec-lifecycle'].runPendingInitialSpec(
            info.projectId,
            info.threadId
          )
        } catch (error) {
          Logger.error('Initial specification generation failed:', error)
        }
      }
      if (!failure && !awaitingUser && !contractBlocked && !revisedSpec && !revisedBrainstorm) {
        const [thread, activeSpec] = await Promise.all([
          this.host.threadManager.getThread(info.projectId, info.threadId),
          this.host.units['spec'].getActiveSpec(info.projectId, info.threadId)
        ])
        const loopAssignment = this.host.state.assignmentEngine.getActive(
          info.projectId,
          info.threadId
        )
        const finalizedBrainstorm =
          !activeSpec && thread?.settings?.loopMode !== true
            ? await this.host.units['brainstorm'].implementationBrainstormContract(
                info.projectId,
                info.threadId
              )
            : null
        if (
          thread?.settings &&
          (await this.host.units['audit'].implementationAuditEligible(thread)) &&
          (activeSpec?.status === 'approved' || finalizedBrainstorm !== null) &&
          (!thread.settings.loopMode || !loopAssignment || loopAssignment.status === 'completed') &&
          thread.auditState !== 'running' &&
          thread.auditState !== 'report_ready'
        ) {
          await this.host.threadManager.setAuditState(info.projectId, info.threadId, 'offered')
          if (thread.settings.loopMode === true) {
            void this.host.units['misc'].continueLoop(info.projectId, info.threadId)
          }
        }
      }
      if (!failure && !contractBlocked && terminalAssistant) {
        assistantResponse = assistantMemoryDecisionContext(terminalAssistant)
      }
    } catch (error) {
      Logger.error('history mirror failed:', error)
      if (this.host.state.userAbortedSessions.has(sessionId)) return
      const issue = historyMirrorIssue(error, info.driverId)
      // The app established this failure while it was already finalizing the
      // turn, so it may not be deferred to a driver registration.
      await this.host.units['turns-sessions'].onSessionError(
        sessionId,
        issue.message,
        false,
        issue.rawError,
        false
      )
      await this.host.units['thread-lifecycle'].broadcastThreadSessionError(
        info.projectId,
        info.threadId,
        sessionId,
        issue
      )
    } finally {
      const interviewWaiting =
        this.host.state.pendingBrainstormTurns.has(sessionId) &&
        [...this.host.pendingQuestions.values()].some(
          (pending) => pending.request.sessionId === sessionId
        )
      // A newer turn already running on this same session owns the registry
      // entry now: clearing its turn markers or tearing its utility gateway
      // down here would rip the credentials out from under a live turn.
      const ownedByNewerTurn = this.host.sessionStatuses.get(sessionId)?.state === 'working'
      if (!interviewWaiting && !ownedByNewerTurn) {
        info.activeTurnUserMessageId = undefined
        info.activeTurnOrigin = undefined
        info.estimatedContextUsed = undefined
        if (!turnUtilitiesCleaned)
          await this.host.units['utilities'].cleanupTurnUtilities(
            sessionId,
            completedGatewayId ?? ''
          )
      }
      // The abort marker only needs to survive until the session's idle
      // finalization has run; after that the session is on a fresh turn.
      this.host.state.userAbortedSessions.delete(sessionId)
    }
    if (assignmentContinuation) {
      try {
        await this.host.units['assignment-run'].ensureAssignmentApi()
        const assignmentId = assignmentContinuation.assignment.id
        const coordinatorThreadId = assignmentContinuation.assignment.coordinatorThreadId
        let dispatched = await this.host.units['assignment'].sendAssignmentCoordinatorPrompt(
          assignmentContinuation.assignment,
          assignmentContinuation.settings,
          this.host.units['assignment'].coordinatorAssignmentPrompt(
            assignmentContinuation.assignment
          )
        )
        if (!dispatched) {
          const stalls = (this.host.state.assignmentContinuationStalls.get(assignmentId) ?? 0) + 1
          if (stalls > ChatEngine.MAX_ASSIGNMENT_CONTINUATION_STALLS) {
            this.host.state.assignmentContinuationStalls.delete(assignmentId)
            Logger.error('Assignment coordinator stalled without making progress', {
              assignmentId,
              threadId: coordinatorThreadId,
              consecutiveNoOpContinuations: stalls
            })
            await this.host.threadManager.setStatus(
              info.projectId,
              coordinatorThreadId,
              'interrupted',
              {
                read: false
              }
            )
            broadcastToast(
              'The Sr. Engineer ended its turn without resolving the Assignment tasks. Resume coordination to continue.',
              'info'
            )
          } else {
            this.host.state.assignmentContinuationStalls.set(assignmentId, stalls)
            dispatched = await this.host.units['assignment'].sendAssignmentCoordinatorPrompt(
              assignmentContinuation.assignment,
              assignmentContinuation.settings,
              this.host.units['assignment'].coordinatorAssignmentPrompt(
                assignmentContinuation.assignment
              ),
              undefined,
              true
            )
            if (dispatched) {
              Logger.info('Forced Assignment coordinator continuation after a no-op turn', {
                assignmentId,
                threadId: coordinatorThreadId,
                consecutiveNoOpContinuations: stalls
              })
            } else {
              Logger.info('Assignment continuation skipped because its snapshot is unchanged', {
                assignmentId,
                threadId: coordinatorThreadId
              })
            }
          }
        } else {
          this.host.state.assignmentContinuationStalls.delete(assignmentId)
        }
      } catch (error) {
        Logger.error('Assignment continuation failed', {
          assignmentId: assignmentContinuation.assignment.id,
          threadId: assignmentContinuation.assignment.coordinatorThreadId,
          error: rawErrorMessage(error)
        })
      }
    }
    try {
      await this.host.units['assignment'].drainCoordinatorHandoffQueue(
        info.projectId,
        info.threadId
      )
    } catch (error) {
      Logger.error('Queued coordinator handoff dispatch failed', {
        projectId: info.projectId,
        threadId: info.threadId,
        error: rawErrorMessage(error)
      })
    }
    if (pendingMemory && assistantResponse && memoryParentTurnId) {
      const driver = this.host.units['turns-dispatch'].driverForRuntime(
        info.driverId,
        info.accountId
      )
      if (driver) {
        void this.host.units['memory']
          .proposeMemoryFromCompletedTurn(
            pendingMemory.userMessage,
            assistantResponse,
            info.projectId,
            info.threadId,
            memoryParentTurnId,
            driver,
            info.projectPath,
            pendingMemory.settings,
            pendingMemory.references
          )
          .catch((error) => Logger.error('Memory signal processing failed:', error))
      }
    }
  }
}
