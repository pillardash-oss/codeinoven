import { join, resolve } from 'path'
import { Logger } from '../../system/logger'
import type { IsolatedSessionHandle } from '../../drivers/isolated-session'
import { supportsIsolatedSessions } from '../../drivers/isolated-session'
import { DEFAULT_HARNESS } from '../../../lib/harness-default'
import { validateBoundedString, validateEntityId } from '../../ipc/ipc-validation'
import { SteerDeliveryFailedError } from '../../drivers/driver.interface'
import type { SteerPromptOptions } from '../../drivers/driver.interface'
import { isCioUtilityRequest } from '../../utilities/cio-utility-prompt'
import { isCioDesignRequest } from '../../utilities/cio-design-prompt'
import { isCioVideoRequest } from '../../utilities/cio-video-prompt'
import type { AuthoredWorkKind } from '../../../lib/ipc/design'
import { legacyHarnessAccountId } from '../../providers/harness-account-registry'
import type {
  AgentMessage,
  PromptAttachment,
  PromptAssignmentTaskReference,
  PromptProjectReference,
  PromptReference,
  UserMessagePresentation,
  Thread,
  ThreadSettings
} from '../../../lib/types'
import { isAssistantSetupThread } from '../../../lib/types'
import type { HeldSteer } from './chat-engine-types'
import { rawErrorMessage } from './chat-engine-errors'
import { withoutTransportParts } from './chat-engine-message-merge'
import { formatProjectReferenceContext } from './chat-engine-message-text'
import { assertHarnessRequestCapabilities } from './chat-engine-constants'
import {
  budgetHiddenContext,
  validatePromptReferences,
  validateUserMessagePresentation
} from './chat-engine-pure'
import type { ChatEngine } from '../chat-engine'

/** ChatEngine turns-steer: one concern, moved verbatim from the composition root. */
export class ChatEngineTurnsSteer {
  constructor(private readonly host: ChatEngine) {}

  /** Resolve a child session back to the root thread session that owns its
   *  steer-hold state (child sessions never hold steers of their own). */
  rootSessionIdForSteer(sessionId: string): string {
    return this.host.state.childSessionOwners.get(sessionId)?.parentSessionId ?? sessionId
  }

  /** Register a held steer and tell renderers the undo window is open. */
  trackHeldSteer(sessionId: string, steer: HeldSteer): void {
    // One steer at a time per session   a second steer while one is held
    // replaces the pending delivery, but only the latest is undoable.
    this.host.state.heldSteers.set(sessionId, steer)
    this.host.broadcast({ type: 'steer.held', sessionId, userMessageId: steer.userMessageId })
  }

  /** Deliver every held steer for a session whose last in-flight tool just
   *  ended   the undo window closes the moment the harness can absorb input. */
  async flushHeldSteers(sessionId: string, mode: 'mid-turn' | 'after-turn'): Promise<void> {
    const steer = this.host.state.heldSteers.get(sessionId)
    if (!steer) return
    if (mode === 'mid-turn') {
      this.host.state.heldSteers.delete(sessionId)
      try {
        await steer.deliverMidTurn()
      } catch (error) {
        Logger.error('Held steer delivery failed:', error)
        // The harness never absorbed the steer: keep the user's message and
        // close the undo window instead of deleting words they typed.
        this.host.broadcast({
          type: 'steer.released',
          sessionId,
          userMessageId: steer.userMessageId
        })
        return
      }
      this.host.broadcast({
        type: 'steer.delivered',
        sessionId,
        userMessageId: steer.userMessageId
      })
      return
    }
    // after-turn: the whole turn finished while the steer was held. Deliver as
    // a regular next-turn send; release on failure (the session is gone).
    this.host.state.heldSteers.delete(sessionId)
    try {
      await steer.deliverAfterTurn()
    } catch (error) {
      Logger.error('Held steer after-turn delivery failed:', error)
      this.host.broadcast({ type: 'steer.released', sessionId, userMessageId: steer.userMessageId })
      return
    }
    // The undo window closed   the steer is now an ordinary sent message.
    this.host.broadcast({ type: 'steer.delivered', sessionId, userMessageId: steer.userMessageId })
  }

  /** Drop a held steer before delivery   nothing ever reached the harness. */
  async discardSteer(projectId: string, threadId: string, userMessageId: string): Promise<void> {
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    userMessageId = validateEntityId(userMessageId, 'Message ID', 256)
    for (const [sessionId, steer] of this.host.state.heldSteers) {
      if (
        steer.projectId !== projectId ||
        steer.conversationId !== threadId ||
        steer.userMessageId !== userMessageId
      ) {
        continue
      }
      this.host.state.heldSteers.delete(sessionId)
      await steer.discard()
      this.host.broadcast({ type: 'steer.discarded', sessionId, userMessageId })
      return
    }
  }

  /** Release any held steer for a session WITHOUT deleting it (driver reset,
   *  teardown, abort). The steer never reached the harness, but the message is
   *  the user's: it stays in the transcript so a stop or a reset can never
   *  make typed words vanish. Only an explicit undo removes it. */
  clearHeldSteers(sessionId: string): void {
    const steer = this.host.state.heldSteers.get(sessionId)
    if (!steer) return
    this.host.state.heldSteers.delete(sessionId)
    this.host.broadcast({ type: 'steer.released', sessionId, userMessageId: steer.userMessageId })
  }

  /** Append a user message to the harness's currently active native turn. */
  async steerPrompt(
    projectId: string,
    threadId: string,
    text: string,
    attachments: PromptAttachment[],
    userMessageId: string,
    promptContext?: string,
    promptReferences?: PromptReference[],
    projectReferences?: PromptProjectReference[],
    presentation?: UserMessagePresentation,
    taskReferences?: PromptAssignmentTaskReference[]
  ): Promise<AgentMessage> {
    this.host.units['messages'].touchUserActivity()
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    text = validateBoundedString(text, 'Prompt', 0, 200_000)
    const hasSendableContext =
      text.length > 0 ||
      (attachments?.length ?? 0) > 0 ||
      Boolean(promptContext) ||
      (promptReferences?.length ?? 0) > 0 ||
      (projectReferences?.length ?? 0) > 0 ||
      (taskReferences?.length ?? 0) > 0
    if (text.length === 0 && !hasSendableContext) {
      throw new TypeError('Prompt must be a string between 1 and 200000 characters')
    }
    const messageId = validateEntityId(userMessageId, 'Message ID', 256)
    const thread = await this.host.threadManager.getThread(projectId, threadId)
    if (!thread) throw new Error(`Thread not found: ${threadId}`)
    if (this.host.state.ovenChat.remote(thread)) {
      await this.host.state.ovenChat.stop(thread)
      return this.host.sendPrompt(
        projectId,
        threadId,
        thread.settings!,
        text,
        attachments,
        undefined,
        messageId,
        promptContext,
        promptReferences,
        projectReferences,
        'user',
        presentation,
        taskReferences
      )
    }
    const brainstormKey = `${projectId}:${threadId}`
    const activeBrainstorm = this.host.state.activeBrainstormSessions.get(brainstormKey)
    const activeSessionId = activeBrainstorm?.sessionId ?? thread.sessionId
    if (!activeSessionId) throw new Error('This thread has no active harness session to steer')
    // Assignment workers remain locked against starting independent user turns,
    // but an already-running worker may be steered from its own conversation.
    // The active-session check below keeps this narrowly scoped to a live turn;
    // auditors and every other locked orchestration task stay non-interactive.
    if (
      thread.userInputLocked &&
      thread.assignmentRole !== 'coordinator' &&
      thread.assignmentRole !== 'worker'
    ) {
      throw new Error('This Assignment task is locked. Return to its coordinator to continue.')
    }
    // A Codex auto-retry (network blip with `willRetry: true`) parks the
    // session in `waiting` while the native turn stays live. Rejecting a steer
    // there claims the turn "finished" when it is merely retrying, so accept
    // `waiting` too when the driver still reports a registered native turn;
    // the actual delivery then proves liveness and falls back to nothing.
    const steerSessionState = this.host.sessionStatuses.get(activeSessionId)?.state
    const steerSettings =
      thread.settings ??
      ({
        harnessId: DEFAULT_HARNESS,
        accountId: legacyHarnessAccountId(DEFAULT_HARNESS),
        providerId: '',
        modelId: '',
        thinkingLevel: 'low',
        permissionLevel: 'auto_review',
        assignmentMode: false,
        loopMode: false
      } satisfies ThreadSettings)
    // A steer is a user message first: when the engine's cached status says
    // the turn is no longer live, the message must still reach the harness
    //   delivered as a regular send (a fresh turn) instead of being rejected.
    // Brainstorm-isolated steers keep their guard: their target session is
    // owned by the brainstorm operation, not the thread's regular session.
    const deliverAsRegularSend = (): Promise<AgentMessage> =>
      this.host.sendPrompt(
        projectId,
        threadId,
        steerSettings,
        text,
        attachments,
        undefined,
        messageId,
        promptContext,
        promptReferences,
        projectReferences,
        'user',
        presentation,
        taskReferences
      )
    if (steerSessionState !== 'working' && steerSessionState !== 'waiting') {
      if (activeBrainstorm) {
        throw new Error('The harness turn finished before the steer message could be delivered')
      }
      return deliverAsRegularSend()
    }
    // Steering targets the ACTIVE session, which belongs to the harness that
    // created it   after a mid-run harness switch the active session still
    // lives in the old harness while `settings.harnessId` points at the new
    // one. Resolve the driver by the active session's owner so a steer after a
    // switch reaches the running turn instead of a foreign harness.
    const activeSessionOwner =
      this.host.sessionRegistry.get(activeSessionId)?.driverId ?? thread.sessionHarnessId
    const driverId =
      activeBrainstorm?.driverId ??
      activeSessionOwner ??
      thread.settings?.harnessId ??
      DEFAULT_HARNESS
    const activeAccountId =
      this.host.sessionRegistry.get(activeSessionId)?.accountId ?? thread.sessionAccountId
    const selectedDriverId = steerSettings.harnessId || DEFAULT_HARNESS
    const selectedAccountId = (
      await this.host.state.accountRegistry.resolve(selectedDriverId, steerSettings.accountId)
    ).id
    if (
      driverId !== selectedDriverId ||
      (activeAccountId ?? legacyHarnessAccountId(driverId)) !== selectedAccountId
    ) {
      const activeRuntime = await this.host.resolve(projectId, driverId, threadId, activeAccountId)
      this.host.state.userAbortedSessions.add(activeSessionId)
      this.clearHeldSteers(activeSessionId)
      // A stop-and-resend steers over a dying turn; the very next statement
      // sends the user's new prompt, which clears the latch again.
      await this.host.threadManager.markStoppedByUser(projectId, threadId)
      await activeRuntime.driver.abort(activeRuntime.projectPath, activeSessionId)
      this.host.sessionStatuses.set(activeSessionId, { state: 'idle' })
      // The dying turn reports nothing from its provider once it is aborted, so
      // its streamed work is recovered before the new prompt moves the
      // boundary past it.
      await this.host.units['messages-write'].persistStreamedTurnWork(
        projectId,
        threadId,
        activeSessionId
      )
      this.host.units['turns-sessions'].handleSessionIdleSignal(activeSessionId)
      await this.host.units['turns-sessions'].awaitSessionIdleFinalization(activeSessionId)
      return this.host.sendPrompt(
        projectId,
        threadId,
        steerSettings,
        text,
        attachments,
        undefined,
        messageId,
        promptContext,
        promptReferences,
        projectReferences,
        'user',
        presentation,
        taskReferences
      )
    }
    const resolved =
      activeBrainstorm ?? (await this.host.resolve(projectId, driverId, threadId, activeAccountId))
    const { driver, projectPath } = resolved
    // `waiting` is only steerable while the native turn is actually live: a
    // usage-limit reset wait parks the session in `waiting` with the turn
    // already torn down, and steering that would lose the message.
    if (
      steerSessionState === 'waiting' &&
      driver.hasActiveTurn !== undefined &&
      !driver.hasActiveTurn(activeSessionId)
    ) {
      // The native turn is already torn down   deliver as a regular send
      // instead of telling the user the turn "finished".
      return deliverAsRegularSend()
    }
    if (driver.capabilities?.steering !== true || !driver.steerPrompt) {
      throw new Error(`${driver.name} does not expose native active-turn steering`)
    }
    assertHarnessRequestCapabilities(
      driver,
      attachments,
      thread.settings?.permissionLevel ?? 'auto_review'
    )
    const hiddenPromptContext = promptContext
      ? validateBoundedString(promptContext, 'Prompt context', 1, 100_000)
      : ''
    const validatedPromptReferences = validatePromptReferences(promptReferences)
    const validatedPresentation = validateUserMessagePresentation(presentation)
    const validatedProjectReferences = await this.host.units['turns'].validateProjectReferences(
      projectId,
      projectReferences,
      thread.scopeBucketId
    )
    const projectReferenceContext = formatProjectReferenceContext(validatedProjectReferences)
    let hiddenContext = [hiddenPromptContext, projectReferenceContext].filter(Boolean).join('\n\n')
    // A steer lands inside the running turn, and that turn's SYSTEM PROMPT
    // already carries the assistant contract (authoring or run), because the
    // engine composes it on every turn of an assistant thread. Re-stating it in
    // the steer message would only add a copy to the harness transcript, so the
    // steer relies on the prompt it is already running under.
    const steerInputBudget = this.host.units['runtime-agents'].selectedModelInputBudget(
      thread.settings?.providerId,
      thread.settings?.modelId,
      projectId
    )
    let driverText = hiddenContext
      ? `${budgetHiddenContext(hiddenContext, steerInputBudget)}\n\nUser message:\n${text}`
      : text
    const userMessage = await this.host.units['messages-write'].persistOutboundMessage(
      projectId,
      threadId,
      messageId,
      text,
      driverText,
      attachments,
      validatedPromptReferences,
      validatedProjectReferences,
      validatedPresentation,
      'user'
    )
    if (this.host.state.pendingBrainstormTurns.has(activeSessionId)) {
      await this.host.state.brainstormAlignmentNotes.clearApproval(
        await this.host.units['brainstorm-review'].brainstormAlignmentRound(projectId, threadId)
      )
    }
    if (
      thread.settings &&
      (await this.host.units['runtime-agents'].modelLacksVision(projectId, thread.settings))
    ) {
      const imageDescriptionContext = await this.host.units[
        'turns-dispatch'
      ].describePromptAttachments(attachments, projectId, threadId, projectPath, activeSessionId)
      if (imageDescriptionContext) {
        hiddenContext = [imageDescriptionContext, hiddenContext].filter(Boolean).join('\n\n')
        driverText = `${budgetHiddenContext(hiddenContext, steerInputBudget)}\n\nUser message:\n${text}`
        const transportPart = userMessage.transportParts?.[0]
        if (transportPart && transportPart.type === 'text') {
          transportPart.text = driverText
          await this.host.threadManager.upsertMessages(projectId, threadId, [userMessage])
        }
      }
    }
    await this.host.units['assignment-workers'].routeTaggedAssignmentWorkers(
      thread,
      'user',
      text,
      taskReferences
    )
    const outboundIds =
      this.host.state.outboundMessageIdsBySession.get(activeSessionId) ?? new Set<string>()
    outboundIds.add(messageId)
    this.host.state.outboundMessageIdsBySession.set(activeSessionId, outboundIds)
    // Steer does not start a new turn   keep the original turn's checkpoint
    // source and start-message anchor. The scanner's window is the true turn
    // (message after final output → final output), not the steer.
    // A steer is the latest user expression in the running turn   keep it (and
    // its referenced selections) as the memory signal for when the turn ends,
    // replacing the message that originally dispatched the turn.
    const previousPendingMemoryDecision =
      this.host.state.pendingMemoryDecisions.get(activeSessionId)
    if (!isAssistantSetupThread(thread)) {
      this.host.state.pendingMemoryDecisions.set(activeSessionId, {
        userMessage: text,
        settings: steerSettings,
        references: validatedPromptReferences
      })
    }
    if (isCioUtilityRequest(text)) this.host.state.cioUtilityThreads.set(threadId, true)
    if (isCioDesignRequest(text)) this.host.state.cioDesignThreads.set(threadId, true)
    if (isCioVideoRequest(text)) this.host.state.cioVideoThreads.set(threadId, true)
    const steeredKind: AuthoredWorkKind | null = isCioVideoRequest(text)
      ? 'video'
      : isCioDesignRequest(text)
        ? 'design'
        : null
    if (steeredKind) {
      await this.host.rememberAuthoredWorkKind(projectId, threadId, steeredKind)
    }
    await this.host.units['utilities'].rearmSteerUtilities(
      driver,
      projectId,
      threadId,
      activeSessionId,
      projectPath,
      steerSettings
    )
    const steerOptions = {
      sessionId: activeSessionId,
      text: driverText,
      attachments,
      userMessageId: messageId
    }
    const steer = driver.steerPrompt.bind(driver) as (
      projectPath: string,
      opts: SteerPromptOptions,
      isolated?: IsolatedSessionHandle
    ) => Promise<void>
    const deliverNow = async (): Promise<void> => {
      try {
        await this.host.units['turns-dispatch'].deliverWorkPrompt(
          projectId,
          threadId,
          userMessage,
          driverText,
          async (text) => {
            const options = { ...steerOptions, text }
            if (activeBrainstorm?.isolated && supportsIsolatedSessions(driver)) {
              await steer(projectPath, options, activeBrainstorm.isolated)
            } else {
              await steer(projectPath, options)
            }
          }
        )
      } catch (error) {
        if (error instanceof SteerDeliveryFailedError) throw error
        // The turn can settle inside the race window between the working check
        // above and this delivery (auto-compaction, silent continue, retry)
        // pi considers compaction part of the working trace but the driver's
        // registered turn is already gone. A settled trace must never reject the
        // user's message: deliver it as the next regular turn instead. The
        // driver's own registered-turn probe is authoritative over the cached
        // status, which can lag a compaction or process exit by seconds.
        const state = this.host.sessionStatuses.get(activeSessionId)?.state
        const turnStillLive = driver.hasActiveTurn
          ? driver.hasActiveTurn(activeSessionId)
          : state === 'working' || state === 'waiting'
        if (turnStillLive) throw error
        Logger.info('Steer landed on a settled turn   delivering as a regular send:', {
          projectId,
          threadId,
          sessionId: activeSessionId,
          error: rawErrorMessage(error)
        })
        if (previousPendingMemoryDecision) {
          this.host.state.pendingMemoryDecisions.set(activeSessionId, previousPendingMemoryDecision)
        } else {
          this.host.state.pendingMemoryDecisions.delete(activeSessionId)
        }
        this.host.sessionStatuses.set(activeSessionId, { state: 'idle' })
        this.host.units['turns-sessions'].handleSessionIdleSignal(activeSessionId)
        await this.host.units['turns-sessions'].awaitSessionIdleFinalization(activeSessionId)
        await deliverAsRegularSend()
      }
    }
    // CodeInOven owns steer delivery timing for every harness: while the turn
    // still has a tool call in flight, hold the steer so the user can undo it.
    // The moment the last in-flight tool ends, the steer is delivered.
    if (this.host.units['utilities-tools'].hasInFlightTool(activeSessionId)) {
      this.trackHeldSteer(activeSessionId, {
        projectId,
        conversationId: threadId,
        userMessageId: messageId,
        kind: 'thread',
        deliverMidTurn: deliverNow,
        deliverAfterTurn: async () => {
          // The turn ended while the steer was held   it becomes the next
          // turn's regular send. persistOutboundMessage dedupes by ID, so the
          // already-persisted user message is kept as-is.
          await this.host.sendPrompt(
            projectId,
            threadId,
            steerSettings,
            text,
            attachments,
            undefined,
            messageId,
            promptContext,
            promptReferences,
            projectReferences,
            'user',
            presentation,
            taskReferences
          )
        },
        discard: async () => {
          // Remove the persisted user message   the harness never saw it, so
          // the conversation must look like the steer never happened.
          const mirror = await this.host.threadManager.loadMessageRecords(projectId, threadId)
          const kept = mirror.filter((message) => message.id !== messageId)
          if (kept.length !== mirror.length) {
            await this.host.threadManager.saveMessages(projectId, threadId, kept)
          }
        }
      })
      return withoutTransportParts(userMessage)
    }
    await deliverNow()
    return withoutTransportParts(userMessage)
  }
}
