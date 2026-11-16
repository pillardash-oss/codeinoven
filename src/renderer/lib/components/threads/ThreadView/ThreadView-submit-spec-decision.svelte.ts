import { scopeState } from '$lib/stores/scope.svelte'
import { invoke } from '$lib/ipc.svelte'
import { workspaceState } from '$lib/stores/workspace.svelte'
import type {
  Thread,
  EngineeringSpec,
  AssignmentPlan,
  AssignmentPlanContent,
  AssignmentModelSelection,
  ScopeChoice,
  AuditReport,
  SpecDecisionAction
} from '$shared/types'
import { hasSelectedStage } from '$shared/engines/engineering-lifecycle-engine'
import { workflowActionPresentation } from '$shared/workflow-action-presentation'
import { specActionLabel } from '../thread-message-presentation'
import type { ThreadView } from './ThreadView-board.svelte'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the ThreadView board. */
export class ThreadViewSubmitSpecDecision extends BoardUnit<ThreadView> {
  constructor(root: ThreadView) {
    super(root)
  }

  /** Reads the thread's audit state once the board can resolve it. */
  bindAuditState(): void {
    this.auditState = this.root.handleAgentEvent.thread.auditState
  }
  showSpecStudio = $state(false)

  assignment = $state<AssignmentPlan | null>(null)

  assignmentVersions = $state<AssignmentPlan[]>([])

  selectedAssignmentVersion = $state<number | undefined>()

  assignmentBusy = $state(false)

  assignmentError = $state('')

  // Intentional mounted-thread snapshot; live changes are reconciled from persisted thread state.
  // svelte-ignore state_referenced_locally
  /** Set by `bind()`: where the audit stands for this thread. */
  auditState = $state<Thread['auditState']>('offered')

  /** An audit run ended in failure. Kept beside `auditError` because a failed
   *  run is not a persisted audit state: the card has to report the failure with
   *  its model picker, so the user can change the auditor's account right there
   *  instead of hunting the auditor thread. */
  auditFailed = $state(false)

  auditBusy = $state(false)

  auditReportActionsAvailable = $derived.by(() => {
    const report = this.root.contextUsage.auditReport
    if (!report) return false
    if (!this.assignment) return this.auditState === 'report_ready'
    return (
      ['completed', 'running'].includes(this.assignment.status) &&
      this.assignment.auditCycle !== undefined &&
      this.assignment.auditCycle.status === 'report_ready' &&
      this.assignment.auditCycle.reportId === report.id &&
      this.assignment.auditCycle.reportVersion === report.version
    )
  })

  /** The accepted report can be pulled back into review. Accepting a report
   *  clears the thread's audit state and lands the thread on Done, so a thread
   *  that still has a report but no audit state is exactly the accepted case. */
  auditRetractAvailable = $derived.by(() => {
    const report = this.root.contextUsage.auditReport
    if (!report || this.auditReportActionsAvailable) return false
    if (this.assignment) {
      return this.assignment.auditCycle?.status === 'completed'
    }
    const thread = this.root.handleAgentEvent.thread
    return thread.status === 'completed' && thread.auditState === undefined
  })

  /**
   * The thread every Assignment call is keyed on.
   *
   * A worker thread presents its coordinator's Assignment, and the studio that
   * edits task models and worker scope can be opened from that worker. The
   * loaded document already names the coordinator it belongs to, so the mounted
   * thread's own id is the wrong key there: the engine answers "Assignment not
   * found" to a lookup done on a worker. Resolve from the document, and fall
   * back to this view only before anything has been loaded.
   */
  assignmentOwner(): { projectId: string; threadId: string } {
    const active = this.assignment
    return {
      projectId: active?.projectId ?? this.root.handleAgentEvent.thread.projectId,
      threadId: active?.coordinatorThreadId ?? this.root.handleAgentEvent.thread.id
    }
  }

  async saveAssignment(content: AssignmentPlanContent): Promise<boolean> {
    this.assignmentBusy = true
    this.assignmentError = ''
    try {
      const owner = this.assignmentOwner()
      this.assignment = await invoke(
        'assignment:saveDraft',
        owner.projectId,
        owner.threadId,
        content,
        {
          source: 'manual',
          actor: 'user',
          harnessId: this.root.loadOlderMessages.settings.harnessId,
          providerId: this.root.loadOlderMessages.settings.providerId,
          modelId: this.root.loadOlderMessages.settings.modelId
        }
      )
      this.assignmentVersions = await invoke(
        'assignment:listVersions',
        this.assignment.projectId,
        this.assignment.coordinatorThreadId,
        this.assignment.id
      )
      this.selectedAssignmentVersion = this.assignment.version
      this.root.handleAgentEvent.engineeringLifecycle = await invoke(
        'engineeringLifecycle:get',
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id
      )
      return true
    } catch (error) {
      this.assignmentError =
        error instanceof Error ? error.message : 'The Assignment draft could not be saved.'
      return false
    } finally {
      this.assignmentBusy = false
    }
  }

  /**
   * Fold a plan the engine just returned into both copies the studio reads.
   *
   * The open panel renders the version list entry, not `assignment`, and a
   * same-version write only moves `updatedAt`. Replacing `assignment` alone
   * therefore left the panel on the plan as it was before the edit: the picker
   * snapped back and the header still described the old plan. Every write that
   * keeps the version goes through here.
   */
  applyAssignmentUpdate(updated: AssignmentPlan): AssignmentPlan {
    this.assignment = updated
    this.assignmentVersions = this.assignmentVersions.map((candidate) =>
      candidate.id === updated.id && candidate.version === updated.version ? updated : candidate
    )
    return updated
  }

  async addAssignmentAnnotation(
    section: string,
    body: string,
    anchor: { quote: string; startOffset: number; endOffset: number }
  ): Promise<AssignmentPlan | null> {
    const current = this.assignment
    if (!current) return null
    this.assignmentBusy = true
    this.assignmentError = ''
    try {
      return this.applyAssignmentUpdate(
        await invoke(
          'assignment:addAnnotation',
          current.projectId,
          current.coordinatorThreadId,
          current.id,
          current.version,
          { section, body, author: 'user', ...anchor }
        )
      )
    } catch (error) {
      this.assignmentError = error instanceof Error ? error.message : 'Adding the comment failed.'
      return null
    } finally {
      this.assignmentBusy = false
    }
  }

  async updateAssignmentAnnotation(
    annotationId: string,
    body: string
  ): Promise<AssignmentPlan | null> {
    const current = this.assignment
    if (!current) return null
    this.assignmentBusy = true
    this.assignmentError = ''
    try {
      return this.applyAssignmentUpdate(
        await invoke(
          'assignment:updateAnnotation',
          current.projectId,
          current.coordinatorThreadId,
          current.id,
          current.version,
          annotationId,
          body
        )
      )
    } catch (error) {
      this.assignmentError = error instanceof Error ? error.message : 'Updating the comment failed.'
      return null
    } finally {
      this.assignmentBusy = false
    }
  }

  async resolveAssignmentAnnotation(annotationId: string): Promise<AssignmentPlan | null> {
    const current = this.assignment
    if (!current) return null
    this.assignmentBusy = true
    this.assignmentError = ''
    try {
      return this.applyAssignmentUpdate(
        await invoke(
          'assignment:resolveAnnotation',
          current.projectId,
          current.coordinatorThreadId,
          current.id,
          current.version,
          annotationId
        )
      )
    } catch (error) {
      this.assignmentError =
        error instanceof Error ? error.message : 'Resolving the comment failed.'
      return null
    } finally {
      this.assignmentBusy = false
    }
  }

  async updateAssignmentTaskModel(
    taskId: string,
    selection: AssignmentModelSelection
  ): Promise<void> {
    this.assignmentBusy = true
    this.assignmentError = ''
    try {
      const owner = this.assignmentOwner()
      this.applyAssignmentUpdate(
        await invoke(
          'assignment:updateUnlinkedWorkerModel',
          owner.projectId,
          owner.threadId,
          taskId,
          selection
        )
      )
    } catch (error) {
      this.assignmentError =
        error instanceof Error ? error.message : 'The task model could not be updated.'
    } finally {
      this.assignmentBusy = false
    }
  }

  async updateAssignmentPhaseModel(
    phaseId: string,
    selection: AssignmentModelSelection
  ): Promise<void> {
    this.assignmentBusy = true
    this.assignmentError = ''
    try {
      const owner = this.assignmentOwner()
      this.applyAssignmentUpdate(
        await invoke(
          'assignment:updateUnlinkedPhaseModel',
          owner.projectId,
          owner.threadId,
          phaseId,
          selection
        )
      )
    } catch (error) {
      this.assignmentError =
        error instanceof Error ? error.message : 'The phase model could not be updated.'
    } finally {
      this.assignmentBusy = false
    }
  }

  async updateAssignmentTaskScope(taskId: string, scope: ScopeChoice): Promise<void> {
    this.assignmentBusy = true
    this.assignmentError = ''
    try {
      const owner = this.assignmentOwner()
      this.applyAssignmentUpdate(
        await invoke(
          'assignment:updateUnlinkedWorkerScope',
          owner.projectId,
          owner.threadId,
          taskId,
          scope
        )
      )
    } catch (error) {
      this.assignmentError =
        error instanceof Error ? error.message : 'The task scope could not be updated.'
    } finally {
      this.assignmentBusy = false
    }
  }

  /**
   * Move every worker of a signed-off Assignment that has no scope of its own.
   * The choice is a request: a dedicated worktree is created at dispatch, so this
   * stays instant however many tasks the Assignment carries.
   */
  async updateAssignmentWorkerScope(scope: ScopeChoice): Promise<void> {
    this.assignmentBusy = true
    this.assignmentError = ''
    try {
      const owner = this.assignmentOwner()
      this.applyAssignmentUpdate(
        await invoke('assignment:updateWorkerScope', owner.projectId, owner.threadId, scope)
      )
    } catch (error) {
      this.assignmentError =
        error instanceof Error ? error.message : 'The worker scope could not be updated.'
    } finally {
      this.assignmentBusy = false
    }
  }

  async approveAssignment(content: AssignmentPlanContent): Promise<void> {
    this.assignmentBusy = true
    this.assignmentError = ''
    try {
      await this.root.sources.assignmentSeniorSettingsPersistence
      const owner = this.assignmentOwner()
      if (!this.assignment || JSON.stringify(this.assignment.content) !== JSON.stringify(content)) {
        this.assignment = await invoke(
          'assignment:saveDraft',
          owner.projectId,
          owner.threadId,
          content,
          {
            source: 'manual',
            actor: 'user',
            harnessId: this.root.loadOlderMessages.settings.harnessId,
            providerId: this.root.loadOlderMessages.settings.providerId,
            modelId: this.root.loadOlderMessages.settings.modelId
          }
        )
      }
      if (
        this.root.handleAgentEvent.engineeringLifecycle?.humanGate === 'assignment_approval' &&
        this.root.handleAgentEvent.engineeringLifecycle.resumeToken
      ) {
        this.root.handleAgentEvent.engineeringLifecycle = (
          await invoke(
            'engineeringLifecycle:resume',
            this.root.handleAgentEvent.thread.projectId,
            this.root.handleAgentEvent.thread.id,
            this.root.handleAgentEvent.engineeringLifecycle.resumeToken,
            'continue'
          )
        ).state
      }
      this.assignment = await invoke('agent:startAssignment', owner.projectId, owner.threadId)
      if (this.root.handleAgentEvent.engineeringLifecycle?.activeStage === 'assignment') {
        this.root.handleAgentEvent.engineeringLifecycle = await invoke(
          'engineeringLifecycle:complete',
          this.root.handleAgentEvent.thread.projectId,
          this.root.handleAgentEvent.thread.id,
          'assignment'
        )
      }
      this.assignmentVersions = await invoke(
        'assignment:listVersions',
        this.assignment.projectId,
        this.assignment.coordinatorThreadId,
        this.assignment.id
      )
      this.selectedAssignmentVersion = this.assignment.version
      this.root.studioTemporaryChatContext.specReadyToolVisible = false
      this.root.loadOlderMessages.settings = {
        ...this.root.loadOlderMessages.settings,
        assignmentMode: hasSelectedStage(
          this.root.handleAgentEvent.engineeringLifecycle,
          'assignment'
        ),
        loopMode: hasSelectedStage(this.root.handleAgentEvent.engineeringLifecycle, 'achievement')
      }
      this.root.sources.commitSettings(this.root.loadOlderMessages.settings)
    } catch (error) {
      this.assignmentError =
        error instanceof Error ? error.message : 'The Assignment could not be started.'
    } finally {
      this.assignmentBusy = false
    }
  }

  /**
   * Generate the Assignment draft. An active Spec is approved in place first so
   * the explicit "Generate Assignment" action never fails on an unapproved Spec;
   * without any Spec the main process decomposes the supplied conversation
   * instead, which is why `instructions` can carry the user's own request.
   */
  async generateAssignmentDraft(instructions?: string): Promise<void> {
    if (this.assignmentBusy) return
    this.assignmentBusy = true
    this.root.composerScope.assignmentFormulatingLocal = true
    this.assignmentError = ''
    try {
      let signingSpec = this.root.submitBrainstormDecision.spec
      if (signingSpec) {
        if (signingSpec.status === 'draft') {
          signingSpec = await invoke(
            'spec:setReview',
            signingSpec.projectId,
            signingSpec.threadId,
            signingSpec.id,
            signingSpec.version
          )
          this.root.submitBrainstormDecision.spec = signingSpec
        }
        if (signingSpec.status === 'in_review') {
          signingSpec = await invoke(
            'spec:approve',
            signingSpec.projectId,
            signingSpec.threadId,
            signingSpec.id,
            signingSpec.version
          )
          await this.root.harnessUsage.setActiveSpec(signingSpec)
        }
      }
      const started = await invoke(
        'agent:generateAssignmentDraft',
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id,
        this.root.loadOlderMessages.settings,
        instructions && instructions.trim() ? instructions : undefined
      )
      if (started.state === 'formulating') {
        // The draft is being built in the background: the thread row already owns
        // the in-progress state and `assignment.ready` opens the board. Nothing
        // here may wait for the model.
        this.root.composerScope.assignmentFormulatingDurable = true
        return
      }
      this.assignment = started.assignment
      this.assignmentVersions = await invoke(
        'assignment:listVersions',
        this.assignment.projectId,
        this.assignment.coordinatorThreadId,
        this.assignment.id
      )
      this.selectedAssignmentVersion = this.assignment.version
      this.root.handleAgentEvent.engineeringLifecycle = await invoke(
        'engineeringLifecycle:get',
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id
      )
      this.root.studioTemporaryChatContext.specReadyToolVisible = false
      this.root.harnessUsage.studioDocument = 'assignment'
      this.showSpecStudio = true
    } catch (error) {
      this.assignmentError =
        error instanceof Error ? error.message : 'The Assignment could not be generated.'
      this.root.handleAgentEvent.errorMessage = this.assignmentError
    } finally {
      this.assignmentBusy = false
      this.root.composerScope.assignmentFormulatingLocal = false
    }
  }

  openAssignmentStudio(): void {
    if (!this.assignment) return
    this.selectedAssignmentVersion = this.assignment.version
    this.root.currentWorkingTraceAttribution.assignmentFocusTaskId = undefined
    workspaceState.specAgentSidebarOpen = false
    this.root.harnessUsage.studioDocument = 'assignment'
    this.showSpecStudio = true
  }

  resumeAssignmentCoordination(): void {
    const current = this.assignment
    if (!current || this.assignmentBusy) return
    this.assignmentBusy = true
    this.assignmentError = ''
    const clearBubbledCoordinatorError =
      this.root.submitBrainstormDecision.coordinatorErrorMatchesAssignmentWorker
    void invoke('agent:resumeAssignmentAttention', current.projectId, current.coordinatorThreadId)
      .then(async (updated) => {
        this.applyAssignmentUpdate(updated)
        if (clearBubbledCoordinatorError) {
          this.root.handleAgentEvent.errorMessage = ''
          this.root.handleAgentEvent.providerStatus = null
        }
        await this.root.submitBrainstormDecision.reconcileReadySpec()
      })
      .catch((error) => {
        this.assignmentError =
          error instanceof Error ? error.message : 'Assignment coordination could not resume.'
        this.root.handleAgentEvent.errorMessage = this.assignmentError
      })
      .finally(() => {
        this.assignmentBusy = false
      })
  }

  async stopAssignment(): Promise<void> {
    const current = this.assignment
    if (!current || this.assignmentBusy) return
    this.assignmentBusy = true
    this.assignmentError = ''
    try {
      const stoppedAssignment = await invoke(
        'agent:stopAssignment',
        current.projectId,
        current.coordinatorThreadId
      )
      this.applyAssignmentUpdate(stoppedAssignment)
    } catch (error) {
      this.assignmentError =
        error instanceof Error ? error.message : 'The Assignment could not be stopped.'
      throw error
    } finally {
      this.assignmentBusy = false
    }
  }

  async resumeStoppedAssignment(): Promise<void> {
    const current = this.assignment
    if (!current || this.assignmentBusy) return
    this.assignmentBusy = true
    this.assignmentError = ''
    try {
      const resumedAssignment = await invoke(
        'agent:resumeAssignment',
        current.projectId,
        current.coordinatorThreadId
      )
      this.applyAssignmentUpdate(resumedAssignment)
    } catch (error) {
      this.assignmentError =
        error instanceof Error ? error.message : 'The Assignment could not be resumed.'
      throw error
    } finally {
      this.assignmentBusy = false
    }
  }

  /** `complete` accepts the audit cycle (thread lands on Done); `dismiss`
   *  cancels the offer/report card without ending the audit cycle. */
  async completeAudit(outcome: 'complete' | 'dismiss' = 'complete'): Promise<void> {
    this.auditBusy = true
    try {
      const updatedThread = await invoke(
        outcome === 'dismiss' ? 'audit:dismiss' : 'audit:complete',
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id
      )
      scopeState.updateThread(updatedThread)
      if (outcome === 'complete') {
        if (this.assignment) {
          const coordinatorThreadId = this.auditWorkflowThreadId()
          const refreshedAssignment = await invoke(
            'assignment:getActive',
            this.root.handleAgentEvent.thread.projectId,
            coordinatorThreadId
          ).catch(() => null)
          if (refreshedAssignment) this.applyAssignmentUpdate(refreshedAssignment)
        }
        if (this.root.handleAgentEvent.engineeringLifecycle?.activeStage === 'achievement') {
          this.root.handleAgentEvent.engineeringLifecycle = await invoke(
            'engineeringLifecycle:complete',
            this.root.handleAgentEvent.thread.projectId,
            this.root.handleAgentEvent.thread.id,
            'achievement'
          )
        }
        this.root.loadOlderMessages.settings = {
          ...this.root.loadOlderMessages.settings,
          loopMode: false
        }
        this.root.sources.commitSettings(this.root.loadOlderMessages.settings)
        await invoke(
          'thread:updateSettings',
          this.root.handleAgentEvent.thread.projectId,
          this.root.handleAgentEvent.thread.id,
          this.root.loadOlderMessages.settings
        )
      } else if (this.assignment) {
        // Dismissing an Assignment offer lands on the plan, so refresh it here
        // or the composer card would stay up until the next reconcile.
        const refreshedAssignment = await invoke(
          'assignment:getActive',
          this.root.handleAgentEvent.thread.projectId,
          this.auditWorkflowThreadId()
        ).catch(() => null)
        if (refreshedAssignment) this.applyAssignmentUpdate(refreshedAssignment)
      }
      this.auditState = undefined
      await this.root.submitBrainstormDecision.reconcileReadySpec()
      this.showSpecStudio = false
      this.root.harnessUsage.studioDocument = 'spec'
    } catch (error) {
      this.root.buildSpecActionPrompt.auditError =
        error instanceof Error ? error.message : 'The feature could not be completed.'
    } finally {
      this.auditBusy = false
    }
  }

  /** Undo an accepted audit report: the report returns to review on `spec` with
   *  its audit state restored, so Rework and Complete are offered again. */
  async retractAudit(): Promise<void> {
    if (this.auditBusy) return
    this.auditBusy = true
    this.root.buildSpecActionPrompt.auditError = ''
    try {
      const updatedThread = await invoke(
        'audit:retract',
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id
      )
      scopeState.updateThread(updatedThread)
      this.auditState = updatedThread.auditState
      if (this.assignment) {
        this.assignment = await invoke(
          'assignment:getActive',
          this.root.handleAgentEvent.thread.projectId,
          this.auditWorkflowThreadId()
        ).catch(() => null)
      }
      await this.root.submitBrainstormDecision.reconcileReadySpec()
    } catch (error) {
      this.root.buildSpecActionPrompt.auditError =
        error instanceof Error ? error.message : 'The audit report could not be retracted.'
    } finally {
      this.auditBusy = false
    }
  }

  auditWorkflowThreadId(): string {
    return (
      this.assignment?.coordinatorThreadId ??
      this.root.handleAgentEvent.thread.coordinatorThreadId ??
      this.root.handleAgentEvent.thread.id
    )
  }

  async reviewAudit(report: AuditReport, notes: string): Promise<boolean> {
    if (this.auditBusy) return false
    this.auditBusy = true
    this.root.buildSpecActionPrompt.auditError = ''
    try {
      const coordinatorThreadId = this.auditWorkflowThreadId()
      const currentAssignment = await invoke(
        'assignment:getActive',
        this.root.handleAgentEvent.thread.projectId,
        coordinatorThreadId
      )
      this.assignment = currentAssignment
      if (!currentAssignment) {
        const updatedCoordinator = await invoke(
          'agent:submitAchievementAuditFeedback',
          this.root.handleAgentEvent.thread.projectId,
          coordinatorThreadId,
          report.id,
          report.version,
          notes
        )
        scopeState.updateThread(updatedCoordinator)
        this.auditState = 'reworking'
        workspaceState.specAgentSidebarOpen = false
        this.showSpecStudio = false
        return true
      }
      if (
        !['completed', 'running'].includes(currentAssignment.status) ||
        !currentAssignment.auditCycle ||
        !['report_ready', 'planning_rework'].includes(currentAssignment.auditCycle.status) ||
        currentAssignment.auditCycle.reportId !== report.id ||
        currentAssignment.auditCycle.reportVersion !== report.version
      ) {
        this.root.buildSpecActionPrompt.auditError =
          currentAssignment?.auditCycle?.status === 'running'
            ? 'The auditor is still working. Review will be available when the report is ready.'
            : 'This historical audit report is read-only. Open the current report to submit feedback.'
        return false
      }
      this.assignment = await invoke(
        'agent:submitAssignmentAuditFeedback',
        this.root.handleAgentEvent.thread.projectId,
        coordinatorThreadId,
        report.id,
        report.version,
        notes
      )
      this.assignmentVersions = await invoke(
        'assignment:listVersions',
        this.assignment.projectId,
        this.assignment.coordinatorThreadId,
        this.assignment.id
      )
      this.selectedAssignmentVersion = this.assignment.version
      this.auditState = 'reworking'
      workspaceState.specAgentSidebarOpen = false
      this.showSpecStudio = false
      return true
    } catch (error) {
      this.root.buildSpecActionPrompt.auditError =
        error instanceof Error ? error.message : 'The Sr. Engineer could not receive the feedback.'
      return false
    } finally {
      this.auditBusy = false
    }
  }

  async submitSpecDecision(
    action: SpecDecisionAction,
    draft: EngineeringSpec,
    notes: string
  ): Promise<void> {
    this.showSpecStudio = false
    if (action === 'implement') {
      this.root.studioTemporaryChatContext.specReadyToolVisible = false
    }
    try {
      let active = draft
      const decisionComment = notes.trim()
      if (decisionComment) {
        active = await invoke(
          'spec:addDecisionComment',
          active.projectId,
          active.threadId,
          active.id,
          active.version,
          action,
          decisionComment
        )
        await this.root.harnessUsage.setActiveSpec(active)
      }
      if (action === 'implement') {
        const lifecycleSpecApproval =
          (this.root.handleAgentEvent.engineeringLifecycle?.activeStage === 'spec' ||
            this.root.handleAgentEvent.engineeringLifecycle?.humanGate === 'spec_approval') &&
          hasSelectedStage(this.root.handleAgentEvent.engineeringLifecycle, 'spec')
        if (lifecycleSpecApproval) {
          if (
            this.root.handleAgentEvent.engineeringLifecycle?.humanGate === 'spec_approval' &&
            this.root.handleAgentEvent.engineeringLifecycle.resumeToken
          ) {
            this.root.handleAgentEvent.engineeringLifecycle = (
              await invoke(
                'engineeringLifecycle:resume',
                this.root.handleAgentEvent.thread.projectId,
                this.root.handleAgentEvent.thread.id,
                this.root.handleAgentEvent.engineeringLifecycle.resumeToken,
                'continue'
              )
            ).state
          }
          if (active.status === 'draft') {
            active = await invoke(
              'spec:setReview',
              active.projectId,
              active.threadId,
              active.id,
              active.version
            )
          }
          if (active.status === 'in_review') {
            active = await invoke(
              'spec:approve',
              active.projectId,
              active.threadId,
              active.id,
              active.version
            )
          }
          await this.root.harnessUsage.setActiveSpec(active)
          this.root.handleAgentEvent.engineeringLifecycle = await invoke(
            'engineeringLifecycle:complete',
            this.root.handleAgentEvent.thread.projectId,
            this.root.handleAgentEvent.thread.id,
            'spec'
          )
          const nextEngineeringSettings = this.root.harnessUsage.settingsForEngineeringState(
            this.root.handleAgentEvent.engineeringLifecycle
          )
          this.root.contextUsage.updateSettings(nextEngineeringSettings)
          if (nextEngineeringSettings.assignmentMode) {
            if (this.assignment) this.openAssignmentStudio()
            else await this.generateAssignmentDraft()
            return
          }
          if (nextEngineeringSettings.assignmentMode || nextEngineeringSettings.loopMode) {
            return
          }
        }
        if (this.root.loadOlderMessages.settings.assignmentMode) {
          if (this.assignment) this.openAssignmentStudio()
          else await this.generateAssignmentDraft()
          return
        }
        if (active.status === 'draft') {
          active = await invoke(
            'spec:setReview',
            active.projectId,
            active.threadId,
            active.id,
            active.version
          )
        }
        if (active.status === 'in_review') {
          active = await invoke(
            'spec:approve',
            active.projectId,
            active.threadId,
            active.id,
            active.version
          )
        }
        await this.root.harnessUsage.setActiveSpec(active)
        if (active.content.assignment && this.root.loadOlderMessages.settings.assignmentMode) {
          await this.root.submitBrainstormDecision.reconcileReadySpec()
          return
        }
      }
      const contextAttachments = await invoke(
        'spec:getContextAttachments',
        active.projectId,
        active.threadId,
        active.id,
        active.version
      )
      await this.root.handleAgentEvent.sendMessage(
        this.root.buildSpecActionPrompt.buildSpecActionPrompt(action, active, notes),
        contextAttachments,
        action,
        undefined,
        undefined,
        [],
        [],
        workflowActionPresentation(specActionLabel(action), notes)
      )
    } catch (error) {
      this.root.handleAgentEvent.errorMessage =
        error instanceof Error ? error.message : `The specification ${action} action failed.`
    }
  }
}
