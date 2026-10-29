import { tick } from 'svelte'
import { mergeStreamedPart } from '$shared/agent-part-merge'
import { reconcilesPendingAttention } from '$lib/session-attention'
import { normalizeComposerMessage } from '../../chats/composer-mentions'
import { invoke } from '$lib/ipc.svelte'
import { messageId } from '$shared/id'
import {
  rendererRecovery,
  type StartAfterThreadReference
} from '$lib/stores/renderer-recovery.svelte'
import { threadMessages } from '$lib/stores/thread-messages.svelte'
import { scopeJobs } from '$lib/stores/scope-jobs.svelte'
import { agentRuns } from '$lib/stores/agent-runs.svelte'
import {
  responseReferencesState,
  type ResponseReferenceAnchor
} from '$lib/stores/response-references.svelte'
import type {
  AgentEvent,
  AgentSessionStatus,
  PromptAttachment,
  PromptAssignmentTaskReference,
  PromptProjectReference,
  PermissionRequest,
  SpecActionIntent,
  PendingAgentQuestionRequest,
  UserMessagePresentation,
  EngineeringLifecycleState
} from '$shared/types'
import { hasSelectedStage } from '$shared/engines/engineering-lifecycle-engine'
import { LiveGenerationRate, generatedTokens } from '$lib/token-rate.svelte'
import type { SendPayload } from '../ConversationController.svelte'
import type { ThreadView } from './ThreadView-board.svelte'
/** One concern of the ThreadView board. */
export class ThreadViewHandleAgentEvent {
  #root: ThreadView | undefined
  /** The board this unit belongs to; set before any member of it runs. */
  get root(): ThreadView {
    if (!this.#root)
      throw new Error('ThreadViewHandleAgentEvent read its board before it was bound')
    return this.#root
  }
  constructor(root: ThreadView) {
    this.#root = root
  }
  thread = $derived(this.root.props.thread ?? this.root.unmirroredTraceStartTime.mountedThread)

  // Intentional initial-value capture   view is remounted (keyed) per thread.
  // svelte-ignore state_referenced_locally
  sessionId = $state(this.thread.sessionId ?? '')

  // Live tokens-per-second tracker for the assistant message currently streaming,
  // plus finalized per-message rates kept for the turn's hover row. The tracker
  // learns its characters-per-token factor from the requests that report token
  // counts, so a harness that reports late (pi reports at each request end,
  // cline only at turn end, muse never) is estimated at its own tokenization
  // rather than a fixed average.
  liveTokenRate = new LiveGenerationRate()

  engineeringLifecycle = $state<EngineeringLifecycleState | null>(null)

  pendingPermissions = $state<PermissionRequest[]>([])

  errorMessage = $state('')

  providerStatus = $state<AgentSessionStatus | null>(null)

  handleAgentEvent(event: AgentEvent): void {
    // A controller-driven conversation is still a real conversation when it is
    // durable (a browser tab's assistant chat is a thread of its own), so the
    // events that carry a human gate have to reach it: a question the agent asked
    // has no other surface, and a card the user never sees leaves the panel
    // blocked until the question times out. Everything else this view handles is
    // either published by the primary conversation surface, which a panel must
    // never touch, or owned by the controller's own store.
    if (this.root.props.controller) {
      if (event.type === 'question.asked' || event.type === 'question.updated') {
        // No session filter: a panel can mount before it has learned its session
        // id, and reconciling asks main for this conversation's own queue, so an
        // event belonging to another conversation costs one read and nothing else.
        void this.root.composerScope.refreshPendingQuestions()
        return
      }
      if (event.type === 'question.resolved') {
        this.root.sources.resolvedQuestionRequestIds.add(event.requestId)
        this.pendingQuestionRequests = this.pendingQuestionRequests.filter(
          (request) => request.requestId !== event.requestId
        )
      }
      return
    }

    if (
      event.type === 'spec.trace' &&
      event.projectId === this.thread.projectId &&
      event.threadId === this.thread.id
    ) {
      this.root.unmirroredTraceStartTime.knownEphemeralSessionIds.add(event.sessionId)
      this.root.sources.applySpecGenerationTrace(event.update)
      return
    }
    if (
      event.type === 'assignment.trace' &&
      event.projectId === this.thread.projectId &&
      event.threadId === this.thread.id
    ) {
      this.root.unmirroredTraceStartTime.knownEphemeralSessionIds.add(event.sessionId)
      this.root.sources.applyAssignmentGenerationTrace(event.update)
      return
    }
    if (
      event.type === 'brainstorm.trace' &&
      event.projectId === this.thread.projectId &&
      event.threadId === this.thread.id
    ) {
      this.root.unmirroredTraceStartTime.knownEphemeralSessionIds.add(event.sessionId)
      if (event.update.type === 'refresh.failed') {
        this.errorMessage = event.update.error
      }
      return
    }
    if (
      event.type === 'checkpoint.updated' &&
      event.projectId === this.thread.projectId &&
      event.threadId === this.thread.id
    ) {
      void this.root.abortRun.refreshCompletedTurn()
      return
    }
    if (
      (event.type === 'spec.ready' ||
        event.type === 'brainstorm.ready' ||
        event.type === 'prd.ready' ||
        event.type === 'assignment.ready') &&
      event.projectId === this.thread.projectId &&
      event.threadId === this.thread.id
    ) {
      if (event.type === 'spec.ready') this.root.sources.clearSpecGenerationTrace()
      this.root.sources.clearAssignmentGenerationTrace()
      this.root.abortRun.clearLocalTurn()
      agentRuns.setIdle(this.thread.projectId, this.thread.id)
      if (this.providerStatus?.state !== 'error') this.providerStatus = null
      void this.root.submitBrainstormDecision.reconcileReadySpec().catch((error) => {
        this.errorMessage =
          error instanceof Error ? error.message : 'The specification could not be loaded.'
      })
      return
    }
    if (event.type === 'thread.error') {
      if (event.projectId !== this.thread.projectId || event.threadId !== this.thread.id) return
      this.root.sources.clearSpecGenerationTrace()
      this.root.sources.clearAssignmentGenerationTrace()
      this.root.buildSpecActionPrompt.restoredBusy = false
      this.root.abortRun.clearLocalTurn()
      agentRuns.setIdle(this.thread.projectId, this.thread.id)
      this.pendingPermissions = []
      this.pendingQuestionRequests = []
      this.root.sources.pendingImageDescriptorError = null
      this.root.composerScope.setProviderStatusFromIssue(event.issue)
      void this.root.abortRun.refreshCheckpoints()
      return
    }
    if (!this.sessionId) return

    switch (event.type) {
      case 'message.part.updated': {
        if (event.sessionId !== this.sessionId) return
        this.root.abortRun.acknowledgeLocalTurn()
        const streamPartIndex = this.root.pollStreamParts.streamTrace.parts.findLastIndex(
          (part) => part.id === event.part.id
        )
        this.root.pollStreamParts.streamTrace.setParts(
          streamPartIndex === -1
            ? [...this.root.pollStreamParts.streamTrace.parts, event.part]
            : this.root.pollStreamParts.streamTrace.parts.map((part, index) =>
                index === streamPartIndex ? mergeStreamedPart(part, event.part) : part
              )
        )
        // Every harness publishes its output as part snapshots, so the text
        // length is the one progress signal available everywhere. Snapshots
        // repeat the whole text, so only growth counts.
        const part = event.part
        if (part.type === 'text' || part.type === 'reasoning') {
          this.liveTokenRate.noteSnapshot(
            part.messageID,
            part.id,
            part.text.length + (part.type === 'reasoning' ? (part.summary?.length ?? 0) : 0)
          )
        }
        if (event.part.type === 'subagent') this.root.abortRun.syncOpenSubagentTabs()
        break
      }
      case 'message.part.delta': {
        if (event.sessionId !== this.sessionId) return
        this.root.abortRun.acknowledgeLocalTurn()
        if (event.delta.length > 0) {
          this.liveTokenRate.noteDelta(event.messageId, event.partId, event.delta.length)
        }
        break
      }
      case 'message.completed': {
        if (event.sessionId !== this.sessionId) return
        this.root.studioTemporaryChatContext.recordGenerationUsage(event)
        this.root.abortRun.acknowledgeLocalTurn()
        // Record what the harness reported before closing the window, so this
        // request's own count teaches the characters-per-token calibration, and
        // in the scope the harness declared: a per-request count is summed
        // across the message's requests instead of keeping the largest.
        if (event.tokens && generatedTokens(event.tokens) > 0) {
          this.liveTokenRate.noteReported(
            event.messageId,
            generatedTokens(event.tokens),
            event.tokenUsageScope ?? 'message'
          )
        }
        // The request's generation window ends here, so the next request starts
        // a fresh one and the tool wait between them is never counted.
        this.liveTokenRate.completeRequest(event.messageId)
        if (event.compaction) {
          this.root.abortRun.turnSawCompaction = true
        } else {
          this.root.abortRun.turnSawAnswer = true
        }
        if (event.error) {
          this.root.abortRun.clearLocalTurn()
          agentRuns.setIdle(this.thread.projectId, this.thread.id)
          // The user intentionally stopped this turn   its abort error is not
          // a session failure, so never surface the error banner.
          if (!this.root.abortRun.userRequestedStop) {
            if (event.issue) {
              this.root.composerScope.setProviderStatusFromIssue(event.issue)
            } else {
              this.errorMessage = event.error
            }
          }
        }
        break
      }
      case 'usage.updated': {
        if (event.sessionId !== this.sessionId) return
        this.root.studioTemporaryChatContext.recordGenerationUsage(event)
        if (event.tokens && generatedTokens(event.tokens) > 0) {
          this.liveTokenRate.noteReported(
            event.messageId,
            generatedTokens(event.tokens),
            event.tokenUsageScope ?? 'message'
          )
        }
        break
      }
      case 'session.idle': {
        if (event.sessionId !== this.sessionId) return
        this.liveTokenRate.settle()
        if (this.liveTokenRate.messageId) {
          const finalizedId = this.liveTokenRate.messageId
          const observation = this.liveTokenRate.observation()
          const rate = this.liveTokenRate.finalize()
          if (rate !== null) {
            this.root.unmirroredTraceStartTime.finalizedTokenRates[finalizedId] = rate
            if (observation)
              this.root.switchProject.finalizedGenerationObservation = {
                messageId: finalizedId,
                observation
              }
          }
        }
        const interruptedCompaction = this.root.abortRun.compactionInterrupted()
        if (!this.root.abortRun.setIdleFromSession()) return
        if (interruptedCompaction) {
          this.root.unmirroredTraceStartTime.compactionInterruptedNotice =
            'Context compaction was interrupted before your message could be processed. Send it again to continue.'
        }
        // Error and will-retry cards survive idle (the scheduled auto-resume
        // owns the session now); everything else clears.
        if (this.providerStatus?.state !== 'error' && this.providerStatus?.state !== 'waiting') {
          this.providerStatus = null
        }
        void this.root.pollStreamParts.refreshStreamTailAfterTurn()
        void this.root.abortRun.refreshCheckpoints()
        setTimeout(() => void this.root.studioTemporaryChatContext.refreshEfficiencyKpis(), 100)
        this.root.composerScope.scheduleReadySpecReconcile()
        this.root.steerQueuedMessage.scheduleIdleAttention()
        break
      }
      case 'session.error': {
        if (event.sessionId !== this.sessionId) return
        this.liveTokenRate.clear()
        this.root.abortRun.clearLocalTurn()
        agentRuns.setIdle(this.thread.projectId, this.thread.id)
        this.pendingPermissions = []
        this.pendingQuestionRequests = []
        this.root.sources.pendingImageDescriptorError = null
        if (!this.root.abortRun.userRequestedStop) {
          if (event.issue) {
            this.root.composerScope.setProviderStatusFromIssue(event.issue)
          } else {
            this.errorMessage = event.error ?? 'The harness session failed.'
          }
        }
        void this.root.pollStreamParts.refreshStreamTailAfterTurn()
        void this.root.abortRun.refreshCheckpoints()
        break
      }
      case 'session.status': {
        if (event.sessionId !== this.sessionId) return
        const previousProviderStatus = this.providerStatus
        const preserveRawError =
          previousProviderStatus?.state === 'error' &&
          Boolean(previousProviderStatus.issue.rawError) &&
          event.status.state === 'error' &&
          !event.status.issue.rawError
        if (
          !preserveRawError &&
          (event.status.state !== 'idle' || previousProviderStatus?.state !== 'error')
        ) {
          this.providerStatus = event.status
        }
        if (event.status.state === 'working') {
          this.root.buildSpecActionPrompt.restoredBusy = false
          this.root.abortRun.acknowledgeLocalTurn()
          this.root.steerQueuedMessage.idleAttentionHandled = false
          this.root.currentWorkingTraceAttribution.ensureLiveWorkingSelection()
          agentRuns.setBusy(
            this.thread.projectId,
            this.thread.id,
            true,
            this.root.submitBrainstormDecision.latestUserMessageId(),
            event.status.state === 'working' ? event.status.startedAt : undefined
          )
          this.errorMessage = ''
        } else if (event.status.state === 'waiting') {
          this.root.buildSpecActionPrompt.restoredBusy = false
          this.root.abortRun.acknowledgeLocalTurn()
          if (!this.root.abortRun.setIdleFromSession()) return
          this.errorMessage = ''
          // 'waiting' is the status a paused permission/question turn reports,
          // but the only other update this triggers is the raw
          // permission.asked/question.asked push, gated on an exact sessionId
          // match. If that push is missed (or its sessionId no longer matches
          // this view's current session), the request card never appears
          // until the view remounts and re-fetches from scratch. Reconcile the
          // authoritative pending queues the same way the 'idle' transition
          // already does below, so a missed push self-heals instead of
          // requiring the user to leave and come back.
          if (reconcilesPendingAttention(event.status.state))
            this.root.steerQueuedMessage.scheduleIdleAttention()
        } else if (event.status.state === 'idle') {
          const interruptedCompaction = this.root.abortRun.compactionInterrupted()
          if (!this.root.abortRun.setIdleFromSession()) return
          if (interruptedCompaction) {
            this.root.unmirroredTraceStartTime.compactionInterruptedNotice =
              'Context compaction was interrupted before your message could be processed. Send it again to continue.'
          }
          // Error and will-retry cards survive idle; everything else clears.
          if (
            previousProviderStatus?.state !== 'error' &&
            previousProviderStatus?.state !== 'waiting'
          ) {
            this.providerStatus = null
          }
          this.root.composerScope.scheduleReadySpecReconcile()
          if (reconcilesPendingAttention(event.status.state))
            this.root.steerQueuedMessage.scheduleIdleAttention()
        } else {
          this.root.abortRun.clearLocalTurn()
          agentRuns.setIdle(this.thread.projectId, this.thread.id)
        }
        break
      }
      case 'permission.asked': {
        if (
          event.sessionId !== this.sessionId &&
          !this.root.unmirroredTraceStartTime.knownEphemeralSessionIds.has(event.sessionId)
        )
          return
        this.pendingPermissions = [
          ...this.pendingPermissions.filter((request) => request.id !== event.permission.id),
          event.permission
        ]
        break
      }
      case 'permission.replied': {
        if (
          event.sessionId !== this.sessionId &&
          !this.root.unmirroredTraceStartTime.knownEphemeralSessionIds.has(event.sessionId)
        )
          return
        this.pendingPermissions = this.pendingPermissions.filter(
          (request) => request.id !== event.requestId
        )
        break
      }
      case 'imageDescriptor.error': {
        if (event.projectId !== this.thread.projectId || event.threadId !== this.thread.id) return
        this.root.sources.pendingImageDescriptorError = event.request
        break
      }
      case 'imageDescriptor.resolved': {
        if (event.projectId !== this.thread.projectId || event.threadId !== this.thread.id) return
        if (this.root.sources.pendingImageDescriptorError?.id === event.requestId) {
          this.root.sources.pendingImageDescriptorError = null
        }
        break
      }
      case 'question.asked': {
        if (event.sessionId !== this.sessionId) return
        void this.root.composerScope.refreshPendingQuestions()
        break
      }
      case 'question.updated': {
        if (event.sessionId !== this.sessionId) return
        void this.root.composerScope.refreshPendingQuestions()
        break
      }
      case 'question.resolved': {
        if (event.sessionId !== this.sessionId) return
        this.root.sources.resolvedQuestionRequestIds.add(event.requestId)
        this.pendingQuestionRequests = this.pendingQuestionRequests.filter(
          (request) => request.requestId !== event.requestId
        )
        break
      }
    }
  }

  pendingQuestionRequests = $state<PendingAgentQuestionRequest[]>([])

  async sendMessage(
    text: string,
    attachments: PromptAttachment[],
    specAction?: SpecActionIntent,
    direct?: boolean,
    promptContext?: string,
    promptReferences: ResponseReferenceAnchor[] = [],
    projectReferences: PromptProjectReference[] = [],
    presentation?: UserMessagePresentation,
    taskReferences: PromptAssignmentTaskReference[] = [],
    restorable?: boolean,
    startAfterThreads: StartAfterThreadReference[] = []
  ): Promise<void> {
    if (this.root.props.controller) {
      this.errorMessage = ''
      this.providerStatus = null
      // A stale transport/load error must not keep the provider status card on
      // screen while the new turn runs   the same rule the thread path follows
      // by clearing cached error state at send time.
      this.root.props.controller.clearError()
      this.root.steerQueuedMessage.idleAttentionHandled = false
      // Snapshot the selection this turn starts with before anything else can
      // change it   identical to the thread path, so mid-turn composer edits
      // never re-label the running trace.
      this.root.currentWorkingTraceAttribution.captureLiveWorkingSelection()
      // A controller-driven conversation backed by a real thread (a browser
      // tab's assistant) queues exactly like the primary surface: while the
      // agent is busy a plain send parks behind the running turn instead of
      // steering it, and a direct send still reaches the live turn. A temporary
      // side chat owns no durable thread to park in, so it always dispatches
      // straight through its controller.
      if (this.root.props.controller.kind === 'thread') {
        const dependencyThreads = startAfterThreads.filter(
          (reference) => reference.id !== this.thread.id && reference.id.length > 0
        )
        if (dependencyThreads.length > 0 || (this.root.switchProject.busy && !direct)) {
          this.root.steerQueuedMessage.parkComposerSend({
            text: normalizeComposerMessage(text, projectReferences),
            attachments,
            promptContext,
            promptReferences,
            projectReferences,
            presentation,
            taskReferences,
            startAfterThreads: dependencyThreads
          })
          return
        }
      }
      const payload: SendPayload = {
        text,
        attachments,
        specAction,
        direct,
        promptContext,
        promptReferences,
        projectReferences,
        presentation,
        taskReferences
      }
      await this.root.props.controller.send(payload)
      this.root.sources.recordModelUse()
      return
    }

    const msg = normalizeComposerMessage(text, projectReferences)
    const hasAttachments = (attachments?.length ?? 0) > 0
    const hasProjectReferences = (projectReferences?.length ?? 0) > 0
    const hasTaskReferences = (taskReferences?.length ?? 0) > 0
    const hasPromptReferences = (promptReferences?.length ?? 0) > 0
    const hasPromptContext = Boolean(promptContext)
    // Allow an empty message when there is attached context   a user comment on
    // a response selection, files, or references   so those alone can be sent.
    if (
      !msg &&
      !hasAttachments &&
      !hasProjectReferences &&
      !hasTaskReferences &&
      !hasPromptReferences &&
      !hasPromptContext
    ) {
      return
    }
    if (this.root.harnessUsage.specFormulating && specAction !== 'request') return
    if (specAction === undefined && this.engineeringLifecycle?.activeStage === 'achievement') {
      if (
        !this.root.submitBrainstormDecision.spec ||
        this.root.submitBrainstormDecision.spec.status !== 'approved'
      ) {
        this.errorMessage = 'Achievement requires an approved Spec.'
        return
      }
      specAction = 'implement'
    }
    const dependencyThreads = startAfterThreads.filter(
      (reference) => reference.id !== this.thread.id && reference.id.length > 0
    )
    // A scope worktree still building for this thread owns the next send: park
    // the message behind the scope switch so it runs in the new scope instead
    // of the old one. Direct steers cannot bypass it because the checkout the
    // message must run in does not exist yet.
    const pendingScopeSwitch =
      !this.root.loadOlderMessages.hasController &&
      scopeJobs.hasPendingScopeJob(this.thread.projectId, this.thread.id)
    if (
      dependencyThreads.length > 0 ||
      (this.root.switchProject.busy && !direct) ||
      pendingScopeSwitch
    ) {
      this.root.steerQueuedMessage.parkComposerSend({
        text: msg,
        attachments,
        promptContext,
        promptReferences,
        projectReferences,
        presentation,
        taskReferences,
        startAfterThreads: dependencyThreads
      })
      return
    }

    const selectedAssignment =
      this.engineeringLifecycle?.activeStage === 'assignment' ||
      this.engineeringLifecycle?.humanGate === 'assignment_approval'
    if (selectedAssignment && specAction === undefined) {
      // A Spec that exists but is not approved still owns the Assignment, so ask
      // for approval first. Only while no Assignment exists yet: once the board
      // is there, the message belongs to the Assignment conversation.
      if (
        this.root.submitBrainstormDecision.spec &&
        this.root.submitBrainstormDecision.spec.status !== 'approved' &&
        this.root.submitSpecDecision.assignment === null
      ) {
        this.root.submitSpecDecision.assignmentError =
          'Approve the Spec before generating an Assignment from it.'
        return
      }
      if (this.engineeringLifecycle?.activeStage === undefined) {
        this.engineeringLifecycle = (
          await invoke('engineeringLifecycle:start', this.thread.projectId, this.thread.id)
        ).state
      }
      if (this.engineeringLifecycle?.autopilot === true) {
        // Autopilot has nobody to answer, so it keeps the forced background
        // decomposition instead of opening an interview.
        await this.root.submitSpecDecision.generateAssignmentDraft(msg)
        return
      }
      // Fall through on purpose: an Assignment-stage message is the Assignment
      // interview. The Sr. Engineer either submits the task graph or asks the
      // questions the thread and the message together cannot settle.
    }

    const lifecycleStarted =
      this.engineeringLifecycle !== null &&
      this.engineeringLifecycle !== undefined &&
      this.engineeringLifecycle.startedAt !== undefined
    const selectedPrd =
      this.engineeringLifecycle?.activeStage === 'prd' ||
      (hasSelectedStage(this.engineeringLifecycle, 'prd') &&
        this.engineeringLifecycle?.activeStage === undefined &&
        !lifecycleStarted)
    // Read once: the entry card below and the PRD branch further down both need
    // the persisted PRD workflow stage.
    const selectedPrdWorkflow = selectedPrd
      ? await invoke('prd:ensureWorkflow', this.thread.projectId, this.thread.id)
      : null

    // PRD/Spec need context: show the "Brainstorm first | Jump directly into…"
    // card at SEND time, never when the Toolbox switch is toggled. Jumping in
    // still lets the Sr. Engineer align   it just skips the Brainstorm document.
    const entryPrd = hasSelectedStage(this.engineeringLifecycle, 'prd')
    const entrySpec = hasSelectedStage(this.engineeringLifecycle, 'spec')
    if (
      this.engineeringLifecycle &&
      this.engineeringLifecycle.activeStage === undefined &&
      !this.engineeringLifecycle.autopilot &&
      !hasSelectedStage(this.engineeringLifecycle, 'brainstorm') &&
      !hasSelectedStage(this.engineeringLifecycle, 'assignment') &&
      !hasSelectedStage(this.engineeringLifecycle, 'achievement') &&
      (entryPrd || entrySpec)
    ) {
      // A resolved entry choice, not a produced document, is what makes the
      // message routable. Asking for documents reopened the card on every later
      // send, because both choices leave them absent for a while: "Start PRD"
      // moves the PRD workflow to `drafting` and "Brainstorm first" saves the
      // entry on the Brainstorm workflow.
      const contextReady = entryPrd
        ? !selectedPrd || selectedPrdWorkflow?.stage !== 'choice_pending'
        : Boolean(
            this.root.editVideoNote.brainstorm?.status === 'finalized' ||
            this.root.harnessUsage.prd !== null ||
            this.root.submitBrainstormDecision.spec !== null ||
            this.root.submitBrainstormDecision.brainstormWorkflow?.entryChoice !== undefined
          )
      if (!contextReady) {
        // Park the send and hand its draft back while the card is up. Returning
        // without this dropped both: the composer had already cleared its
        // buffer, and nothing resent the message once the choice resolved.
        this.root.editVideoNote.pendingEntrySend = {
          text,
          attachments,
          ...(direct ? { direct } : {}),
          ...(promptContext ? { promptContext } : {}),
          ...(specAction ? { specAction } : {}),
          ...(presentation ? { presentation } : {}),
          promptReferences,
          projectReferences,
          taskReferences,
          startAfterThreads
        }
        rendererRecovery.setDraft(
          this.thread.projectId,
          this.thread.id,
          text,
          attachments,
          projectReferences,
          taskReferences
        )
        if (promptReferences.length > 0) {
          responseReferencesState.setForThread(
            this.thread.projectId,
            this.thread.id,
            promptReferences
          )
          this.root.steerQueuedMessage.scheduleResponseHighlightRestore(promptReferences)
        }
        this.root.currentWorkingTraceAttribution.composerRestoreKey += 1
        if (this.root.editVideoNote.pendingEngineeringEntry === null) {
          this.root.editVideoNote.pendingEngineeringEntry = entryPrd ? 'prd' : 'spec'
        }
        return
      }
    }

    if (selectedPrd && selectedPrdWorkflow?.stage !== 'brainstorming' && specAction === undefined) {
      if (selectedPrdWorkflow?.stage === 'choice_pending') {
        this.root.harnessUsage.prdError =
          'Choose Brainstorm first or Start PRD before sending the requirements.'
        return
      }
      // The PRD stage is conversational: this message becomes an ordinary turn
      // under the PRD prompt, and the agent either writes the document or asks the
      // product questions the document still needs. The document itself arrives
      // through the `prd.ready` broadcast once the agent submits it.
      this.root.harnessUsage.prdError = ''
      if (this.engineeringLifecycle?.activeStage === undefined) {
        this.engineeringLifecycle = (
          await invoke('engineeringLifecycle:start', this.thread.projectId, this.thread.id)
        ).state
      }
    }

    this.root.sources.recordModelUse()

    // Follow the new message only when the reader is already at the tail. A
    // reader scrolled up into history keeps their position: the optimistic
    // message lands at the tail off-screen, and on-screen messages must never
    // unmount   releasing the tail lock here would re-window and hide them.
    this.root.steerQueuedMessage.idleAttentionHandled = false

    // Persist settings as last-used. Each family seeds its own store, so the
    // next chat or assistant task inherits this thread's model, thinking level
    // and File System state, never another family's configuration.
    this.root.sources.commitSettings(this.root.loadOlderMessages.settings)

    this.errorMessage = ''
    this.providerStatus = null

    // Use a stable UUIDv7 for the optimistic message and the persisted mirror
    // message so they merge cleanly across thread switches. Mark the run busy
    // before waiting for a slow first connection so the initial send is
    // acknowledged immediately and cannot be submitted again.
    const userMessageId = messageId()
    const { projectId, id } = this.thread
    this.root.buildSpecActionPrompt.beginLocalTurn(userMessageId)
    this.root.currentWorkingTraceAttribution.captureLiveWorkingSelection()
    agentRuns.setBusy(projectId, id, true, userMessageId)

    // Set the moment the dispatch settles: from that instant the prompt is the
    // agent's, and everything the rest of this block does (the scroll, the
    // Engineering reconciliation) is bookkeeping around a turn that is already
    // running. A failure in that bookkeeping must never hand the message back to
    // the composer   the buffer the user just emptied would refill with the
    // words the agent is already answering, which reads as "the send did nothing"
    // even though the work started.
    let dispatched = false
    try {
      const sendPromise = threadMessages.send(
        projectId,
        id,
        this.root.loadOlderMessages.settings,
        msg,
        attachments,
        specAction,
        userMessageId,
        this.root.currentWorkingTraceAttribution.prepareSessionForSend,
        promptContext,
        promptReferences,
        projectReferences,
        presentation,
        taskReferences
      )
      // Wait for the DOM to reflect the optimistic message, then scroll to it
      //   but only when the reader stayed at the tail. A detached reader is
      // never yanked; their on-screen messages must stay mounted.
      await tick()
      if (this.root.loadOlderMessages.scrollEl && !this.root.loadOlderMessages.userScrolledAway)
        this.root.loadOlderMessages.scrollEl.scrollTop =
          this.root.loadOlderMessages.scrollEl.scrollHeight
      await sendPromise
      dispatched = true
      if (this.root.submitBrainstormDecision.engineeringOn) {
        await this.root.submitBrainstormDecision.reconcileReadySpec()
        if (this.root.submitBrainstormDecision.brainstormWorkflow?.stage === 'choice_pending') {
          this.root.abortRun.clearLocalTurn()
          agentRuns.setIdle(projectId, id)
        }
      }
    } catch (error) {
      this.root.abortRun.clearLocalTurn()
      agentRuns.setIdle(projectId, id)
      const failure = error instanceof Error ? error.message : 'The prompt could not be sent.'
      this.errorMessage = failure
      // Only when the message never reached the conversation   the agent never
      // started working, so nothing on screen owns the words   is it put back in
      // the composer. Once `dispatched` is set the optimistic user message is
      // that copy, and a later failure has to leave the composer empty.
      if (restorable && !dispatched) {
        rendererRecovery.setDraft(
          projectId,
          id,
          msg,
          attachments,
          projectReferences,
          taskReferences
        )
        this.root.currentWorkingTraceAttribution.composerRestoreKey += 1
      }
      if (promptReferences.length > 0) {
        responseReferencesState.setForThread(projectId, id, promptReferences)
        this.root.steerQueuedMessage.scheduleResponseHighlightRestore(promptReferences)
      }
      void this.root.abortRun.refreshCheckpoints()
      if (specAction === 'request') {
        throw error instanceof Error ? error : new Error(failure)
      }
    }
  }
}
