import { readFile } from 'fs/promises'
import { join } from 'path'
import { handedOffWorkersNote } from '../thread-transfer-service/thread-transfer-workers'
import type { ThreadTransferRelease } from '../thread-transfer-service/thread-transfer-workers'
import type { HandoffReleaseDetails } from '../../system/instance-handoff-bus'
import { createHash } from 'crypto'
import { Logger } from '../../system/logger'
import { broadcastThreadUpdate } from '../thread-events'
import { estimateTokens } from '../memory-service'
import { validateEntityId } from '../../ipc/ipc-validation'
import type { HarnessDriver } from '../../drivers/driver.interface'
import { instanceRegistry } from '../../system/instance-registry'
import type {
  ThreadSettings,
  ThreadTransferResult,
  TurnCheckpointChangeSummary,
  TurnCheckpointSummary
} from '../../../lib/types'
import { isAssistantSetupThread, isWorkflowCoordinatorThread } from '../../../lib/types'
import type { TitleAttemptAccounting } from '../../drivers/persistent-cli-driver'
import type { AuxiliaryRoute } from './chat-engine-types'
import { rawErrorMessage } from './chat-engine-errors'
import { titleAttemptsFromDriver } from './chat-engine-message-text'
import { TRANSFER_SETTLE_POLL_MS, TRANSFER_SETTLE_TIMEOUT_MS } from './chat-engine-constants'
import type { ChatEngine } from '../chat-engine'

/** ChatEngine threads-title: one concern, moved verbatim from the composition root. */
export class ChatEngineThreadsTitle {
  constructor(private readonly host: ChatEngine) {}

  /** Install the cross-instance preflight that frees a settled Codex writer. */
  attachThreadTransferPreflight(
    preflight: (projectId: string, threadId: string) => Promise<ThreadTransferResult>
  ): () => void {
    this.host.state.threadTransferPreflight = preflight
    return () => {
      if (this.host.state.threadTransferPreflight === preflight)
        this.host.state.threadTransferPreflight = null
    }
  }

  /**
   * Request a one-shot model-generated title for a fresh thread. The fallback
   * title is applied in `sendPrompt()` before the main prompt is dispatched so
   * the sidebar updates instantly. This method only replaces the fallback when
   * the model succeeds, and never overwrites a manual title.
   *
   * The title generation is non-blocking   `generateTitleWithModel` returns a
   * Promise that resolves asynchronously via the event loop when the harness
   * session goes idle, so even a slow model cannot stall the main prompt.
   */
  async autoTitleThread(
    projectId: string,
    threadId: string,
    driverId: string,
    settings: ThreadSettings,
    text: string,
    parentTurnId: string,
    parentSessionId?: string,
    projectPathOverride?: string
  ): Promise<void> {
    const thread = await this.host.threadManager.getThread(projectId, threadId)
    if (!thread || thread.titleSource === 'manual' || isAssistantSetupThread(thread)) return
    // The first-message fallback is already visible, and it must never be the
    // only title a thread gets. An auxiliary assignment is a preference, not a
    // precondition: `generateTitleWithModel` tries the assigned model first and
    // falls back to the harness's own cheap model, so an unassigned app still
    // refines the fallback instead of keeping a truncated first line forever.
    Logger.dev('Thread auto-title generation started', { projectId, threadId, driverId })

    let generated: string | null
    try {
      generated = await this.generateTitleWithModel(
        projectId,
        threadId,
        driverId,
        settings,
        text,
        parentTurnId,
        parentSessionId,
        projectPathOverride
      )
    } catch (error) {
      // The fallback is already applied in sendPrompt(); silently keep it.
      Logger.dev('Thread auto-title generation failed   keeping fallback', {
        projectId,
        threadId,
        driverId,
        error: rawErrorMessage(error)
      })
      return
    }
    if (!generated) {
      Logger.dev('Thread auto-title generation returned no usable title', {
        projectId,
        threadId,
        driverId
      })
      return
    }

    // The user may have renamed the thread while the model was working
    // never overwrite a manual title.
    const latest = await this.host.threadManager.getThread(projectId, threadId)
    if (!latest || latest.titleSource === 'manual') return
    const updated = await this.host.threadManager.updateThread(projectId, threadId, {
      title: generated,
      titleSource: 'auto'
    })
    if (updated) broadcastThreadUpdate(updated)
    Logger.dev('Thread auto-title generation applied', { projectId, threadId, driverId })
  }

  /** Delegate one-shot title generation and model fallback to the selected driver. */
  async generateTitleWithModel(
    projectId: string,
    threadId: string,
    driverId: string,
    settings: ThreadSettings,
    text: string,
    parentTurnId: string,
    parentSessionId?: string,
    projectPathOverride?: string
  ): Promise<string | null> {
    // A user-assigned auxiliary model wins over the harness's own cheap-model
    // preference and may belong to a different harness, so titling a thread no
    // longer has to start a second server of the same harness. Only when that
    // model produces no usable title does the thread's own model take over.
    const auxiliary = await this.host.units['turns'].resolveAuxiliaryRoute({
      projectId,
      threadId,
      threadHarnessId: driverId,
      ...(projectPathOverride ? { projectPath: projectPathOverride } : {})
    })
    if (auxiliary) {
      const auxiliaryTitle = await this.generateTitleOnAuxiliaryRoute(
        auxiliary,
        text,
        threadId,
        parentTurnId
      )
      if (auxiliaryTitle) return auxiliaryTitle
    }
    const { driver, projectPath } = projectPathOverride
      ? {
          driver: await this.host.driverForAccount(driverId, settings.accountId),
          projectPath: projectPathOverride
        }
      : await this.host.resolve(projectId, driverId, threadId, settings.accountId)
    let generated: string | null = null
    let failure: string | null = null
    try {
      generated = await driver.generateTitle(projectPath, {
        settings,
        message: text,
        ...(parentSessionId ? { parentSessionId } : {})
      })
      return generated
    } catch (error) {
      failure = rawErrorMessage(error)
      throw error
    } finally {
      const inputTokens = estimateTokens(text)
      const outputTokens = estimateTokens(generated ?? '')
      this.host.state.memoryService.recordAuxiliaryUsage('title', inputTokens, text.length, {
        outputTokens,
        costUsd: null,
        costStatus: 'unavailable'
      })
      const attempts = titleAttemptsFromDriver(driver)
      this.recordTitleAttemptRows({
        attempts,
        idPrefix: '',
        harnessId: driverId,
        providerId: settings.providerId,
        modelId: settings.modelId,
        threadId,
        parentTurnId,
        inputTokens,
        outputTokens,
        success: generated !== null && failure === null,
        failure
      })
    }
  }

  /**
   * Run one title attempt on the user-assigned auxiliary model. Every failure
   * returns null so the caller falls back to the thread's own model; the
   * attempt is still recorded in the usage ledger either way.
   */
  async generateTitleOnAuxiliaryRoute(
    route: AuxiliaryRoute,
    text: string,
    threadId: string,
    parentTurnId: string
  ): Promise<string | null> {
    let generated: string | null = null
    let failure: string | null = null
    try {
      generated = await route.driver.generateTitle(route.projectPath, {
        settings: route.settings,
        message: text,
        candidates: route.candidates
      })
      if (!generated) failure = 'No usable title produced'
      return generated
    } catch (error) {
      failure = rawErrorMessage(error)
      Logger.dev('Auxiliary agent could not title the thread; using the thread model:', {
        auxiliaryHarnessId: route.harnessId,
        auxiliaryModelId: route.modelId,
        error: failure
      })
      return null
    } finally {
      const inputTokens = estimateTokens(text)
      const outputTokens = estimateTokens(generated ?? '')
      this.host.state.memoryService.recordAuxiliaryUsage('title', inputTokens, text.length, {
        outputTokens,
        costUsd: null,
        costStatus: 'unavailable'
      })
      this.recordTitleAttemptRows({
        attempts: titleAttemptsFromDriver(route.driver),
        idPrefix: 'aux',
        harnessId: route.harnessId,
        providerId: route.providerId,
        modelId: route.modelId,
        threadId,
        parentTurnId,
        inputTokens,
        outputTokens,
        success: generated !== null && failure === null,
        failure
      })
    }
  }

  /**
   * Record the title run in the event-level usage ledger, one row per candidate
   * attempt. The auxiliary route prefixes its ids so an auxiliary attempt and
   * the thread-model fallback that followed it stay distinct rows.
   */
  recordTitleAttemptRows(target: {
    attempts: readonly TitleAttemptAccounting[]
    idPrefix: string
    harnessId: string
    providerId: string
    modelId: string
    threadId: string
    parentTurnId: string
    inputTokens: number
    outputTokens: number
    success: boolean
    failure: string | null
  }): void {
    const {
      attempts,
      idPrefix,
      harnessId,
      providerId,
      modelId,
      threadId,
      parentTurnId,
      inputTokens,
      outputTokens,
      success,
      failure
    } = target
    if (attempts.length > 0) {
      for (const attempt of attempts) {
        const tokens = attempt.usage?.tokens
        const reportedCost = attempt.usage?.cost
        const pricingProvenance = attempt.usage?.costProvenance
        const hasKnownCost = reportedCost !== undefined && pricingProvenance !== undefined
        this.host.state.usageRepo.recordEvent({
          id: idPrefix
            ? `title:${parentTurnId}:${idPrefix}:${attempt.attempt}`
            : `title:${parentTurnId}:${attempt.attempt}`,
          threadId,
          parentTurnId,
          featureCallId: `auto-title:${attempt.providerId}:${attempt.modelId}`,
          attempt: attempt.attempt,
          feature: 'title',
          harnessId,
          providerId: attempt.providerId,
          modelId: attempt.modelId,
          thinkingLevel: 'minimal',
          utilityId: null,
          rawProviderUsage: tokens ? { ...tokens } : {},
          tokens: {
            uncachedInput: tokens?.input ?? null,
            cachedInput: tokens?.cacheRead ?? null,
            cacheWrite: tokens?.cacheWrite ?? null,
            output: tokens?.output ?? null,
            reasoning: tokens?.reasoning ?? null
          },
          rawTotal: tokens?.total ?? null,
          totalSemantics: tokens ? 'provider_defined' : 'unavailable',
          toolFeeUsd: null,
          success: attempt.success,
          retryCause: attempt.fallbackReason,
          durationMs: attempt.usage?.durationMs ?? 0,
          createdAt: Date.now(),
          ...(hasKnownCost
            ? {
                costStatus: 'known' as const,
                costUsd: reportedCost,
                pricingProvenance
              }
            : {
                costStatus: 'unavailable' as const,
                costUsd: null,
                pricingProvenance: null
              })
        })
      }
      return
    }
    this.host.state.usageRepo.recordEvent({
      id: idPrefix ? `title:${parentTurnId}:${idPrefix}` : `title:${parentTurnId}`,
      threadId,
      parentTurnId,
      featureCallId: 'auto-title',
      attempt: 1,
      feature: 'title',
      harnessId,
      providerId,
      modelId,
      thinkingLevel: 'minimal',
      utilityId: null,
      rawProviderUsage: {},
      tokens: {
        uncachedInput: inputTokens,
        cachedInput: null,
        cacheWrite: null,
        output: outputTokens,
        reasoning: null
      },
      rawTotal: null,
      totalSemantics: 'unavailable',
      toolFeeUsd: null,
      success,
      retryCause: failure,
      durationMs: 0,
      createdAt: Date.now(),
      costStatus: 'unavailable',
      costUsd: null,
      pricingProvenance: null
    })
  }

  /**
   * Stop this process's run for a thread another instance asked to take over.
   *
   * Nothing here is inferred: the shared `active_turns` ledger already names
   * this process as the owner, so the release is a deliberate stop (the same
   * teardown a user Stop performs, minus the user-stop latch) followed by a
   * deterministic settle of the turn. The turn must be fully settled before the
   * caller acks, because the adopting instance writes its own ledger row the
   * moment it resumes   a late settle event from this process would delete it.
   */
  async releaseThreadForTransfer(
    projectId: string,
    threadId: string
  ): Promise<ThreadTransferRelease> {
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    const thread = await this.host.threadManager.getThread(projectId, threadId)
    if (!thread) return { released: false, reason: 'The thread no longer exists.' }
    // A coordinated workflow moves as one unit, so a release for any of its
    // threads is a release for the whole group.
    const coordinatorThreadId = await this.host.units['assignment'].workflowCoordinatorFor(
      projectId,
      thread
    )
    if (coordinatorThreadId !== null) {
      return this.host.releaseWorkflowForTransfer(projectId, coordinatorThreadId)
    }
    // The workers running under this thread die with the process that hosts
    // them, and once they are settled the shared database can no longer say
    // whether they finished or were stopped by this move. Read the roster before
    // anything is stopped, and hand it to the adopting instance with the release.
    const workers = await this.host.units['assignment-workers'].runningWorkersOf(
      projectId,
      threadId
    )
    const ownerPid = await this.host.checkpointManager.activeTurnOwnerPid(projectId, threadId)
    // A pawn agent runs on a thread of its own, so this thread's own turn can be
    // idle while a pawn it spawned is still working here.
    const pawns = await this.host.units['assignment-workers'].runningPawnThreads(
      projectId,
      threadId
    )
    if (ownerPid !== process.pid && pawns.length === 0) {
      return { released: false, reason: 'This instance is no longer running that thread.' }
    }
    if (ownerPid === process.pid) {
      if (!thread.sessionId || !thread.settings) {
        return { released: false, reason: 'This thread has no resumable session to transfer.' }
      }
      const driverId =
        this.host.sessionRegistry.get(thread.sessionId)?.driverId ??
        thread.sessionHarnessId ??
        thread.settings.harnessId
      const accountId =
        this.host.sessionRegistry.get(thread.sessionId)?.accountId ?? thread.sessionAccountId
      // A Codex app-server can only be handed over once its thread's own turn has
      // stopped, so the run is stopped first and the writer released second. Ask
      // whether that release can succeed before anything is stopped: a refusal
      // that arrived afterwards would cost the user a run this instance can no
      // longer hand over and never restarts.
      let writer: { driver: HarnessDriver; projectPath: string } | null = null
      if (driverId === 'codex') {
        const resolved = await this.host.resolve(projectId, driverId, threadId, accountId)
        const probe = await resolved.driver.canHandOffIdleSession?.(
          resolved.projectPath,
          thread.sessionId
        )
        if (probe?.blocked) return { released: false, reason: probe.reason }
        if (resolved.driver.releaseIdleSessionForTransfer) writer = resolved
      }
      await this.host.abort(projectId, threadId, { reason: 'transfer' })
      await this.settleThreadTurnForTransfer(projectId, threadId)
      instanceRegistry.publishTurnActivity()
      if (writer) {
        // The run is already stopped at this point, so a driver that throws here
        // must not strand it: turn the failure into the same refusal path a
        // delivered refusal uses, which puts the run back on this instance.
        let refusal: string | null = null
        try {
          const writerRelease = await writer.driver.releaseIdleSessionForTransfer?.(
            writer.projectPath,
            thread.sessionId
          )
          if (writerRelease?.owner && !writerRelease.released) {
            refusal = writerRelease.reason ?? 'The Codex writer is still held by this instance.'
          }
        } catch (error) {
          Logger.error('The Codex writer could not be released for a thread transfer:', {
            projectId,
            threadId,
            error: rawErrorMessage(error)
          })
          refusal = 'This Codex session is no longer available to hand over.'
        }
        if (refusal !== null)
          return await this.host.units['runtime-connectivity'].resumeRunAfterRefusedHandOff(
            thread,
            refusal
          )
      }
    }
    // A pawn thread really does move: it is a thread of its own, so stopping its
    // run here lets the adopting instance continue the same persisted session.
    // Leaving it running would strand work under a parent that has already left.
    const pawnThreadIds: string[] = []
    for (const pawn of pawns) {
      await this.host.abort(projectId, pawn.id, { reason: 'transfer' })
      await this.settleThreadTurnForTransfer(projectId, pawn.id)
      pawnThreadIds.push(pawn.id)
    }
    if (pawnThreadIds.length > 0) instanceRegistry.publishTurnActivity()
    return {
      released: true,
      ...(workers.length > 0 ? { workers } : {}),
      ...(pawnThreadIds.length > 0 ? { pawnThreadIds } : {})
    }
  }

  /**
   * Release this process's idle Codex app-server when a sibling is about to
   * resume one of its native threads. The app-server is shared by project path,
   * so only an entirely idle host can be stopped without interrupting another
   * conversation.
   */
  async releaseIdleCodexThreadForTransfer(
    projectId: string,
    threadId: string
  ): Promise<{ owner: boolean; released: boolean; reason?: string }> {
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    const thread = await this.host.threadManager.getThread(projectId, threadId)
    if (!thread?.sessionId || !thread.settings) {
      return { owner: false, released: false }
    }
    const driverId =
      this.host.sessionRegistry.get(thread.sessionId)?.driverId ??
      thread.sessionHarnessId ??
      thread.settings.harnessId
    if (driverId !== 'codex') return { owner: false, released: false }
    if ((await this.host.units['assignment'].workflowCoordinatorFor(projectId, thread)) !== null) {
      return { owner: false, released: false }
    }
    const activeOwnerPid = await this.host.checkpointManager.activeTurnOwnerPid(projectId, threadId)
    if (activeOwnerPid !== null) {
      return {
        owner: true,
        released: false,
        reason: 'This Codex thread still has an active turn.'
      }
    }
    const accountId =
      this.host.sessionRegistry.get(thread.sessionId)?.accountId ?? thread.sessionAccountId
    const { driver, projectPath } = await this.host.resolve(
      projectId,
      driverId,
      threadId,
      accountId
    )
    if (!driver.releaseIdleSessionForTransfer) return { owner: false, released: false }
    try {
      return await driver.releaseIdleSessionForTransfer(projectPath, thread.sessionId)
    } catch (error) {
      // This preflight only clears an idle writer out of a peer's way before a
      // prompt. A session this process cannot even read holds no writer it can
      // act on, so the prompt is free to continue here rather than fail on a
      // hand-off this instance has nothing to hand over.
      Logger.error('An idle Codex thread could not be released for a prompt:', {
        projectId,
        threadId,
        error: rawErrorMessage(error)
      })
      return { owner: false, released: false }
    }
  }

  /**
   * Hand a coordinated workflow to a sibling instance, as one unit.
   *
   * The Sr. Engineer and its workers are never split across instances, so a
   * release stops and settles every member this process is running, then drops
   * the workflow's ownership row so the adopter can claim the whole group. The
   * row goes last, because it is what tells a peer the workflow is still owned
   * here.
   */
  async releaseWorkflowForTransfer(
    projectId: string,
    coordinatorThreadId: string
  ): Promise<{ released: boolean; reason?: string }> {
    projectId = validateEntityId(projectId, 'Project ID')
    coordinatorThreadId = validateEntityId(coordinatorThreadId, 'Coordinator Thread ID')
    const coordinator = await this.host.threadManager.getThread(projectId, coordinatorThreadId)
    if (!coordinator || !isWorkflowCoordinatorThread(coordinator)) {
      return { released: false, reason: 'This thread is not the Sr. Engineer of a workflow.' }
    }
    const group = await this.host.units['runtime-workflows'].workflowGroup(
      projectId,
      coordinatorThreadId
    )
    if (
      !(await this.host.units['runtime-workflows'].ownsWorkflow(
        projectId,
        coordinatorThreadId,
        group
      ))
    ) {
      return { released: false, reason: 'This instance is no longer running that workflow.' }
    }
    for (const member of group) {
      const ownerPid = await this.host.checkpointManager.activeTurnOwnerPid(projectId, member.id)
      if (ownerPid !== process.pid) continue
      await this.host.abort(projectId, member.id, { reason: 'transfer' })
      await this.settleThreadTurnForTransfer(projectId, member.id)
    }
    await this.host.state.workflowOwnership.release(projectId, coordinatorThreadId)
    instanceRegistry.publishTurnActivity()
    return { released: true }
  }

  /**
   * Resume a thread whose run just arrived from another instance.
   *
   * The departing instance already stopped its harness and settled the turn, so
   * this process continues the persisted session exactly as restart recovery
   * would, with the busy probe and stop latch bypassed because the hand-off is
   * explicit and this process cannot see the sibling's harness.
   */
  async adoptTransferredThread(
    projectId: string,
    threadId: string,
    released?: HandoffReleaseDetails
  ): Promise<ThreadTransferResult> {
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    const thread = await this.host.threadManager.getThread(projectId, threadId)
    if (!thread) return { ok: false, reason: 'The thread no longer exists.' }
    // A coordinated workflow is adopted as one unit, never thread by thread.
    const coordinatorThreadId = await this.host.units['assignment'].workflowCoordinatorFor(
      projectId,
      thread
    )
    if (coordinatorThreadId !== null) {
      return this.host.adoptTransferredWorkflow(projectId, coordinatorThreadId)
    }
    if (!thread.sessionId || !thread.settings) {
      return { ok: false, reason: 'This thread has no resumable session.' }
    }
    // The workers the departure had to stop cannot be resumed anywhere: they
    // were sessions inside the process that has just released the thread. What
    // the agent returning here must not do is read its own interrupted trace as
    // a pile of failures, so the continuation names them.
    const note = handedOffWorkersNote(released?.workers ?? [], {
      pawnsResumed: (released?.pawnThreadIds?.length ?? 0) > 0
    })
    try {
      let resumed = await this.host.units['thread-lifecycle'].resumeThreadFromPersistedSession(
        thread,
        {
          force: true,
          ...(note ? { note } : {})
        }
      )
      if (!resumed && thread.settings.loopMode === true) {
        // An Achievement loop resumes through its own driver, not a plain
        // Continue; mirror the loop branch restart recovery uses.
        const activeSpec = await this.host.units['spec'].getActiveSpec(projectId, threadId)
        if (activeSpec?.status === 'approved') {
          void this.host.units['misc'].continueLoop(projectId, threadId)
          resumed = true
        }
      }
      if (!resumed) {
        return { ok: false, reason: 'This thread cannot be resumed on this instance.' }
      }
      await this.host.units['assignment-workers'].resumeTransferredPawns(
        projectId,
        threadId,
        released?.pawnThreadIds ?? []
      )
      instanceRegistry.publishTurnActivity()
      return { ok: true }
    } catch (error) {
      Logger.error('Transferred thread resume failed:', {
        projectId,
        threadId,
        error: rawErrorMessage(error)
      })
      return {
        ok: false,
        reason: `The transfer could not resume this run: ${rawErrorMessage(error)}`
      }
    }
  }

  /**
   * Take a transferred workflow over on this instance.
   *
   * The departing instance stopped every member's run and released the
   * workflow's ownership row, so this process claims the group and resumes it
   * through the same path restart recovery uses. A workflow waiting on a user
   * gate starts no turn, and that is still a successful transfer: the whole group
   * now belongs here.
   */
  async adoptTransferredWorkflow(
    projectId: string,
    coordinatorThreadId: string
  ): Promise<ThreadTransferResult> {
    projectId = validateEntityId(projectId, 'Project ID')
    coordinatorThreadId = validateEntityId(coordinatorThreadId, 'Coordinator Thread ID')
    const coordinator = await this.host.threadManager.getThread(projectId, coordinatorThreadId)
    if (!coordinator) return { ok: false, reason: 'The workflow no longer exists.' }
    await this.host.state.workflowOwnership.claim(projectId, coordinatorThreadId)
    try {
      const group = await this.host.units['runtime-workflows'].workflowGroup(
        projectId,
        coordinatorThreadId
      )
      await this.host.units['runtime-connectivity'].resumePendingWorkflow(coordinator, group)
      instanceRegistry.publishTurnActivity()
      return { ok: true }
    } catch (error) {
      Logger.error('Transferred workflow resume failed:', {
        projectId,
        coordinatorThreadId,
        error: rawErrorMessage(error)
      })
      return {
        ok: false,
        reason: `The transfer could not resume this workflow: ${rawErrorMessage(error)}`
      }
    }
  }

  /**
   * What a transfer request for `threadId` actually moves, and which process owns
   * it right now.
   *
   * A coordinated workflow moves as a whole, so the target is its coordinator and
   * the owner is whoever holds the workflow: the durable ownership row first,
   * then an in-flight turn on any member. Everything else transfers on its own
   * thread, exactly as before.
   */
  async resolveTransferTarget(
    projectId: string,
    threadId: string
  ): Promise<{ rootThreadId: string; ownerPid: number | null }> {
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    const thread = await this.host.threadManager.getThread(projectId, threadId)
    if (!thread) return { rootThreadId: threadId, ownerPid: null }
    const coordinatorThreadId = await this.host.units['assignment'].workflowCoordinatorFor(
      projectId,
      thread
    )
    if (coordinatorThreadId === null) {
      const ownerPid = await this.host.checkpointManager.activeTurnOwnerPid(projectId, threadId)
      if (ownerPid !== null) return { rootThreadId: threadId, ownerPid }
      // The thread's own turn can be idle while a pawn it spawned still works:
      // a pawn is a thread of its own, and it moves with the primary, so while
      // one runs under a sibling instance this thread is still foreign.
      for (const pawn of await this.host.units['assignment-workers'].pawnThreadsOf(
        projectId,
        threadId
      )) {
        const pawnOwner = await this.host.checkpointManager.activeTurnOwnerPid(projectId, pawn.id)
        if (pawnOwner !== null) return { rootThreadId: threadId, ownerPid: pawnOwner }
      }
      return { rootThreadId: threadId, ownerPid: null }
    }
    const claimOwner = await this.host.state.workflowOwnership.ownerPid(
      projectId,
      coordinatorThreadId
    )
    return {
      rootThreadId: coordinatorThreadId,
      ownerPid:
        claimOwner ??
        (await this.host.units['turns'].workflowActiveTurnOwner(projectId, coordinatorThreadId))
    }
  }

  /**
   * Wait for the aborted turn to release the shared ledger row, forcing the
   * release if the harness never reported its terminal settle, then detach this
   * process's turn bookkeeping so no late event can touch the row again.
   */
  async settleThreadTurnForTransfer(projectId: string, threadId: string): Promise<void> {
    const deadline = Date.now() + TRANSFER_SETTLE_TIMEOUT_MS
    while (Date.now() < deadline) {
      if ((await this.host.checkpointManager.activeTurnOwnerPid(projectId, threadId)) === null)
        break
      await new Promise((resolve) => setTimeout(resolve, TRANSFER_SETTLE_POLL_MS))
    }
    await this.host.checkpointManager.markActiveInterrupted(projectId, threadId)
    this.host.units['thread-lifecycle'].detachThreadTurnBookkeeping(projectId, threadId)
  }

  /**
   * In-progress file changes for the thread's running turn, so the Changes tab
   * can surface edits before the turn completes. Nothing is persisted: the
   * summary stats the turn's claimed paths against the active checkpoint's
   * opening snapshot. Returns null when no turn is running or nothing has been
   * observed to change yet.
   */
  async activeTurnChangeSummary(
    projectId: string,
    threadId: string
  ): Promise<TurnCheckpointSummary | null> {
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    const session = [...this.host.sessionRegistry.values()].find(
      (candidate) =>
        candidate.projectId === projectId &&
        candidate.threadId === threadId &&
        candidate.activeTurnId &&
        (candidate.changedPaths?.size ?? 0) > 0
    )
    if (!session?.activeTurnId) return null
    const checkpoint = await this.host.checkpointManager.getActive(projectId, threadId)
    if (!checkpoint) return null
    const userTouched = session.userTouchedPaths

    // Scanner: validate that each claimed path actually changed from the turn's
    // opening snapshot (before) to current disk. Steer does not reset the
    // window   it stays [checkpoint.before.createdAt, now]. Foreign filtering
    // mirrors completeTurn so a fork never claims a file it didn't touch.
    const MAX_LIVE_PATHS = 200
    const changedPaths = session.changedPaths ?? new Set<string>()
    const rawPaths = [...changedPaths].sort().slice(0, MAX_LIVE_PATHS)
    const ownThreadIds = await this.host.units['thread-lifecycle'].selfFamilyThreadIds(
      projectId,
      threadId
    )
    const activeTurnThreadIds = await this.host.checkpointManager
      .activeTurnThreadIds(projectId)
      .catch(() => undefined)
    const foreign = await this.host.checkpointManager.foreignClaimedPathsForLive(
      checkpoint,
      this.host.units['runtime-connectivity'].liveForeignClaimedPaths(
        session,
        ownThreadIds,
        activeTurnThreadIds
      ),
      ownThreadIds
    )
    const precise = session.preciseChangedPaths ?? new Map<string, number>()
    /** This turn recorded a write source for the path (tool target or shell window). */
    const ownedSource = (path: string): boolean =>
      (session.changeSources?.get(path)?.length ?? 0) > 0
    // Batched, bounded scanning: stat + hash only claimed paths, 8 at a time,
    // so low-end hardware is never hammered.
    const BATCH = 8
    const changes: TurnCheckpointChangeSummary[] = []
    const isBinaryByStat = (buf: Uint8Array): boolean => {
      // Keep live binary detection cheap: reuse the same heuristic as the
      // change-tracking service (null byte).
      for (let i = 0; i < Math.min(buf.length, 8000); i++) if (buf[i] === 0) return true
      return false
    }
    for (let i = 0; i < rawPaths.length; i += BATCH) {
      const batch = rawPaths.slice(i, i + BATCH)
      const results = await Promise.all(
        batch.map(async (path) => {
          // Foreign dedup, strongest evidence first. Another turn's file tool
          // beats everything but this turn's own precise claim. Another turn's
          // shell window only watched the file move, so this turn's own recorded
          // write evidence outranks it. A live claim is current by construction
          // (the other thread's claims reset per turn), so its timestamp is never
          // compared to the turn start.
          if (foreign.claimed.has(path) && !precise.has(path)) return null
          if (foreign.window.has(path) && !precise.has(path) && !ownedSource(path)) return null
          // The user's own in-app editor saves are never the thread's changes.
          if (userTouched?.has(path)) return null
          const before = checkpoint.before.files[path]
          const abs = join(checkpoint.before.projectRoot, path)
          let afterBuf: Uint8Array
          try {
            afterBuf = await readFile(abs)
          } catch (error) {
            if (!(
              error instanceof Error &&
              'code' in error &&
              (error as NodeJS.ErrnoException).code === 'ENOENT'
            ))
              return null
            if (!before) return null
            return {
              path,
              kind: 'deleted' as const,
              binary: false,
              beforeSize: before.size
            } satisfies TurnCheckpointChangeSummary
          }
          if (!before) {
            return {
              path,
              kind: 'created' as const,
              binary: isBinaryByStat(afterBuf),
              afterSize: afterBuf.length
            } satisfies TurnCheckpointChangeSummary
          }
          // Modified only if hash differs   size alone is not enough.
          const afterHash = createHash('sha256').update(afterBuf).digest('hex')
          if (afterHash === before.hash) return null
          return {
            path,
            kind: 'modified' as const,
            binary: isBinaryByStat(afterBuf),
            beforeSize: before.size,
            afterSize: afterBuf.length
          } satisfies TurnCheckpointChangeSummary
        })
      )
      for (const r of results)
        if (r) changes.push({ ...r, sources: session.changeSources?.get(r.path) })
    }
    if (changes.length === 0) return null
    // Keep deterministic ordering
    changes.sort((a, b) => a.path.localeCompare(b.path))
    return {
      id: checkpoint.id,
      projectId,
      threadId,
      label: checkpoint.label,
      status: 'active',
      changes,
      createdAt: checkpoint.createdAt
    }
  }
}
