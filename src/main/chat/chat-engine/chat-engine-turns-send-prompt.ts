import { unarchivedThreadSql } from '../../../lib/archives'
import { join, resolve } from 'path'
import { Logger } from '../../system/logger'
import { DEFAULT_HARNESS } from '../../../lib/harness-default'
import { CheckpointLimitError } from '../../git/change-tracking-service'
import { updateRetryWakeWindow } from '../thread-events'
import type { BehaviorExecutionScope } from '../prompt-assembler'
import { leanAgentNameForMode } from '../../opencode/opencode-agent-definitions'
import {
  validateBoundedString,
  validateEntityId,
  validateThreadSettings
} from '../../ipc/ipc-validation'
import type { SendPromptOptions } from '../../drivers/driver.interface'
import { isAssistantNextStepsPrompt } from '../../../lib/assistant-next-steps'
import { isContinuationRelayPrompt } from '../../../lib/pending-request'
import { composeAssistantInstruction } from '../../../lib/assistant-run'
import { isCioUtilityRequest } from '../../utilities/cio-utility-prompt'
import { isCioDesignRequest } from '../../utilities/cio-design-prompt'
import { isCioVideoRequest } from '../../utilities/cio-video-prompt'
import { isCioOrchestrateRequest } from '../../orchestration/cio-orchestrate-prompt'
import type { AuthoredWorkKind } from '../../../lib/ipc/design'
import type { UtilityTurnBudgetContext } from '../../utilities/utility-orchestration-service'
import type {
  AgentMessage,
  BrainstormDocument,
  PromptAttachment,
  PromptAssignmentTaskReference,
  PromptProjectReference,
  PromptReference,
  SpecActionIntent,
  UserMessagePresentation,
  Thread,
  ThreadSettings
} from '../../../lib/types'
import { ASSISTANT_SPACE_ID, INBOX_PROJECT_ID, isAssistantSetupThread } from '../../../lib/types'
import {
  budgetTurnLayers,
  composeBudgetedSend,
  estimateTextTokens,
  truncateToTokenBudget
} from '../../../lib/prompt-budget'
import {
  ASSIGNMENT_PLAN_SCHEMA,
  ASSIGNMENT_PLAN_TOOL_NAME,
  PRODUCT_REQUIREMENTS_DOCUMENT_TOOL_NAME
} from '../../../lib/agent-tools'
import {
  UTILITY_ACTIVATE_TOOL_NAME,
  UTILITY_INVOKE_TOOL_NAME,
  UTILITY_SEARCH_TOOL_NAME
} from '../../../lib/gateway-tools'
import { PRD_DOCUMENT_JSON_SCHEMA } from '../../../lib/prd/prd-validation'
import { deriveTitleFromText } from '../title-generator'
import { createTurnDispatchTimer } from '../turn-dispatch-timer'
import { createAutoTitleLauncher } from '../title-generation-policy'
import { artifactInstruction } from '../generated-artifact-service'
import { GLOBAL_BROWSER_PROJECT_ID } from '../../../lib/ipc/browser'
import {
  assistantThreadWorkspaceDirectory,
  browserThreadWorkspaceDirectory,
  chatThreadWorkspaceDirectory
} from '../../../lib/project-artifacts'
import { messageId as createMessageId } from '../../../lib/id'
import type {
  PendingAssignmentTurn,
  PendingPrdTurn,
  PendingSpecRevision,
  QueuedCoordinatorHandoff
} from './chat-engine-types'
import { rawErrorDetail, rawErrorMessage } from './chat-engine-errors'
import { withoutTransportParts } from './chat-engine-message-merge'
import { formatProjectReferenceContext } from './chat-engine-message-text'
import {
  MAX_RECAP_TOKENS,
  SPEC_GENERATION_FAILURE_USER_MESSAGE,
  SYSTEM_LAYER_RESERVE_TOKENS,
  assertHarnessRequestCapabilities,
  traceLeanAgent
} from './chat-engine-constants'
import {
  CHAT_WORKSPACE_TOOLS,
  chatGatewayAllowedTools,
  ENGINEERING_PARKED_LIFECYCLE_INSTRUCTION,
  IMAGE_DESCRIPTOR_SYSTEM_NOTE,
  MEMORY_RESPONSE_BOUNDARY_INSTRUCTION,
  SPEC_BRAINSTORM_ALLOWED_TOOLS,
  buildSpecRevisionSystemPrompt,
  chatFilesystemBoundaryInstruction,
  composeBrainstormSystemPrompt,
  composeTurnSystemPrompt
} from './chat-engine-prompts'
import { specGenerationSchema } from './chat-engine-generated-artifacts'
import {
  assignmentWorkerRoutingReceipt,
  broadcastToast,
  isCoordinatorThread,
  queuedCoordinatorHandoffMessage,
  validatePromptReferences,
  validateUserMessagePresentation
} from './chat-engine-pure'
import type { ChatEngine } from '../chat-engine'

/** ChatEngine turns-send-prompt: one concern, moved verbatim from the composition root. */
export class ChatEngineTurnsSendPrompt {
  constructor(private readonly host: ChatEngine) {}

  /** Send a prompt to the agent (non-blocking; the reply streams over events). */
  async sendPrompt(
    projectId: string,
    threadId: string,
    settings: ThreadSettings,
    text: string,
    attachments: PromptAttachment[],
    specAction?: SpecActionIntent,
    userMessageId?: string,
    promptContext?: string,
    promptReferences?: PromptReference[],
    projectReferences?: PromptProjectReference[],
    origin: 'user' | 'internal' = 'user',
    presentation?: UserMessagePresentation,
    taskReferences?: PromptAssignmentTaskReference[],
    /** Persist this internal prompt as a visible user turn. Used by the
     *  Assignment worker dispatch so the task that started a worker reads as
     *  the first user prompt in its conversation. */
    visiblePrompt = false
  ): Promise<AgentMessage> {
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    // Dev-only phase clock for this dispatch (see `turn-dispatch-timer`). Every
    // mark below is a clock read; the breakdown only reaches the dev log.
    const dispatchTimer = createTurnDispatchTimer(projectId, threadId)
    // Queue behind an in-flight optimistic create so a just-created thread can
    // accept its first prompt as soon as its row is persisted.
    await this.host.threadCreation?.awaitReady(threadId)
    dispatchTimer.mark('threadReady')
    const visible = await this.host.database.queryViaWorker(
      `SELECT id FROM threads WHERE id = ? AND project_id = ? AND ${unarchivedThreadSql()}`,
      [threadId, projectId],
      1
    )
    if (!visible.ok || visible.rows.length === 0) {
      throw new Error('Unarchive this thread and its project or assistant before continuing')
    }
    if (origin === 'user') {
      this.host.units['messages'].touchUserActivity()
      // A real user prompt re-arms automatic resumes: the stop latch only ever
      // vetoes resuming until the user themselves come back to the thread.
      await this.host.threadManager.clearStoppedByUser(projectId, threadId)
      // Renderer settings may still contain the Stop flag cleared above.
      const { stoppedByUserAt: _stoppedByUserAt, ...resumedSettings } = settings
      settings = resumedSettings
    }
    settings = validateThreadSettings(settings)
    text = validateBoundedString(text, 'Prompt', 0, 200_000)
    const ovenThread = await this.host.threadManager.getThread(projectId, threadId)
    if (ovenThread && this.host.state.ovenChat.remote(ovenThread, settings)) {
      await this.host.threadManager.updateSettings(projectId, threadId, settings)
      const sessionId = await this.host.ensureSession(projectId, threadId)
      this.host.registerSession(
        sessionId,
        projectId,
        threadId,
        settings.ovenPath ?? '',
        settings.permissionLevel,
        settings.harnessId
      )
      const remoteContext = [
        promptContext ? validateBoundedString(promptContext, 'Prompt context', 1, 100_000) : '',
        ...validatePromptReferences(promptReferences).map(
          (reference) =>
            `${reference.label}:\n${reference.text}${reference.comment ? `\nUser comment: ${reference.comment}` : ''}`
        ),
        ...(projectReferences ?? []).map(
          (reference) =>
            `Workspace reference: ${validateBoundedString(reference.path, 'Reference path', 1, 4096)}`
        )
      ]
        .filter(Boolean)
        .join('\n\n')
      const bound = await this.host.threadManager.getThread(projectId, threadId)
      // A remote turn returns before the local auto-title block below, which
      // left every Oven thread titled "New Thread". Title it here: the same
      // deterministic fallback applies immediately, and the model's own title
      // follows when this machine can run the harness for one disposable turn.
      const mirrorBeforePrompt = await this.host.threadManager.loadMessagePage(
        projectId,
        threadId,
        undefined,
        1
      )
      const shouldAutoTitle =
        ovenThread.status === 'created' &&
        ovenThread.titleSource !== 'manual' &&
        !isAssistantSetupThread(ovenThread) &&
        mirrorBeforePrompt.messages.length === 0
      if (shouldAutoTitle) {
        const fallback = deriveTitleFromText(text)
        if (fallback) {
          await this.host.threadManager.updateThread(projectId, threadId, {
            title: fallback,
            titleSource: 'auto'
          })
        }
      }
      const sent = await this.host.state.ovenChat.send(
        bound ?? ovenThread,
        settings,
        text,
        attachments,
        userMessageId,
        remoteContext
      )
      if (shouldAutoTitle && settings.titleMode !== 'deterministic') {
        // The project's path lives on the Oven, so a disposable title turn on
        // this machine needs a local working directory of its own.
        const titleProjectPath = await this.host.units['turns'].ephemeralWorkingDirectory(threadId)
        void createAutoTitleLauncher(true, () =>
          this.host.units['threads-title'].autoTitleThread(
            projectId,
            threadId,
            settings.harnessId,
            settings,
            text,
            sent.id,
            undefined,
            titleProjectPath
          )
        )()
      }
      return sent
    }

    // A continuation relay re-sends a request the user made earlier, and its
    // files can be gone from disk by the time the retry runs. A vanished file
    // drops from the relay so the turn still carries the request; failing it
    // would leave the user with the same unanswered request.
    if (isContinuationRelayPrompt(text)) {
      attachments = await this.host.units['runtime-workflows'].relayAttachments(
        projectId,
        threadId,
        attachments
      )
    }
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
    this.host.units['turns'].markProjectActive(projectId)
    let targetThread = await this.host.threadManager.getThread(projectId, threadId)
    if (
      specAction === 'implement' &&
      settings.loopMode === true &&
      !this.host.state.assignmentEngine.getActive(projectId, threadId)
    ) {
      await this.host.ensureAchievementScope(projectId, threadId)
      targetThread = await this.host.threadManager.getThread(projectId, threadId)
    }
    const targetSessionDriverId = targetThread?.sessionId
      ? (this.host.sessionRegistry.get(targetThread.sessionId)?.driverId ??
        targetThread.sessionHarnessId ??
        targetThread.settings?.harnessId ??
        settings.harnessId)
      : undefined
    if (targetThread?.sessionId && targetSessionDriverId === 'codex') {
      const accountId =
        this.host.sessionRegistry.get(targetThread.sessionId)?.accountId ??
        targetThread.sessionAccountId
      const { driver, projectPath } = await this.host.resolve(
        projectId,
        'codex',
        threadId,
        accountId
      )
      // A locally held writer needs no peer handoff. Asking every peer here
      // made ordinary follow-ups fail when an unrelated instance did not answer.
      if (!driver.hasSessionWriter?.(projectPath, targetThread.sessionId)) {
        const transfer = await this.host.state.threadTransferPreflight?.(projectId, threadId)
        if (transfer && !transfer.ok) throw new Error(transfer.reason)
      }
    }
    // This process is about to drive the workflow this thread belongs to, so it
    // records ownership for the whole group now. A peer launching between two of
    // the workflow's turns must see a live owner rather than an unowned persisted
    // workflow it could adopt and double-drive.
    if (targetThread)
      await this.host.units['thread-lifecycle'].claimWorkflowOwnershipForThread(
        projectId,
        targetThread
      )
    if (
      specAction === undefined &&
      targetThread?.sessionId &&
      this.host.state.engineeringImplementationSessions.has(targetThread.sessionId)
    ) {
      if (origin === 'user') {
        // A plain user message is explicit intent: retire the spec-contract
        // continuation flag so the turn is answered as a normal chat turn
        // instead of being hijacked into "COMPLETE THE TOTAL SPEC CONTRACT!"
        // prompting after the achievement loop has finished.
        this.host.state.engineeringImplementationSessions.delete(targetThread.sessionId)
      } else {
        specAction = 'implement'
      }
    }
    if (
      targetThread?.userInputLocked &&
      targetThread.assignmentRole !== 'coordinator' &&
      origin === 'user'
    ) {
      throw new Error('This Assignment task is locked. Return to its coordinator to continue.')
    }
    const hiddenPromptContext = promptContext
      ? validateBoundedString(promptContext, 'Prompt context', 1, 100_000)
      : ''
    const validatedPromptReferences = validatePromptReferences(promptReferences)
    const validatedPresentation = validateUserMessagePresentation(presentation)
    const validatedProjectReferences = await this.host.units['turns'].validateProjectReferences(
      projectId,
      projectReferences,
      targetThread?.scopeBucketId
    )
    const projectReferenceContext = formatProjectReferenceContext(validatedProjectReferences)
    let hiddenContext = [hiddenPromptContext, projectReferenceContext].filter(Boolean).join('\n\n')
    // A run of an assistant that already has its knowledge: the knowledge is the
    // instruction set, and this contract tells the agent to supply any
    // connection the run needs that is not set up, asking the user for what
    // only the user can give. The app's own next-steps message is not a run, so
    // it carries neither the contract nor management.
    const assistantRun = this.host.assistantRunHiddenContext(targetThread)
    const assistantTaskTurn =
      assistantRun !== undefined && !(origin === 'internal' && isAssistantNextStepsPrompt(text))
    // A user turn on the Getting started thread of an assistant that is already
    // saved: the user is tweaking the knowledge, the schedule, or the connections,
    // not running the assistant. It carries the editing contract through
    // `assistantAuthoringInstruction` below, and the same management grant a run
    // gets, because a tweak can need a capability this thread has to install.
    const assistantKnowledgeUpdateTurn =
      origin === 'user' &&
      this.host.units['assistant-authoring'].assistantConversation(targetThread) === 'update'
    // The contract belongs to the thread, not to one send path. A scheduled run
    // and a user follow-up on the same task are both the assistant's assistant, so
    // both carry the self-provisioning contract and the run grant; gating it on
    // an internal origin left a follow-up with only the reuse contract, which
    // reserves installing and dead-ends on "connect it yourself".
    //
    // The contracts are instructions for the agent's behavior on this thread, so
    // they ride the SYSTEM PROMPT rather than the user message. Every harness
    // rewrites that prompt each turn, while text appended to a user message is
    // kept in the harness transcript and replayed once more on every later turn,
    // which would accumulate one copy per turn for the life of the thread.
    const assistantInstruction = assistantTaskTurn
      ? composeAssistantInstruction(this.host.assistantPersonaLayers(targetThread), assistantRun)
      : origin === 'user'
        ? await this.host.assistantAuthoringInstruction(projectId, threadId, targetThread)
        : undefined
    if (origin === 'user') {
      const workerDirective =
        await this.host.units['assignment-workers'].workerAssignmentTurnDirective(targetThread)
      if (workerDirective) {
        hiddenContext = [hiddenContext, workerDirective].filter(Boolean).join('\n\n')
      }
    }
    // One aggregate selected-model input budget for the turn (A-13). The
    // session-dependent system/behavior/tool layers are not assembled yet, so
    // driverText's hidden orchestration context is capped against an early
    // aggregate budget that reserves the final system layer; the precise recap
    // budget is re-derived later from the actual composed system base. When the
    // fixed user/system layers already exceed the model input budget, the
    // dynamic (hidden + recap) layers are capped to zero and the user text is
    // sent as-is   the harness enforces its own truncation, and no dynamic
    // layer is ever allocated past the remaining headroom.
    const inputBudget = this.host.units['runtime-agents'].selectedModelInputBudget(
      settings.providerId,
      settings.modelId,
      projectId
    )
    const earlyLayers = budgetTurnLayers(
      {
        userTokens: estimateTextTokens(text),
        systemTokens: SYSTEM_LAYER_RESERVE_TOKENS,
        hiddenTokens: estimateTextTokens(hiddenContext),
        recapTokens: MAX_RECAP_TOKENS
      },
      inputBudget
    )
    const budgetedHidden = truncateToTokenBudget(hiddenContext, earlyLayers.hiddenTokens)
    let driverText = budgetedHidden ? `${budgetedHidden}\n\nUser message:\n${text}` : text
    if (
      specAction !== undefined &&
      specAction !== 'request' &&
      specAction !== 'review' &&
      specAction !== 'implement'
    ) {
      throw new TypeError('Invalid specification action')
    }
    const messageId = validateEntityId(userMessageId ?? createMessageId(), 'Message ID', 256)
    const coordinatorHandoff = (createdAt: number): QueuedCoordinatorHandoff => ({
      schemaVersion: 1,
      id: messageId,
      projectId,
      threadId,
      settings,
      text,
      attachments,
      ...(specAction ? { specAction } : {}),
      ...(hiddenPromptContext ? { promptContext: hiddenPromptContext } : {}),
      promptReferences: validatedPromptReferences,
      projectReferences: validatedProjectReferences,
      ...(validatedPresentation ? { presentation: validatedPresentation } : {}),
      taskReferences: taskReferences ?? [],
      createdAt
    })
    if (
      origin === 'internal' &&
      isCoordinatorThread(targetThread) &&
      !this.host.state.dispatchingCoordinatorHandoffIds.has(messageId)
    ) {
      const handoff = coordinatorHandoff(Date.now())
      await this.host.units['assignment'].enqueueCoordinatorHandoff(handoff)
      await this.host.units['assignment'].drainCoordinatorHandoffQueue(projectId, threadId)
      return queuedCoordinatorHandoffMessage(handoff)
    }

    // Decide auto-title against the pre-prompt mirror BEFORE the user message
    // is persisted below, so a fresh thread's first prompt still auto-titles.
    const mirrorBeforePrompt = await this.host.threadManager.loadMessagePage(
      projectId,
      threadId,
      undefined,
      1
    )
    const shouldAutoTitle =
      targetThread?.status === 'created' &&
      targetThread.titleSource !== 'manual' &&
      !(targetThread && isAssistantSetupThread(targetThread)) &&
      mirrorBeforePrompt.messages.length === 0

    // Persist the user message to the mirror immediately   before any slow
    // session, utility, or history work   so a renderer reload, thread switch,
    // or crash can never lose the message the user just sent. The renderer
    // only holds an optimistic in-memory copy at this point, so delaying this
    // write until after session setup left a wide window in which a reload
    // wiped the message while the thread kept working.
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
      origin,
      visiblePrompt
    )
    const publicUserMessage = withoutTransportParts(userMessage)
    dispatchTimer.mark('userPersisted')
    const workerRouting = await this.host.units['assignment-workers'].routeTaggedAssignmentWorkers(
      targetThread,
      origin,
      text,
      taskReferences
    )
    const assignmentCoordinatorSystemPrompt = [
      await this.host.units['assignment'].assignmentCoordinatorUserTurnPrompt(targetThread, origin),
      assignmentWorkerRoutingReceipt(workerRouting)
    ]
      .filter(Boolean)
      .join('\n\n')
    // First prompt of a fresh thread (forks carry a mirror)   auto-title it
    // in the background so the sidebar never fills with "New Thread" rows.
    // The fallback is applied immediately. The model-generated title uses a
    // disposable session that starts independently from the main turn.
    if (shouldAutoTitle) {
      const fallback = deriveTitleFromText(text)
      if (fallback) {
        await this.host.threadManager.updateThread(projectId, threadId, {
          title: fallback,
          titleSource: 'auto'
        })
      }
    }

    const driverId = settings.harnessId || DEFAULT_HARNESS
    const selectedAccount = await this.host.state.accountRegistry.resolveForProvider(
      driverId,
      settings.providerId,
      settings.accountId
    )
    settings = { ...settings, accountId: selectedAccount.id }
    const { driver, projectPath } = await this.host.resolve(
      projectId,
      driverId,
      threadId,
      selectedAccount.id
    )
    // Branch metadata must use the same resolved cwd as the harness. Relative
    // thread directories are anchored to the project root by resolveThreadPath.
    // It is a label on the thread row, not an input to the turn, so the git read
    // and its write never gate the prompt the user is waiting on.
    if (targetThread?.workingDirectory) {
      void this.host.state.repositoryService
        .getCurrentBranch(projectPath)
        .then((branch) =>
          branch && targetThread.branch !== branch
            ? this.host.threadManager.setBranch(projectId, threadId, branch)
            : undefined
        )
        .catch((error: unknown) => Logger.dev('Thread branch label refresh failed:', error))
    }
    assertHarnessRequestCapabilities(driver, attachments, settings.permissionLevel)
    const project = await this.host.state.projectManager.getProject(projectId)
    if (!project) throw new Error(`Project not found: ${projectId}`)
    const engineeringActive =
      project.id !== INBOX_PROJECT_ID &&
      this.host.units['turns'].engineeringLifecycleActive(projectId, threadId)
    let titleParentSessionId: string | undefined
    // Other harnesses can title immediately. Claude receives the parent session
    // identity after dispatch so only its auxiliary title process waits for that
    // turn to prove authentication; unrelated Claude turns remain concurrent.
    const scheduleAutoTitle = createAutoTitleLauncher(
      shouldAutoTitle && settings.titleMode !== 'deterministic',
      () =>
        this.host.units['threads-title'].autoTitleThread(
          projectId,
          threadId,
          driverId,
          settings,
          text,
          messageId,
          titleParentSessionId
        )
    )
    if (driverId !== 'claude-code') void scheduleAutoTitle()
    const isChatThread = project.id === INBOX_PROJECT_ID || project.id === GLOBAL_BROWSER_PROJECT_ID
    // An assistant task is its own class: neither a project thread nor a chat.
    // It carries the app-owned assistant prompt and its own lean harness agent.
    const isAssistantTask = project.id === ASSISTANT_SPACE_ID
    const chatFileSystemEnabled = isChatThread && settings.fileSystemMode === true
    // A parked lifecycle (no circle actively running and no decision gate
    // pending) means the user is free to chat: their message must NOT be
    // hijacked into the planning/spec workflow. Only explicit designated stage
    // actions ('request'/'review' from the studios) or an actively planning
    // lifecycle take the brainstorming path. Parking must not depend on
    // `selection`: a completed manual circle resets `selection` to 'none' while
    // keeping `startedAt` set, and that thread stays in implementation mode.
    const lifecycleForMode = this.host.state.engineeringLifecycleEngine.get(projectId, threadId)
    const lifecycleParked =
      lifecycleForMode !== null &&
      lifecycleForMode.activeStage === undefined &&
      lifecycleForMode.humanGate === undefined
    // A thread whose Assignment is already signed or running is a working
    // conversation, not a planning one: the Sr. Engineer coordinates workers and
    // answers the user there, so a plain message must reach the coordinator
    // prompt instead of reopening the specification pipeline or stalling on a
    // Brainstorm entry card. Explicit studio actions still take the planning path.
    const ownedAssignment = this.host.state.assignmentEngine.getActive(projectId, threadId)
    const assignmentInProgress = ownedAssignment !== null && ownedAssignment.status !== 'draft'
    const explicitPlanningAction = specAction === 'request' || specAction === 'review'
    const planningSpecTurn =
      engineeringActive &&
      specAction !== 'implement' &&
      (explicitPlanningAction || (!lifecycleParked && !assignmentInProgress))
    // Persist the selected harness before resolving the session. The renderer
    // pre-binds this same harness immediately before dispatch; leaving the old
    // harness in thread settings would make ensureSession replace that session
    // and stream the reply under an id the renderer is not listening to.
    await this.host.threadManager.updateSettings(projectId, threadId, settings)
    const preloadedActiveSpec = planningSpecTurn
      ? await this.host.units['spec'].getActiveSpec(projectId, threadId)
      : null
    let activeBrainstormTurn: BrainstormDocument | null = null
    let activeBrainstormSession = false
    // The PRD stage is conversational, including its `prd_finalization` gate: the
    // agent writes the PRD when the message, the conversation, and any finalized
    // Brainstorm are enough, and interviews the user when they are not. A draft
    // under review is still being discussed, and a review comment must never be
    // mistaken for the specification turn that finalization unlocks.
    //
    // It also owns no Brainstorm entry. "Start PRD" writes only the PRD workflow,
    // so the Brainstorm block below would find no entry choice, swallow the
    // message, and answer it with an unrelated Brainstorm card.
    const prdDiscussionTurn =
      planningSpecTurn &&
      specAction === undefined &&
      !preloadedActiveSpec &&
      (lifecycleForMode?.activeStage === 'prd' ||
        lifecycleForMode?.humanGate === 'prd_finalization') &&
      this.host.state.prdEngine.getWorkflowState(projectId, threadId)?.stage === 'drafting'
    // The Assignment stage is conversational for the same reason the PRD stage
    // is: a message can describe work that cannot be decomposed yet, and the
    // honest answer there is a focused question, not an invented task graph.
    // It owns both its active stage and its `assignment_approval` gate, because
    // the unsigned draft under review is still being discussed. The turn applies
    // while the thread still owns its own Assignment (none yet, or an unsigned
    // draft the user can still change) and while the user is the one driving it;
    // Autopilot keeps the forced background generation because nobody is there
    // to answer, and a signed or running Assignment hands the thread to the
    // coordinator conversation instead.
    const assignmentDiscussionTurn =
      planningSpecTurn &&
      specAction === undefined &&
      (lifecycleForMode?.activeStage === 'assignment' ||
        lifecycleForMode?.humanGate === 'assignment_approval') &&
      lifecycleForMode.autopilot !== true &&
      (ownedAssignment === null || ownedAssignment.status === 'draft')
    if (
      planningSpecTurn &&
      !preloadedActiveSpec &&
      !prdDiscussionTurn &&
      !assignmentDiscussionTurn
    ) {
      let brainstormWorkflow = this.host.state.brainstormEngine.getWorkflowState(
        projectId,
        threadId
      )
      if (!brainstormWorkflow) {
        brainstormWorkflow = this.host.state.brainstormEngine.ensureWorkflow(projectId, threadId)
      }
      if (!brainstormWorkflow.entryChoice) {
        void scheduleAutoTitle()
        await this.host.threadManager.setStatus(projectId, threadId, 'awaiting_approval', {
          read: false
        })
        return publicUserMessage
      }
      if (
        brainstormWorkflow.entryChoice === 'brainstorm' &&
        brainstormWorkflow.stage === 'drafting'
      ) {
        activeBrainstormSession = true
        const activeBrainstorm = await this.host.state.brainstormEngine.getActive(
          projectId,
          threadId
        )
        if (activeBrainstorm) {
          activeBrainstormTurn = activeBrainstorm
          const reviewText = presentation?.body?.trim()
          if (
            origin === 'user' &&
            (presentation?.action === 'Review Brainstorm' ||
              presentation?.action === 'Discuss Brainstorm') &&
            reviewText &&
            activeBrainstorm.decisionComments.at(-1)?.body !== reviewText
          ) {
            activeBrainstormTurn = await this.host.state.brainstormEngine.addDecisionComment(
              projectId,
              threadId,
              activeBrainstorm.id,
              activeBrainstorm.version,
              'review',
              reviewText
            )
          }
        }
      }
    }
    // Session preparation may need to probe the CLI, create a native session,
    // install per-turn utilities, and rebuild context. Publish the working
    // state before that work so every renderer surface reflects the run as
    // soon as the composer accepts it.
    await this.host.threadManager.setStatus(
      projectId,
      threadId,
      planningSpecTurn ? 'planning' : 'executing'
    )
    // A fork or recovered thread starts a fresh harness session   replay the
    // mirrored transcript through the system prompt so context carries over.
    let sessionId: string
    try {
      sessionId = await this.host.ensureSession(projectId, threadId, driverId)
      const previousStatus = this.host.sessionStatuses.get(sessionId)
      if (
        previousStatus?.state === 'error' &&
        previousStatus.issue.kind === 'authentication' &&
        previousStatus.issue.harnessId === driver.id
      ) {
        await driver.restartAfterAuthentication?.(projectPath)
      }
      titleParentSessionId = sessionId
      if (specAction === 'implement') {
        this.host.state.engineeringImplementationSessions.add(sessionId)
      }
      // The planning-session mark drives terminal-answer suppression at turn
      // finalization and on transcript reloads. It must reflect THIS turn's
      // intent, never stale membership from an earlier planning turn: planning
      // specification turns suppress their chat prose. Brainstorm interviews and
      // PRD interviews must retain the findings, the recap, and the questions as
      // visible conversation.
      if (
        planningSpecTurn &&
        !activeBrainstormSession &&
        !prdDiscussionTurn &&
        !assignmentDiscussionTurn
      ) {
        this.host.state.planningSessions.add(sessionId)
      } else {
        this.host.state.planningSessions.delete(sessionId)
      }
    } catch (error) {
      await this.host.threadManager.setStatus(projectId, threadId, 'failed', {
        error: rawErrorMessage(error),
        errorDetail: rawErrorDetail(error)
      })
      throw error
    }
    const modelNeedsImageDescriptor = await this.host.units['runtime-agents'].modelLacksVision(
      projectId,
      settings
    )
    dispatchTimer.mark('sessionReady')
    if (modelNeedsImageDescriptor) {
      const imageDescriptionContext = await this.host.units[
        'turns-dispatch'
      ].describePromptAttachments(attachments, projectId, threadId, projectPath, sessionId)
      if (imageDescriptionContext) {
        hiddenContext = [imageDescriptionContext, hiddenContext].filter(Boolean).join('\n\n')
        driverText = hiddenContext ? `${hiddenContext}\n\nUser message:\n${text}` : text
        const transportPart = userMessage.transportParts?.[0]
        if (transportPart && transportPart.type === 'text') {
          transportPart.text = driverText
          await this.host.threadManager.upsertMessages(projectId, threadId, [userMessage])
        }
      }
    }
    if (origin === 'user') {
      this.host.state.mermaidRepairAttempts.delete(sessionId)
      this.host.state.incompleteTurnRecoveryAttempts.delete(sessionId)
      this.host.state.searchNudgeAttempts.delete(sessionId)
      this.host.state.todoReconcileAttempts.delete(sessionId)
      this.host.state.taskReconcileTurns.delete(sessionId)
      // A new user prompt starts a fresh delivery accounting: an artifact the
      // previous turn rendered must not satisfy this turn's visual request.
      this.host.state.visualDeliverableNudges.delete(sessionId)
      this.host.state.artifactRenderedSessions.delete(sessionId)
    }
    // A new turn resolves any pending auto-resume for this session   the user
    // (or a previous scheduled retry) is driving it again.
    this.host.state.retryScheduler?.clear(sessionId)
    // The thread can also carry a pending record keyed to an earlier session:
    // a harness or account switch replaces the session id while the old wait
    // stays on the ledger. A fresh turn on the thread resolves every one of
    // them, so a retried worker can never keep reading "Waiting to retry"
    // while it is actually working.
    this.host.state.retryScheduler?.dropThread(threadId)
    updateRetryWakeWindow(sessionId, null)
    // Track the latest user expression for the memory proposal at turn end.
    // Recorded before the active-turn branch below so a message that steers a
    // running turn still carries its text and referenced selections.
    if (origin === 'user' && !(targetThread && isAssistantSetupThread(targetThread))) {
      this.host.state.pendingMemoryDecisions.set(sessionId, {
        userMessage: text,
        settings,
        references: validatedPromptReferences
      })
    }
    if (activeBrainstormSession && origin === 'user') {
      await this.host.state.brainstormAlignmentNotes.clearApproval(
        await this.host.units['brainstorm-review'].brainstormAlignmentRound(projectId, threadId)
      )
    }
    const activeSessionState = this.host.sessionStatuses.get(sessionId)?.state
    if (
      origin === 'internal' &&
      isCoordinatorThread(targetThread) &&
      (activeSessionState === 'working' || activeSessionState === 'waiting')
    ) {
      await this.host.units['assignment'].enqueueCoordinatorHandoff(
        coordinatorHandoff(userMessage.createdAt)
      )
      return publicUserMessage
    }
    // Renderer callers normally use agent:steerPrompt while a turn is active.
    // Keep sendPrompt safe as a second line of defense: an accidental regular
    // USER dispatch must steer the live turn, never reject and poison its task
    // status. This also covers a Codex auto-retry: the session parks in
    // `waiting` while the native turn stays live, and a dispatch there must
    // reach the retrying turn instead of colliding with it in the driver.
    // Internal coordinator handoffs are queued above so worker/auditor
    // reports cannot interrupt or confuse the Sr. Engineer's current reasoning.
    const driverReportsLiveTurn =
      activeSessionState === 'waiting' &&
      driver.hasActiveTurn !== undefined &&
      driver.hasActiveTurn(sessionId)
    if (activeSessionState === 'working' || driverReportsLiveTurn) {
      if (driver.capabilities?.steering !== true || !driver.steerPrompt) {
        throw new Error(`${driver.name} does not expose native active-turn steering`)
      }
      const outboundIds =
        this.host.state.outboundMessageIdsBySession.get(sessionId) ?? new Set<string>()
      outboundIds.add(messageId)
      this.host.state.outboundMessageIdsBySession.set(sessionId, outboundIds)
      // Steer appends to the live turn   do not rebind the checkpoint source
      // or move the turn-start anchor. Only a message after final output
      // starts a new turn; steers are mid-turn follow-ups.
      // Note: steering appends to the LIVE native turn, which still runs under
      // the model that started it. Do not record the new settings model here
      // that would mask a pending model switch until the following resume.
      const deliverFallbackSteer = async (): Promise<void> => {
        const steer = driver.steerPrompt
        if (!steer) throw new Error('steer unavailable')
        await this.host.units['turns-dispatch'].deliverWorkPrompt(
          projectId,
          threadId,
          userMessage,
          driverText,
          async (text) => {
            await steer.call(driver, projectPath, {
              sessionId,
              text,
              attachments,
              userMessageId: messageId
            })
          }
        )
      }
      // Same undo window as steerPrompt: hold while a tool call is in flight.
      if (this.host.units['utilities-tools'].hasInFlightTool(sessionId)) {
        this.host.units['turns-steer'].trackHeldSteer(sessionId, {
          projectId,
          conversationId: threadId,
          userMessageId: messageId,
          kind: 'thread',
          deliverMidTurn: deliverFallbackSteer,
          deliverAfterTurn: async () => {
            await this.host.sendPrompt(
              projectId,
              threadId,
              settings,
              text,
              attachments,
              specAction,
              messageId,
              promptContext,
              promptReferences,
              projectReferences,
              origin,
              presentation,
              taskReferences
            )
          },
          discard: async () => {
            const mirror = await this.host.threadManager.loadMessageRecords(projectId, threadId)
            const kept = mirror.filter((message) => message.id !== messageId)
            if (kept.length !== mirror.length) {
              await this.host.threadManager.saveMessages(projectId, threadId, kept)
            }
          }
        })
        return publicUserMessage
      }
      await deliverFallbackSteer()
      this.host.units['turns-sessions'].markSessionWorking(sessionId)
      return publicUserMessage
    }
    // Internal continuation prompts (search nudges, mermaid repairs,
    // incomplete-turn retries) start a new turn after the user's turn already
    // completed. Attribute the new checkpoint to that user message   label and
    // source id inherited from the thread's latest checkpoint   so the file
    // changes card reports the user's prompt, never the hidden internal text.
    const checkpointPromise: Promise<string | undefined> =
      planningSpecTurn || (isChatThread && !chatFileSystemEnabled)
        ? Promise.resolve(undefined)
        : this.host.checkpointManager
            .getLatestCompleted(projectId, threadId)
            .catch((error: unknown) => {
              Logger.dev('Checkpoint attribution lookup failed:', error)
              return null
            })
            .then((previous) =>
              this.host.checkpointManager.beginTurn(
                projectId,
                threadId,
                projectPath,
                origin === 'internal' && previous
                  ? previous.label
                  : text.slice(0, 80) || 'Agent turn',
                project.changeTrackingMode === 'git',
                origin === 'internal' && previous?.sourceMessageId
                  ? previous.sourceMessageId
                  : messageId
              )
            )
            .then((checkpoint) => checkpoint.id)
            .catch((error: unknown) => {
              if (!(error instanceof CheckpointLimitError)) throw error
              Logger.info('Checkpoint skipped because the project exceeds snapshot limits', {
                projectId,
                threadId,
                detail: error.message
              })
              broadcastToast(
                'Rollback checkpoint skipped because this project exceeds the snapshot limit. The agent will continue normally.',
                'info'
              )
              return undefined
            })
    const utilityBudgetContext: UtilityTurnBudgetContext = {
      selectedModelInputTokens: inputBudget,
      composedTurnTokens: earlyLayers.totalTokens,
      parentTurnId: messageId
    }
    const utilitySetupRequested = origin === 'user' && isCioUtilityRequest(text)
    if (utilitySetupRequested) this.host.state.cioUtilityThreads.set(threadId, true)
    // A design session lasts for the thread, and it opens two ways: the turn that
    // types @cio-design gets the session briefing here and promotes the design
    // capability to an active one, and a turn where the agent activates the
    // capability itself opens the same session, whose briefing rides the
    // activation payload. Every later turn keeps the capability and gets the
    // continuation instead.
    const designRequested = origin === 'user' && isCioDesignRequest(text)
    if (designRequested) this.host.state.cioDesignThreads.set(threadId, true)
    const designSession = await this.host.units['media-visual'].designSessionFor(
      projectId,
      threadId,
      designRequested,
      targetThread?.authoredWorkKind
    )
    // A video session opens the same two ways and lasts for the thread just as
    // long: the turn that types @cio-video gets the session briefing here and
    // promotes the video capability to an active one, and an agent activating the
    // capability opens the session from the activation payload. Every later turn
    // keeps the capability and gets the continuation instead.
    const videoRequested = origin === 'user' && isCioVideoRequest(text)
    if (videoRequested) this.host.state.cioVideoThreads.set(threadId, true)
    const videoSession = await this.host.units['media-visual'].videoSessionFor(
      projectId,
      threadId,
      videoRequested,
      targetThread?.authoredWorkKind
    )
    // An orchestration session is user-started on the same terms. It is what
    // grants the workstation tools, so the turn that types @cio-hey
    // gets the dispatch contract and every later turn of the thread keeps the
    // tools reachable.
    const orchestrationRequested = origin === 'user' && isCioOrchestrateRequest(text)
    if (orchestrationRequested) this.host.state.cioOrchestrateThreads.set(threadId, true)
    const orchestrationSession = await this.host.units['turns-sessions'].orchestrationSessionFor(
      projectId,
      threadId,
      orchestrationRequested
    )
    // The thread row carries the session, so the sidebar draws its marker from
    // the persisted field instead of a message scan. A thread that opened the
    // session in an earlier turn (detected as `continue` above) records it here
    // too, which heals a database that predates the column.
    const authoredWorkKind: AuthoredWorkKind | null =
      videoRequested || videoSession === 'continue'
        ? 'video'
        : designRequested || designSession === 'continue'
          ? 'design'
          : null
    if (authoredWorkKind) {
      await this.host.rememberAuthoredWorkKind(projectId, threadId, authoredWorkKind)
    }
    // The assistant knowledge authoring thread carries the utility gateway from the
    // start: the agent has to research and install the skills, MCPs and plugins
    // an assistant needs while it writes the knowledge, without the user first arming
    // setup by hand. It grants the same contract as an explicit @cio-utility
    // invocation, and it is derived from the thread on every turn rather than
    // memoized, so it ends the moment the knowledge is saved.
    const assistantAuthoringTurn =
      this.host.units['assistant-authoring'].isAssistantAuthoringThread(targetThread)
    // Once @cio-utility has been invoked in this thread (earlier or now), later
    // turns keep the setup contract reusable without repeating the invocation.
    // Other utilities were already freely invocable whenever the gateway runs,
    // and read-only app diagnostics never needed the invocation at all.
    // An assistant task whose assistant is saved keeps management too: a run (or a
    // follow-up on the task) has to be able to supply a connection the assistant
    // needs instead of dead-ending on "connect it yourself".
    const utilitySetupAllowed =
      utilitySetupRequested ||
      assistantAuthoringTurn ||
      assistantTaskTurn ||
      assistantKnowledgeUpdateTurn ||
      (await this.host.units['utilities'].hasCioUtilityInvocation(projectId, threadId))
    // Every chat, web-only or not, receives the app utility gateway: the
    // in-app browser (and any installed web tool) is reached through it, and
    // masking the chat's file-system tools happens on the harness allowlist
    // below instead of by withholding the gateway. Without the gateway a
    // web-only chat could reach neither the internet nor the in-app browser on
    // a harness whose only web path is the gateway.
    const utilityInstructionsPromise = this.host.units['utilities'].prepareTurnUtilities(
      driver,
      projectId,
      threadId,
      sessionId,
      projectPath,
      settings,
      utilityBudgetContext,
      targetThread?.title ?? '',
      targetThread?.scopeBucketId,
      false,
      utilitySetupAllowed,
      activeBrainstormSession,
      utilitySetupRequested || assistantAuthoringTurn,
      assistantTaskTurn ? 'run' : assistantKnowledgeUpdateTurn ? 'edit' : 'none',
      assistantAuthoringTurn ? (targetThread?.assistantId ?? null) : null,
      designSession,
      videoSession,
      orchestrationSession,
      // A real project thread may create its engineering artifacts through the
      // artifact tools. A chat, an assistant task, the inbox and an Assignment
      // worker are offered none of those routes.
      !isChatThread &&
        !isAssistantTask &&
        targetThread !== null &&
        targetThread.assignmentRole === undefined &&
        projectId !== INBOX_PROJECT_ID,
      dispatchTimer
    )
    const transportPromise = utilityInstructionsPromise.then(() =>
      driver.preparePromptTransport?.(projectPath, sessionId, settings)
    )
    // Behavior and vision layers are branch-agnostic and needed both for the
    // system-prompt base estimate and the final composition below, so compute
    // them once before the history recap budget is derived.
    const behaviorMode = isAssistantTask
      ? 'assistant'
      : specAction === 'implement'
        ? 'implement'
        : planningSpecTurn
          ? 'brainstorm'
          : 'chat'
    const behaviorScope: BehaviorExecutionScope = isChatThread
      ? 'standalone-chat'
      : isAssistantTask
        ? 'assistant'
        : 'project-thread'
    const [checkpointId, utilityInstructions, behaviorPrompt, rawRecap] = await Promise.all([
      dispatchTimer.step('checkpoint', checkpointPromise),
      dispatchTimer.step('utilityRuntime', utilityInstructionsPromise),
      dispatchTimer.step(
        'behaviorPrompt',
        this.host.units['turns-dispatch'].getBehaviorPrompt(
          projectId,
          threadId,
          projectPath,
          behaviorMode,
          settings,
          behaviorScope,
          messageId
        )
      ),
      dispatchTimer.step(
        'historyRecap',
        this.host.units['transcripts'].buildHistoryRecap(
          projectId,
          threadId,
          driverId,
          undefined,
          messageId
        )
      ),
      dispatchTimer.step('promptTransport', transportPromise)
    ])
    const imageDescriptorNote = modelNeedsImageDescriptor ? IMAGE_DESCRIPTOR_SYSTEM_NOTE : ''
    dispatchTimer.mark('turnContext')
    // The standalone workspace of this conversation, resolved by scope. An
    // assistant task owns `assistant-cwd/<assistantId>`, a chat owns
    // `chats-cwd/<threadId>`; resolving a chat path for an assistant thread put
    // a directory the session never runs in into its prompt.
    const chatWorkspaceRoot = this.host.storage.resolve(
      projectId === GLOBAL_BROWSER_PROJECT_ID
        ? browserThreadWorkspaceDirectory(threadId)
        : projectId === ASSISTANT_SPACE_ID
          ? assistantThreadWorkspaceDirectory(threadId, targetThread?.assistantId)
          : chatThreadWorkspaceDirectory(threadId)
    )
    const generatedArtifactPrompt = artifactInstruction(
      targetThread ?? {
        projectId,
        id: threadId,
        title: 'current-work',
        featureSlug: undefined,
        assistantId: undefined
      },
      {
        chatWorkspaceRoot,
        chatFileSystemMode: isChatThread && chatFileSystemEnabled
      }
    )
    const parkedLifecycleInstruction = lifecycleParked
      ? ENGINEERING_PARKED_LIFECYCLE_INSTRUCTION
      : ''
    const promptBehavior = [behaviorPrompt, generatedArtifactPrompt, parkedLifecycleInstruction]
      .filter(Boolean)
      .join('\n\n')
    // One aggregate selected-model input budget across user text + the final
    // system/behavior/tool prompt + hidden orchestration context + history
    // recap, with output/tool headroom reserved once (A-13). The recap takes
    // only the headroom left after the fixed user/system layers and the actual
    // hidden context consumed.
    const brainstormingTurn = planningSpecTurn
    const chatSystemPrompt = isChatThread
      ? [
          await this.host.units['turns-dispatch'].cioPrompt(
            chatFileSystemEnabled ? 'file-system-chat' : 'chat'
          ),
          chatFileSystemEnabled
            ? `This chat owns the dedicated workspace ${chatWorkspaceRoot}. Work inside it, including image generation, scripts, and generated files, is already authorized and requires no permission question.`
            : chatFilesystemBoundaryInstruction(chatWorkspaceRoot)
        ]
          .filter(Boolean)
          .join('\n\n')
      : ''
    const brainstormDiscussionPrompt = brainstormingTurn
      ? [
          await this.host.units['turns-dispatch'].cioPrompt('brainstorm-discussion'),
          activeBrainstormSession
            ? await this.host.units['brainstorm-review'].brainstormAlignmentContext(
                projectId,
                threadId,
                true
              )
            : ''
        ]
          .filter(Boolean)
          .join('\n\n')
      : ''
    const engineeringSpecPrompt = brainstormingTurn
      ? await this.host.units['turns-dispatch'].cioPrompt('engineering-spec')
      : ''
    // This turn is never schema-enforced, because the agent must stay free to ask
    // product questions instead of submitting. The shape therefore travels in the
    // prompt, exactly as it does for drivers without structured output.
    const prdDiscussionPrompt = prdDiscussionTurn
      ? [
          await this.host.units['turns-dispatch'].cioPrompt('prd-discussion'),
          `The ${PRODUCT_REQUIREMENTS_DOCUMENT_TOOL_NAME} contract in this conversation is one JSON object matching this schema and nothing else: ${JSON.stringify(PRD_DOCUMENT_JSON_SCHEMA)}`
        ].join('\n\n')
      : ''
    const assignmentDiscussionPrompt = assignmentDiscussionTurn
      ? [
          await this.host.units['turns-dispatch'].cioPrompt('assignment-discussion'),
          `The ${ASSIGNMENT_PLAN_TOOL_NAME} contract in this conversation is one JSON object matching this schema and nothing else: ${JSON.stringify(ASSIGNMENT_PLAN_SCHEMA)}`
        ].join('\n\n')
      : ''
    const systemBasePrompt = brainstormingTurn
      ? composeBrainstormSystemPrompt({
          activeBrainstormTurn: activeBrainstormSession,
          assignmentMode: settings.assignmentMode === true,
          brainstormDiscussionPrompt,
          engineeringSpecPrompt,
          prdDiscussionPrompt,
          assignmentDiscussionPrompt,
          revisionPrompt: '',
          memoryInstruction: MEMORY_RESPONSE_BOUNDARY_INSTRUCTION,
          imageDescriptorNote,
          behaviorPrompt: promptBehavior,
          utilityInstructions,
          assistantInstruction
        })
      : composeTurnSystemPrompt({
          chatPrompt: chatSystemPrompt,
          memoryInstruction: MEMORY_RESPONSE_BOUNDARY_INSTRUCTION,
          imageDescriptorNote,
          assignmentCoordinatorSystemPrompt,
          behaviorPrompt: promptBehavior,
          utilityInstructions,
          assistantInstruction,
          behaviorMode
        })
    // The single production budget/composition decision: build the raw recap,
    // then let composeBudgetedSend cap the hidden + recap layers against the one
    // aggregate selected-model input budget and DETERMINISTICALLY REJECT when
    // the fixed user + system layers exceed the budget (never harness
    // truncation). Recompose the ACTUAL sent driverText from the precise hidden
    // allowance and sync the persisted mirror so the transport text matches.
    const composition = composeBudgetedSend({
      availableInputTokens: inputBudget,
      userText: text,
      systemPrompt: systemBasePrompt,
      hiddenText: hiddenContext,
      recapText: rawRecap,
      systemReserveTokens: SYSTEM_LAYER_RESERVE_TOKENS
    })
    utilityBudgetContext.composedTurnTokens = composition.totalTokens
    if (composition.driverText !== driverText) {
      driverText = composition.driverText
      const transportPart = userMessage.transportParts?.[0]
      if (transportPart && transportPart.type === 'text') {
        transportPart.text = driverText
        await this.host.threadManager.upsertMessages(projectId, threadId, [userMessage])
      }
    }
    const historyRecap = composition.recapText
    // The recap is now part of the turn's persisted driver text, so a driver
    // that keeps it natively no longer needs it replayed into a later prefix.
    // A driver that does not (pi) keeps the entry, because its transcript will
    // never hold the delta and the next turn still needs it.
    if (this.host.state.parkedSessionReplay.get(sessionId)?.repeat !== true) {
      this.host.state.parkedSessionReplay.delete(sessionId)
    }
    this.host.sessionStatuses.set(sessionId, { state: 'idle' })
    this.host.handledIdleSessions.delete(sessionId)
    // A fresh turn on this session is no longer a continuation of a stop the
    // user requested earlier   clear the marker so a real failure is reported.
    this.host.state.userAbortedSessions.delete(sessionId)

    const outboundIds =
      this.host.state.outboundMessageIdsBySession.get(sessionId) ?? new Set<string>()
    outboundIds.add(messageId)
    this.host.state.outboundMessageIdsBySession.set(sessionId, outboundIds)

    const workflow = await this.host.state.specEngine.getWorkflowState(projectId, threadId)
    const activeSpec =
      preloadedActiveSpec ??
      (planningSpecTurn && workflow?.activeSpecId && workflow.activeSpecVersion
        ? await this.host.state.specEngine.getVersion(
            projectId,
            threadId,
            workflow.activeSpecId,
            workflow.activeSpecVersion
          )
        : null)
    const shouldScheduleInitialSpec =
      planningSpecTurn &&
      !activeSpec &&
      !activeBrainstormSession &&
      !prdDiscussionTurn &&
      !assignmentDiscussionTurn
    if (planningSpecTurn) {
      if (!activeBrainstormSession) this.host.state.planningSessions.add(sessionId)
      const requestedSpec = specAction === 'request'
      const revisingSpec = activeSpec !== null
      let promptDispatched = false
      if (shouldScheduleInitialSpec) {
        await this.host.units['spec-lifecycle'].queuePendingInitialSpec({
          projectId,
          threadId,
          sessionId,
          source: text,
          settings
        })
      }
      if (prdDiscussionTurn) {
        const pendingPrdTurn: PendingPrdTurn = {
          schemaVersion: 1,
          projectId,
          threadId,
          sessionId,
          harnessId: driverId,
          ...(settings.providerId ? { providerId: settings.providerId } : {}),
          ...(settings.modelId ? { modelId: settings.modelId } : {}),
          createdAt: Date.now()
        }
        this.host.state.pendingPrdTurns.set(sessionId, pendingPrdTurn)
        await this.host.units['prd'].writePendingPrdTurn(pendingPrdTurn)
      }
      if (assignmentDiscussionTurn) {
        const pendingAssignmentTurn: PendingAssignmentTurn = {
          schemaVersion: 1,
          projectId,
          threadId,
          sessionId,
          harnessId: driverId,
          ...(settings.providerId ? { providerId: settings.providerId } : {}),
          ...(settings.modelId ? { modelId: settings.modelId } : {}),
          createdAt: Date.now()
        }
        this.host.state.pendingAssignmentTurns.set(sessionId, pendingAssignmentTurn)
        await this.host.units['assignment'].writePendingAssignmentTurn(pendingAssignmentTurn)
      }
      this.host.registerSession(
        sessionId,
        projectId,
        threadId,
        projectPath,
        settings.permissionLevel,
        driverId
      )
      const planningSession = this.host.sessionRegistry.get(sessionId)
      if (planningSession) planningSession.estimatedContextUsed = composition.totalTokens
      this.host.units['turns-sessions'].markSessionWorking(sessionId)
      try {
        if (requestedSpec && !revisingSpec && !activeBrainstormSession) {
          // OpenCode 1.18.x accepts JSON-schema output on prompt submission but
          // cannot decode that user message when history is loaded afterward.
          // Keep the persistent chat readable and run the enforced
          // engineering_spec/StructuredOutput contract in a disposable session.
          promptDispatched = true
          const generated = await this.host.units['spec-lifecycle'].runPendingInitialSpec(
            projectId,
            threadId
          )
          void scheduleAutoTitle()
          this.host.sessionStatuses.set(sessionId, { state: 'idle' })
          this.host.broadcast({ type: 'session.status', sessionId, status: { state: 'idle' } })
          await this.host.units['utilities'].cleanupTurnUtilities(sessionId)
          if (!generated) throw new Error(SPEC_GENERATION_FAILURE_USER_MESSAGE)
          const pendingMemory = this.host.state.pendingMemoryDecisions.get(sessionId)
          this.host.state.pendingMemoryDecisions.delete(sessionId)
          if (pendingMemory) {
            void this.host.units['memory']
              .proposeMemoryFromCompletedTurn(
                pendingMemory.userMessage,
                JSON.stringify(generated.content),
                projectId,
                threadId,
                messageId,
                driver,
                projectPath,
                pendingMemory.settings,
                pendingMemory.references
              )
              .catch((error) => Logger.error('Memory signal processing failed:', error))
          }
          return publicUserMessage
        }
        if (activeSpec && !prdDiscussionTurn && !assignmentDiscussionTurn) {
          const pendingRevision: PendingSpecRevision = {
            schemaVersion: 1,
            projectId,
            threadId,
            sessionId,
            specId: activeSpec.id,
            baseVersion: activeSpec.version,
            harnessId: driverId,
            providerId: settings.providerId,
            modelId: settings.modelId,
            createdAt: Date.now()
          }
          this.host.state.pendingSpecRevisions.set(sessionId, pendingRevision)
          await this.host.units['spec-authoring'].writePendingSpecRevision(pendingRevision)
        }
        if (activeBrainstormSession) {
          this.host.state.pendingBrainstormTurns.set(sessionId, {
            ...(activeBrainstormTurn
              ? {
                  brainstormId: activeBrainstormTurn.id,
                  version: activeBrainstormTurn.version
                }
              : {}),
            note: origin === 'user' ? text : ''
          })
        }
        const revisionPrompt =
          activeSpec && !prdDiscussionTurn && !assignmentDiscussionTurn
            ? buildSpecRevisionSystemPrompt(
                await this.host.units['media-artifacts'].artifactRef(
                  projectId,
                  threadId,
                  join('versions', `${activeSpec.id}-v${activeSpec.version}.md`)
                ),
                activeSpec.annotations
              )
            : ''
        // Expose the engineering_spec contract for real on interactive
        // spec-revision turns: structured-output-capable harnesses (claude-code)
        // enforce the schema on the final response, so the model cannot end the
        // turn without a valid specification submission. Brainstorm-discussion
        // turns stay conversational, and unsupported models keep the
        // validated text-JSON fallback in persistPendingSpecRevision.
        const structuredOutputKey = `${driverId}:${settings.providerId}:${settings.modelId}`
        const revisionStructuredOutput =
          activeSpec !== null &&
          !activeBrainstormSession &&
          !prdDiscussionTurn &&
          !assignmentDiscussionTurn &&
          driver.capabilities?.structuredOutput === true &&
          !this.host.state.unsupportedStructuredOutputModels.has(structuredOutputKey)
            ? {
                schema: specGenerationSchema(settings.assignmentMode === true),
                retryCount: 2
              }
            : undefined
        const prompt: SendPromptOptions = {
          sessionId,
          settings,
          text: driverText,
          attachments,
          systemPrompt: composeBrainstormSystemPrompt({
            activeBrainstormTurn: activeBrainstormSession,
            assignmentMode: settings.assignmentMode === true,
            brainstormDiscussionPrompt,
            engineeringSpecPrompt,
            prdDiscussionPrompt,
            assignmentDiscussionPrompt,
            revisionPrompt,
            memoryInstruction: MEMORY_RESPONSE_BOUNDARY_INSTRUCTION,
            imageDescriptorNote,
            behaviorPrompt,
            utilityInstructions,
            assistantInstruction
          }),
          allowedTools:
            activeBrainstormSession && driverId === 'opencode'
              ? [
                  ...SPEC_BRAINSTORM_ALLOWED_TOOLS,
                  `utilities_${UTILITY_SEARCH_TOOL_NAME}`,
                  `utilities_${UTILITY_ACTIVATE_TOOL_NAME}`,
                  `utilities_${UTILITY_INVOKE_TOOL_NAME}`
                ]
              : SPEC_BRAINSTORM_ALLOWED_TOOLS,
          ...(revisionStructuredOutput === undefined
            ? {}
            : { structuredOutput: revisionStructuredOutput }),
          ...(historyRecap ? { historyRecap } : {}),
          userMessageId: messageId
        }
        await this.host.units['turns-dispatch'].deliverWorkPrompt(
          projectId,
          threadId,
          userMessage,
          driverText,
          async (text) => {
            await driver.sendPrompt(projectPath, { ...prompt, text })
          }
        )
        this.host.state.sessionModelIds.set(sessionId, {
          providerId: settings.providerId,
          modelId: settings.modelId,
          thinkingLevel: settings.thinkingLevel ?? undefined
        })
        void scheduleAutoTitle()
        promptDispatched = true
      } catch (error) {
        this.host.state.pendingMemoryDecisions.delete(sessionId)
        await this.host.units['utilities'].cleanupTurnUtilities(sessionId)
        this.host.units['runtime-connectivity'].clearCompletionWaiter(sessionId)
        this.host.state.pendingSpecRevisions.delete(sessionId)
        this.host.state.pendingPrdTurns.delete(sessionId)
        this.host.state.pendingAssignmentTurns.delete(sessionId)
        this.host.state.pendingBrainstormTurns.delete(sessionId)
        await this.host.units['spec-lifecycle'].clearPendingSpecRevision(projectId, threadId)
        await this.host.units['prd'].clearPendingPrdTurn(projectId, threadId)
        await this.host.units['assignment'].clearPendingAssignmentTurn(projectId, threadId)
        if (shouldScheduleInitialSpec && !promptDispatched) {
          await this.host.units['spec-lifecycle'].clearPendingInitialSpec(projectId, threadId)
        }
        await this.host.threadManager.setStatus(projectId, threadId, 'failed', {
          error: rawErrorMessage(error),
          errorDetail: rawErrorDetail(error)
        })
        await this.host.units['thread-lifecycle'].broadcastThreadSessionError(
          projectId,
          threadId,
          sessionId,
          this.host.units['providers-accounts'].fallbackProviderIssue(
            driverId,
            rawErrorMessage(error),
            rawErrorDetail(error)
          )
        )
        throw error
      }
      return publicUserMessage
    }

    // A signed implementation turn must never inherit a pending planning
    // contract from an interrupted or previously completed revision turn.
    this.host.state.pendingSpecRevisions.delete(sessionId)
    this.host.state.pendingBrainstormTurns.delete(sessionId)
    await this.host.units['spec-lifecycle'].clearPendingSpecRevision(projectId, threadId)

    try {
      // Refresh the permission policy for the session used by this turn.
      this.host.registerSession(
        sessionId,
        projectId,
        threadId,
        projectPath,
        settings.permissionLevel,
        driverId,
        checkpointId
      )
      const activeSession = this.host.sessionRegistry.get(sessionId)
      if (activeSession) {
        activeSession.activeTurnUserMessageId = messageId
        activeSession.activeTurnOrigin = origin
        activeSession.activeTurnOvenId = settings.ovenId ?? 'local'
        activeSession.estimatedContextUsed = composition.totalTokens
      }
      this.host.units['turns-sessions'].markSessionWorking(sessionId)
      // Chat owns a writable cwd even with File System off. External paths
      // remain subject to the thread's file-access permission policy.
      dispatchTimer.mark('dispatchStart')
      await this.host.units['turns-dispatch'].deliverWorkPrompt(
        projectId,
        threadId,
        userMessage,
        driverText,
        async (text) => {
          await driver.sendPrompt(projectPath, {
            sessionId,
            // Full Access may skip native permission events. With File System
            // off, retain the native cwd sandbox so external paths still ask.
            settings:
              isChatThread && !chatFileSystemEnabled
                ? { ...settings, permissionLevel: 'auto_review' }
                : settings,
            text,
            attachments,
            readOnly: false,
            systemPrompt:
              composeTurnSystemPrompt({
                chatPrompt: chatSystemPrompt,
                memoryInstruction: MEMORY_RESPONSE_BOUNDARY_INSTRUCTION,
                imageDescriptorNote,
                assignmentCoordinatorSystemPrompt,
                behaviorPrompt,
                utilityInstructions,
                assistantInstruction,
                behaviorMode
              }) || undefined,
            allowedTools:
              isChatThread &&
              !chatFileSystemEnabled &&
              (!utilitySetupAllowed || projectId === GLOBAL_BROWSER_PROJECT_ID)
                ? [...CHAT_WORKSPACE_TOOLS, ...chatGatewayAllowedTools(driverId)]
                : undefined,
            agent: utilitySetupRequested
              ? leanAgentNameForMode('utility-setup')
              : isAssistantTask
                ? leanAgentNameForMode('assistant')
                : isChatThread
                  ? leanAgentNameForMode(chatFileSystemEnabled ? 'file-system-chat' : 'inbox-chat')
                  : undefined,
            ...(historyRecap ? { historyRecap } : {}),
            userMessageId: messageId
          })
          dispatchTimer.mark('harnessAccepted')
          dispatchTimer.finish()
        }
      )
      if (utilitySetupRequested || isChatThread || isAssistantTask) {
        traceLeanAgent(
          utilitySetupRequested
            ? 'utility-setup'
            : isAssistantTask
              ? 'assistant'
              : chatFileSystemEnabled
                ? 'file-system-chat'
                : 'inbox-chat',
          sessionId,
          driverId
        )
      }
      this.host.state.sessionModelIds.set(sessionId, {
        providerId: settings.providerId,
        modelId: settings.modelId,
        thinkingLevel: settings.thinkingLevel ?? undefined
      })
      void scheduleAutoTitle()
      if (origin === 'internal' && isCoordinatorThread(targetThread)) {
        try {
          await this.host.units['assignment-run'].completeCoordinatorHandoff(
            projectId,
            threadId,
            messageId
          )
        } catch (error) {
          Logger.error('Dispatched coordinator handoff could not be removed from its queue', {
            projectId,
            threadId,
            messageId,
            error: rawErrorMessage(error)
          })
        }
      }
      this.host.state.preparedImplementationSessions.delete(sessionId)
    } catch (error) {
      this.host.state.pendingMemoryDecisions.delete(sessionId)
      dispatchTimer.mark('dispatchFailed')
      dispatchTimer.finish()
      await this.host.units['utilities'].cleanupTurnUtilities(sessionId)
      this.host.state.preparedImplementationSessions.delete(sessionId)
      const failure = error instanceof Error ? error.message : String(error)
      await this.host.units['transcripts'].finishCheckpoint(
        sessionId,
        this.host.sessionRegistry.get(sessionId),
        'failed',
        failure
      )
      await this.host.threadManager.setStatus(projectId, threadId, 'failed', {
        error: failure,
        errorDetail: rawErrorDetail(error)
      })
      await this.host.units['thread-lifecycle'].broadcastThreadSessionError(
        projectId,
        threadId,
        sessionId,
        this.host.units['providers-accounts'].fallbackProviderIssue(
          driverId,
          failure,
          rawErrorDetail(error)
        )
      )
      throw error
    }
    return publicUserMessage
  }
}
