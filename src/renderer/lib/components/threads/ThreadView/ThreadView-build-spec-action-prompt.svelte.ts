import { tick } from 'svelte'
import { scopeState } from '$lib/stores/scope.svelte'
import { invoke } from '$lib/ipc.svelte'
import { workspaceState } from '$lib/stores/workspace.svelte'
import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
import { modelKey } from '$lib/model-keys'
import { threadMessages } from '$lib/stores/thread-messages.svelte'
import { agentRuns } from '$lib/stores/agent-runs.svelte'
import { revealFileInAppTree } from '$lib/reveal-file'
import type {
  Thread,
  ThreadSettings,
  AgentMessage,
  EngineeringSpec,
  AuditReport,
  AuditSectionId,
  SpecActionIntent
} from '$shared/types'
import {
  isActivityOnlyUserMessage,
  lastTurnStartIndex,
  pendingTurnAnchorIndex
} from '../thread-turn-parts'
import type { AssignmentAuditDisplayState } from './ThreadView-types'
import type { ThreadView } from './ThreadView-board.svelte'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the ThreadView board. */
export class ThreadViewBuildSpecActionPrompt extends BoardUnit<ThreadView> {
  constructor(root: ThreadView) {
    super(root)
  }
  /**
   * The transcript as of its last structural change: identity, role, and
   * timestamps, without subscribing to streamed content. A delta replaces text
   * inside an existing part without moving this reference, so everything that
   * only needs the shape of the conversation   which window is mounted, where
   * the last turn starts, what the user has already asked   reads this instead
   * of the live `messages` array and stops recomputing at the stream cadence.
   */
  structureMessages = $derived.by(() => {
    const source = this.root.loadOlderMessages.hasController
      ? this.root.loadOlderMessages.messages
      : threadMessages.structureMessages(
          this.root.handleAgentEvent.thread.projectId,
          this.root.handleAgentEvent.thread.id
        )
    // A held steer has not reached the harness, so it must not open a turn: the
    // turn it steers keeps its own trace above the message instead of splitting
    // into a new one below it. Mark the in-memory copy transparent until the
    // steer is delivered, when the message becomes a turn of its own.
    let marked: AgentMessage[] | null = null
    for (let index = 0; index < source.length; index++) {
      const message = source[index]
      if (
        message?.role === 'user' &&
        threadMessages.isSteerHeld(
          this.root.handleAgentEvent.thread.projectId,
          this.root.pollStreamParts.conversationId,
          message.id
        )
      ) {
        marked ??= source.slice()
        marked[index] = { ...message, turnTransparent: true }
      }
    }
    return marked ?? source
  })

  /** The latest turn that already has an assistant message. A newly submitted
   *  user follow-up is handled separately until its first assistant message is
   *  mirrored, so it can never lend live state to the preceding trace. */
  latestTurnInfo = $derived.by(() => {
    const startIndex = lastTurnStartIndex(this.structureMessages)
    if (startIndex === -1) return { startIndex: -1, active: false }
    let endIndex = startIndex
    while (endIndex + 1 < this.structureMessages.length) {
      const next = this.structureMessages[endIndex + 1]
      if (!next) break
      if (next.role === 'assistant' || isActivityOnlyUserMessage(next)) {
        endIndex += 1
        continue
      }
      break
    }
    const hasNewPrompt = this.structureMessages
      .slice(endIndex + 1)
      .some(
        (message) =>
          message.role === 'user' && !this.root.pollStreamParts.isTransparentTurnMessage(message)
      )
    const awaitingLocalPrompt =
      this.locallySubmittedTurnId !== null &&
      !this.structureMessages.some((message) => message.id === this.locallySubmittedTurnId)
    return { startIndex, active: !hasNewPrompt && !awaitingLocalPrompt }
  })

  /** A live turn whose user message is visible but whose assistant message has
   *  not been mirrored yet. Pi can keep streaming durable parts in this state
   *  for an entire follow-up turn. Render those parts under the user message
   *  instead of treating the preceding assistant trace as the active one. */
  pendingLiveTurn = $derived.by(() => {
    if (
      !this.root.pollStreamParts.conversationBusy ||
      this.root.unmirroredTraceStartTime.brainstormReportRefreshing
    )
      return null
    const pendingIndex = pendingTurnAnchorIndex(this.structureMessages)
    const userMessageId = this.structureMessages[pendingIndex]?.id
    if (!userMessageId) return null
    // A steer still held for its undo window has not reached the harness yet, so
    // it must not open a pending turn of its own. Whatever streams while it is
    // held is work on the turn it steers, and that turn's own live trace owns it
    // above the message. Opening a second trace here is what rendered the new
    // working trace above the steered message instead of under it once the
    // harness took it.
    if (
      threadMessages.isSteerHeld(
        this.root.handleAgentEvent.thread.projectId,
        this.root.pollStreamParts.conversationId,
        userMessageId
      )
    )
      return null
    const userMessageIndex = this.structureMessages.findIndex(
      (message) => message.id === userMessageId
    )
    const userMessage = this.structureMessages[userMessageIndex]
    if (
      userMessageIndex === -1 ||
      !userMessage ||
      userMessage.role !== 'user' ||
      isActivityOnlyUserMessage(userMessage)
    ) {
      return null
    }
    const assistantMirrored = this.structureMessages
      .slice(userMessageIndex + 1)
      .some((message) => message.role === 'assistant')
    return assistantMirrored ? null : { userMessageId, userMessageIndex }
  })

  pendingLiveTurnParts = $derived(
    this.pendingLiveTurn ? this.root.pollStreamParts.streamWorkingPartsForPendingTurn() : []
  )

  /** Absolute index of a held steer in view, or -1. A held steer has not
   *  reached the harness yet, so it does not open a turn: the live trace still
   *  belongs to the turn it steers and must render above the message. */
  heldSteerAbsIndex = $derived.by(() => {
    for (let index = this.structureMessages.length - 1; index >= 0; index--) {
      const message = this.structureMessages[index]
      if (message?.role !== 'user') continue
      if (
        threadMessages.isSteerHeld(
          this.root.handleAgentEvent.thread.projectId,
          this.root.pollStreamParts.conversationId,
          message.id
        )
      )
        return index
    }
    return -1
  })

  /** True while we are showing a working trace rehydrated from persisted state
   *  because no live session activity is available to confirm the run (a silent
   *  session, or an app restart mid-turn). The trace renders the
   *  last-known saved parts with an explicit saved-activity note instead of the
   *  thread dropping to idle or showing a bare "Agent working…" spinner. Cleared
   *  as soon as a live session confirms the real terminal state. */
  restoredBusy = $state(false)

  assignmentAuditThread = $state<Thread | undefined>()

  auditVersions = $state<AuditReport[]>([])

  auditError = $state('')

  achievementOnly = $derived(
    this.root.loadOlderMessages.settings.loopMode === true &&
      this.root.loadOlderMessages.settings.assignmentMode !== true
  )

  assignmentAuditState = $derived.by<AssignmentAuditDisplayState>(() => {
    if (this.root.submitSpecDecision.auditBusy) return 'running'
    const cycleStatus = this.root.submitSpecDecision.assignment?.auditCycle?.status
    if (cycleStatus === 'failed') return 'failed'
    if (cycleStatus === 'available' && this.assignmentAuditThread?.status === 'failed')
      return 'failed'
    // An `available` cycle means "the implementation finished, review it", so it
    // is only an offer while the plan really is finished. A plan whose tasks were
    // reopened after the offer appeared would otherwise pin the card to the
    // composer with no way out: the audit cannot start from there and Cancel
    // cannot dismiss it, so the card returned on every refresh.
    if (cycleStatus === 'available') {
      return this.root.submitSpecDecision.assignment?.status === 'completed' ? 'offered' : undefined
    }
    if (cycleStatus === 'running') return 'running'
    // A report that was generated but whose verification evidence could not be
    // fully validated surfaces as the half-report card instead of a final one.
    if (cycleStatus === 'report_ready') {
      return this.root.contextUsage.auditReport?.evidenceValidation === 'partial'
        ? 'partial'
        : 'report_ready'
    }
    if (
      cycleStatus === 'planning_rework' ||
      cycleStatus === 'awaiting_rework_approval' ||
      cycleStatus === 'reworking'
    )
      return 'reworking'
    if (cycleStatus === 'completed') return undefined
    if (
      this.root.submitSpecDecision.auditState === 'report_ready' &&
      this.root.contextUsage.auditReport
    ) {
      return this.root.contextUsage.auditReport.evidenceValidation === 'partial'
        ? 'partial'
        : 'report_ready'
    }
    return this.root.submitSpecDecision.auditState
  })

  /** The composer's "Implementation finished" prompt is dismissed while the cycle
   *  stays `available`, so the coordinator panel and the studios keep their audit
   *  entry. Dismissing reveals the ordinary composer for the Sr. Engineer. */
  assignmentAuditOfferDismissed = $derived(
    this.root.submitSpecDecision.assignment?.auditCycle?.status === 'available' &&
      this.root.submitSpecDecision.assignment.auditCycle.offerDismissedAt !== undefined
  )

  delegatedThreadWorking(candidate: Thread | undefined): boolean {
    if (!candidate) return false
    if (agentRuns.hasSettled(candidate.projectId, candidate.id)) {
      return agentRuns.isBusy(candidate.projectId, candidate.id)
    }
    return (
      Boolean(candidate.sessionId) &&
      (candidate.status === 'planning' || candidate.status === 'executing')
    )
  }

  activeAssignmentWorkerCount = $derived(
    this.root.currentWorkingTraceAttribution.assignmentThreads.filter((worker) =>
      this.delegatedThreadWorking(worker)
    ).length
  )

  assignmentAuditorWorking = $derived(
    this.assignmentAuditState === 'running' ||
      this.delegatedThreadWorking(this.assignmentAuditThread)
  )

  achievementAuditorWorking = $derived(
    this.root.submitSpecDecision.auditState === 'running' ||
      this.delegatedThreadWorking(this.root.contextUsage.durableAuditThread)
  )

  delegatedWorkBusy = $derived.by(() => {
    if (
      this.root.submitSpecDecision.assignment?.coordinatorThreadId ===
      this.root.handleAgentEvent.thread.id
    ) {
      return this.activeAssignmentWorkerCount > 0 || this.assignmentAuditorWorking
    }
    return (
      this.achievementOnly &&
      this.root.handleAgentEvent.thread.achievementRole !== 'auditor' &&
      this.achievementAuditorWorking
    )
  })

  /** Guards a newly submitted turn from stale idle snapshots while an existing
   *  thread reconnects to its persisted provider session. */
  locallySubmittedTurnId: string | null = $state(null)

  beginLocalTurn(userMessageId: string): void {
    this.root.handleAgentEvent.liveTokenRate.startTurn(Date.now())
    this.restoredBusy = false
    this.root.pollStreamParts.clearStreamParts()
    this.locallySubmittedTurnId = userMessageId
    this.root.abortRun.locallySubmittedTurnAcknowledged = false
    this.root.abortRun.turnSawCompaction = false
    this.root.abortRun.turnSawAnswer = false
    this.root.abortRun.userRequestedStop = false
    this.root.unmirroredTraceStartTime.compactionInterruptedNotice = ''
  }

  /** Cached thread/session state may describe the previous turn on reconnect. */
  setIdleFromRestore(): void {
    if (this.locallySubmittedTurnId) return
    if (
      agentRuns.activity(
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id
      ) === 'brainstorm_report'
    )
      return
    this.restoredBusy = false
    agentRuns.setIdle(
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id
    )
  }

  /** Reconcile persisted thread updates without inferring a live turn. The
   *  live session probe owns session busy state; an awaiting-approval thread
   *  has finished its turn and is waiting on the user, so it must read as idle
   *  (Needs attention), never as still working. Live session activity for
   *  pending permission/question gates is re-established by connectSession.
   *
   *  Coordinator status is broader: it remains executing while workers or an
   *  auditor run. That delegated state keeps the coordination trace visible via
   *  `threadWorking`, but it must not make the composer queue/steer against an
   *  idle Sr. Engineer session. */
  restoreWorkingState(
    status: Thread['status'],
    auditRunning = this.root.handleAgentEvent.thread.auditState === 'running'
  ): void {
    // Once the session probe has completed, persisted thread status must never
    // resurrect a stale busy flag. New live work enters through agent events or
    // the send path and establishes the run explicitly.
    if (this.root.unmirroredTraceStartTime.liveStatusKnown) return
    // Delegated activity contributes to the aggregate working display, but it
    // says nothing about the Sr. Engineer's own live session. Preserve the raw
    // session state here: live working keeps Steer available, while live idle
    // is established authoritatively by connectSession/session.status.
    if (this.delegatedWorkBusy || auditRunning) {
      return
    }
    if (status === 'planning' || status === 'executing') {
      // Do not infer active work from the database row. The provider status
      // probe below is the only source that can restore a live turn.
      return
    }
    this.setIdleFromRestore()
  }

  async openAssignmentAuditWork(): Promise<void> {
    if (
      this.assignmentAuditThread &&
      this.root.submitSpecDecision.assignment?.auditCycle !== undefined
    ) {
      workspaceState.openThread(this.assignmentAuditThread, this.root.contextUsage.project)
      return
    }
    if (this.root.contextUsage.auditReport) {
      this.root.contextUsage.openAuditStudio()
      return
    }
    // Nothing to open yet: the offer prompt is the audit entry, so bring a
    // dismissed offer back before scrolling it into view.
    if (this.assignmentAuditOfferDismissed) {
      const restored = await invoke(
        'audit:restoreOffer',
        this.root.handleAgentEvent.thread.projectId,
        this.root.submitSpecDecision.auditWorkflowThreadId()
      ).catch(() => null)
      if (restored) {
        this.root.submitSpecDecision.assignment = restored
        this.root.submitSpecDecision.auditState = 'offered'
      }
    }
    this.root.submitSpecDecision.showSpecStudio = false
    await tick()
    this.root.loadOlderMessages.scrollEl?.scrollTo({
      top: this.root.loadOlderMessages.scrollEl.scrollHeight,
      behavior: 'smooth'
    })
  }

  async generateAudit(selected: ThreadSettings): Promise<void> {
    if (this.root.submitSpecDecision.assignment?.status === 'completed') {
      await this.generateDurableAssignmentAudit(selected)
      return
    }
    if (this.achievementOnly) {
      await this.generateDurableAchievementAudit(
        selected,
        this.root.handleAgentEvent.thread.coordinatorThreadId ??
          this.root.handleAgentEvent.thread.id
      )
      return
    }
    if (this.root.handleAgentEvent.thread.achievementRole === 'auditor') {
      await this.retryAssignmentAuditFromAuditor(selected)
      return
    }
    await this.root.contextUsage.generateDurableImplementationAudit(selected)
  }

  /** Replace the auditor thread with a brand-new one and run a fresh audit.
   *  The main process deletes the previous auditor thread (session, transcript,
   *  disk artifacts) before creating the new one, so a stuck or repeatedly
   *  failing auditor is escaped rather than resumed. The report lineage on the
   *  coordinator survives, so the fresh auditor still verifies rework against
   *  the previous report when one exists. */
  async startFreshIndependentAudit(selected: ThreadSettings): Promise<void> {
    this.root.submitSpecDecision.auditBusy = true
    this.auditError = ''
    this.root.handleAgentEvent.errorMessage = ''
    this.root.contextUsage.auditSettings = selected
    rendererRecovery.addRecentModel(
      modelKey(selected.harnessId, selected.providerId, selected.modelId)
    )
    try {
      const result = await invoke(
        'agent:startFreshIndependentAudit',
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id,
        {
          settings: selected
        }
      )
      this.root.contextUsage.auditReport = result.report
      this.root.contextUsage.durableAuditThread = result.auditorThread
      this.root.submitSpecDecision.auditState = 'report_ready'
      this.auditVersions = await invoke(
        'audit:listVersions',
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id,
        this.root.contextUsage.auditReport.id
      )
    } catch (error) {
      const rawError = error instanceof Error ? error.message : 'The new audit could not start.'
      this.root.handleAgentEvent.errorMessage = rawError.replace(
        /^Error invoking remote method '[^']+': Error:\s*/u,
        ''
      )
      this.auditError = this.root.handleAgentEvent.errorMessage
      // The previous auditor is gone and the failed run still created a fresh
      // one, so resolve it instead of leaving a deleted thread on screen.
      this.root.contextUsage.durableAuditThread = await invoke(
        'agent:ensureIndependentAuditorThread',
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id,
        selected
      ).catch(() => undefined)
    } finally {
      this.root.submitSpecDecision.auditBusy = false
    }
  }

  async generateDurableAssignmentAudit(
    selected: ThreadSettings,
    coordinatorThreadId = this.root.handleAgentEvent.thread.id
  ): Promise<void> {
    this.root.submitSpecDecision.auditBusy = true
    this.auditError = ''
    this.root.handleAgentEvent.errorMessage = ''
    this.root.submitSpecDecision.auditState = 'running'
    this.root.contextUsage.auditSettings = selected
    rendererRecovery.addRecentModel(
      modelKey(selected.harnessId, selected.providerId, selected.modelId)
    )
    try {
      this.assignmentAuditThread = await invoke(
        'agent:ensureAssignmentAuditorThread',
        this.root.handleAgentEvent.thread.projectId,
        coordinatorThreadId,
        selected
      )
      const result = await invoke(
        'agent:generateAssignmentAudit',
        this.root.handleAgentEvent.thread.projectId,
        coordinatorThreadId,
        selected
      )
      this.assignmentAuditThread = result.auditorThread
      this.root.contextUsage.auditReport = result.report
      this.auditVersions = await invoke(
        'audit:listVersions',
        this.root.handleAgentEvent.thread.projectId,
        coordinatorThreadId,
        result.report.id
      )
      this.root.submitSpecDecision.assignment = await invoke(
        'assignment:getActive',
        this.root.handleAgentEvent.thread.projectId,
        coordinatorThreadId
      )
      this.root.submitSpecDecision.auditState = 'report_ready'
    } catch (error) {
      this.root.submitSpecDecision.auditState = 'offered'
      const rawError = error instanceof Error ? error.message : 'The Assignment audit failed.'
      this.root.handleAgentEvent.errorMessage = rawError.replace(
        /^Error invoking remote method '[^']+': Error:\s*/u,
        ''
      )
      this.auditError = this.root.handleAgentEvent.errorMessage
      const persistedAssignment = await invoke(
        'assignment:getActive',
        this.root.handleAgentEvent.thread.projectId,
        coordinatorThreadId
      ).catch(() => null)
      if (persistedAssignment) this.root.submitSpecDecision.assignment = persistedAssignment
      if (persistedAssignment?.auditorThreadId) {
        this.assignmentAuditThread =
          (await invoke(
            'thread:get',
            this.root.handleAgentEvent.thread.projectId,
            persistedAssignment.auditorThreadId
          ).catch(() => null)) ?? this.assignmentAuditThread
      }
    } finally {
      this.root.submitSpecDecision.auditBusy = false
    }
  }

  async generateDurableAchievementAudit(
    selected: ThreadSettings,
    coordinatorThreadId = this.root.handleAgentEvent.thread.id
  ): Promise<void> {
    this.root.submitSpecDecision.auditBusy = true
    this.auditError = ''
    this.root.handleAgentEvent.errorMessage = ''
    this.root.submitSpecDecision.auditState = 'running'
    this.root.contextUsage.auditSettings = selected
    rendererRecovery.addRecentModel(
      modelKey(selected.harnessId, selected.providerId, selected.modelId)
    )
    try {
      this.root.contextUsage.durableAuditThread = await invoke(
        'agent:ensureAchievementAuditorThread',
        this.root.handleAgentEvent.thread.projectId,
        coordinatorThreadId,
        selected
      )
      const result = await invoke(
        'agent:generateAchievementAudit',
        this.root.handleAgentEvent.thread.projectId,
        coordinatorThreadId,
        selected
      )
      this.root.contextUsage.durableAuditThread = result.auditorThread
      this.root.contextUsage.auditReport = result.report
      this.auditVersions = await invoke(
        'audit:listVersions',
        this.root.handleAgentEvent.thread.projectId,
        coordinatorThreadId,
        result.report.id
      )
      this.root.submitSpecDecision.auditState = 'report_ready'
    } catch (error) {
      this.root.submitSpecDecision.auditState = 'offered'
      const rawError = error instanceof Error ? error.message : 'The Achievement audit failed.'
      this.root.handleAgentEvent.errorMessage = rawError.replace(
        /^Error invoking remote method '[^']+': Error:\s*/u,
        ''
      )
      this.auditError = this.root.handleAgentEvent.errorMessage
    } finally {
      this.root.submitSpecDecision.auditBusy = false
    }
  }

  async retryAssignmentAuditFromAuditor(selected: ThreadSettings): Promise<void> {
    if (!this.root.handleAgentEvent.thread.coordinatorThreadId) {
      this.auditError = 'The coordinator could not be found.'
      return
    }
    if (this.root.handleAgentEvent.thread.assignmentId !== undefined) {
      await this.generateDurableAssignmentAudit(
        selected,
        this.root.handleAgentEvent.thread.coordinatorThreadId
      )
      return
    }
    const coordinator = await invoke(
      'thread:get',
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.coordinatorThreadId
    )
    if (coordinator?.settings?.loopMode === true) {
      await this.generateDurableAchievementAudit(
        selected,
        this.root.handleAgentEvent.thread.coordinatorThreadId
      )
      return
    }
    await this.root.contextUsage.generateDurableImplementationAudit(
      selected,
      this.root.handleAgentEvent.thread.coordinatorThreadId
    )
  }

  async saveAudit(edited: AuditReport): Promise<AuditReport | null> {
    this.root.submitSpecDecision.auditBusy = true
    this.auditError = ''
    try {
      const saved = await invoke('audit:save', edited, edited.content)
      this.root.contextUsage.auditReport = saved
      this.auditVersions = this.auditVersions.map((version) =>
        version.version === saved.version ? saved : version
      )
      return saved
    } catch (error) {
      this.auditError =
        error instanceof Error ? error.message : 'The audit report could not be saved.'
      return null
    } finally {
      this.root.submitSpecDecision.auditBusy = false
    }
  }

  async refreshAudit(updated: Promise<AuditReport>): Promise<AuditReport | null> {
    this.root.submitSpecDecision.auditBusy = true
    try {
      const refreshed = await updated
      this.root.contextUsage.auditReport = refreshed
      this.auditVersions = this.auditVersions.map((version) =>
        version.version === this.root.contextUsage.auditReport?.version
          ? this.root.contextUsage.auditReport
          : version
      )
      return refreshed
    } catch (error) {
      this.auditError =
        error instanceof Error ? error.message : 'The audit report could not be updated.'
      return null
    } finally {
      this.root.submitSpecDecision.auditBusy = false
    }
  }

  addAuditAnnotation(
    section: AuditSectionId,
    body: string,
    // Mirrors the studio AnnotationAnchor shape: start/endLine are optional in
    // the declared callback type, so this handler must accept them as optional
    // too (they are always supplied in practice and default to 0).
    anchor?: {
      quote: string
      startLine?: number
      endLine?: number
      startOffset: number
      endOffset: number
    }
  ): Promise<AuditReport | null> {
    const report = this.root.contextUsage.auditReport
    if (!report) return Promise.resolve(null)
    return this.refreshAudit(
      invoke(
        'audit:addAnnotation',
        this.root.handleAgentEvent.thread.projectId,
        this.root.submitSpecDecision.auditWorkflowThreadId(),
        report.id,
        report.version,
        {
          section,
          body,
          author: 'user',
          startLine: anchor?.startLine ?? 0,
          endLine: anchor?.endLine ?? 0,
          ...anchor
        }
      )
    )
  }

  updateAuditAnnotation(annotationId: string, body: string): Promise<AuditReport | null> {
    const report = this.root.contextUsage.auditReport
    if (!report) return Promise.resolve(null)
    return this.refreshAudit(
      invoke(
        'audit:updateAnnotation',
        this.root.handleAgentEvent.thread.projectId,
        this.root.submitSpecDecision.auditWorkflowThreadId(),
        report.id,
        report.version,
        annotationId,
        body
      )
    )
  }

  resolveAuditAnnotation(annotationId: string): Promise<AuditReport | null> {
    const report = this.root.contextUsage.auditReport
    if (!report) return Promise.resolve(null)
    return this.refreshAudit(
      invoke(
        'audit:resolveAnnotation',
        this.root.handleAgentEvent.thread.projectId,
        this.root.submitSpecDecision.auditWorkflowThreadId(),
        report.id,
        report.version,
        annotationId
      )
    )
  }

  async returnAuditToOffer(): Promise<void> {
    this.root.submitSpecDecision.auditBusy = true
    this.auditError = ''
    try {
      const coordinatorThreadId = this.root.submitSpecDecision.auditWorkflowThreadId()
      const currentAssignment = await invoke(
        'assignment:getActive',
        this.root.handleAgentEvent.thread.projectId,
        coordinatorThreadId
      )
      if (currentAssignment) {
        this.root.submitSpecDecision.assignment = await invoke(
          'audit:returnToOffer',
          this.root.handleAgentEvent.thread.projectId,
          coordinatorThreadId
        )
      } else {
        const updatedCoordinator = await invoke(
          'agent:returnAchievementAuditToOffer',
          this.root.handleAgentEvent.thread.projectId,
          coordinatorThreadId
        )
        scopeState.updateThread(updatedCoordinator)
        // Returning a dormant durable cycle to the offer state may revive
        // Achievement (loopMode) on the coordinator: mirror it locally so the
        // follow-up audit keeps routing through the Achievement flow.
        if (updatedCoordinator.settings)
          this.root.loadOlderMessages.settings = updatedCoordinator.settings
      }
      this.root.submitSpecDecision.auditState = 'offered'
    } catch (error) {
      this.auditError = error instanceof Error ? error.message : 'The audit could not be reopened.'
    } finally {
      this.root.submitSpecDecision.auditBusy = false
    }
  }

  async reaudit(selected: ThreadSettings): Promise<void> {
    await this.returnAuditToOffer()
    if (this.root.submitSpecDecision.auditState === 'offered') await this.generateAudit(selected)
  }

  async openAuditInEditor(report: AuditReport): Promise<void> {
    this.auditError = ''
    try {
      await invoke(
        'audit:openInEditor',
        report.projectId,
        report.threadId,
        report.id,
        report.version
      )
    } catch (error) {
      this.auditError =
        error instanceof Error ? error.message : 'The audit report could not be opened.'
    }
  }

  async revealAuditInAppFile(report: AuditReport): Promise<void> {
    this.auditError = ''
    try {
      const absPath = await invoke(
        'audit:revealInFiles',
        report.projectId,
        report.threadId,
        report.id,
        report.version
      )
      await revealFileInAppTree(report.projectId, absPath)
    } catch (error) {
      this.auditError =
        error instanceof Error ? error.message : 'The audit report could not be revealed.'
    }
  }

  buildSpecActionPrompt(action: SpecActionIntent, draft: EngineeringSpec, notes: string): string {
    const annotations = draft.annotations
      .filter((annotation) => annotation.status === 'open')
      .map((annotation) => ({
        section: annotation.section,
        comment: annotation.body,
        ...(annotation.quote ? { quote: annotation.quote } : {}),
        ...(annotation.startLine ? { startLine: annotation.startLine } : {}),
        ...(annotation.endLine ? { endLine: annotation.endLine } : {})
      }))
    const additionalNotes = notes.trim()
    const storedDecisionComments = draft.decisionComments ?? []
    const decisionHistory = additionalNotes
      ? storedDecisionComments.slice(0, -1)
      : storedDecisionComments
    const contextInstruction =
      'Read each project-relative context path and use attached files as explicit supporting context. Treat project_rule paths as instructions for this run. Use decisionHistory as the prior user decisions for this specification version.'
    const context = JSON.stringify(
      {
        specification: {
          id: draft.id,
          version: draft.version,
          content: draft.content
        },
        annotations,
        context: draft.context.map((reference) => ({
          type: reference.type,
          label: reference.label,
          ...(reference.path ? { path: reference.path } : {})
        })),
        decisionHistory: decisionHistory.map((comment) => ({
          action: comment.action,
          comment: comment.body,
          createdAt: comment.createdAt
        })),
        ...(additionalNotes ? { additionalNotes } : {})
      },
      null,
      2
    )

    if (action === 'review') {
      return [
        'Review this specification using the discussion so far and the attached annotations.',
        contextInstruction,
        'Explain the concrete changes still needed. Do not implement yet.',
        context
      ].join('\n\n')
    }
    return [
      'Implement this specification.',
      'Take note of every attached annotation, update your working specification to incorporate them, then complete the implementation.',
      contextInstruction,
      'The user has signed off on this specification.',
      context
    ].join('\n\n')
  }
}
