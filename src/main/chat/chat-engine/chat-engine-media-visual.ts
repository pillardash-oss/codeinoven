import { validateModelRuntimeSettings } from '../../../lib/model-runtime-settings'
import { join, resolve } from 'path'
import { Logger } from '../../system/logger'
import { supportsIsolatedSessions } from '../../drivers/isolated-session'
import {
  currentHarnessVersion,
  episodeFromPieces,
  tokenUsageAttribution
} from '../token-usage-attribution'
import { leanAgentNameForMode } from '../../opencode/opencode-agent-definitions'
import { validateBoundedString, validateEntityId } from '../../ipc/ipc-validation'
import type { SendPromptOptions } from '../../drivers/driver.interface'
import { isCioDesignRequest, type DesignSessionMode } from '../../utilities/cio-design-prompt'
import { isCioVideoRequest, type VideoSessionMode } from '../../utilities/cio-video-prompt'
import type { AuthoredWorkKind } from '../../../lib/ipc/design'
import { NativeProviderConfigService } from '../../agents/native-provider-config-service'
import type {
  DesignCapabilityExecutor,
  VideoCapabilityExecutor
} from '../../utilities/utility-orchestration-service'
import {
  IMAGE_DESCRIPTOR_PROMPT,
  imageDescriptorInactivityTimeoutMs,
  resolveVisionAttachment
} from '../../providers/image-descriptor-provider'
import type {
  ImageDescriptorExecutorRequest,
  ImageDescriptorResult,
  ResolvedImageEntry
} from '../../providers/image-descriptor-provider'
import {
  IMAGE_DESCRIPTOR_BATCH_OUTPUT_SCHEMA,
  imageDescriptorBatchCapability,
  imageDescriptorBatchPrompt,
  runImageDescriptorBatch
} from '../../services/image-descriptor'
import type { ImageDescriptorBatchRun } from '../../services/image-descriptor'
import type {
  AgentMessage,
  AgentModelSelection,
  AgentPart,
  AgentProviderIssueKind,
  ImageDescriptorErrorRequest,
  ImageDescriptorReplyAction,
  PromptAttachment,
  ThreadStatus,
  Thread,
  ThreadSettings
} from '../../../lib/types'
import { classifyProviderIssue } from '../../../lib/provider-issue'
import { generateId } from '../../../lib/utils'
import { messageId as createMessageId } from '../../../lib/id'
import type {
  ImageDescriptorUserDecision,
  PendingImageDescriptorDecision
} from './chat-engine-types'
import { ImageDescriptorInactivityError, rawErrorMessage } from './chat-engine-errors'
import { IMAGE_DESCRIPTOR_DECISION_TIMEOUT_MS, traceLeanAgent } from './chat-engine-constants'
import { isSameImageDescriptorModel, parseBatchedDescriptorJson } from './chat-engine-images'
import {
  buildImageDescriptorReplacement,
  imageDescriptorFailureMessage,
  imageDescriptorFailureResults
} from './chat-engine-pure'
import type { ChatEngine } from '../chat-engine'

/** ChatEngine media-visual: one concern, moved verbatim from the composition root. */
export class ChatEngineMediaVisual {
  constructor(private readonly host: ChatEngine) {}

  /**
   * Register the executor behind the app-owned design capability's `preview`
   * operation. The chat engine owns the turn's project and thread, so it is the
   * app surface that hands the executor those two ids.
   */
  setDesignPreviewExecutor(executor: DesignCapabilityExecutor | null): void {
    this.host.state.utilityOrchestration.setDesignPreviewExecutor(executor)
  }

  /**
   * Register the executor behind the design capability's `save-media`
   * operation. It needs the database rather than the chat engine's own state,
   * because the one thing it resolves is the project root the file lands in.
   */
  setDesignMediaExecutor(executor: DesignCapabilityExecutor | null): void {
    this.host.state.utilityOrchestration.setDesignMediaExecutor(executor)
  }

  /**
   * Register the executor behind the `generate` operation the design and video
   * capabilities share. It needs the database for the project root, the live
   * config for the craft's model, and the vault for the provider token, all of
   * which the app owns rather than the turn.
   */
  setMediaGenerationExecutor(executor: DesignCapabilityExecutor | null): void {
    this.host.state.utilityOrchestration.setMediaGenerationExecutor(executor)
  }

  /**
   * Register the executor behind the app-owned video capability's `preview`
   * operation. The chat engine owns the turn's project and thread, so it is the
   * app surface that hands the executor those two ids.
   */
  setVideoPreviewExecutor(executor: VideoCapabilityExecutor | null): void {
    this.host.state.utilityOrchestration.setVideoPreviewExecutor(executor)
  }

  /**
   * Register the executor behind the video capability's `capture` operation,
   * which renders one frame and screenshots it. It needs the browser and the
   * preview server, both of which the app owns.
   */
  setVideoCaptureExecutor(executor: VideoCapabilityExecutor | null): void {
    this.host.state.utilityOrchestration.setVideoCaptureExecutor(executor)
  }

  /**
   * Whether a design session was opened in this thread, now or earlier, and
   * whether this turn is the one that opened it. The same memo-and-rescan shape
   * as the utility tag, so an edit or rollback that removes the tag takes the
   * session with it.
   *
   * The thread's row answers before the scan does, because the row is the durable
   * record of the session and it is already in hand. A session the agent opened
   * itself   it picked the capability up and the row was written then   is still
   * that thread's session, and a thread that has ever designed something keeps
   * designing: without this, both would be handed turns with no design contract
   * and no active capability, which is exactly the state a model hand-rolls the
   * markup in and never checks it.
   */
  async designSessionFor(
    projectId: string,
    threadId: string,
    requestedThisTurn: boolean,
    recordedKind?: AuthoredWorkKind
  ): Promise<DesignSessionMode> {
    if (requestedThisTurn) return 'start'
    if (this.host.state.cioDesignThreads.has(threadId)) return 'continue'
    if (recordedKind === 'design') return 'continue'
    const userMessages = await this.host.threadManager.loadUserMessages(projectId, threadId)
    const opened = userMessages.some((message) => isCioDesignRequest(message.content))
    if (opened) this.host.state.cioDesignThreads.set(threadId, true)
    return opened ? 'continue' : 'off'
  }

  /**
   * Whether a video session was opened in this thread, now or earlier, and
   * whether this turn is the one that opened it. The same memo-and-rescan shape
   * as the design tag, and the same durable record behind it: the row answers
   * first, so a composition the agent started on its own keeps its session.
   */
  async videoSessionFor(
    projectId: string,
    threadId: string,
    requestedThisTurn: boolean,
    recordedKind?: AuthoredWorkKind
  ): Promise<VideoSessionMode> {
    if (requestedThisTurn) return 'start'
    if (this.host.state.cioVideoThreads.has(threadId)) return 'continue'
    if (recordedKind === 'video') return 'continue'
    const userMessages = await this.host.threadManager.loadUserMessages(projectId, threadId)
    const opened = userMessages.some((message) => isCioVideoRequest(message.content))
    if (opened) this.host.state.cioVideoThreads.set(threadId, true)
    return opened ? 'continue' : 'off'
  }

  /**
   * Run the image descriptor agent: resolve the thread's (or global) vision
   * model selection and describe every requested image. Compatible multi-image
   * requests run as one structured vision call attributed to the parent turn
   * through a single feature call id; incompatible or oversized requests fall
   * back to one safe per-image call, and a failed batch vision call degrades to
   * the per-image path so no image is ever dropped or mislabeled.
   */
  async executeImageDescriptor(
    request: ImageDescriptorExecutorRequest
  ): Promise<ImageDescriptorResult[]> {
    try {
      return await this.runImageDescriptor(request)
    } catch (error) {
      // A failed descriptor must never stop the thread's work. The sendPrompt
      // and steerPrompt flows call describePromptAttachments before dispatch
      // inside a try/catch that marks the thread 'failed'; escaping here would
      // kill the whole turn just because the vision model could not describe
      // an image. Degrade to per-image error results so the (text-only) model
      // receives an explicit note instead of the thread dying.
      Logger.error('Image descriptor failed; continuing the thread without image descriptions', {
        projectId: request.projectId,
        threadId: request.threadId,
        error: error instanceof Error ? (error.stack ?? error.message) : String(error)
      })
      // A decision prompt (or another early step) may have cleared the parent
      // session's watchdog before failing; always re-arm it so the real turn
      // stays guarded after the descriptor degrades and returns.
      this.host.units['lifecycle'].startSessionWatchdog(request.sessionId)
      return imageDescriptorFailureResults(
        request,
        rawErrorMessage(error) || 'The vision model could not describe the attached image.'
      )
    }
  }

  async runImageDescriptor(
    request: ImageDescriptorExecutorRequest
  ): Promise<ImageDescriptorResult[]> {
    const thread = await this.host.threadManager.getThread(request.projectId, request.threadId)
    // A model that can already see images must never have a dedicated vision
    // model describe them: the provider catalog says so, or the user reported
    // it as a false positive. The check is resolved here, at executor time, so
    // it holds even when the model reached the descriptor through the gateway.
    if (
      thread?.settings &&
      !(await this.host.units['runtime-agents'].modelLacksVision(
        request.projectId,
        thread.settings
      ))
    ) {
      Logger.info('Image descriptor skipped: executing model can see images', {
        modelId: thread.settings.modelId,
        threadId: request.threadId
      })
      return request.images.map((entry) => ({
        id: entry.id,
        source: entry.source,
        type: entry.type,
        description: '',
        error:
          'You can see images yourself, so the image descriptor was not run. Inspect the image directly instead of requesting a description.'
      }))
    }
    const config = await this.host.storage.getConfig()
    // A thread-level pick (e.g. a model chosen on the error card) always wins,
    // then the utility pin, then the global default. The pin is read fresh at
    // invoke time so re-pinning mid-turn affects later descriptor calls.
    let selection =
      thread?.settings?.imageDescriptor ??
      request.pinnedSelection ??
      config.agentDefaults.imageDescriptor ??
      this.host.units['runtime-agents'].firstVisionModelFromCache(request.projectId)
    // A configured fallback vision model is tried automatically when the
    // primary fails, before the user is asked to pick another one.
    const fallback =
      thread?.settings?.imageDescriptorFallback ?? config.agentDefaults.imageDescriptorFallback
    if (!selection) {
      const decision = await this.requestImageDescriptorDecision(
        request,
        undefined,
        'A vision model is required to describe the image for this text-only model.',
        'unknown'
      )
      if (decision.action !== 'retry' || !decision.selection) {
        return imageDescriptorFailureResults(
          request,
          'No vision model was selected to describe the image.'
        )
      }
      selection = decision.selection
      await this.persistImageDescriptorSelection(request.projectId, request.threadId, selection)
    }
    // The selection is shared with the recovery path so a model chosen while
    // resolving one image is reused for the remaining images in the same run.
    const selectionRef: { current: AgentModelSelection } = { current: selection }
    this.host.units['turns-sessions'].clearSessionWatchdog(request.sessionId)
    try {
      const parentTurnId = this.host.database.get<{ id: string }>(
        `SELECT id FROM agent_messages
         WHERE thread_id = ? AND role = 'user'
         ORDER BY created_at DESC, id DESC LIMIT 1`,
        request.threadId
      )?.id
      // Try the whole request as one candidate run against the currently
      // selected model; a failed batch retries once on the fallback before
      // degrading to one safe call per image.
      const runBatch = async (): Promise<ImageDescriptorBatchRun> => {
        const currentCapability = await this.host.imageDescriptorBatchCapability(
          request,
          selectionRef.current
        )
        return runImageDescriptorBatch(
          request.images,
          currentCapability,
          (images, featureCallId) =>
            this.describeImagesOnVisionModelBatch(
              request,
              selectionRef.current,
              images,
              parentTurnId,
              featureCallId
            ),
          (image) =>
            this.describeWithImageDescriptorRecovery(
              request,
              selectionRef,
              fallback,
              image,
              parentTurnId
            )
        )
      }
      try {
        const run = await runBatch()
        return run.results
      } catch (error) {
        Logger.dev('Image descriptor batch failed; falling back to per-image calls:', error)
        // The batch call failed before producing results: retry the whole
        // batch once on the configured fallback model when one exists, then
        // degrade to the per-image recovery path which itself tries the
        // fallback and only then notifies the user.
        if (fallback && !isSameImageDescriptorModel(fallback, selectionRef.current)) {
          selectionRef.current = fallback
          try {
            const run = await runBatch()
            return run.results
          } catch (fallbackError) {
            Logger.dev(
              'Image descriptor batch failed on the fallback model; degrading to per-image calls:',
              fallbackError
            )
          }
        }
        const results: ImageDescriptorResult[] = []
        for (const image of request.images) {
          results.push(
            await this.describeWithImageDescriptorRecovery(
              request,
              selectionRef,
              fallback,
              image,
              parentTurnId
            )
          )
        }
        return results
      }
    } finally {
      this.host.units['lifecycle'].startSessionWatchdog(request.sessionId)
    }
  }

  /**
   * Describe all supplied images in one disposable harness session on the
   * vision model, requesting a single structured `{ results }` object. Returns
   * the parsed structured output (or, when structured output is unsupported,
   * the JSON parsed from the assistant's text) so the batch orchestration can
   * map it back to per-image results strictly by id. The whole batch is
   * attributed to its parent turn through the single `featureCallId`.
   */
  async describeImagesOnVisionModelBatch(
    request: ImageDescriptorExecutorRequest,
    selection: AgentModelSelection,
    images: ResolvedImageEntry[],
    parentTurnId: string | undefined,
    featureCallId: string
  ): Promise<unknown> {
    const account = await this.host.state.accountRegistry.resolveForProvider(
      selection.harnessId,
      selection.providerId,
      selection.accountId
    )
    const { driver } = await this.host.resolve(
      request.projectId,
      selection.harnessId,
      request.threadId,
      account.id
    )
    const settings: ThreadSettings = {
      harnessId: selection.harnessId,
      accountId: account.id,
      providerId: selection.providerId,
      modelId: selection.modelId,
      inferenceMode: selection.inferenceMode,
      contextWindow: selection.contextWindow,
      thinkingLevel: selection.thinkingLevel ?? 'low',
      permissionLevel: 'auto_review',
      assignmentMode: false,
      loopMode: false
    }
    const isolated = supportsIsolatedSessions(driver)
      ? await driver.createIsolatedSession(request.projectPath, 'Image description')
      : undefined
    const sessionId =
      isolated?.sessionId ?? (await driver.createSession(request.projectPath, 'Image description'))
    this.host.registerSession(
      sessionId,
      request.projectId,
      request.threadId,
      request.projectPath,
      'auto_review',
      selection.harnessId,
      undefined,
      true
    )
    const registeredBatchSession = this.host.sessionRegistry.get(sessionId)
    if (registeredBatchSession) registeredBatchSession.accountId = settings.accountId
    let response: AgentMessage | undefined
    let failure: string | null = null
    try {
      const attachments: PromptAttachment[] = []
      for (const image of images) {
        attachments.push(await resolveVisionAttachment(image))
      }
      const firstAttachment = attachments[0] ?? { mime: 'image/*' as const, url: '' }
      const timeoutMs = imageDescriptorInactivityTimeoutMs(firstAttachment, 0)
      const nextTimeoutMs = imageDescriptorInactivityTimeoutMs(firstAttachment, 1)
      const completion = this.host.units['turns-sessions'].waitForSessionCompletion(
        sessionId,
        timeoutMs,
        'Image upload or vision-model response',
        () => new ImageDescriptorInactivityError(timeoutMs, 0, nextTimeoutMs)
      )
      const prompt = imageDescriptorBatchPrompt(images)
      const requestOptions: SendPromptOptions = {
        sessionId,
        settings,
        text: prompt,
        attachments,
        readOnly: true,
        allowedTools: [],
        userMessageId: createMessageId(),
        structuredOutput: { schema: IMAGE_DESCRIPTOR_BATCH_OUTPUT_SCHEMA }
      }
      if (isolated && supportsIsolatedSessions(driver)) {
        await driver.sendPrompt(request.projectPath, requestOptions, isolated)
      } else {
        await driver.sendPrompt(request.projectPath, requestOptions)
      }
      await completion
      const messages =
        isolated && supportsIsolatedSessions(driver)
          ? await driver.loadMessages(request.projectPath, sessionId, isolated)
          : await driver.loadMessages(request.projectPath, sessionId)
      response = [...messages].reverse().find((message) => message.role === 'assistant')
      if (!response) throw new Error('The vision model returned no description')
      if (response.error) throw new Error(response.error)
      if (response.structuredOutput !== undefined) return response.structuredOutput
      const text = response.parts
        .filter((part): part is Extract<AgentPart, { type: 'text' }> => part.type === 'text')
        .map((part) => part.text)
        .join('\n')
        .trim()
      if (!text) throw new Error('The vision model returned an empty description')
      return parseBatchedDescriptorJson(text)
    } catch (error) {
      failure = rawErrorMessage(error)
      throw error
    } finally {
      if (parentTurnId) {
        this.host.units['messages-write'].recordAuxiliaryUsageEvent({
          feature: 'image_descriptor',
          threadId: request.threadId,
          parentTurnId,
          featureCallId,
          attempt: 1,
          harnessId: selection.harnessId,
          settings,
          inputText: imageDescriptorBatchPrompt(images),
          response,
          failure
        })
      }
      this.host.units['runtime-connectivity'].clearCompletionWaiter(sessionId)
      this.host.units['turns-sessions'].clearSessionWatchdog(sessionId)
      this.host.sessionRegistry.delete(sessionId)
      this.host.sessionStatuses.delete(sessionId)
      this.host.state.reasoningTimes.delete(sessionId)
      this.host.state.toolTimes.delete(sessionId)
      if (isolated && supportsIsolatedSessions(driver)) {
        driver.disposeIsolatedSession(isolated)
      } else {
        try {
          await driver.deleteSession?.(request.projectPath, sessionId)
        } catch (error) {
          Logger.dev('Image descriptor session deletion was incomplete:', error)
        }
      }
    }
  }

  /**
   * Describe one image with the vision model. When the primary vision model
   * fails, a configured fallback model is tried automatically before the user
   * is involved. If the fallback also fails (or none was configured), the
   * failure surfaces a user decision card (change model / retry / ignore)
   * instead of silently handing the error to the text-only model. The decision
   * drives the retry: a new selection is persisted to the thread, and `ignore`
   * forwards whatever partial output exists (usually nothing) plus the error so
   * the text-only model can work with it or explain what is missing.
   */
  async describeWithImageDescriptorRecovery(
    request: ImageDescriptorExecutorRequest,
    selection: { current: AgentModelSelection },
    fallback: AgentModelSelection | undefined,
    image: ResolvedImageEntry,
    parentTurnId?: string
  ): Promise<ImageDescriptorResult> {
    let next: AgentModelSelection = selection.current
    let usedFallback = false
    // The image being described can be replaced from the error card when its
    // source is missing/unreadable; the replacement keeps the original id so
    // its description still maps back to the same slot in the result set.
    let currentImage: ResolvedImageEntry = image
    // One try for the primary, one automatic try for the fallback, and one
    // try for a model (or replacement image) picked from the user decision
    // card   enough rounds to cover the configured pair without ever hanging
    // the turn in a loop.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const active = next
      // A reply to the error card briefly re-arms the parent watchdog. The
      // descriptor owns its own adaptive inactivity deadline while retrying.
      this.host.units['turns-sessions'].clearSessionWatchdog(request.sessionId)
      try {
        const description = await this.describeImageOnVisionModel(
          request.projectId,
          request.threadId,
          request.projectPath,
          active,
          currentImage,
          attempt,
          parentTurnId
        )
        return {
          id: currentImage.id,
          source: currentImage.source,
          type: currentImage.type,
          description
        }
      } catch (error) {
        const message = imageDescriptorFailureMessage(error)
        const kind: AgentProviderIssueKind =
          error instanceof ImageDescriptorInactivityError
            ? 'network'
            : classifyProviderIssue(message)
        Logger.dev('Image description failed', {
          harnessId: active.harnessId,
          providerId: active.providerId,
          modelId: active.modelId,
          error: message
        })
        const attributedMessage = `The vision model (${this.host.units[
          'runtime-agents'
        ].visionModelLabel(request.projectId, active)}) failed: ${message}`
        // Automatic fallback: switch to the configured fallback model and
        // retry silently, before interrupting the user with a decision card.
        if (!usedFallback && fallback && !isSameImageDescriptorModel(fallback, active)) {
          usedFallback = true
          next = fallback
          // Keep the shared selection on the working model so the remaining
          // images in the same run start from it; never persist it as a
          // permanent override of the user's configured primary.
          selection.current = fallback
          continue
        }
        const decision = await this.requestImageDescriptorDecision(
          request,
          active,
          attributedMessage,
          kind,
          currentImage.id
        )
        if (decision.action === 'retry') {
          if (decision.selection) {
            selection.current = decision.selection
            await this.persistImageDescriptorSelection(
              request.projectId,
              request.threadId,
              selection.current
            )
            next = decision.selection
          } else {
            next = active
          }
          continue
        }
        if (decision.action === 'pick_image') {
          // The user picked a replacement image from the error card: describe
          // it instead of the source that is missing/unreadable.
          currentImage = decision.entry
          continue
        }
        return {
          id: currentImage.id,
          source: currentImage.source,
          type: currentImage.type,
          description: '',
          error: `${attributedMessage} You chose to continue. Work with the partial description above if it is usable; otherwise tell the user what is missing and suggest how to fix it.`
        }
      }
    }
    return {
      id: currentImage.id,
      source: currentImage.source,
      type: currentImage.type,
      description: '',
      error: 'Image description failed after retry'
    }
  }

  /**
   * Surface an image-descriptor failure to the renderer and await the user's
   * decision. The gateway HTTP request stays open while the user picks, so the
   * text-only model's tool call blocks exactly like a permission prompt. On
   * timeout the decision auto-resolves as `ignore` so the turn never hangs.
   */
  async requestImageDescriptorDecision(
    request: ImageDescriptorExecutorRequest,
    selection: AgentModelSelection | undefined,
    error: string,
    kind: AgentProviderIssueKind,
    imageId?: string
  ): Promise<ImageDescriptorUserDecision> {
    const id = generateId()
    this.host.units['turns-sessions'].clearSessionWatchdog(request.sessionId)
    this.host.units['turns'].markProjectActive(request.projectId)
    const owningThread = await this.host.threadManager.getThread(
      request.projectId,
      request.threadId
    )
    const surfaceThreadId =
      owningThread?.assignmentRole === 'worker' && owningThread.coordinatorThreadId
        ? owningThread.coordinatorThreadId
        : request.threadId
    const assignment =
      owningThread?.assignmentRole === 'worker' && owningThread.coordinatorThreadId
        ? this.host.state.assignmentEngine.getActive(
            request.projectId,
            owningThread.coordinatorThreadId
          )
        : null
    const task = assignment?.content.tasks.find(
      (candidate) =>
        candidate.threadId === request.threadId || candidate.id === owningThread?.assignmentTaskId
    )
    const requestingModel = this.host.units['runtime-agents'].visionReportModel(
      owningThread?.settings
    )
    return new Promise<ImageDescriptorUserDecision>((resolve) => {
      // The card blocks the turn on user input, exactly like the question tool:
      // park the thread on "Needs attention" and restore the working status
      // once the decision resolves (reply, ignore, or timeout).
      const session = this.host.sessionRegistry.get(request.sessionId)
      const resumeStatus: Extract<ThreadStatus, 'planning' | 'executing'> =
        session?.activeTurnId || this.host.state.planningSessions.has(request.sessionId)
          ? 'executing'
          : 'planning'
      const requestForCard: ImageDescriptorErrorRequest = {
        id,
        sessionId: request.sessionId,
        projectId: request.projectId,
        threadId: request.threadId,
        surfaceThreadId,
        ...(task ? { assignmentTaskId: task.id, assignmentTaskTitle: task.title } : {}),
        ...(owningThread?.assignmentRole === 'worker' ? { workerTitle: owningThread.title } : {}),
        error,
        kind,
        selection,
        ...(imageId ? { imageId } : {}),
        ...(requestingModel ? { requestingModel } : {}),
        partialOutput: '',
        imageCount: request.images.length,
        createdAt: Date.now()
      }
      const pending: PendingImageDescriptorDecision = {
        sessionId: request.sessionId,
        projectId: request.projectId,
        threadId: request.threadId,
        request: requestForCard,
        resolve,
        resumeStatus,
        timer: setTimeout(() => {
          // The card is about to resolve itself as ignored, so record what the
          // user was offered and what the app chose on their behalf.
          this.host.units['misc'].reportAutoAnswer({
            id: requestForCard.id,
            kind: 'image-descriptor',
            outcome: 'ignored',
            projectId: request.projectId,
            // File it on the conversation the card was shown on, which is the
            // coordinator for a delegated worker, not the worker that ran.
            threadId: surfaceThreadId,
            entries: [
              {
                prompt: requestForCard.error,
                options: ['Retry', 'Pick new image', 'Ignore'],
                picked: 'Ignore'
              }
            ],
            at: Date.now()
          })
          // Never leave the card behind when this decision auto-resolves: a
          // card whose request is gone is a card the user cannot dismiss.
          this.settleImageDescriptorDecision(pending)
          this.host.units['lifecycle'].startSessionWatchdog(request.sessionId)
          void this.host.threadManager
            .setStatus(request.projectId, request.threadId, resumeStatus)
            .catch(() => undefined)
        }, IMAGE_DESCRIPTOR_DECISION_TIMEOUT_MS)
      }
      // One blocked session can only receive one answer, so a newer request
      // supersedes every older one for the same session: the older cards are
      // settled as `ignore` immediately instead of staying on screen as
      // unanswerable cards that report themselves as no longer pending.
      for (const [supersededId, superseded] of this.host.state.pendingImageDescriptorDecisions) {
        if (superseded.sessionId !== request.sessionId || supersededId === id) continue
        this.settleImageDescriptorDecision(superseded)
      }
      this.host.state.pendingImageDescriptorDecisions.set(id, pending)
      void this.host.threadManager
        .setStatus(request.projectId, request.threadId, 'awaiting_approval', { read: false })
        .catch(() => undefined)
      this.host.broadcast({
        type: 'imageDescriptor.error',
        sessionId: request.sessionId,
        projectId: request.projectId,
        threadId: surfaceThreadId,
        request: requestForCard
      })
    })
  }

  /**
   * Settle one pending image-descriptor decision as `ignore` without a user
   * reply (timeout, a newer request superseding it, or the session being
   * retired). The blocked tool call returns with partial output and the card is
   * removed in every view, so no card is ever left behind that would answer
   * itself with "no longer pending".
   */
  settleImageDescriptorDecision(pending: PendingImageDescriptorDecision): void {
    const requestId = pending.request.id
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    this.host.state.pendingImageDescriptorDecisions.delete(requestId)
    this.host.broadcast({
      type: 'imageDescriptor.resolved',
      sessionId: pending.sessionId,
      projectId: pending.projectId,
      threadId: pending.request.surfaceThreadId,
      requestId,
      action: 'ignore'
    })
    pending.resolve({ action: 'ignore' })
  }

  /** Persist the image-descriptor vision model to the thread so retries and
   *  future sends in the same thread use it. Best-effort: a missing thread
   *  (e.g. ephemeral standalone chat) simply skips persistence. */
  async persistImageDescriptorSelection(
    projectId: string,
    threadId: string,
    selection: AgentModelSelection
  ): Promise<void> {
    try {
      const thread = await this.host.threadManager.getThread(projectId, threadId)
      if (!thread?.settings) return
      await this.host.threadManager.updateSettings(projectId, threadId, {
        ...thread.settings,
        imageDescriptor: selection
      })
    } catch (error) {
      Logger.dev('Image descriptor selection persistence failed:', error)
    }
  }

  /** Describe one image in a disposable harness session on the vision model. */
  async describeImageOnVisionModel(
    projectId: string,
    threadId: string,
    projectPath: string,
    selection: AgentModelSelection,
    image: ResolvedImageEntry,
    attempt: number,
    parentTurnId?: string
  ): Promise<string> {
    const account = await this.host.state.accountRegistry.resolveForProvider(
      selection.harnessId,
      selection.providerId,
      selection.accountId
    )
    const { driver } = await this.host.resolve(projectId, selection.harnessId, threadId, account.id)
    const settings: ThreadSettings = {
      harnessId: selection.harnessId,
      accountId: account.id,
      providerId: selection.providerId,
      modelId: selection.modelId,
      inferenceMode: selection.inferenceMode,
      contextWindow: selection.contextWindow,
      thinkingLevel: selection.thinkingLevel ?? 'low',
      permissionLevel: 'auto_review',
      assignmentMode: false,
      loopMode: false
    }
    const isolated = supportsIsolatedSessions(driver)
      ? await driver.createIsolatedSession(projectPath, 'Image description')
      : undefined
    const sessionId =
      isolated?.sessionId ?? (await driver.createSession(projectPath, 'Image description'))
    this.host.registerSession(
      sessionId,
      projectId,
      threadId,
      projectPath,
      'auto_review',
      selection.harnessId,
      undefined,
      true
    )
    const registeredImageSession = this.host.sessionRegistry.get(sessionId)
    if (registeredImageSession) registeredImageSession.accountId = settings.accountId
    let response: AgentMessage | undefined
    let failure: string | null = null
    try {
      // Pasted/dropped images live in the project's temporary attachment
      // directory, so pass the resolved file path to the vision session and
      // let the harness read it itself   no base64 inflation in the prompt.
      // A missing file throws here and surfaces via the recovery card, where
      // the user can pick a replacement image.
      const attachment = await resolveVisionAttachment(image)
      const timeoutMs = imageDescriptorInactivityTimeoutMs(attachment, attempt)
      const nextTimeoutMs =
        attempt === 0 ? imageDescriptorInactivityTimeoutMs(attachment, attempt + 1) : undefined
      const completion = this.host.units['turns-sessions'].waitForSessionCompletion(
        sessionId,
        timeoutMs,
        'Image upload or vision-model response',
        () => new ImageDescriptorInactivityError(timeoutMs, attempt, nextTimeoutMs)
      )
      // The descriptor prompt is app-owned wiring, not a template: it is the
      // instruction every vision call is dispatched with, and a text-only model
      // reading the result depends on its shape.
      const imageDescriptionPrompt = IMAGE_DESCRIPTOR_PROMPT
      const request: SendPromptOptions = {
        sessionId,
        settings,
        text: imageDescriptionPrompt,
        attachments: [attachment],
        readOnly: true,
        allowedTools: [],
        agent: leanAgentNameForMode('image-description'),
        userMessageId: createMessageId()
      }
      traceLeanAgent('image-description', sessionId, selection.harnessId)
      tokenUsageAttribution.recordPromptAttribution(
        episodeFromPieces({
          key: `img:${sessionId}`,
          mode: 'image-description',
          driverId: selection.harnessId,
          pieces: [{ title: 'Image descriptor prompt', content: imageDescriptionPrompt }]
        })
      )
      if (isolated && supportsIsolatedSessions(driver)) {
        await driver.sendPrompt(projectPath, request, isolated)
      } else {
        await driver.sendPrompt(projectPath, request)
      }
      await completion
      const messages =
        isolated && supportsIsolatedSessions(driver)
          ? await driver.loadMessages(projectPath, sessionId, isolated)
          : await driver.loadMessages(projectPath, sessionId)
      response = [...messages].reverse().find((message) => message.role === 'assistant')
      if (!response) throw new Error('The vision model returned no description')
      if (response.error) throw new Error(response.error)
      tokenUsageAttribution.recordTurnTotals({
        key: `img:${sessionId}`,
        agent: leanAgentNameForMode('image-description'),
        driverId: selection.harnessId,
        harnessVersion: currentHarnessVersion(),
        providerId: response.providerId ?? settings.providerId ?? null,
        modelId: response.modelId ?? settings.modelId ?? null,
        reportedInputTokens: response.normalizedUsage?.uncachedInput ?? null,
        reportedTotalTokens: response.normalizedUsage?.rawTotal ?? null
      })
      const text = response.parts
        .filter((part): part is Extract<AgentPart, { type: 'text' }> => part.type === 'text')
        .map((part) => part.text)
        .join('\n')
        .trim()
      if (!text) throw new Error('The vision model returned an empty description')
      return text
    } catch (error) {
      failure = rawErrorMessage(error)
      throw error
    } finally {
      if (parentTurnId) {
        this.host.units['messages-write'].recordAuxiliaryUsageEvent({
          feature: 'image_descriptor',
          threadId,
          parentTurnId,
          featureCallId: image.id,
          attempt: attempt + 1,
          harnessId: selection.harnessId,
          settings,
          inputText: IMAGE_DESCRIPTOR_PROMPT,
          response,
          failure
        })
      }
      this.host.units['runtime-connectivity'].clearCompletionWaiter(sessionId)
      this.host.units['turns-sessions'].clearSessionWatchdog(sessionId)
      this.host.sessionRegistry.delete(sessionId)
      this.host.sessionStatuses.delete(sessionId)
      this.host.state.reasoningTimes.delete(sessionId)
      this.host.state.toolTimes.delete(sessionId)
      if (isolated && supportsIsolatedSessions(driver)) {
        driver.disposeIsolatedSession(isolated)
      } else {
        try {
          await driver.deleteSession?.(projectPath, sessionId)
        } catch (error) {
          Logger.dev('Image descriptor session deletion was incomplete:', error)
        }
      }
    }
  }

  /**
   * Resolve a pending image-descriptor error card. `retry` re-runs the vision
   * model (with the supplied selection, persisting it to the thread when it
   * differs); `ignore` forwards whatever partial output exists to the text-only
   * model so it can work with it or explain what is missing; `false_positive`
   * records the model that was executing the turn as vision-capable so the
   * image descriptor never runs for it again, then continues like `ignore`.
   *
   * A card whose request the engine already settled (timeout, a newer request
   * superseding it, or its session being retired) is never an error: the reply
   * settles the card and applies what it still can, because a card the user can
   * see must always be dismissable.
   */
  async replyImageDescriptor(
    projectId: string,
    threadId: string,
    requestId: string,
    action: ImageDescriptorReplyAction,
    selection?: AgentModelSelection,
    imagePath?: string
  ): Promise<void> {
    this.host.units['messages'].touchUserActivity()
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    requestId = validateEntityId(requestId, 'Image descriptor request ID', 256)
    if (
      action !== 'retry' &&
      action !== 'ignore' &&
      action !== 'false_positive' &&
      action !== 'pick_image'
    ) {
      throw new TypeError('Invalid image descriptor reply')
    }
    const pending = this.host.state.pendingImageDescriptorDecisions.get(requestId)
    const staleRequest =
      pending === undefined ||
      pending.projectId !== projectId ||
      pending.request.surfaceThreadId !== threadId
    if (action === 'false_positive') {
      // The card normally carries the model executing the turn. A report that
      // arrives for an already settled card keeps the same attribution by
      // reading the thread the card was shown for, so a late report still lands
      // instead of failing the user's click.
      const requestingModel =
        pending?.request.requestingModel ??
        this.host.units['runtime-agents'].visionReportModel(
          staleRequest
            ? (await this.host.threadManager.getThread(projectId, threadId).catch(() => null))
                ?.settings
            : undefined
        )
      if (!requestingModel) {
        throw new Error('This report needs the model that was executing the turn')
      }
      await this.host.storage.addVisionModel(requestingModel.modelId)
      // The app's record is not what the harness reads, so a report that only
      // landed there would leave the next turn replacing the image again. Repair
      // the catalog entry the report says is wrong.
      const repaired = await new NativeProviderConfigService(
        this.host.storage
      ).markModelVisionCapable(
        requestingModel.harnessId,
        requestingModel.providerId,
        requestingModel.modelId
      )
      Logger.info('Vision capability recorded from user report', {
        modelId: requestingModel.modelId,
        providerId: requestingModel.providerId,
        harnessId: requestingModel.harnessId,
        catalogUpdated: repaired
      })
    }
    // A retry carries the vision model the user chose on the card, so it is
    // validated at the IPC boundary even when the card turns out to be settled.
    if (action === 'retry' && selection !== undefined) {
      selection = {
        harnessId: validateBoundedString(
          selection.harnessId,
          'Image descriptor harness ID',
          1,
          256
        ),
        providerId: validateBoundedString(
          selection.providerId,
          'Image descriptor provider ID',
          1,
          256
        ),
        ...validateModelRuntimeSettings(selection),
        modelId: validateBoundedString(selection.modelId, 'Image descriptor model ID', 1, 256),
        ...(selection.accountId === undefined
          ? {}
          : {
              accountId: validateEntityId(selection.accountId, 'Image descriptor account ID', 256)
            })
      }
    }
    if (staleRequest || !pending) {
      // Nothing is left to resolve: the blocked tool call already returned, so
      // the reply only clears the card. Never throw here; a stale card must not
      // trap the user.
      Logger.dev(`Ignoring reply for settled image descriptor request: ${requestId}`)
      return
    }
    // A replacement image picked from the error card is validated here (it must
    // be a readable file) and keeps the failed image's id so its description
    // still maps to the same slot in the per-image result set.
    let replacement: ResolvedImageEntry | undefined
    if (action === 'pick_image') {
      const failedImageId = pending.request.imageId
      if (!failedImageId) {
        throw new Error('This image descriptor request has no failed image to replace')
      }
      replacement = await buildImageDescriptorReplacement(failedImageId, imagePath)
    }
    if (pending.timer !== undefined) {
      clearTimeout(pending.timer)
    }
    this.host.state.pendingImageDescriptorDecisions.delete(requestId)
    this.host.units['lifecycle'].startSessionWatchdog(pending.sessionId)
    // The decision resolved the user-input block: restore the thread's working
    // status (same contract as the question tool's resolution path).
    void this.host.threadManager
      .setStatus(pending.projectId, pending.threadId, pending.resumeStatus)
      .catch(() => undefined)
    this.host.broadcast({
      type: 'imageDescriptor.resolved',
      sessionId: pending.sessionId,
      projectId,
      threadId: pending.request.surfaceThreadId,
      requestId,
      action
    })
    if (action === 'retry') {
      pending.resolve({ action: 'retry', selection: selection ?? undefined })
    } else if (action === 'pick_image' && replacement) {
      pending.resolve({ action: 'pick_image', entry: replacement })
    } else {
      pending.resolve({ action: 'ignore' })
    }
  }

  /** Resolve (as ignore) every image-descriptor decision bound to a session that
   *  is being torn down, so blocked gateway tool calls return partial output
   *  instead of hanging forever. Each settled decision also clears its card, so
   *  a retired session never leaves an unanswerable card on screen. */
  clearPendingImageDescriptorDecisionsForSession(sessionId: string): void {
    for (const [, pending] of this.host.state.pendingImageDescriptorDecisions) {
      if (pending.sessionId !== sessionId) continue
      this.settleImageDescriptorDecision(pending)
    }
  }
}
